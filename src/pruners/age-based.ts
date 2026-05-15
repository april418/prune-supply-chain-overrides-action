import type { Pruner, PrunerContext } from './types.js';
import type { PrunedEntry, PrunerName, PrunerReport } from '../types.js';
import {
  readSequenceKeys,
  removeFromSequence,
  isCollectionEmpty,
  removeKey,
} from '../files/pnpm-workspace.js';
import { formatMinutes } from '../util/format.js';

interface AgeBasedConfig {
  name: PrunerName;
  /** YAML key in pnpm-workspace.yaml. */
  yamlKey: string;
  /** Threshold field used to gate removal. */
  thresholdKey: 'minimumReleaseAge' | 'trustPolicyIgnoreAfter';
}

/**
 * Generic implementation for "remove entries whose resolved versions are
 * already past a release-age threshold" pruners. Used for both
 * `minimumReleaseAgeExclude` and `trustPolicyExclude`.
 */
class AgeBasedPruner implements Pruner {
  constructor(public readonly config: AgeBasedConfig) {}

  get name(): PrunerName {
    return this.config.name;
  }

  async run(ctx: PrunerContext): Promise<PrunerReport> {
    const removed: PrunedEntry[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    if (!ctx.workspace) {
      return { pruner: this.name, removed, skipped };
    }
    const threshold = this.thresholdFor(ctx);
    if (threshold <= 0) {
      ctx.logger.info(
        `${this.config.yamlKey}: skipped because ${this.config.thresholdKey} is not configured.`,
      );
      return { pruner: this.name, removed, skipped };
    }

    const entries = readSequenceKeys(ctx.workspace.document, this.config.yamlKey);
    if (entries.length === 0) {
      return { pruner: this.name, removed, skipped };
    }

    const toRemove: string[] = [];
    for (const { value: pkg } of entries) {
      const decision = await this.evaluateEntry(pkg, threshold, ctx);
      if (decision.action === 'remove') {
        toRemove.push(pkg);
        removed.push({
          field: this.name,
          key: pkg,
          reason: decision.reason,
          file: ctx.workspace.filePath,
        });
      } else {
        skipped.push({ key: pkg, reason: decision.reason });
      }
    }

    if (toRemove.length > 0) {
      removeFromSequence(ctx.workspace.document, this.config.yamlKey, toRemove);
      if (isCollectionEmpty(ctx.workspace.document, this.config.yamlKey)) {
        removeKey(ctx.workspace.document, this.config.yamlKey);
      }
    }

    return { pruner: this.name, removed, skipped };
  }

  private thresholdFor(ctx: PrunerContext): number {
    if (!ctx.workspace) return 0;
    return this.config.thresholdKey === 'minimumReleaseAge'
      ? ctx.workspace.minimumReleaseAge
      : ctx.workspace.trustPolicyIgnoreAfter;
  }

  private async evaluateEntry(
    pkg: string,
    thresholdMinutes: number,
    ctx: PrunerContext,
  ): Promise<{ action: 'remove'; reason: string } | { action: 'skip'; reason: string }> {
    const versions = ctx.lockfile?.resolvedVersions.get(pkg);
    if (!versions || versions.size === 0) {
      return {
        action: 'remove',
        reason: 'package is no longer referenced from pnpm-lock.yaml',
      };
    }

    let newestPublish: Date | null = null;
    let newestVersion: string | null = null;
    for (const v of versions) {
      let publishedAt: Date | null;
      try {
        publishedAt = await ctx.registry.publishTime(pkg, v);
      } catch (err) {
        return {
          action: 'skip',
          reason: `failed to fetch publish time for ${pkg}@${v}: ${(err as Error).message}`,
        };
      }
      if (!publishedAt) {
        return {
          action: 'skip',
          reason: `npm registry has no publish time for ${pkg}@${v}`,
        };
      }
      if (!newestPublish || publishedAt > newestPublish) {
        newestPublish = publishedAt;
        newestVersion = v;
      }
    }
    if (!newestPublish || !newestVersion) {
      return { action: 'skip', reason: 'no resolved versions could be checked' };
    }

    const ageMin = (ctx.now.getTime() - newestPublish.getTime()) / 60_000;
    if (ageMin >= thresholdMinutes) {
      return {
        action: 'remove',
        reason: `newest resolved version ${newestVersion} was published ${formatMinutes(ageMin)} ago (>= ${this.config.thresholdKey} ${formatMinutes(thresholdMinutes)})`,
      };
    }
    return {
      action: 'skip',
      reason: `newest resolved version ${newestVersion} is only ${formatMinutes(ageMin)} old (< ${formatMinutes(thresholdMinutes)})`,
    };
  }
}

export const minimumReleaseAgeExcludePruner: Pruner = new AgeBasedPruner({
  name: 'minimumReleaseAgeExclude',
  yamlKey: 'minimumReleaseAgeExclude',
  thresholdKey: 'minimumReleaseAge',
});

export const trustPolicyExcludePruner: Pruner = new AgeBasedPruner({
  name: 'trustPolicyExclude',
  yamlKey: 'trustPolicyExclude',
  thresholdKey: 'trustPolicyIgnoreAfter',
});
