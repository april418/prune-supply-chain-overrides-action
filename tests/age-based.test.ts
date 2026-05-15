import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { minimumReleaseAgeExcludePruner } from '../src/pruners/age-based.js';
import { loadPnpmWorkspace } from '../src/files/pnpm-workspace.js';
import { NpmRegistry } from '../src/registry/npm-registry.js';
import { consoleLogger } from '../src/util/logger.js';
import type { PrunerContext } from '../src/pruners/types.js';

class FakeRegistry extends NpmRegistry {
  constructor(private readonly times: Record<string, Record<string, string>>) {
    super('https://example.invalid');
  }
  override async publishTime(name: string, version: string): Promise<Date | null> {
    const iso = this.times[name]?.[version];
    return iso ? new Date(iso) : null;
  }
}

async function setupCtx(opts: {
  workspaceYaml: string;
  lockfile?: Map<string, Set<string>>;
  times: Record<string, Record<string, string>>;
  now: Date;
}): Promise<PrunerContext> {
  const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), opts.workspaceYaml);
  const workspace = await loadPnpmWorkspace(dir);
  return {
    cwd: dir,
    packageManager: 'pnpm',
    registry: new FakeRegistry(opts.times),
    workspace,
    packageJson: null,
    npmrc: null,
    lockfile: opts.lockfile
      ? {
          filePath: path.join(dir, 'pnpm-lock.yaml'),
          lockfileVersion: '9.0',
          resolvedVersions: opts.lockfile,
          recordedOverrides: {},
          raw: {},
        }
      : null,
    now: opts.now,
    logger: consoleLogger,
  };
}

describe('minimumReleaseAgeExclude pruner', () => {
  it('removes entry when resolved version is older than threshold', async () => {
    const now = new Date('2026-05-16T00:00:00Z');
    const ctx = await setupCtx({
      workspaceYaml:
        'minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - fast-uri\n  - next\n',
      lockfile: new Map([
        ['fast-uri', new Set(['3.1.2'])],
        ['next', new Set(['16.2.6'])],
      ]),
      times: {
        'fast-uri': { '3.1.2': '2026-04-01T00:00:00Z' },
        next: { '16.2.6': '2026-05-15T00:00:00Z' },
      },
      now,
    });

    const report = await minimumReleaseAgeExcludePruner.run(ctx);

    expect(report.removed.map((e) => e.key)).toEqual(['fast-uri']);
    expect(report.skipped.map((e) => e.key)).toEqual(['next']);
  });

  it('removes entry when package is no longer in lockfile', async () => {
    const ctx = await setupCtx({
      workspaceYaml: 'minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - ghost-pkg\n',
      lockfile: new Map(),
      times: {},
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed.map((e) => e.key)).toEqual(['ghost-pkg']);
  });

  it('skips entry when threshold is not configured', async () => {
    const ctx = await setupCtx({
      workspaceYaml: 'minimumReleaseAgeExclude:\n  - fast-uri\n',
      lockfile: new Map([['fast-uri', new Set(['3.1.2'])]]),
      times: { 'fast-uri': { '3.1.2': '2020-01-01T00:00:00Z' } },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
  });

  it('takes the newest publish time when multiple versions are resolved', async () => {
    const ctx = await setupCtx({
      workspaceYaml: 'minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - fast-uri\n',
      lockfile: new Map([['fast-uri', new Set(['3.1.2', '3.1.3'])]]),
      times: {
        'fast-uri': {
          '3.1.2': '2026-04-01T00:00:00Z',
          '3.1.3': '2026-05-15T00:00:00Z',
        },
      },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
  });
});
