import type { Pruner, PrunerContext } from './types.js';
import type { PrunedEntry, PrunerReport } from '../types.js';
import {
  readSequenceKeys,
  removeFromSequence,
  isCollectionEmpty,
  removeKey,
} from '../files/pnpm-workspace.js';

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/**
 * Prune entries from `onlyBuiltDependencies` whose package either:
 *
 * 1. is no longer in the dependency graph, or
 * 2. no longer declares any of `preinstall`/`install`/`postinstall` scripts
 *    in the currently-resolved version.
 *
 * Both cases mean the allow-list entry is dead weight that grants unnecessary
 * lifecycle-script permission to a package that does not use it.
 */
export const onlyBuiltDependenciesPruner: Pruner = {
  name: 'onlyBuiltDependencies',
  async run(ctx: PrunerContext): Promise<PrunerReport> {
    const removed: PrunedEntry[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    if (!ctx.workspace) return { pruner: 'onlyBuiltDependencies', removed, skipped };

    const entries = readSequenceKeys(ctx.workspace.document, 'onlyBuiltDependencies');
    if (entries.length === 0) {
      return { pruner: 'onlyBuiltDependencies', removed, skipped };
    }

    const toRemove: string[] = [];
    for (const { value: pkg } of entries) {
      const decision = await evaluate(pkg, ctx);
      if (decision.action === 'remove') {
        toRemove.push(pkg);
        removed.push({
          field: 'onlyBuiltDependencies',
          key: pkg,
          reason: decision.reason,
          file: ctx.workspace.filePath,
        });
      } else {
        skipped.push({ key: pkg, reason: decision.reason });
      }
    }

    if (toRemove.length > 0) {
      removeFromSequence(ctx.workspace.document, 'onlyBuiltDependencies', toRemove);
      if (isCollectionEmpty(ctx.workspace.document, 'onlyBuiltDependencies')) {
        removeKey(ctx.workspace.document, 'onlyBuiltDependencies');
      }
    }

    return { pruner: 'onlyBuiltDependencies', removed, skipped };
  },
};

async function evaluate(
  pkg: string,
  ctx: PrunerContext,
): Promise<{ action: 'remove' | 'skip'; reason: string }> {
  const versions = ctx.lockfile?.resolvedVersions.get(pkg);
  if (!versions || versions.size === 0) {
    return { action: 'remove', reason: 'package is no longer present in pnpm-lock.yaml' };
  }

  const versionsWithScripts: string[] = [];
  for (const v of versions) {
    let manifest;
    try {
      manifest = await ctx.registry.manifest(pkg, v);
    } catch (err) {
      return {
        action: 'skip',
        reason: `failed to fetch manifest for ${pkg}@${v}: ${(err as Error).message}`,
      };
    }
    if (hasLifecycleScript(manifest)) {
      versionsWithScripts.push(v);
    }
  }

  if (versionsWithScripts.length === 0) {
    return {
      action: 'remove',
      reason: `${pkg} no longer declares preinstall/install/postinstall scripts in any resolved version`,
    };
  }
  return {
    action: 'skip',
    reason: `${pkg}@${versionsWithScripts.join(', ')} still declares lifecycle scripts`,
  };
}

function hasLifecycleScript(manifest: {
  scripts?: Record<string, string>;
  hasInstallScript?: boolean;
}): boolean {
  if (manifest.hasInstallScript) return true;
  if (!manifest.scripts) return false;
  return LIFECYCLE_SCRIPTS.some((s) => Boolean(manifest.scripts?.[s]));
}
