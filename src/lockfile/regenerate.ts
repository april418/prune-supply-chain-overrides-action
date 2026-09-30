import { exec } from '@actions/exec';
import type { Logger } from '../util/logger.js';
import { findPnpmLockfiles } from './pnpm-lockfile.js';

/**
 * Re-run `pnpm install --lockfile-only` so that `pnpm-lock.yaml` reflects the
 * post-prune state of `pnpm-workspace.yaml`. Without this, consumers of the
 * resulting PR hit `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on
 * `pnpm install --frozen-lockfile` because the `overrides` block recorded in
 * the lockfile no longer matches what the workspace file declares.
 *
 * Returns the absolute paths of the (now-updated) lockfiles, including
 * per-project ones (see {@link findPnpmLockfiles}), or an empty array when
 * there is no lockfile to regenerate.
 */
export async function regeneratePnpmLockfile(cwd: string, logger: Logger): Promise<string[]> {
  if ((await findPnpmLockfiles(cwd)).length === 0) {
    logger.info('No pnpm-lock.yaml found — skipping lockfile regeneration.');
    return [];
  }
  const exitCode = await exec(
    'pnpm',
    ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
    {
      cwd,
      ignoreReturnCode: true,
    },
  );
  if (exitCode !== 0) {
    throw new Error(
      `pnpm install --lockfile-only failed with exit code ${exitCode}. ` +
        'The pruned files do not resolve, so no pull request was created.',
    );
  }
  return findPnpmLockfiles(cwd);
}
