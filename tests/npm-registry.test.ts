import { describe, expect, it } from 'vitest';
import { NpmRegistry, assertRegistryReachable } from '../src/registry/npm-registry.js';
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
