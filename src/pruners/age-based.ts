import semver from 'semver';
import type { Pruner, PrunerContext } from './types.js';
import type { PrunedEntry, PrunerName, PrunerReport } from '../types.js';
import {
  readSequenceKeys,
  removeFromSequence,
  isCollectionEmpty,
  removeKey,
} from '../files/pnpm-workspace.js';
import { formatMinutes } from '../util/format.js';
import { findFirst } from '../util/concurrency.js';
import { parseExcludeEntry } from './exclude-entry.js';

// A pattern such as `*` can match every package in the lockfile; unbounded,
// that is one simultaneous registry request per package.
const REGISTRY_CONCURRENCY = 8;

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
    entry: string,
    thresholdMinutes: number,
    ctx: PrunerContext,
  ): Promise<{ action: 'remove'; reason: string } | { action: 'skip'; reason: string }> {
    const parsed = parseExcludeEntry(entry);
    if (!parsed) {
      return {
        action: 'skip',
        reason: 'not a package name, name pattern, or name@exact-versions entry that can be checked',
      };
    }
    if (!ctx.lockfile) {
      return { action: 'skip', reason: 'no lockfile to check the resolved versions against' };
    }

    // Keyed by name because one packument answers for every version of it.
    const resolved = new Map<string, string[]>();
    for (const [name, versions] of ctx.lockfile.resolvedVersions) {
      if (!parsed.matches(name)) continue;
      const matched = [...versions].filter(
        // pnpm checks only registry versions against the policy; `link:` and
        // alias entries have no publish time and would never let the entry go.
        (version) =>
          semver.valid(version) !== null &&
          (parsed.versions.length === 0 || parsed.versions.includes(version)),
      );
      if (matched.length > 0) resolved.set(name, matched);
    }
    if (resolved.size === 0) {
      let reason = 'package is no longer referenced from pnpm-lock.yaml';
      if (parsed.isPattern) reason = 'no package matching the pattern is referenced from pnpm-lock.yaml';
      if (parsed.versions.length > 0) reason = 'none of the listed versions is resolved in pnpm-lock.yaml';
      return { action: 'remove', reason };
    }

    // One version that is too young (or cannot be dated) keeps the entry, so
    // the lookups stop there instead of covering every package a pattern matches.
    const checked: Array<{ label: string; publishedAt: Date }> = [];
    const keepReason = await findFirst(resolved, REGISTRY_CONCURRENCY, async ([name, versions]) => {
      for (const version of versions) {
        let publishedAt: Date | null;
        try {
          publishedAt = await ctx.registry.publishTime(name, version);
        } catch (err) {
          return `failed to fetch publish time for ${name}@${version}: ${(err as Error).message}`;
        }
        if (!publishedAt) return `npm registry has no publish time for ${name}@${version}`;
        const label = parsed.isPattern ? `${name}@${version}` : version;
        const ageMin = (ctx.now.getTime() - publishedAt.getTime()) / 60_000;
        if (ageMin < thresholdMinutes) {
          return `resolved version ${label} is only ${formatMinutes(ageMin)} old (< ${formatMinutes(thresholdMinutes)})`;
        }
        checked.push({ label, publishedAt });
      }
      return undefined;
    });
    if (keepReason !== undefined) return { action: 'skip', reason: keepReason };

    const newest = checked.reduce((a, b) => (b.publishedAt > a.publishedAt ? b : a));
    const ageMin = (ctx.now.getTime() - newest.publishedAt.getTime()) / 60_000;
    return {
      action: 'remove',
      reason: `newest resolved version ${newest.label} was published ${formatMinutes(ageMin)} ago (>= ${this.config.thresholdKey} ${formatMinutes(thresholdMinutes)})`,
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
