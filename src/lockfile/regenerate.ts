import { exec } from '@actions/exec';
import type { Logger } from '../util/logger.js';
import type { PackageManager } from '../types.js';
import { lockfileManager } from './manager.js';

/**
 * Re-resolve the lockfiles so that they reflect the post-prune state of
 * `pnpm-workspace.yaml` / `package.json`. Without this, consumers of the
 * resulting PR hit `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (or npm's equivalent
 * `npm ci` failure) because the overrides recorded in the lockfile no longer
 * match the manifest.
 *
 * Returns the absolute paths of the (now-updated) lockfiles, including
 * per-project ones (see {@link findPnpmLockfiles}), or an empty array when
 * there is no lockfile to regenerate.
 */
export async function regenerateLockfile(
  cwd: string,
  packageManager: PackageManager,
  logger: Logger,
): Promise<string[]> {
  const manager = lockfileManager(packageManager);
  if ((await manager.find(cwd)).length === 0) {
    logger.info(`No ${manager.name} found — skipping lockfile regeneration.`);
    return [];
  }
  const { command, args } = manager.resolveCommand;
  const exitCode = await exec(command, args, { cwd, ignoreReturnCode: true });
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 2).join(' ')} failed with exit code ${exitCode}. ` +
        'The pruned files do not resolve, so no pull request was created.',
    );
  }
  return manager.find(cwd);
}
