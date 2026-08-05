import * as github from '@actions/github';
import { exec, getExecOutput } from '@actions/exec';
import type { Logger } from '../util/logger.js';
import type { PrunerReport, PrunedEntry } from '../types.js';

export interface PullRequestOptions {
  cwd: string;
  token: string;
  branch: string;
  base: string;
  title: string;
  bodyHeader?: string;
  commitMessage: string;
  labels: string[];
  changedFiles: string[];
  reports: PrunerReport[];
  logger: Logger;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export async function ensureGitIdentity(cwd: string): Promise<void> {
  const name = process.env.GIT_AUTHOR_NAME ?? 'github-actions[bot]';
  const email = process.env.GIT_AUTHOR_EMAIL ?? '41898282+github-actions[bot]@users.noreply.github.com';
  await exec('git', ['config', 'user.name', name], { cwd });
  await exec('git', ['config', 'user.email', email], { cwd });
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const out = await getExecOutput('git', ['status', '--porcelain'], { cwd, silent: true });
  return out.stdout.trim().length > 0;
}

interface RemoteBranch {
  sha: string;
  tree: string;
}

async function fetchRemoteBranch(cwd: string, remoteUrl: string, branch: string): Promise<RemoteBranch | null> {
  const fetched = await getExecOutput('git', ['fetch', '--no-tags', remoteUrl, `refs/heads/${branch}`], {
    cwd,
    silent: true,
    ignoreReturnCode: true,
  });
  if (fetched.exitCode !== 0) return null;
  const sha = await getExecOutput('git', ['rev-parse', 'FETCH_HEAD'], { cwd, silent: true });
  const tree = await getExecOutput('git', ['rev-parse', 'FETCH_HEAD^{tree}'], { cwd, silent: true });
  return { sha: sha.stdout.trim(), tree: tree.stdout.trim() };
}

export async function createPullRequest(opts: PullRequestOptions): Promise<PullRequestResult> {
  const { cwd, branch, base, title, commitMessage, changedFiles, reports, logger } = opts;
  const octokit = github.getOctokit(opts.token);
  const { owner, repo } = github.context.repo;
  const remoteUrl = `https://x-access-token:${opts.token}@github.com/${owner}/${repo}.git`;

  await ensureGitIdentity(cwd);
  await exec('git', ['checkout', '-B', branch], { cwd });
  for (const file of changedFiles) {
    await exec('git', ['add', '--', file], { cwd });
  }
  await exec('git', ['commit', '-m', commitMessage], { cwd });

  // The branch name is stable across runs, so a previous run may have pushed it
  // already. Compare trees to avoid force-pushing an identical commit (which
  // would only churn the open PR), and use an explicit lease so a concurrent
  // update between fetch and push is rejected instead of overwritten.
  const remote = await fetchRemoteBranch(cwd, remoteUrl, branch);
  const localTree = (await getExecOutput('git', ['rev-parse', 'HEAD^{tree}'], { cwd, silent: true })).stdout.trim();
  if (remote && remote.tree === localTree) {
    logger.info(`Branch ${branch} already has these changes; skipping push.`);
  } else {
    await exec(
      'git',
      ['push', `--force-with-lease=refs/heads/${branch}:${remote?.sha ?? ''}`, remoteUrl, `${branch}:${branch}`],
      { cwd, silent: true },
    );
  }

  const existing = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'open',
  });

  let pr: { number: number; html_url: string };
  if (existing.data.length > 0) {
    pr = existing.data[0]!;
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      title,
      body: renderBody(reports, opts.bodyHeader),
    });
    logger.info(`Updated existing PR #${pr.number} (${pr.html_url})`);
  } else {
    const created = await octokit.rest.pulls.create({
      owner,
      repo,
      head: branch,
      base,
      title,
      body: renderBody(reports, opts.bodyHeader),
    });
    pr = created.data;
    logger.info(`Opened PR #${pr.number} (${pr.html_url})`);
  }

  if (opts.labels.length > 0) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pr.number,
      labels: opts.labels,
    });
  }

  await closeSupersededPullRequests(octokit, branch, pr.number, logger);

  return { number: pr.number, url: pr.html_url };
}

// Versions up to v1.0.4 appended a `YYYYMMDDHHMM` suffix to the branch name,
// so each scheduled run left another open PR behind. Detect those leftovers
// so they can be closed once the fixed-branch PR exists.
export function isSupersededBranch(branch: string, ref: string): boolean {
  const prefix = `${branch}/`;
  if (!ref.startsWith(prefix)) return false;
  return /^\d{12}$/.test(ref.slice(prefix.length));
}

async function closeSupersededPullRequests(
  octokit: ReturnType<typeof github.getOctokit>,
  branch: string,
  currentPrNumber: number,
  logger: Logger,
): Promise<void> {
  const { owner, repo } = github.context.repo;
  const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  const superseded = openPrs.filter(
    (p) =>
      p.number !== currentPrNumber &&
      p.head.repo?.full_name === `${owner}/${repo}` &&
      isSupersededBranch(branch, p.head.ref),
  );
  for (const stale of superseded) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: stale.number,
        body: `Superseded by #${currentPrNumber}.`,
      });
      await octokit.rest.pulls.update({ owner, repo, pull_number: stale.number, state: 'closed' });
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${stale.head.ref}` });
      logger.info(`Closed superseded PR #${stale.number} and deleted ${stale.head.ref}`);
    } catch (err) {
      logger.warn(`Failed to close superseded PR #${stale.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function renderBody(reports: PrunerReport[], header?: string): string {
  const lines: string[] = [];
  if (header) {
    lines.push(header.trim());
    lines.push('');
  }
  lines.push(
    'This pull request is generated by [`prune-supply-chain-overrides-action`](https://github.com/marketplace/actions/prune-supply-chain-overrides).',
  );
  lines.push('');
  lines.push(
    'Entries below were originally added as supply-chain mitigations and have since become unnecessary, so the action removed them.',
  );
  lines.push('');

  for (const report of reports) {
    if (report.removed.length === 0 && report.skipped.length === 0) continue;
    lines.push(`### ${report.pruner}`);
    lines.push('');
    if (report.removed.length > 0) {
      lines.push('**Removed**');
      lines.push('');
      for (const entry of report.removed) {
        lines.push(`- \`${entry.key}\`${entry.value ? ` (\`${entry.value}\`)` : ''} — ${entry.reason}`);
      }
      lines.push('');
    }
    if (report.skipped.length > 0) {
      lines.push('<details><summary>Skipped (kept)</summary>');
      lines.push('');
      for (const entry of report.skipped) {
        lines.push(`- \`${entry.key}\` — ${entry.reason}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function summarizeRemovals(reports: PrunerReport[]): PrunedEntry[] {
  return reports.flatMap((r) => r.removed);
}
