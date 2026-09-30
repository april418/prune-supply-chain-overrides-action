import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from '../src/util/logger.js';
import type { PrunerReport } from '../src/types.js';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('@actions/exec', () => ({
  exec: execMock,
}));

const { regenerateAndVerify, withFilesRestored } = await import('../src/lockfile/verify.js');

const reports: PrunerReport[] = [
  {
    pruner: 'overrides',
    removed: [
      {
        field: 'overrides',
        key: 'tmp@<0.2.6',
        value: '>=0.2.6',
        reason: '',
        file: 'pnpm-workspace.yaml',
      },
    ],
    skipped: [],
  },
];

async function projectWithLockfile(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'verify-test-'));
  await writeFile(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  return cwd;
}

/** Make the mocked `pnpm install` write a lockfile resolving tmp to `versions`. */
function resolveTmpTo(...versions: string[]): void {
  execMock.mockImplementation(async (_cmd: string, _args: string[], opts: { cwd: string }) => {
    const packages = Object.fromEntries(versions.map((v) => [`tmp@${v}`, {}]));
    const lock = { lockfileVersion: '9.0', packages };
    await writeFile(path.join(opts.cwd, 'pnpm-lock.yaml'), JSON.stringify(lock));
    return 0;
  });
}

describe('regenerateAndVerify', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('returns the lockfile path when every removed override still holds', async () => {
    const cwd = await projectWithLockfile();
    resolveTmpTo('0.2.7');

    await expect(regenerateAndVerify(cwd, 'pnpm', reports, null, consoleLogger)).resolves.toEqual([
      path.join(cwd, 'pnpm-lock.yaml'),
    ]);
  });

  it('throws when the regenerated lockfile brings back a removed override target', async () => {
    const cwd = await projectWithLockfile();
    resolveTmpTo('0.0.33', '0.2.7');

    await expect(regenerateAndVerify(cwd, 'pnpm', reports, null, consoleLogger)).rejects.toThrow(
      /no longer satisfies removed overrides: tmp@<0\.2\.6 \(tmp 0\.0\.33/,
    );
  });

  it('returns null without running pnpm when there is no lockfile', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'verify-test-'));

    await expect(regenerateAndVerify(cwd, 'pnpm', reports, null, consoleLogger)).resolves.toEqual(
      [],
    );
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('withFilesRestored', () => {
  it('restores the files after the callback succeeds', async () => {
    const cwd = await projectWithLockfile();
    const file = path.join(cwd, 'pnpm-lock.yaml');

    const result = await withFilesRestored([file], async () => {
      await writeFile(file, 'changed');
      return 'done';
    });

    expect(result).toBe('done');
    expect(await readFile(file, 'utf8')).toBe("lockfileVersion: '9.0'\n");
  });

  it('restores the files and rethrows when the callback throws', async () => {
    const cwd = await projectWithLockfile();
    const file = path.join(cwd, 'pnpm-lock.yaml');

    await expect(
      withFilesRestored([file], async () => {
        await writeFile(file, 'changed');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await readFile(file, 'utf8')).toBe("lockfileVersion: '9.0'\n");
  });
});
