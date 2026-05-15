import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPnpmLockfile } from '../src/lockfile/pnpm-lockfile.js';

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
