import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { consoleLogger } from '../src/util/logger.js';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('@actions/exec', () => ({
  exec: execMock,
}));

// Import AFTER vi.mock so the module uses the mocked exec.
const { regeneratePnpmLockfile } = await import('../src/lockfile/regenerate.js');

describe('regeneratePnpmLockfile', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('returns null when pnpm-lock.yaml is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'regenerate-test-'));
    const result = await regeneratePnpmLockfile(dir, consoleLogger);
    expect(result).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('runs pnpm install --lockfile-only when lockfile exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'regenerate-test-'));
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    execMock.mockResolvedValueOnce(0);

    const result = await regeneratePnpmLockfile(dir, consoleLogger);

    expect(result).toBe(path.join(dir, 'pnpm-lock.yaml'));
    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execMock.mock.calls[0]!;
    expect(cmd).toBe('pnpm');
    expect(args).toEqual([
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--no-frozen-lockfile',
    ]);
    expect(opts).toMatchObject({ cwd: dir, ignoreReturnCode: true });
  });

  it('throws when pnpm install fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'regenerate-test-'));
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    execMock.mockResolvedValueOnce(1);

    await expect(regeneratePnpmLockfile(dir, consoleLogger)).rejects.toThrow(
      /pnpm install --lockfile-only failed with exit code 1/,
    );
  });
});
