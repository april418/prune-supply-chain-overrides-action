import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from '../src/util/logger.js';

const BRANCH = 'chore/prune-supply-chain-overrides';
const TOKEN = 'ghs_secret';

const calls = vi.hoisted(() => [] as string[]);
const execMock = vi.hoisted(() => vi.fn());
const getExecOutputMock = vi.hoisted(() => vi.fn());
const octokitMock = vi.hoisted(() => ({
  paginate: vi.fn(),
  rest: {
    git: { deleteRef: vi.fn() },
    pulls: { list: vi.fn(), update: vi.fn(), create: vi.fn() },
    issues: { createComment: vi.fn(), addLabels: vi.fn() },
  },
}));

vi.mock('@actions/github', () => ({
  getOctokit: () => octokitMock,
  context: { repo: { owner: 'IntimateMerger', repo: 'piggy-next' } },
}));

vi.mock('@actions/exec', () => ({
  exec: execMock,
  getExecOutput: getExecOutputMock,
}));

// Import AFTER vi.mock so the module uses the mocked dependencies.
const { createPullRequest, isSupersededBranch } = await import('../src/github/pr.js');

describe('isSupersededBranch', () => {
  const branch = BRANCH;

  it('matches legacy timestamped branches', () => {
    expect(isSupersededBranch(branch, `${branch}/202607200707`)).toBe(true);
  });

  it('does not match the fixed branch itself', () => {
    expect(isSupersededBranch(branch, branch)).toBe(false);
  });

  it('does not match suffixes that are not a 12-digit timestamp', () => {
    expect(isSupersededBranch(branch, `${branch}/2026072007`)).toBe(false);
    expect(isSupersededBranch(branch, `${branch}/20260720070700`)).toBe(false);
    expect(isSupersededBranch(branch, `${branch}/not-a-timestamp`)).toBe(false);
    expect(isSupersededBranch(branch, `${branch}/202607200707/extra`)).toBe(false);
  });

  it('does not match unrelated branches', () => {
    expect(isSupersededBranch(branch, 'feature/202607200707')).toBe(false);
    expect(isSupersededBranch(branch, `${branch}-other/202607200707`)).toBe(false);
  });
});

describe('createPullRequest', () => {
  let push: { exitCode: number; stderr: string };

  const run = () =>
    createPullRequest({
      cwd: '/repo',
      token: TOKEN,
      branch: BRANCH,
      base: 'develop',
      title: 'chore: prune',
      commitMessage: 'chore: prune',
      labels: [],
      changedFiles: ['pnpm-workspace.yaml'],
      reports: [],
      logger: consoleLogger,
    });

  beforeEach(() => {
    calls.length = 0;
    push = { exitCode: 0, stderr: '' };

    execMock.mockReset().mockResolvedValue(0);
    getExecOutputMock.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') return { exitCode: 128, stdout: '', stderr: "fatal: couldn't find remote ref" };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'tree\n', stderr: '' };
      if (args[0] === 'push') {
        calls.push('push');
        return { exitCode: push.exitCode, stdout: '', stderr: push.stderr };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    octokitMock.rest.pulls.create.mockReset().mockImplementation(async () => {
      calls.push('create');
      return { data: { number: 300, html_url: 'https://github.com/IntimateMerger/piggy-next/pull/300' } };
    });
  });

  it("surfaces git's stderr with the token redacted when the push fails", async () => {
    push = {
      exitCode: 1,
      stderr: `remote: error: cannot lock ref\nTo https://x-access-token:${TOKEN}@github.com/IntimateMerger/piggy-next.git\n`,
    };

    const error = await run().then(
      () => {
        throw new Error('expected createPullRequest to reject');
      },
      (err: unknown) => err as Error,
    );

    expect(error.message).toContain(`git push to ${BRANCH} failed (exit 1): remote: error: cannot lock ref`);
    expect(error.message).toContain('https://x-access-token:***@github.com');
    expect(error.message).not.toContain(TOKEN);
    expect(calls).not.toContain('create');
  });
});
