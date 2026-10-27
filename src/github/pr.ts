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
  const email =
    process.env.GIT_AUTHOR_EMAIL ?? '41898282+github-actions[bot]@users.noreply.github.com';
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

async function fetchRemoteBranch(
  cwd: string,
  remoteUrl: string,
  branch: string,
): Promise<RemoteBranch | null> {
  const fetched = await getExecOutput(
    'git',
    ['fetch', '--no-tags', remoteUrl, `refs/heads/${branch}`],
    {
      cwd,
      silent: true,
      ignoreReturnCode: true,
    },
  );
  if (fetched.exitCode !== 0) return null;
  const sha = await getExecOutput('git', ['rev-parse', 'FETCH_HEAD'], { cwd, silent: true });
  const tree = await getExecOutput('git', ['rev-parse', 'FETCH_HEAD^{tree}'], {
    cwd,
    silent: true,
  });
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

  const supersededPrs = await removeSupersededBranches(octokit, branch, logger);

  // The branch name is stable across runs, so a previous run may have pushed it
  // already. Compare trees to avoid force-pushing an identical commit (which
  // would only churn the open PR), and use an explicit lease so a concurrent
  // update between fetch and push is rejected instead of overwritten.
  const remote = await fetchRemoteBranch(cwd, remoteUrl, branch);
  const localTree = (
    await getExecOutput('git', ['rev-parse', 'HEAD^{tree}'], { cwd, silent: true })
  ).stdout.trim();
  const existing = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'open',
  });
  const openPr = existing.data.find(
    (p) => p.head.ref === branch && p.head.repo?.full_name === `${owner}/${repo}`,
  );
  if (remote && remote.tree === localTree) {
    logger.info(`Branch ${branch} already has these changes; skipping push.`);
  } else {
    // Without an open PR nobody is reviewing the branch: its PR was merged or
    // closed, or was never opened.
    if (remote && openPr) {
      const manual = await findManualCommits(octokit, cwd, branch, remote.sha);
      if (manual.total > 0) {
        await reportManualCommits(octokit, {
          branch,
          head: remote.sha,
          pr: openPr,
          manual,
          reports,
          logger,
        });
        return { number: openPr.number, url: openPr.html_url };
      }
    }
    // silent keeps the token-bearing URL out of the log, which also hides
    // git's stderr, so it is surfaced through the thrown error instead.
    const pushed = await getExecOutput(
      'git',
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${remote?.sha ?? ''}`,
        remoteUrl,
        `${branch}:${branch}`,
      ],
      { cwd, silent: true, ignoreReturnCode: true },
    );
    if (pushed.exitCode !== 0) {
      throw new Error(
        `git push to ${branch} failed (exit ${pushed.exitCode}): ${redact(pushed.stderr, opts.token).trim()}`,
      );
    }
  }

  let pr: { number: number; html_url: string };
  if (openPr) {
    pr = openPr;
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

  await commentOnSupersededPullRequests(octokit, supersededPrs, pr.number, logger);

  return { number: pr.number, url: pr.html_url };
}

type Octokit = ReturnType<typeof github.getOctokit>;

// Versions up to v1.0.4 appended a `YYYYMMDDHHMM` suffix to the branch name,
// so each scheduled run left another branch (and often an open PR) behind.
export function isSupersededBranch(branch: string, ref: string): boolean {
  const prefix = `${branch}/`;
  if (!ref.startsWith(prefix)) return false;
  return /^\d{12}$/.test(ref.slice(prefix.length));
}

/**
 * Deletes every branch under `<branch>/` left behind by v1.0.4 and earlier,
 * closing open PRs on them first. Must run before pushing `<branch>`: git
 * refuses to create `refs/heads/<branch>` while any ref exists under it.
 *
 * Returns the numbers of the closed PRs. Throws without deleting anything when
 * a branch under `<branch>/` does not look like one of those leftovers. An API
 * failure throws as well, leaving the branches handled before it closed and
 * deleted.
 */
export async function removeSupersededBranches(
  octokit: Octokit,
  branch: string,
  logger: Logger,
): Promise<number[]> {
  const { owner, repo } = github.context.repo;
  const refs = await octokit.paginate(octokit.rest.git.listMatchingRefs, {
    owner,
    repo,
    ref: `heads/${branch}/`,
  });
  const branches = refs.map((r) => ({
    name: r.ref.replace(/^refs\/heads\//, ''),
    sha: r.object.sha,
  }));
  const foreign = branches
    .filter(({ name }) => !isSupersededBranch(branch, name))
    .map(({ name }) => name);
  if (foreign.length > 0) {
    throw new Error(
      `Cannot push ${branch} because branches exist under ${branch}/ (${foreign.join(', ')}). ` +
        'Rename or delete them, or set a different pr-branch.',
    );
  }

  const closed: number[] = [];
  for (const { name, sha } of branches) {
    try {
      const open = await octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${name}`,
        state: 'open',
      });
      // Closing is destructive, so do not rely on the head filter alone to scope it.
      const stale = open.data.filter(
        (p) => p.head.ref === name && p.head.repo?.full_name === `${owner}/${repo}`,
      );
      for (const pr of stale) {
        // The new PR does not exist yet and may never be opened if a later step
        // fails, so explain the closure without referring to it.
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: `Closing: branch \`${name}\` is deleted so that \`${branch}\` can be pushed. Later prune results go to the pull request from \`${branch}\`.`,
        });
        await octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' });
        closed.push(pr.number);
        logger.info(`Closed superseded PR #${pr.number}`);
      }
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${name}` });
      logger.info(`Deleted superseded branch ${name} (was ${sha})`);
    } catch (err) {
      throw new Error(
        `Failed to remove superseded branch ${name}, which blocks pushing ${branch}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return closed;
}

