import { readFile, writeFile } from 'node:fs/promises';
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
import type { PnpmLockfile } from '../lockfile/pnpm-lockfile.js';
import { lockfileManager } from '../lockfile/manager.js';
import { removeOverrides } from '../files/package-json.js';
import { removeOverrideKeys } from '../files/json-text.js';

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
  // Same split as pnpm's parseWantedDependency: the first "@" after a scope's
  // leading one, so a selector such as `npm:bar@^1` keeps its own "@".
  const at = target.indexOf('@', 1);
  return at === -1
    ? { name: target }
    : { name: target.slice(0, at), selector: target.slice(at + 1) };
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
    const source = ctx.packageManager === 'npm' ? npmSource(ctx) : pnpmSource(ctx);
    if (!source) return { pruner: 'overrides', removed, skipped };
    skipped.push(...source.unsupported);
    const { entries } = source;
    if (entries.length === 0) return { pruner: 'overrides', removed, skipped };

    const manager = lockfileManager(ctx.packageManager);
    const lockfilePaths = await manager.find(ctx.cwd);
    if (lockfilePaths.length === 0) {
      ctx.logger.warn(
        `overrides pruner: ${manager.name} is missing — skipping (a lockfile is required to verify resolution).`,
      );
      return { pruner: 'overrides', removed, skipped };
    }
    const fileBackup = await readFile(source.filePath, 'utf8');
    const lockBackup = await readFiles(lockfilePaths);
    const baseline = await manager.load(ctx.cwd);

    const toRemoveKeys: string[] = [];
    let fileAccepted = fileBackup;
    let lockAccepted = lockBackup;
    try {
      // Other pruners edit only the in-memory document, so start from it: an
      // override may be needed only because an exclude above is being removed.
      // Resolving it once before removing anything also tells a starting state
      // that never resolves (e.g. npm's EOVERRIDE) apart from a failed removal.
      const pruned = source.serialize();
      if (pruned !== fileBackup) await writeFile(source.filePath, pruned, 'utf8');
      const install = await resolveLockfile(ctx);
      if (install.exitCode !== 0) {
        const cause =
          pruned === fileBackup
            ? 'the lockfile does not resolve even with every override in place'
            : "the other pruners' changes do not resolve";
        const reason = `${cause}, so no override was evaluated: ${install.output}`;
        for (const { key } of entries) skipped.push({ key, reason });
        return { pruner: 'overrides', removed, skipped };
      }
      fileAccepted = pruned;
      lockAccepted = await readFiles(lockfilePaths);
      for (const { key, value: range } of entries) {
        const decision = await evaluateOverride(ctx, source, key, range, removed, baseline);
        if (decision.action === 'remove') {
          toRemoveKeys.push(key);
          removed.push({
            field: 'overrides',
            key,
            value: range,
            reason: decision.reason,
            file: source.filePath,
          });
          fileAccepted = await readFile(source.filePath, 'utf8');
          lockAccepted = await readFiles(lockfilePaths);
        } else {
          skipped.push({ key, reason: decision.reason });
          await restore(source.filePath, fileAccepted);
          await writeFiles(lockAccepted);
        }
      }
    } finally {
      await restore(source.filePath, fileBackup);
      await writeFiles(lockBackup);
    }

    if (toRemoveKeys.length > 0) source.remove(toRemoveKeys);
    return { pruner: 'overrides', removed, skipped };
  },
};

/** Where a package manager keeps its overrides, and how to edit them. */
interface OverridesSource {
  filePath: string;
  /** Overrides whose value is a version range, in file order. */
  entries: Array<{ key: string; value: string }>;
  /** Overrides this pruner cannot evaluate; they are always kept. */
  unsupported: Array<{ key: string; reason: string }>;
  /** The file as the other pruners' in-memory edits leave it. */
  serialize(): string;
  /** `text` (the file's content) with the override `key` removed. */
  without(text: string, key: string): string;
  /** Apply the accepted removals to the in-memory document. */
  remove(keys: string[]): void;
}

