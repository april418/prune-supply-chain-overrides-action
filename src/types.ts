export type PackageManager = 'pnpm' | 'npm';

export type PrunerName =
  | 'minimumReleaseAgeExclude'
  | 'overrides'
  | 'trustPolicyExclude'
  | 'onlyBuiltDependencies';

export interface PrunedEntry {
  /** Field that the entry was removed from (e.g. "minimumReleaseAgeExclude", "overrides"). */
  field: PrunerName;
  /** Package name or override key that was removed. */
  key: string;
  /** Original value (for overrides this is the version range string). */
  value?: string;
  /** Human-readable explanation of why this entry is no longer needed. */
  reason: string;
  /** File that the entry was removed from. */
  file: string;
}

export interface PrunerReport {
  pruner: PrunerName;
  removed: PrunedEntry[];
  /** Entries that could not be safely pruned, with reasons. Useful in dry-run output. */
  skipped: Array<{ key: string; reason: string }>;
}

export interface ActionInputs {
  workingDirectory: string;
  targets: PrunerName[];
  packageManager: PackageManager | 'auto';
  registry: string;
  dryRun: boolean;
  createPr: boolean;
  prBranch: string;
  prTitle: string;
  prBase: string;
  prLabels: string[];
  commitMessage: string;
  githubToken: string;
}
