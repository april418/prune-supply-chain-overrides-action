import { access } from 'node:fs/promises';
import path from 'node:path';
import { exec } from '@actions/exec';
import type { Logger } from '../util/logger.js';

/**
 * Re-run `pnpm install --lockfile-only` so that `pnpm-lock.yaml` reflects the
 * post-prune state of `pnpm-workspace.yaml`. Without this, consumers of the
 * resulting PR hit `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on
 * `pnpm install --frozen-lockfile` because the `overrides` block recorded in
 * the lockfile no longer matches what the workspace file declares.
 *
 * Returns the absolute path of the (now-updated) lockfile, or null when there
 * is no lockfile to regenerate.
 */
export async function regeneratePnpmLockfile(
  cwd: string,
  logger: Logger,
): Promise<string | null> {
  const lockfilePath = path.join(cwd, 'pnpm-lock.yaml');
  try {
    await access(lockfilePath);
  } catch {
    logger.info('No pnpm-lock.yaml found — skipping lockfile regeneration.');
    return null;
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
        'The pnpm-workspace.yaml prune was rolled back to avoid committing a broken state.',
    );
  }
  return lockfilePath;
}
