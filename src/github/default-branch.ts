import * as github from '@actions/github';
import { getExecOutput } from '@actions/exec';
import type { Logger } from '../util/logger.js';

/**
 * Resolve the repository's default branch, used as the base for the prune PR.
 *
 * The original implementation relied solely on
 * `git symbolic-ref refs/remotes/origin/HEAD`. However `actions/checkout` does
 * not populate `refs/remotes/origin/HEAD`, so that command always exited
 * non-zero and the action fell back to "main". On repositories whose default
 * branch is not "main" (e.g. "develop" / "master") the subsequent
 * `pulls.create` call then failed with
 * `Validation Failed: {"resource":"PullRequest","field":"base","code":"invalid"}`.
 *
 * We now ask the GitHub API first — it is authoritative regardless of the
 * triggering event or checkout configuration — and only fall back to the
 * event payload and the local git ref when the API is unavailable.
 */
export async function resolveDefaultBranch(
  token: string,
  cwd: string,
  logger: Logger,
): Promise<string> {
  // 1. Authoritative source: the GitHub API.
  if (token) {
    try {
      const octokit = github.getOctokit(token);
      const { owner, repo } = github.context.repo;
      const { data } = await octokit.rest.repos.get({ owner, repo });
      if (data.default_branch) return data.default_branch;
    } catch (err) {
      logger.warn(
        `Could not resolve default branch via the GitHub API: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 2. Event payload — populated for most webhook events.
  const fromPayload = github.context.payload.repository?.default_branch;
  if (fromPayload) return fromPayload;

  // 3. Local git ref — only set when checkout configured origin/HEAD.
  const out = await getExecOutput('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  });
  if (out.exitCode === 0) {
    const ref = out.stdout.trim();
    const slash = ref.lastIndexOf('/');
    if (slash !== -1) return ref.slice(slash + 1);
  }

  logger.warn('Could not determine default branch; falling back to "main".');
  return 'main';
}
