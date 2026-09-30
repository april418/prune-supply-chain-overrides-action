import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exec } from '@actions/exec';
import semver from 'semver';
import { parseDocument, isMap } from 'yaml';
import type { Pruner, PrunerContext } from './types.js';
import type { PrunedEntry, PrunerReport } from '../types.js';
import {
  readMapEntries,
  removeFromMap,
  isCollectionEmpty,
  removeKey,
} from '../files/pnpm-workspace.js';
import { loadPnpmLockfile, type PnpmLockfile } from '../lockfile/pnpm-lockfile.js';

// pnpm's own parent>child delimiter (parse-overrides). A `>` preceded by a
// space, `|` or `@` belongs to a range selector such as `foo@>=1.0.0 <2`.
const NESTED_DELIMITER = /[^ |@]>/;

/**
 * Split a pnpm `overrides` key into the target package name and its version
 * selector (`undefined` when the key has none).
 *
 * Override keys may use the nested `parent>child` syntax, e.g. `tmp@<0.2.6`,
 * `@scope/pkg@>=1.0.0 <2`, `foo>bar@1.0.0`; the target is the child.
 */
export function parseOverrideKey(key: string): { name: string; selector?: string } {
  const delimiter = key.search(NESTED_DELIMITER);
  const target = delimiter === -1 ? key : key.slice(delimiter + 2);
  // lastIndexOf('@') === 0 means a scoped name with no selector (`@scope/pkg`);
  // <0 means an unscoped name with no selector.
  const at = target.lastIndexOf('@');
  return at > 0 ? { name: target.slice(0, at), selector: target.slice(at + 1) } : { name: target };
}

/** The bare package name an override key targets, as keyed in resolvedVersions. */
export function overrideTargetName(key: string): string {
  return parseOverrideKey(key).name;
}

/**
 * Remove `overrides` entries whose pin is no longer load-bearing — i.e. the
 * natural resolution without the override has no version of the target that
 * violates it (see {@link violating}). Verified by running
 * `pnpm install --lockfile-only` against a backup copy of pnpm-workspace.yaml /
 * pnpm-lock.yaml.
 *
 * Removals are evaluated cumulatively: each candidate is tried on top of the
 * removals already accepted, and every accepted override is re-checked against
 * the resulting lockfile. Overlapping rules for the same package (e.g.
 * `tmp@<=0.2.3` and `tmp@<0.2.6`) each look redundant while the other one is
 * still in place, so evaluating them in isolation would drop all of them.
 */
