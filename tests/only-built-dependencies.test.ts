import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { onlyBuiltDependenciesPruner } from '../src/pruners/only-built-dependencies.js';
import { loadPnpmWorkspace } from '../src/files/pnpm-workspace.js';
import { NpmRegistry, type VersionManifest } from '../src/registry/npm-registry.js';
import { consoleLogger } from '../src/util/logger.js';
import type { PrunerContext } from '../src/pruners/types.js';

class FakeRegistry extends NpmRegistry {
  constructor(private readonly scripts: Record<string, Record<string, string>>) {
    super('https://example.invalid');
  }
  override async manifest(name: string, version: string): Promise<VersionManifest> {
    return { name, version, scripts: this.scripts[name] };
  }
}

async function setupCtx(opts: {
  workspaceYaml: string;
  lockfile?: Map<string, Set<string>>;
  scripts?: Record<string, Record<string, string>>;
}): Promise<PrunerContext> {
  const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), opts.workspaceYaml);
  return {
    cwd: dir,
    packageManager: 'pnpm',
    registry: new FakeRegistry(opts.scripts ?? {}),
    workspace: await loadPnpmWorkspace(dir),
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
    now: new Date('2026-05-16T00:00:00Z'),
    logger: consoleLogger,
  };
}

describe('onlyBuiltDependencies pruner', () => {
  it('removes packages that are gone from the lockfile or no longer run install scripts', async () => {
    const ctx = await setupCtx({
      workspaceYaml: 'onlyBuiltDependencies:\n  - esbuild\n  - ghost-pkg\n  - plain-pkg\n',
      lockfile: new Map([
        ['esbuild', new Set(['0.25.0'])],
        ['plain-pkg', new Set(['1.0.0'])],
      ]),
      scripts: { esbuild: { postinstall: 'node install.js' } },
    });
    const report = await onlyBuiltDependenciesPruner.run(ctx);
    expect(report.removed.map((e) => e.key)).toEqual(['ghost-pkg', 'plain-pkg']);
    expect(report.skipped.map((e) => e.key)).toEqual(['esbuild']);
  });

  it('keeps every entry when there is no lockfile', async () => {
    const ctx = await setupCtx({
      workspaceYaml: 'onlyBuiltDependencies:\n  - esbuild\n  - ghost-pkg\n',
    });
    const report = await onlyBuiltDependenciesPruner.run(ctx);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toEqual([
      { key: 'esbuild', reason: 'no lockfile to check the resolved versions against' },
      { key: 'ghost-pkg', reason: 'no lockfile to check the resolved versions against' },
    ]);
  });
});
