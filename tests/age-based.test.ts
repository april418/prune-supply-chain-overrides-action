import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { minimumReleaseAgeExcludePruner, trustPolicyExcludePruner } from '../src/pruners/age-based.js';
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
          filePaths: [path.join(dir, 'pnpm-lock.yaml')],
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

  it('keeps every entry when there is no lockfile', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - ghost-pkg\n  - '@next/*'\n",
      times: {},
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toEqual([
      { key: 'ghost-pkg', reason: 'no lockfile to check the resolved versions against' },
      { key: '@next/*', reason: 'no lockfile to check the resolved versions against' },
    ]);
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

  it('keeps a name pattern while any package it matches is younger than the threshold', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '@next/*'\n",
      lockfile: new Map([
        ['@next/env', new Set(['16.4.1'])],
        ['@next/swc-linux-x64-gnu', new Set(['16.4.1'])],
        ['next', new Set(['16.4.1'])],
      ]),
      times: {
        '@next/env': { '16.4.1': '2026-04-01T00:00:00Z' },
        '@next/swc-linux-x64-gnu': { '16.4.1': '2026-05-15T00:00:00Z' },
      },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toEqual([
      { key: '@next/*', reason: 'newest resolved version @next/swc-linux-x64-gnu@16.4.1 is only 1d old (< 7d)' },
    ]);
  });

  it('removes a name pattern once every package it matches is past the threshold', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '@next/*'\n",
      lockfile: new Map([['@next/env', new Set(['16.4.1'])]]),
      times: { '@next/env': { '16.4.1': '2026-04-01T00:00:00Z' } },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed.map((e) => e.key)).toEqual(['@next/*']);
  });

  it('keeps a name pattern when the publish time of any matched package is unknown', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '@next/*'\n",
      lockfile: new Map([
        ['@next/env', new Set(['16.4.1'])],
        ['@next/third-parties', new Set(['16.4.1'])],
      ]),
      times: { '@next/env': { '16.4.1': '2026-04-01T00:00:00Z' } },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped.map((e) => e.key)).toEqual(['@next/*']);
  });

  it('ignores workspace links and other non-registry versions', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '@myorg/*'\n",
      lockfile: new Map([
        ['@myorg/ui', new Set(['link:packages/ui'])],
        ['@myorg/utils', new Set(['1.0.0'])],
      ]),
      times: { '@myorg/utils': { '1.0.0': '2026-04-01T00:00:00Z' } },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed.map((e) => e.key)).toEqual(['@myorg/*']);
  });

  it('removes a name pattern that matches nothing in the lockfile', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '@next/*'\n",
      lockfile: new Map([['next', new Set(['16.4.1'])]]),
      times: {},
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toEqual([
      expect.objectContaining({
        key: '@next/*',
        reason: 'no package matching the pattern is referenced from pnpm-lock.yaml',
      }),
    ]);
  });

  it('judges a versioned entry by the listed versions only', async () => {
    const yaml = "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - 'webpack@4.47.0 || 5.102.1'\n";
    const times = {
      webpack: {
        '4.47.0': '2026-01-01T00:00:00Z',
        '5.102.1': '2026-05-15T00:00:00Z',
        '5.103.0': '2026-05-15T12:00:00Z',
      },
    };
    const now = new Date('2026-05-16T00:00:00Z');

    const young = await setupCtx({
      workspaceYaml: yaml,
      lockfile: new Map([['webpack', new Set(['5.102.1'])]]),
      times,
      now,
    });
    expect((await minimumReleaseAgeExcludePruner.run(young)).removed).toHaveLength(0);

    const old = await setupCtx({
      workspaceYaml: yaml,
      lockfile: new Map([['webpack', new Set(['4.47.0', '5.103.0'])]]),
      times,
      now,
    });
    expect((await minimumReleaseAgeExcludePruner.run(old)).removed.map((e) => e.key)).toEqual([
      'webpack@4.47.0 || 5.102.1',
    ]);

    const gone = await setupCtx({
      workspaceYaml: yaml,
      lockfile: new Map([['webpack', new Set(['5.103.0'])]]),
      times,
      now,
    });
    expect((await minimumReleaseAgeExcludePruner.run(gone)).removed).toEqual([
      expect.objectContaining({ reason: 'none of the listed versions is resolved in pnpm-lock.yaml' }),
    ]);
  });

  it('keeps entries it cannot judge', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '!next'\n  - 'webpack@^5.0.0'\n",
      lockfile: new Map(),
      times: {},
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await minimumReleaseAgeExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped.map((e) => e.key)).toEqual(['!next', 'webpack@^5.0.0']);
  });
});

describe('trustPolicyExclude pruner', () => {
  it('reads name patterns the same way', async () => {
    const ctx = await setupCtx({
      workspaceYaml: "trustPolicyIgnoreAfter: 10080\ntrustPolicyExclude:\n  - '@next/*'\n",
      lockfile: new Map([['@next/env', new Set(['16.4.1'])]]),
      times: { '@next/env': { '16.4.1': '2026-05-15T00:00:00Z' } },
      now: new Date('2026-05-16T00:00:00Z'),
    });
    const report = await trustPolicyExcludePruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped.map((e) => e.key)).toEqual(['@next/*']);
  });
});
