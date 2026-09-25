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
 * Stand-in for `pnpm install --lockfile-only`. Each package has the versions
 * the dependency graph asks for without any override (`natural`) and the
 * versions the registry offers (`available`). An override whose selector
 * matches a natural version replaces it with the highest available version
 * satisfying the override's range, as pnpm does.
 */
const GRAPH: Record<string, { natural: string[]; available: string[] }> = {
  // card-data-archives: external-editor pulls tmp@^0.0.33, others pull ^0.2.x.
  tmp: {
    natural: ['0.0.33', '0.2.3'],
    available: ['0.0.33', '0.2.3', '0.2.4', '0.2.7'],
  },
  // card-data-archives: monaco-editor@0.55.1 pulls dompurify 3.2.7.
  dompurify: {
    natural: ['3.2.7', '3.4.8'],
    available: ['3.2.7', '3.3.2', '3.4.8'],
  },
};

function resolve(overrides: Record<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, { natural, available }] of Object.entries(GRAPH)) {
    const versions = new Set<string>();
    for (const v of natural) {
      const rule = Object.entries(overrides).find(([key]) => {
        const at = key.lastIndexOf('@');
        if (at <= 0) return key === name;
        return key.slice(0, at) === name && semver.satisfies(v, key.slice(at + 1));
      });
      versions.add(rule ? (semver.maxSatisfying(available, rule[1]) ?? v) : v);
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

async function setup(): Promise<PrunerContext> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'overrides-pruner-test-'));
  await writeFile(path.join(cwd, 'pnpm-workspace.yaml'), WORKSPACE, 'utf8');
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
});