function pnpmSource(ctx: PrunerContext): OverridesSource | null {
  const workspace = ctx.workspace;
  if (!workspace) return null;
  return {
    filePath: workspace.filePath,
    entries: readMapEntries(workspace.document, 'overrides'),
    unsupported: [],
    serialize: () => workspace.document.toString({ lineWidth: 0 }),
    without(text, key) {
      const doc = parseDocument(text);
      const overrides = doc.get('overrides', true);
      if (isMap(overrides)) {
        overrides.delete(key);
        if (overrides.items.length === 0) doc.delete('overrides');
      }
      return doc.toString({ lineWidth: 0 });
    },
    remove(keys) {
      removeFromMap(workspace.document, 'overrides', keys, overrideTargetName);
      if (isCollectionEmpty(workspace.document, 'overrides')) {
        removeKey(workspace.document, 'overrides');
      }
    },
  };
}

/**
 * npm's `package.json#overrides`. Only top-level string values are evaluated:
 * a nested object scopes overrides to a parent package and a `$name` value
 * refers to a direct dependency, and neither maps onto a single version range.
 */
function npmSource(ctx: PrunerContext): OverridesSource | null {
  const pkg = ctx.packageJson;
  if (!pkg) return null;
  const overrides = pkg.json.overrides;
  const entries: OverridesSource['entries'] = [];
  const unsupported: OverridesSource['unsupported'] = [];
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value !== 'string') {
        unsupported.push({ key, reason: 'nested npm overrides are not evaluated' });
      } else if (value.startsWith('$')) {
        unsupported.push({ key, reason: `"${value}" refers to a dependency and is not evaluated` });
      } else {
        entries.push({ key, value });
      }
    }
  }
  return {
    filePath: pkg.filePath,
    entries,
    unsupported,
    serialize: () => pkg.text,
    without: (text, key) => removeOverrideKeys(text, [key]),
    remove: (keys) => removeOverrides(pkg, keys),
  };
}

async function evaluateOverride(
  ctx: PrunerContext,
  source: OverridesSource,
  overrideKey: string,
  range: string,
  alreadyRemoved: readonly PrunedEntry[],
  baseline: PnpmLockfile | null,
): Promise<{ action: 'remove' | 'skip'; reason: string }> {
  const text = await readFile(source.filePath, 'utf8');
  await writeFile(source.filePath, source.without(text, overrideKey), 'utf8');

  const install = await resolveLockfile(ctx);
  if (install.exitCode !== 0) {
    return {
      action: 'skip',
      reason: `lockfile resolution failed while simulating removal: ${install.output}`,
    };
  }

  const newLockfile = await lockfileManager(ctx.packageManager).load(ctx.cwd);
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

/** Re-resolve the lockfiles; `output` is the tail of the command's output or the error. */
async function resolveLockfile(ctx: PrunerContext): Promise<{ exitCode: number; output: string }> {
  const { command, args } = lockfileManager(ctx.packageManager).resolveCommand;
  const output: string[] = [];
  try {
    const exitCode = await exec(command, args, {
      cwd: ctx.cwd,
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data) => output.push(data.toString()),
        stderr: (data) => output.push(data.toString()),
      },
    });
    return { exitCode, output: `exit code ${exitCode}: ${output.join('').slice(-400)}` };
  } catch (err) {
    return { exitCode: -1, output: (err as Error).message };
  }
}

async function readFiles(paths: readonly string[]): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(paths.map(async (p) => [p, await readFile(p, 'utf8')] as const)),
  );
}

async function writeFiles(contents: ReadonlyMap<string, string>): Promise<void> {
  await Promise.all([...contents].map(([p, content]) => writeFile(p, content, 'utf8')));
}

async function restore(filePath: string, original: string): Promise<void> {
  await writeFile(filePath, original, 'utf8');
}
