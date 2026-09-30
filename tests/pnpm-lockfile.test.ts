import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPnpmLockfiles, loadPnpmLockfile } from '../src/lockfile/pnpm-lockfile.js';

async function withLockfile(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
  await writeFile(path.join(dir, 'pnpm-lock.yaml'), content);
  return dir;
}

describe('loadPnpmLockfile', () => {
  it('returns null when missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
    expect(await loadPnpmLockfile(dir)).toBeNull();
  });

  it('parses resolved versions from packages and snapshots', async () => {
    const dir = await withLockfile(
      [
        "lockfileVersion: '9.0'",
        'packages:',
        "  fast-uri@3.1.2:",
        '    resolution: { integrity: sha512-x }',
        "  '@next/env@16.2.6':",
        '    resolution: { integrity: sha512-x }',
        'snapshots:',
        "  fast-uri@3.1.2:",
        '    dev: false',
      ].join('\n'),
    );
    const lock = await loadPnpmLockfile(dir);
    expect(lock).not.toBeNull();
    expect([...(lock!.resolvedVersions.get('fast-uri') ?? [])]).toEqual(['3.1.2']);
    expect([...(lock!.resolvedVersions.get('@next/env') ?? [])]).toEqual(['16.2.6']);
  });

  it('strips peer suffix from resolved versions', async () => {
    const dir = await withLockfile(
      [
        "lockfileVersion: '9.0'",
        'packages:',
        "  react@19.2.5(@types/react@19.2.14):",
        '    resolution: { integrity: sha512-x }',
      ].join('\n'),
    );
    const lock = await loadPnpmLockfile(dir);
    expect([...(lock!.resolvedVersions.get('react') ?? [])]).toEqual(['19.2.5']);
  });

  it('extracts root-level overrides', async () => {
    const dir = await withLockfile(
      [
        "lockfileVersion: '9.0'",
        'overrides:',
        "  fast-uri: '>=3.1.2'",
        'packages: {}',
      ].join('\n'),
    );
    const lock = await loadPnpmLockfile(dir);
    expect(lock!.recordedOverrides).toEqual({ 'fast-uri': '>=3.1.2' });
  });
});

describe('per-project lockfiles (sharedWorkspaceLockfile: false)', () => {
  async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), content);
    }
    return dir;
  }
  const lock = (id: string) => `lockfileVersion: '9.0'\npackages:\n  ${id}:\n    resolution: {}\n`;

  it('uses only the root lockfile when lockfiles are shared', async () => {
    const dir = await project({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'pnpm-lock.yaml': lock('a@1.0.0'),
      'packages/x/pnpm-lock.yaml': lock('b@1.0.0'),
    });
    expect(await findPnpmLockfiles(dir)).toEqual([path.join(dir, 'pnpm-lock.yaml')]);
  });

  it('finds every project lockfile and skips node_modules', async () => {
    const dir = await project({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\nsharedWorkspaceLockfile: false\n",
      'packages/x/pnpm-lock.yaml': lock('a@1.0.0'),
      'packages/y/pnpm-lock.yaml': lock('a@2.0.0'),
      'packages/y/node_modules/z/pnpm-lock.yaml': lock('c@1.0.0'),
    });

    expect(await findPnpmLockfiles(dir)).toEqual([
      path.join(dir, 'packages/x/pnpm-lock.yaml'),
      path.join(dir, 'packages/y/pnpm-lock.yaml'),
    ]);
    const merged = await loadPnpmLockfile(dir);
    expect([...merged!.resolvedVersions.get('a')!].sort()).toEqual(['1.0.0', '2.0.0']);
    expect(merged!.resolvedVersions.has('c')).toBe(false);
    expect(merged!.filePaths).toHaveLength(2);
  });

  it('reads the setting from .npmrc too', async () => {
    const dir = await project({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      '.npmrc': 'shared-workspace-lockfile=false\n',
      'packages/x/pnpm-lock.yaml': lock('a@1.0.0'),
    });
    expect(await findPnpmLockfiles(dir)).toEqual([path.join(dir, 'packages/x/pnpm-lock.yaml')]);
  });
});
