import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNpmLockfile } from '../src/lockfile/npm-lockfile.js';

describe('loadNpmLockfile', () => {
  it('returns null when package-lock.json is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'npm-lock-test-'));
    expect(await loadNpmLockfile(dir)).toBeNull();
  });

  it('collects every installed version, including nested and scoped ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'npm-lock-test-'));
    await writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', version: '1.0.0' },
          'node_modules/is-number': { version: '7.0.0' },
          'node_modules/is-odd/node_modules/is-number': { version: '6.0.0' },
          'node_modules/@scope/pkg': { version: '2.0.0' },
          'packages/a': { name: 'a', version: '0.0.0' },
          'node_modules/a': { resolved: 'packages/a', link: true },
        },
      }),
    );

    const lockfile = await loadNpmLockfile(dir);

    expect([...lockfile!.resolvedVersions.get('is-number')!].sort()).toEqual(['6.0.0', '7.0.0']);
    expect([...lockfile!.resolvedVersions.get('@scope/pkg')!]).toEqual(['2.0.0']);
    expect(lockfile!.resolvedVersions.has('a')).toBe(false);
    expect(lockfile!.filePaths).toEqual([path.join(dir, 'package-lock.json')]);
  });
});

describe('npm lockfile variants', () => {
  it('prefers npm-shrinkwrap.json over package-lock.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'npm-lock-test-'));
    const lock = (version: string) =>
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version } } });
    await writeFile(path.join(dir, 'package-lock.json'), lock('1.0.0'));
    await writeFile(path.join(dir, 'npm-shrinkwrap.json'), lock('2.0.0'));

    const lockfile = await loadNpmLockfile(dir);

    expect(lockfile!.filePath).toBe(path.join(dir, 'npm-shrinkwrap.json'));
    expect([...lockfile!.resolvedVersions.get('x')!]).toEqual(['2.0.0']);
  });

  it('rejects lockfileVersion 1', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'npm-lock-test-'));
    await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1 }));

    await expect(loadNpmLockfile(dir)).rejects.toThrow(/lockfileVersion 1/);
  });
});
