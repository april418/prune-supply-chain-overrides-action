import { describe, expect, it } from 'vitest';
import {
  NpmRegistry,
  OtherRegistryError,
  assertRegistryReachable,
} from '../src/registry/npm-registry.js';
import { consoleLogger } from '../src/util/logger.js';

/** A fetch stand-in that answers only for package names in `ok`. */
function fakeFetch(ok: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const name = decodeURIComponent(url.split('/').pop()!);
    if (!ok.includes(name)) return new Response('not json', { status: 200 });
    return Response.json({ name, time: { '1.0.0': '2026-01-01T00:00:00Z' }, versions: {} });
  }) as typeof fetch;
}

describe('NpmRegistry request stats', () => {
  it('counts each distinct request once, whether it succeeded or failed', async () => {
    const registry = new NpmRegistry('https://registry.example', fakeFetch(['good']));

    await registry.publishTime('good', '1.0.0');
    await registry.publishTime('good', '1.0.0');
    await expect(registry.publishTime('bad', '1.0.0')).rejects.toThrow(/bad/);

    const stats = registry.stats();
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]).toMatch(/Failed to fetch packument for bad/);
  });
});

describe('NpmRegistry scope routes', () => {
  /** Answers every request with an empty packument and records the URLs. */
  function recordingFetch(urls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ name: 'pkg', time: {}, versions: {} });
    }) as typeof fetch;
  }

  it('does not request packages whose scope is installed from another registry', async () => {
    const urls: string[] = [];
    const registry = new NpmRegistry(
      'https://registry.example',
      recordingFetch(urls),
      new Map([['@octo-org', { url: 'https://npm.octo-org.example/', source: 'set in .npmrc' }]]),
    );

    const message =
      '@octo-org packages are installed from https://npm.octo-org.example/ (set in .npmrc), ' +
      'so @octo-org/lib is not looked up in https://registry.example';
    for (const request of [
      () => registry.publishTime('@octo-org/lib', '1.0.0'),
      () => registry.manifest('@octo-org/lib', '1.0.0'),
    ]) {
      await expect(request()).rejects.toBeInstanceOf(OtherRegistryError);
      await expect(request()).rejects.toThrow(message);
    }
    await registry.publishTime('@octo-org-public/lib', '1.0.0');
    await registry.publishTime('octo-org', '1.0.0');

    expect(urls).toEqual([
      'https://registry.example/%40octo-org-public/lib',
      'https://registry.example/octo-org',
    ]);
    expect(registry.stats()).toEqual({ succeeded: 2, failed: [] });
  });

  it('requests a scope routed to the queried registry however its URL is spelled', async () => {
    const urls: string[] = [];
    const registry = new NpmRegistry(
      'https://registry.example',
      recordingFetch(urls),
      new Map([
        [
          '@octo-org',
          { url: 'https://REGISTRY.example:443/', source: 'set in pnpm-workspace.yaml' },
        ],
      ]),
    );

    await registry.publishTime('@octo-org/lib', '1.0.0');

    expect(urls).toEqual(['https://registry.example/%40octo-org/lib']);
  });

  it('leaves credentials in the route URL out of the rejection', async () => {
    const registry = new NpmRegistry(
      'https://registry.example',
      recordingFetch([]),
      new Map([
        [
          '@octo-org',
          { url: 'https://bot:s3cret@npm.octo-org.example/npm/', source: 'set in .npmrc' },
        ],
      ]),
    );

    const rejection = registry.publishTime('@octo-org/lib', '1.0.0');

    await expect(rejection).rejects.toThrow('installed from https://npm.octo-org.example/npm/ (');
    await expect(rejection).rejects.not.toThrow('s3cret');
  });
});

describe('NpmRegistry.publishTime', () => {
  it('returns null for a publish time that is not a date', async () => {
    const fetchImpl = (async () =>
      Response.json({
        name: 'pkg',
        time: { '1.0.0': 'garbage', '1.0.1': '2026-01-01T00:00:00Z' },
        versions: {},
      })) as typeof fetch;
    const registry = new NpmRegistry('https://registry.example', fetchImpl);

    expect(await registry.publishTime('pkg', '1.0.0')).toBeNull();
    expect(await registry.publishTime('pkg', '1.0.1')).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(await registry.publishTime('pkg', '2.0.0')).toBeNull();
  });
});

describe('assertRegistryReachable', () => {
  it('passes when nothing was requested', () => {
    expect(() =>
      assertRegistryReachable({ succeeded: 0, failed: [] }, consoleLogger),
    ).not.toThrow();
  });

  it('warns but passes when only some requests failed', () => {
    const warnings: string[] = [];
    const logger = { ...consoleLogger, warn: (m: string) => warnings.push(m) };

    assertRegistryReachable({ succeeded: 3, failed: ['a failed'] }, logger);

    expect(warnings).toEqual([expect.stringContaining('1 npm registry request(s) failed')]);
  });

  it('throws when every request failed', () => {
    expect(() =>
      assertRegistryReachable({ succeeded: 0, failed: ['a failed', 'b failed'] }, consoleLogger),
    ).toThrow(/All 2 npm registry request\(s\) failed.*a failed/);
  });
});