export const overridesPruner: Pruner = {
  name: 'overrides',
  async run(ctx: PrunerContext): Promise<PrunerReport> {
    const removed: PrunedEntry[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    if (!ctx.workspace) return { pruner: 'overrides', removed, skipped };
    if (ctx.packageManager !== 'pnpm') {
      ctx.logger.info('overrides pruner: only pnpm projects are supported in this release');
      return { pruner: 'overrides', removed, skipped };
    }

    const entries = readMapEntries(ctx.workspace.document, 'overrides');
    if (entries.length === 0) return { pruner: 'overrides', removed, skipped };

    const lockfilePath = path.join(ctx.cwd, 'pnpm-lock.yaml');
    const wsBackup = await readFile(ctx.workspace.filePath, 'utf8');
    let lockBackup: string | null = null;
    try {
      lockBackup = await readFile(lockfilePath, 'utf8');
    } catch {
      ctx.logger.warn(
        'overrides pruner: pnpm-lock.yaml is missing — skipping (a lockfile is required to verify resolution).',
      );
      return { pruner: 'overrides', removed, skipped };
    }
    const baseline = await loadPnpmLockfile(ctx.cwd);

    const toRemoveKeys: string[] = [];
    let wsAccepted = wsBackup;
    let lockAccepted = lockBackup;
    try {
      for (const { key, value: range } of entries) {
        const decision = await evaluateOverride(ctx, key, range, removed, baseline);
        if (decision.action === 'remove') {
          toRemoveKeys.push(key);
          removed.push({
            field: 'overrides',
            key,
            value: range,
            reason: decision.reason,
            file: ctx.workspace.filePath,
          });
          wsAccepted = await readFile(ctx.workspace.filePath, 'utf8');
          lockAccepted = await readFile(lockfilePath, 'utf8');
        } else {
          skipped.push({ key, reason: decision.reason });
          await restore(ctx.workspace.filePath, wsAccepted);
          await writeFile(lockfilePath, lockAccepted, 'utf8');
        }
      }
    } finally {
      await restore(ctx.workspace.filePath, wsBackup);
      await writeFile(lockfilePath, lockBackup, 'utf8');
    }

    if (toRemoveKeys.length > 0) {
      removeFromMap(ctx.workspace.document, 'overrides', toRemoveKeys);
      if (isCollectionEmpty(ctx.workspace.document, 'overrides')) {
        removeKey(ctx.workspace.document, 'overrides');
      }
    }

    return { pruner: 'overrides', removed, skipped };
  },
};

async function evaluateOverride(
  ctx: PrunerContext,
  overrideKey: string,
  range: string,
  alreadyRemoved: readonly PrunedEntry[],
  baseline: PnpmLockfile | null,
): Promise<{ action: 'remove' | 'skip'; reason: string }> {
  if (!ctx.workspace) return { action: 'skip', reason: 'no pnpm-workspace.yaml' };

  const wsSource = await readFile(ctx.workspace.filePath, 'utf8');
  const doc = parseDocument(wsSource);
  const overrides = doc.get('overrides', true);
  if (!isMap(overrides)) {
    return { action: 'skip', reason: 'overrides block missing or malformed' };
  }
  overrides.delete(overrideKey);
  if (overrides.items.length === 0) doc.delete('overrides');
  await writeFile(ctx.workspace.filePath, doc.toString({ lineWidth: 0 }), 'utf8');

  const output: string[] = [];
  let exitCode: number;
  try {
    exitCode = await exec(
      'pnpm',
      ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
      {
        cwd: ctx.cwd,
        ignoreReturnCode: true,
        silent: true,
        listeners: {
          stdout: (data) => output.push(data.toString()),
          stderr: (data) => output.push(data.toString()),
        },
      },
    );
  } catch (err) {
    return {
      action: 'skip',
      reason: `pnpm install failed while simulating removal: ${(err as Error).message}`,
    };
  }
  if (exitCode !== 0) {
    return {
      action: 'skip',
      reason: `pnpm install exited with code ${exitCode}: ${output.join('').slice(-400)}`,
    };
  }

  const newLockfile = await loadPnpmLockfile(ctx.cwd);
  if (!newLockfile) {
    return { action: 'skip', reason: 'lockfile disappeared after simulation' };
  }
  const regressions = findUnsatisfiedOverrides(newLockfile, alreadyRemoved, baseline);
  if (regressions.length > 0) {
    return {
      action: 'skip',
      reason: `removing the override would also undo an already-removed override: ${regressions.join('; ')}`,
    };
  }
  const targetName = overrideTargetName(overrideKey);
  const versions = newLockfile.resolvedVersions.get(targetName);
  if (!versions || versions.size === 0) {
    return {
      action: 'remove',
      reason: `${targetName} is no longer pulled into the dependency graph after removing the override`,
    };
  }
  const violators = violating(
    versions,
    overrideKey,
    range,
    baseline?.resolvedVersions.get(targetName),
  );
  if (violators.length === 0) {
    const resolved = [...versions].join(', ');
    const selector = selectorScope(overrideKey);
    return {
      action: 'remove',
      reason: selector
        ? `natural resolution (${resolved}) has no version matching "${selector}" outside "${range}"`
        : `natural resolution (${resolved}) already satisfies "${range}"`,
    };
  }
  return {
    action: 'skip',
    reason: `removing the override would resolve ${targetName} to ${violators.join(', ')} which does not satisfy "${range}"`,
  };
}

/**
 * Check removed overrides against a lockfile. Returns one message per removed
 * override whose target now resolves to a violating version (see
 * {@link violating}); an empty array means every removal still holds.
 * `baseline` is the lockfile from before any override was removed; without it
 * every resolved version is checked against the override's range.
 */
export function findUnsatisfiedOverrides(
  lockfile: PnpmLockfile,
  removedOverrides: readonly PrunedEntry[],
  baseline?: PnpmLockfile | null,
): string[] {
  const out: string[] = [];
  for (const { key, value: range } of removedOverrides) {
    if (range === undefined) continue;
    const name = overrideTargetName(key);
    const versions = lockfile.resolvedVersions.get(name);
    if (!versions) continue;
    const violators = violating(versions, key, range, baseline?.resolvedVersions.get(name));
    if (violators.length > 0) {
      out.push(`${key} (${name} ${violators.join(', ')} does not satisfy "${range}")`);
    }
  }
  return out;
}

/** The key's selector when it is a semver range, otherwise undefined. */
function selectorScope(key: string): string | undefined {
  const { selector } = parseOverrideKey(key);
  return selector && semver.validRange(selector) ? selector : undefined;
}

/**
 * Resolved versions that removing the override would let through: those not
 * satisfying its range, except versions outside its selector that were already
 * resolved before any removal (`baselineVersions`). pnpm applies an override
 * when the declared range intersects the selector, so a range such as
 * `>=1.0.0` can jump past a `<1.1.13` selector once the override is gone; only
 * pre-existing out-of-selector versions (e.g. the other majors in a
 * per-series set of overrides) are known not to be held back by it.
 */
function violating(
  versions: Iterable<string>,
  key: string,
  range: string,
  baselineVersions?: ReadonlySet<string>,
): string[] {
  const scope = selectorScope(key) ?? '*';
  // includePrerelease widens the scope only, so a prerelease is never exempted.
  return [...versions].filter(
    (v) =>
      semver.valid(v) &&
      !semver.satisfies(v, range) &&
      (semver.satisfies(v, scope, { includePrerelease: true }) || !baselineVersions?.has(v)),
  );
}

async function restore(filePath: string, original: string): Promise<void> {
  await writeFile(filePath, original, 'utf8');
}
