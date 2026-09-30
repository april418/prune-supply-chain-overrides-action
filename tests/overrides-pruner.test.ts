import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from '../src/util/logger.js';
import { loadPnpmWorkspace } from '../src/files/pnpm-workspace.js';
import type { PrunerContext } from '../src/pruners/types.js';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('@actions/exec', () => ({
  exec: execMock,
}));

const { overridesPruner, findUnsatisfiedOverrides } = await import('../src/pruners/overrides.js');

/**
 * Stand-in for `pnpm install --lockfile-only`. Each package has the ranges the
 * dependency graph declares for it (`declared`) and the versions the registry
 * offers (`available`). As in pnpm, an override applies when its selector
 * intersects the declared range (not the resolved version) and resolves to the
 * highest available version satisfying the override's range; otherwise the
 * declared range resolves to its highest available version.
 */
type Graph = Record<string, { declared: string[]; available: string[] }>;

const DEFAULT_GRAPH: Graph = {
  // card-data-archives: external-editor pulls tmp@^0.0.33, others pull ^0.2.x.
  tmp: {
    declared: ['0.0.33', '0.2.3'],
    available: ['0.0.33', '0.2.3', '0.2.4', '0.2.7'],
  },
  // card-data-archives: monaco-editor@0.55.1 pulls dompurify 3.2.7.
  dompurify: {
    declared: ['3.2.7', '3.4.8'],
    available: ['3.2.7', '3.3.2', '3.4.8'],
  },
};

let graph: Graph = DEFAULT_GRAPH;

function resolve(overrides: Record<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, { declared, available }] of Object.entries(graph)) {
    const versions = new Set<string>();
    for (const spec of declared) {
      const rule = Object.entries(overrides).find(([key]) => {
        const at = key.lastIndexOf('@');
        if (at <= 0) return key === name;
        return key.slice(0, at) === name && semver.intersects(spec, key.slice(at + 1));
      });
      versions.add(semver.maxSatisfying(available, rule ? rule[1] : spec)!);
    }
    out.set(name, versions);
  }
  return out;
}

async function fakePnpmInstall(cwd: string): Promise<number> {
  const ws = parseYaml(await readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8')) as {
    overrides?: Record<string, string>;
  };
  const packages: Record<string, object> = {};
  for (const [name, versions] of resolve(ws.overrides ?? {})) {
    for (const v of versions) packages[`${name}@${v}`] = {};
  }
  const lock = {
    lockfileVersion: '9.0',
    overrides: ws.overrides ?? {},
    packages,
  };
  await writeFile(path.join(cwd, 'pnpm-lock.yaml'), JSON.stringify(lock), 'utf8');
  return 0;
}

// Same entries as card-data-archives' pnpm-workspace.yaml before PR #47.
const WORKSPACE = `packages:
  - 'apps/*'
overrides:
  dompurify@<3.3.2: '>=3.3.2'
  dompurify@<3.4.0: '>=3.4.0'
  dompurify@<=3.3.1: '>=3.3.2'
  dompurify@<=3.3.3: '>=3.4.0'
  dompurify@>=1.0.10 <3.4.0: '>=3.4.0'
  dompurify@>=3.0.1 <3.4.0: '>=3.4.0'
  dompurify@>=3.1.3 <=3.3.1: '>=3.3.2'
  tmp@<=0.2.3: '>=0.2.4'
  tmp@<0.2.6: '>=0.2.6'
`;

async function setup(workspace = WORKSPACE): Promise<PrunerContext> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'overrides-pruner-test-'));
  await writeFile(path.join(cwd, 'pnpm-workspace.yaml'), workspace, 'utf8');
  await fakePnpmInstall(cwd);
  return {
    cwd,
    packageManager: 'pnpm',
    registry: {} as PrunerContext['registry'],
    workspace: await loadPnpmWorkspace(cwd),
    packageJson: null,
    npmrc: null,
    lockfile: null,
    now: new Date(),
    logger: consoleLogger,
  };
}

