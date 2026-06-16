import { describe, expect, it, vi, beforeEach } from 'vitest';
import { consoleLogger } from '../src/util/logger.js';

const reposGetMock = vi.hoisted(() => vi.fn());
const getExecOutputMock = vi.hoisted(() => vi.fn());
const contextMock = vi.hoisted(() => ({
  repo: { owner: 'IntimateMerger', repo: 'rt.js' },
  payload: {} as { repository?: { default_branch?: string } },
}));

vi.mock('@actions/github', () => ({
  getOctokit: () => ({ rest: { repos: { get: reposGetMock } } }),
  context: contextMock,
}));

vi.mock('@actions/exec', () => ({
  getExecOutput: getExecOutputMock,
}));

// Import AFTER vi.mock so the module uses the mocked dependencies.
const { resolveDefaultBranch } = await import('../src/github/default-branch.js');

describe('resolveDefaultBranch', () => {
  beforeEach(() => {
    reposGetMock.mockReset();
    getExecOutputMock.mockReset();
    contextMock.payload = {};
  });

  it('returns the default branch from the GitHub API and skips the git fallback', async () => {
    reposGetMock.mockResolvedValueOnce({ data: { default_branch: 'develop' } });

    const result = await resolveDefaultBranch('token', '/repo', consoleLogger);

    expect(result).toBe('develop');
    expect(reposGetMock).toHaveBeenCalledWith({ owner: 'IntimateMerger', repo: 'rt.js' });
    expect(getExecOutputMock).not.toHaveBeenCalled();
  });

  it('falls back to the event payload when the API call fails', async () => {
    reposGetMock.mockRejectedValueOnce(new Error('boom'));
    contextMock.payload = { repository: { default_branch: 'master' } };

    const result = await resolveDefaultBranch('token', '/repo', consoleLogger);

    expect(result).toBe('master');
    expect(getExecOutputMock).not.toHaveBeenCalled();
  });

  it('falls back to git symbolic-ref when the API and payload are unavailable', async () => {
    reposGetMock.mockRejectedValueOnce(new Error('boom'));
    getExecOutputMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'refs/remotes/origin/trunk\n',
      stderr: '',
    });

    const result = await resolveDefaultBranch('token', '/repo', consoleLogger);

    expect(result).toBe('trunk');
  });

  it('falls back to "main" when nothing resolves the default branch', async () => {
    reposGetMock.mockRejectedValueOnce(new Error('boom'));
    getExecOutputMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fatal' });

    const result = await resolveDefaultBranch('token', '/repo', consoleLogger);

    expect(result).toBe('main');
  });

  it('skips the API entirely when no token is provided', async () => {
    contextMock.payload = { repository: { default_branch: 'develop' } };

    const result = await resolveDefaultBranch('', '/repo', consoleLogger);

    expect(result).toBe('develop');
    expect(reposGetMock).not.toHaveBeenCalled();
  });
});
