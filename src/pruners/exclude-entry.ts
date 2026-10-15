import semver from 'semver';

/**
 * A `minimumReleaseAgeExclude` / `trustPolicyExclude` entry, read the way pnpm
 * reads it (`createPackageVersionPolicy` in @pnpm/config.version-policy).
 */
export interface ExcludeEntry {
  /** Whether the entry covers this package name. */
  matches(name: string): boolean;
  /** The exact versions the entry exempts; empty when it exempts every version. */
  versions: string[];
  /** True when the name part contains a `*` wildcard. */
  isPattern: boolean;
}

/**
 * Parses `name`, a name with `*` wildcards (`@scope/*`), or
 * `name@1.2.3 || 1.2.4`. Returns null for what pnpm rejects (a wildcard
 * combined with versions, a non-exact version) and for `!name`, which pnpm
 * treats as "every package except name" and cannot be judged by age.
 */
export function parseExcludeEntry(entry: string): ExcludeEntry | null {
  if (entry.startsWith('!')) return null;
  const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@');
  if (at === -1) {
    return { matches: nameMatcher(entry), versions: [], isPattern: entry.includes('*') };
  }
  const name = entry.slice(0, at);
  if (name.includes('*')) return null;
  const versions: string[] = [];
  for (const raw of entry.slice(at + 1).split('||')) {
    const version = semver.valid(raw);
    if (version === null) return null;
    versions.push(version);
  }
  return { matches: nameMatcher(name), versions, isPattern: false };
}

function nameMatcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes('*')) return (name) => name === pattern;
  const regexp = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return (name) => regexp.test(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