describe('overridesPruner', () => {
  beforeEach(() => {
    graph = DEFAULT_GRAPH;
    execMock.mockReset();
    execMock.mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) =>
      fakePnpmInstall(opts.cwd),
    );
  });

  it('keeps enough overlapping rules that the vulnerable versions stay overridden', async () => {
    const ctx = await setup();

    const report = await overridesPruner.run(ctx);

    const remaining = (ctx.workspace!.document.toJSON() as { overrides?: Record<string, string> })
      .overrides;
    const resolved = resolve(remaining ?? {});
    expect([...resolved.get('tmp')!]).toEqual(['0.2.7']);
    expect([...resolved.get('dompurify')!]).toEqual(['3.4.8']);
    // Overlapping rules are still redundant, so some of them should go.
    expect(report.removed.length).toBeGreaterThan(0);
  });

  it('keeps a rule whose own range still holds when removing it undoes an earlier removal', async () => {
    // Removing the first rule is safe while the second one lifts 0.0.33 to
    // 0.2.7. The second rule's own range (>=0.0.1) accepts 0.0.33, so only the
    // re-check of the first removal can tell that it must stay.
    const ctx = await setup(`overrides:
  tmp@<=0.2.3: '>=0.2.4'
  tmp@<0.2.6: '>=0.0.1'
`);

    const report = await overridesPruner.run(ctx);

    expect(report.removed.map((e) => e.key)).toEqual(['tmp@<=0.2.3']);
    expect(report.skipped).toEqual([
      { key: 'tmp@<0.2.6', reason: expect.stringContaining('tmp@<=0.2.3') },
    ]);
  });

  describe('with one override per major series', () => {
    // card-data-archives pins each brace-expansion major separately.
    const SERIES = `overrides:
  brace-expansion@<1.1.13: '^1.1.13'
  brace-expansion@>=2.0.0 <2.1.4: '^2.1.4'
  brace-expansion@>=4.0.0 <5.0.9: '^5.0.9'
`;
    const available = ['1.1.11', '1.1.16', '2.0.1', '2.1.4', '5.0.5', '5.0.9'];

    it('removes every series whose natural resolution is already fixed', async () => {
      graph = { 'brace-expansion': { declared: ['1.1.16', '2.1.4', '5.0.9'], available } };
      const ctx = await setup(SERIES);

      const report = await overridesPruner.run(ctx);

      expect(report.removed.map((e) => e.key)).toEqual([
        'brace-expansion@<1.1.13',
        'brace-expansion@>=2.0.0 <2.1.4',
        'brace-expansion@>=4.0.0 <5.0.9',
      ]);
    });

    it('keeps only the series that would fall back into its selector', async () => {
      graph = { 'brace-expansion': { declared: ['1.1.11', '2.1.4', '5.0.9'], available } };
      const ctx = await setup(SERIES);

      const report = await overridesPruner.run(ctx);

      expect(report.skipped.map((e) => e.key)).toEqual(['brace-expansion@<1.1.13']);
      expect(report.skipped[0]!.reason).toContain('1.1.11');
    });

    it('keeps an override whose removal lets a declared range jump past its selector', async () => {
      // `>=1.0.0` intersects `<1.1.13`, so the override pins it to 1.1.16.
      // Without it the range resolves to 3.0.0, outside the selector but new.
      graph = {
        'brace-expansion': { declared: ['>=1.0.0'], available: ['1.1.11', '1.1.16', '3.0.0'] },
      };
      const ctx = await setup(`overrides:
  brace-expansion@<1.1.13: '^1.1.13'
`);

      const report = await overridesPruner.run(ctx);

      expect(report.removed).toEqual([]);
      expect(report.skipped[0]!.reason).toContain('3.0.0');
    });
  });
});

describe('findUnsatisfiedOverrides', () => {
  const lockfile = {
    filePath: 'pnpm-lock.yaml',
    lockfileVersion: '9.0',
    resolvedVersions: new Map([['tmp', new Set(['0.0.33', '0.2.7'])]]),
    recordedOverrides: {},
    raw: {},
  };
  const entry = (key: string, value: string) => ({
    field: 'overrides' as const,
    key,
    value,
    reason: '',
    file: 'pnpm-workspace.yaml',
  });

  it('reports a removed override whose target resolves outside its range', () => {
    expect(findUnsatisfiedOverrides(lockfile, [entry('tmp@<0.2.6', '>=0.2.6')])).toEqual([
      'tmp@<0.2.6 (tmp 0.0.33 does not satisfy ">=0.2.6")',
    ]);
  });

  it('accepts removals that still hold or whose target left the graph', () => {
    expect(
      findUnsatisfiedOverrides(lockfile, [
        entry('tmp@<0.0.1', '>=0.0.1'),
        entry('dompurify@>=1.0.10 <3.4.0', '>=3.4.0'),
      ]),
    ).toEqual([]);
  });

  it('ignores out-of-selector versions only when they were resolved before', () => {
    const removed = [entry('tmp@>=0.2.0 <0.2.6', '^0.2.6')];
    expect(findUnsatisfiedOverrides(lockfile, removed, lockfile)).toEqual([]);
    expect(findUnsatisfiedOverrides(lockfile, removed)).toEqual([
      'tmp@>=0.2.0 <0.2.6 (tmp 0.0.33 does not satisfy "^0.2.6")',
    ]);
  });
});