async function commentOnSupersededPullRequests(
  octokit: Octokit,
  prNumbers: number[],
  currentPrNumber: number,
  logger: Logger,
): Promise<void> {
  const { owner, repo } = github.context.repo;
  for (const number of prNumbers) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: `Superseded by #${currentPrNumber}.`,
      });
    } catch (err) {
      logger.warn(
        `Failed to comment on superseded PR #${number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface ManualCommits {
  total: number;
  listed: { sha: string; subject: string; author: string }[];
}

const MAX_LISTED_COMMITS = 10;

/**
 * Finds the commits on `head` that this action did not create, i.e. the ones
 * that force-pushing `HEAD` would drop. A run pushes a single commit on top of
 * the checked-out commit, so only the oldest of them can be the action's, and
 * only when its author and committer match `HEAD`'s.
 */
async function findManualCommits(
  octokit: Octokit,
  cwd: string,
  branch: string,
  head: string,
): Promise<ManualCommits> {
  const { owner, repo } = github.context.repo;
  // NUL-separated so that an empty email cannot shift the fields.
  const own = await getExecOutput('git', ['show', '-s', '--format=%P%x00%ae%x00%ce%x00', 'HEAD'], {
    cwd,
    silent: true,
  });
  const [parents = '', authorEmail, committerEmail] = own.stdout.split('\0');
  const parent = parents.split(' ')[0];
  let compared;
  try {
    // Without paging parameters the API returns the newest 250 commits; with
    // per_page it starts from the oldest, which is where the action's commit is.
    compared = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${parent}...${head}`,
      per_page: MAX_LISTED_COMMITS + 1,
    });
  } catch (err) {
    throw new Error(
      `Failed to list the commits on ${branch} that pushing would drop: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const { commits, total_commits: total } = compared.data;
  const [first] = commits;
  const ownsFirst =
    first !== undefined &&
    first.commit.author?.email === authorEmail &&
    first.commit.committer?.email === committerEmail;
  const manual = ownsFirst ? commits.slice(1) : commits;
  return {
    total: ownsFirst ? total - 1 : total,
    listed: manual.slice(0, MAX_LISTED_COMMITS).map((c) => ({
      sha: c.sha,
      subject: c.commit.message.split('\n')[0] ?? '',
      author: c.author?.login ?? c.commit.author?.name ?? 'unknown',
    })),
  };
}

async function reportManualCommits(
  octokit: Octokit,
  opts: {
    branch: string;
    head: string;
    pr: { number: number };
    manual: ManualCommits;
    reports: PrunerReport[];
    logger: Logger;
  },
): Promise<void> {
  const { branch, head, pr, manual, logger } = opts;
  const { owner, repo } = github.context.repo;
  logger.warn(
    `Did not update ${branch}: it has ${manual.total} commit(s) that this action did not create, and PR #${pr.number} is still open. Merge or close the PR to let the next run update the branch.`,
  );

  // Only this comment tells the PR's reviewers why the PR stopped updating,
  // so failing to post it fails the run.
  try {
    // Scheduled runs keep hitting the same branch until the PR is merged or
    // closed, so comment once per branch head instead of on every run.
    const marker = `<!-- prune-supply-chain-overrides-action:manual-commits ${head} -->`;
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
    });
    if (comments.some((c) => c.body?.includes(marker))) {
      logger.info(`PR #${pr.number} already has a comment about ${head}; not commenting again.`);
      return;
    }

    const lines = [
      marker,
      `This run did not update \`${branch}\`, because the branch has commits that this action did not create:`,
      '',
      ...manual.listed.map((c) => `- ${c.sha.slice(0, 7)} ${codeSpan(c.subject)} (${c.author})`),
    ];
    if (manual.total > manual.listed.length) {
      lines.push(`- …and ${manual.total - manual.listed.length} more`);
    }
    lines.push(
      '',
      'Pushing the new prune result would force-push over them, so this pull request keeps the result of an earlier run.',
      `Once this pull request is merged or closed, the next run that finds entries to prune starts \`${branch}\` over and opens a new pull request.`,
      '',
      '<details><summary>Result of this run</summary>',
      '',
      ...renderReportLines(opts.reports),
      '</details>',
    );
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: lines.join('\n'),
    });
  } catch (err) {
    throw new Error(
      `Failed to comment on PR #${pr.number} about the commits that keep ${branch} from being updated: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// A code span keeps @mentions and #references in commit subjects from
// notifying people or adding cross-references to other issues.
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
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
  lines.push(...renderReportLines(reports));
  return lines.join('\n');
}

function renderReportLines(reports: PrunerReport[]): string[] {
  const lines: string[] = [];
  for (const report of reports) {
    if (report.removed.length === 0 && report.skipped.length === 0) continue;
    lines.push(`### ${report.pruner}`);
    lines.push('');
    if (report.removed.length > 0) {
      lines.push('**Removed**');
      lines.push('');
      for (const entry of report.removed) {
        lines.push(
          `- \`${entry.key}\`${entry.value ? ` (\`${entry.value}\`)` : ''} — ${entry.reason}`,
        );
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
  return lines;
}

export function summarizeRemovals(reports: PrunerReport[]): PrunedEntry[] {
  return reports.flatMap((r) => r.removed);
}
