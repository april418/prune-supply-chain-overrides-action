import { readFile, writeFile } from 'node:fs/promises';
import type { Logger } from '../util/logger.js';
import type { PrunerReport } from '../types.js';
import { findUnsatisfiedOverrides } from '../pruners/overrides.js';
import { loadPnpmLockfile, type PnpmLockfile } from './pnpm-lockfile.js';
import { regeneratePnpmLockfile } from './regenerate.js';

/**
 * Regenerate `pnpm-lock.yaml` for the pruned files on disk and re-check every
 * removed override against it. `baseline` is the lockfile from before any
 * pruning. Throws when the lockfile cannot be regenerated or a removed
 * override no longer holds; returns the lockfile paths, or an empty array when
 * the project has no lockfile.
 */
export async function regenerateAndVerify(
  cwd: string,
  reports: readonly PrunerReport[],
  baseline: PnpmLockfile | null,
  logger: Logger,
): Promise<string[]> {
  const regenerated = await regeneratePnpmLockfile(cwd, logger);
  if (regenerated.length === 0) return regenerated;
  // The overrides pruner verified its removals before the other pruners'
  // edits were written, so re-check them against the lockfile actually
  // produced. The resulting PR is made with GITHUB_TOKEN and gets no CI.
  const finalLockfile = await loadPnpmLockfile(cwd);
  if (finalLockfile) {
    const removedOverrides = reports.flatMap((r) => (r.pruner === 'overrides' ? r.removed : []));
    const regressions = findUnsatisfiedOverrides(finalLockfile, removedOverrides, baseline);
    if (regressions.length > 0) {
      throw new Error(
        `Regenerated pnpm-lock.yaml no longer satisfies removed overrides: ${regressions.join('; ')}`,
      );
    }
  }
  return regenerated;
}

/**
 * Run `fn`, then write `filePaths` back to their contents from before the call,
 * whether `fn` succeeds or throws. Every path must exist when called.
 */
export async function withFilesRestored<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const originals = await Promise.all(
    filePaths.map(async (p) => [p, await readFile(p, 'utf8')] as const),
  );
  try {
    return await fn();
  } finally {
    // allSettled so one failed write neither skips the rest nor masks fn's error.
    await Promise.allSettled(originals.map(([p, content]) => writeFile(p, content, 'utf8')));
  }
}
