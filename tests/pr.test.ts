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
    git: { listMatchingRefs: vi.fn(), deleteRef: vi.fn() },
    pulls: { list: vi.fn(), update: vi.fn(), create: vi.fn() },
    issues: { createComment: vi.fn(), addLabels: vi.fn() },
  },
}));

vi.mock('@actions/github', () => ({
  getOctokit: () => octokitMock,
  context: { repo: { owner: 'octo-org', repo: 'octo-repo' } },
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
  const OWNER = 'octo-org';
  const REPO = `${OWNER}/octo-repo`;
  const closingNote = (name: string) =>
    `Closing: branch \`${name}\` is deleted so that \`${BRANCH}\` can be pushed. Later prune results go to the pull request from \`${BRANCH}\`.`;

  let remoteRefs: string[];
  let openPrs: { number: number; head: string; repo?: string }[];
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

  const toPullsListItem = (p: { number: number; head: string; repo?: string }) => ({
    number: p.number,
    head: { ref: p.head, repo: { full_name: p.repo ?? REPO } },
  });

  beforeEach(() => {
    calls.length = 0;
    remoteRefs = [];
    openPrs = [];
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

    octokitMock.paginate.mockReset().mockImplementation(async (fn: (p: unknown) => Promise<{ data: unknown }>, p) => {
      return (await fn(p)).data;
    });
    octokitMock.rest.git.listMatchingRefs.mockReset().mockImplementation(async ({ ref }: { ref: string }) => ({
      data: remoteRefs
        .map((name) => `refs/heads/${name}`)
        .filter((r) => r.startsWith(`refs/${ref}`))
        .map((r) => ({ ref: r, object: { sha: 'abc123' } })),
    }));
    octokitMock.rest.git.deleteRef.mockReset().mockImplementation(async ({ ref }: { ref: string }) => {
      calls.push(`deleteRef ${ref}`);
    });
    octokitMock.rest.pulls.list.mockReset().mockImplementation(async ({ head }: { head: string }) => {
      if (!head.startsWith(`${OWNER}:`)) throw new Error(`head must be "owner:branch", got "${head}"`);
      const ref = head.slice(OWNER.length + 1);
      return { data: openPrs.filter((p) => p.head === ref && (p.repo ?? REPO) === REPO).map(toPullsListItem) };
    });
    octokitMock.rest.pulls.update.mockReset().mockImplementation(async ({ pull_number }: { pull_number: number }) => {
      calls.push(`close #${pull_number}`);
    });
    octokitMock.rest.pulls.create.mockReset().mockImplementation(async () => {
      calls.push('create');
      return { data: { number: 300, html_url: 'https://github.com/octo-org/octo-repo/pull/300' } };
    });
    octokitMock.rest.issues.createComment.mockReset().mockImplementation(
      async ({ issue_number, body }: { issue_number: number; body: string }) => {
        calls.push(`comment #${issue_number}: ${body}`);
      },
    );
    octokitMock.rest.issues.addLabels.mockReset();
  });

  it('deletes legacy branches before pushing, whether or not they have an open PR', async () => {
    remoteRefs = [`${BRANCH}/202606080746`, `${BRANCH}/202606220814`, `${BRANCH}-other`, 'chore/other'];

    await run();

    expect(calls).toEqual([
      `deleteRef heads/${BRANCH}/202606080746`,
      `deleteRef heads/${BRANCH}/202606220814`,
      'push',
      'create',
    ]);
  });

  it('explains and closes open PRs on legacy branches before pushing, then links them to the new PR', async () => {
    remoteRefs = [`${BRANCH}/202607200707`];
    openPrs = [{ number: 210, head: `${BRANCH}/202607200707` }];

    const pr = await run();

    expect(pr.number).toBe(300);
    expect(calls).toEqual([
      `comment #210: ${closingNote(`${BRANCH}/202607200707`)}`,
      'close #210',
      `deleteRef heads/${BRANCH}/202607200707`,
      'push',
      'create',
      'comment #210: Superseded by #300.',
    ]);
  });

  it('never closes PRs from other branches or forks even if the API ignores the head filter', async () => {
    remoteRefs = [`${BRANCH}/202607200707`];
    openPrs = [
      { number: 210, head: `${BRANCH}/202607200707` },
      { number: 211, head: `${BRANCH}/202607200707`, repo: 'someone/octo-repo' },
      { number: 212, head: 'feature/unrelated' },
    ];
    octokitMock.rest.pulls.list.mockImplementationOnce(async () => ({ data: openPrs.map(toPullsListItem) }));

    await run();

    expect(calls.filter((c) => c.startsWith('close'))).toEqual(['close #210']);
  });

  it('keeps the new PR when linking a superseded PR fails', async () => {
    remoteRefs = [`${BRANCH}/202607200707`];
    openPrs = [{ number: 210, head: `${BRANCH}/202607200707` }];
    octokitMock.rest.issues.createComment.mockImplementation(
      async ({ issue_number, body }: { issue_number: number; body: string }) => {
        if (body.startsWith('Superseded')) throw new Error('rate limited');
        calls.push(`comment #${issue_number}: ${body}`);
      },
    );

    const pr = await run();

    expect(pr.number).toBe(300);
  });

  it('refuses to delete anything when a branch under pr-branch is not a legacy leftover', async () => {
    remoteRefs = [`${BRANCH}/202607200707`, `${BRANCH}/manual-fix`];

    await expect(run()).rejects.toThrow(`branches exist under ${BRANCH}/ (${BRANCH}/manual-fix)`);
    expect(calls).toEqual([]);
  });

  it('stops before pushing when a legacy branch cannot be deleted', async () => {
    remoteRefs = [`${BRANCH}/202607200707`];
    octokitMock.rest.git.deleteRef.mockRejectedValueOnce(new Error('Resource not accessible by integration'));

    await expect(run()).rejects.toThrow(
      `Failed to remove superseded branch ${BRANCH}/202607200707, which blocks pushing ${BRANCH}: Resource not accessible by integration`,
    );
    expect(calls).not.toContain('push');
  });

  it("surfaces git's stderr with the token redacted when the push fails", async () => {
    push = {
      exitCode: 1,
      stderr: `remote: error: cannot lock ref\nTo https://x-access-token:${TOKEN}@github.com/octo-org/octo-repo.git\n`,
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
