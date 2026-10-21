import semver from 'semver';
import { PrunerError, asError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { ScopeRegistry } from './scope-registries.js';

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

/** Outcome of the distinct requests a registry made (cached repeats count once). */
export interface RegistryStats {
  succeeded: number;
  /** Error message of each failed request. */
  failed: string[];
}

/**
 * Rejection for a package whose scope the project installs from a registry
 * other than the one queried. No request is made, so it is not counted in
 * {@link NpmRegistry.stats}.
 */
export class OtherRegistryError extends PrunerError {
  constructor(message: string) {
    super(message);
    this.name = 'OtherRegistryError';
  }
}

export class NpmRegistry {
  private readonly packumentCache = new Map<string, Promise<Packument>>();
  private readonly manifestCache = new Map<string, Promise<VersionManifest>>();
  private readonly otherRegistries = new Map<string, ScopeRegistry>();
  private succeeded = 0;
  private readonly failed: string[] = [];

  /**
   * Packages under a scope in `scopeRegistries` that routes to another
   * registry are rejected with {@link OtherRegistryError} instead of fetched.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    scopeRegistries: ReadonlyMap<string, ScopeRegistry> = new Map(),
  ) {
    for (const [scope, route] of scopeRegistries) {
      if (normalizeRegistryUrl(route.url) !== normalizeRegistryUrl(baseUrl)) {
        this.otherRegistries.set(scope, route);
      }
    }
  }

  packument(name: string): Promise<Packument> {
    const elsewhere = this.otherRegistryError(name);
    if (elsewhere) return Promise.reject(elsewhere);
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
        throw new PrunerError(
          `Failed to fetch packument for ${name}: ${asError(err).message}`,
          err,
        );
      });
    this.track(promise);
    this.packumentCache.set(name, promise);
    return promise;
  }

  /** Fetch a single-version manifest. */
  manifest(name: string, version: string): Promise<VersionManifest> {
    const elsewhere = this.otherRegistryError(name);
    if (elsewhere) return Promise.reject(elsewhere);
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
    this.track(promise);
    this.manifestCache.set(cacheKey, promise);
    return promise;
  }

  stats(): RegistryStats {
    return { succeeded: this.succeeded, failed: [...this.failed] };
  }

  private otherRegistryError(name: string): OtherRegistryError | null {
    const slash = name.indexOf('/');
    if (!name.startsWith('@') || slash === -1) return null;
    const scope = name.slice(0, slash);
    const route = this.otherRegistries.get(scope);
    if (!route) return null;
    return new OtherRegistryError(
      `${scope} packages are installed from ${withoutUserinfo(route.url)} (${route.source}), ` +
        `so ${name} is not looked up in ${this.baseUrl}`,
    );
  }

  private track(request: Promise<unknown>): void {
    request.then(
      () => {
        this.succeeded += 1;
      },
      (err) => {
        this.failed.push(asError(err).message);
      },
    );
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
   * Look up publish time for a specific version. Returns null if unknown or
   * not a parseable date.
   */
  async publishTime(name: string, version: string): Promise<Date | null> {
    const packument = await this.packument(name);
    const iso = packument.time[version];
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}

/**
 * Pruners keep an entry whose registry lookup failed, so a registry that is
 * unreachable (or a fetch that silently breaks) would otherwise look like
 * "nothing to prune". Warns on partial failure and throws when every request
 * failed.
 */
export function assertRegistryReachable(stats: RegistryStats, logger: Logger): void {
  const { succeeded, failed } = stats;
  if (failed.length === 0) return;
  if (succeeded === 0) {
    throw new Error(
      `All ${failed.length} npm registry request(s) failed, so no entry could be verified. ` +
        `First error: ${failed[0]}`,
    );
  }
  logger.warn(
    `${failed.length} npm registry request(s) failed; the affected entries were kept. ` +
      `First error: ${failed[0]}`,
  );
}

/** Origin and path without trailing slashes, so that spellings of one registry compare equal. */
function normalizeRegistryUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/** Skip reasons go into the PR body, where credentials in a registry URL must not appear. */
function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return url;
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
