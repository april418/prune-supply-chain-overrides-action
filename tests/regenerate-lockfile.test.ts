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
const { regenerateLockfile } = await import('../src/lockfile/regenerate.js');

describe('regenerateLockfile', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it('returns null when pnpm-lock.yaml is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'regenerate-test-'));
    const result = await regenerateLockfile(dir, 'pnpm', consoleLogger);
    expect(result).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('runs pnpm install --lockfile-only when lockfile exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'regenerate-test-'));
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    execMock.mockResolvedValueOnce(0);

    const result = await regenerateLockfile(dir, 'pnpm', consoleLogger);

    expect(result).toEqual([path.join(dir, 'pnpm-lock.yaml')]);
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

    await expect(regenerateLockfile(dir, 'pnpm', consoleLogger)).rejects.toThrow(
      /pnpm install --lockfile-only failed with exit code 1/,
    );
  });

  it('runs npm install --package-lock-only for npm projects', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'regenerate-test-'));
    await writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    execMock.mockResolvedValueOnce(0);

    const result = await regenerateLockfile(dir, 'npm', consoleLogger);

    expect(result).toEqual([path.join(dir, 'package-lock.json')]);
    const [cmd, args] = execMock.mock.calls[0]!;
    expect(cmd).toBe('npm');
    expect(args).toEqual([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  });
});
