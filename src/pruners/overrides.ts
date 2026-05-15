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
import { loadPnpmLockfile } from '../lockfile/pnpm-lockfile.js';

/**
 * Remove `overrides` entries whose pin is no longer load-bearing — i.e. the
 * natural resolution (without the override) already satisfies the override
 * range. Verified by running `pnpm install --lockfile-only` against a backup
 * copy of pnpm-workspace.yaml / pnpm-lock.yaml.
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

    const toRemoveKeys: string[] = [];
    try {
      for (const { key, value: range } of entries) {
        const decision = await evaluateOverride(ctx, key, range);
        if (decision.action === 'remove') {
          toRemoveKeys.push(key);
          removed.push({
            field: 'overrides',
            key,
            value: range,
            reason: decision.reason,
            file: ctx.workspace.filePath,
          });
        } else {
          skipped.push({ key, reason: decision.reason });
        }
        await restore(ctx.workspace.filePath, wsBackup);
        await writeFile(lockfilePath, lockBackup, 'utf8');
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
  const versions = newLockfile.resolvedVersions.get(overrideKey);
  if (!versions || versions.size === 0) {
    return {
      action: 'remove',
      reason: `${overrideKey} is no longer pulled into the dependency graph after removing the override`,
    };
  }
  const violators = [...versions].filter((v) => semver.valid(v) && !semver.satisfies(v, range));
  if (violators.length === 0) {
    return {
      action: 'remove',
      reason: `natural resolution (${[...versions].join(', ')}) already satisfies "${range}"`,
    };
  }
  return {
    action: 'skip',
    reason: `removing the override would resolve ${overrideKey} to ${violators.join(', ')} which does not satisfy "${range}"`,
  };
}

async function restore(filePath: string, original: string): Promise<void> {
  await writeFile(filePath, original, 'utf8');
}
