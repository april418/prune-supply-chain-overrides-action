import semver from 'semver';
import { PrunerError, asError } from '../util/errors.js';

/** Subset of an npm packument we care about. */
export interface Packument {
  name: string;
  /** Map of version -> ISO date string when that version was published. */
  time: Record<string, string>;
  versions: Record<string, unknown>;
}

/** Subset of a single-version manifest we care about. */
export interface VersionManifest {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  hasInstallScript?: boolean;
}

export interface ReleaseAgeInfo {
  /** Latest published version in the registry. */
  latest: string;
  /** Latest version whose age >= minimumAgeMinutes. */
  latestStable: string | null;
  /** Publish time of `latestStable`, or null. */
  latestStablePublishedAt: Date | null;
}

export class NpmRegistry {
  private readonly packumentCache = new Map<string, Promise<Packument>>();
  private readonly manifestCache = new Map<string, Promise<VersionManifest>>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  packument(name: string): Promise<Packument> {
    const cached = this.packumentCache.get(name);
    if (cached) return cached;
    const url = `${this.baseUrl.replace(/\/$/, '')}/${encodePackageName(name)}`;
    // Use the full packument (not `application/vnd.npm.install-v1+json`) — the
    // abbreviated install-metadata format omits the `time` field that we need
    // to compute release age.
    const promise = this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new PrunerError(`npm registry returned ${res.status} for ${name} (${url})`);
        }
        return (await res.json()) as Packument;
      })
      .catch((err) => {
        throw new PrunerError(`Failed to fetch packument for ${name}: ${asError(err).message}`, err);
      });
    this.packumentCache.set(name, promise);
    return promise;
  }

  /** Fetch a single-version manifest. */
  manifest(name: string, version: string): Promise<VersionManifest> {
    const cacheKey = `${name}@${version}`;
    const cached = this.manifestCache.get(cacheKey);
    if (cached) return cached;
    const url = `${this.baseUrl.replace(/\/$/, '')}/${encodePackageName(name)}/${encodeURIComponent(version)}`;
    const promise = this.fetchImpl(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new PrunerError(`npm registry returned ${res.status} for ${cacheKey} (${url})`);
        }
        return (await res.json()) as VersionManifest;
      })
      .catch((err) => {
        throw new PrunerError(
          `Failed to fetch manifest for ${cacheKey}: ${asError(err).message}`,
          err,
        );
      });
    this.manifestCache.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolve the highest version in `range` whose publish age is at least
   * `minimumAgeMinutes`. Returns null when no published version qualifies.
   */
  async resolveStableVersion(
    name: string,
    range: string,
    now: Date,
    minimumAgeMinutes: number,
  ): Promise<{ version: string; publishedAt: Date } | null> {
    const packument = await this.packument(name);
    const cutoff = now.getTime() - minimumAgeMinutes * 60_000;
    const candidates = Object.keys(packument.versions)
      .filter((v) => semver.valid(v) && !semver.prerelease(v))
      .filter((v) => (range === '*' || range === '' ? true : semver.satisfies(v, range)))
      .sort(semver.rcompare);
    for (const version of candidates) {
      const publishedAtIso = packument.time[version];
      if (!publishedAtIso) continue;
      const publishedAt = new Date(publishedAtIso);
      if (publishedAt.getTime() <= cutoff) {
        return { version, publishedAt };
      }
    }
    return null;
  }

  /**
   * Look up publish time for a specific version. Returns null if unknown.
   */
  async publishTime(name: string, version: string): Promise<Date | null> {
    const packument = await this.packument(name);
    const iso = packument.time[version];
    return iso ? new Date(iso) : null;
  }
}

function encodePackageName(name: string): string {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash === -1) return encodeURIComponent(name);
    return `${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
  }
  return encodeURIComponent(name);
}
