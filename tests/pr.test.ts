import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from '../src/util/logger.js';
import type { PrunerReport } from '../src/types.js';

const BRANCH = 'chore/prune-supply-chain-overrides';
const TOKEN = 'ghs_secret';
const BOT = '41898282+github-actions[bot]@users.noreply.github.com';

const calls = vi.hoisted(() => [] as string[]);
const execMock = vi.hoisted(() => vi.fn());
const getExecOutputMock = vi.hoisted(() => vi.fn());
const octokitMock = vi.hoisted(() => ({
  paginate: vi.fn(),
  rest: {
    git: { listMatchingRefs: vi.fn(), deleteRef: vi.fn() },
    pulls: { list: vi.fn(), update: vi.fn(), create: vi.fn() },
    issues: { createComment: vi.fn(), addLabels: vi.fn(), listComments: vi.fn() },
    repos: { compareCommitsWithBasehead: vi.fn() },
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
  let pushArgs: string[];
  // The fixed branch as pushed by an earlier run, or null when it does not exist.
  let remoteBranch: { sha: string; tree: string } | null;
  let branchCommits: { sha: string; author: string; committer: string; subject: string }[];
  let prComments: string[];
  let compared: string[];
  let warnings: string[];
  // The commit this run made on top of the checked-out commit `base-sha`.
  let head: { author: string; committer: string };

  const reports: PrunerReport[] = [
    {
      pruner: 'overrides',
      removed: [
        {
          field: 'overrides',
          file: 'pnpm-workspace.yaml',
          key: 'lodash',
          value: '4.17.21',
          reason: 'unused',
        },
      ],
      skipped: [],
    },
  ];

  const run = (overrides: { labels?: string[] } = {}) =>
    createPullRequest({
      cwd: '/repo',
      token: TOKEN,
      branch: BRANCH,
      base: 'develop',
      title: 'chore: prune',
      commitMessage: 'chore: prune',
      labels: [],
      changedFiles: ['pnpm-workspace.yaml'],
      reports,
      logger: { ...consoleLogger, warn: (m) => warnings.push(m) },
      ...overrides,
    });

  const toPullsListItem = (p: { number: number; head: string; repo?: string }) => ({
    number: p.number,
    html_url: `https://github.com/${REPO}/pull/${p.number}`,
    head: { ref: p.head, repo: { full_name: p.repo ?? REPO } },
  });

  const ok = (stdout: string) => ({ exitCode: 0, stdout: `${stdout}\n`, stderr: '' });

  beforeEach(() => {
    calls.length = 0;
    remoteRefs = [];
    openPrs = [];
    push = { exitCode: 0, stderr: '' };
    pushArgs = [];
    remoteBranch = null;
    branchCommits = [];
    prComments = [];
    compared = [];
    warnings = [];
    head = { author: BOT, committer: BOT };

    execMock.mockReset().mockResolvedValue(0);
    getExecOutputMock.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') {
        return remoteBranch
          ? ok('')
          : { exitCode: 128, stdout: '', stderr: "fatal: couldn't find remote ref" };
      }
      if (args.join(' ') === 'rev-parse FETCH_HEAD') return ok(remoteBranch!.sha);
      if (args.join(' ') === 'rev-parse FETCH_HEAD^{tree}') return ok(remoteBranch!.tree);
      if (args.join(' ') === 'rev-parse HEAD^{tree}') return ok('local-tree');
      if (args.join(' ') === 'show -s --format=%P%x00%ae%x00%ce%x00 HEAD')
        return ok(`base-sha\0${head.author}\0${head.committer}\0`);
      if (args[0] === 'push') {
        calls.push('push');
        pushArgs = args;
        return { exitCode: push.exitCode, stdout: '', stderr: push.stderr };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    octokitMock.paginate
      .mockReset()
      .mockImplementation(async (fn: (p: unknown) => Promise<{ data: unknown }>, p) => {
        return (await fn(p)).data;
      });
    octokitMock.rest.git.listMatchingRefs
      .mockReset()
      .mockImplementation(async ({ ref }: { ref: string }) => ({
        data: remoteRefs
          .map((name) => `refs/heads/${name}`)
          .filter((r) => r.startsWith(`refs/${ref}`))
          .map((r) => ({ ref: r, object: { sha: 'abc123' } })),
      }));
    octokitMock.rest.git.deleteRef
      .mockReset()
      .mockImplementation(async ({ ref }: { ref: string }) => {
        calls.push(`deleteRef ${ref}`);
      });
    octokitMock.rest.pulls.list
      .mockReset()
      .mockImplementation(async ({ head }: { head: string }) => {
        if (!head.startsWith(`${OWNER}:`))
          throw new Error(`head must be "owner:branch", got "${head}"`);
        const ref = head.slice(OWNER.length + 1);
        return {
          data: openPrs
            .filter((p) => p.head === ref && (p.repo ?? REPO) === REPO)
            .map(toPullsListItem),
        };
      });
    octokitMock.rest.pulls.update
      .mockReset()
      .mockImplementation(
        async ({ pull_number, state }: { pull_number: number; state?: string }) => {
          calls.push(state === 'closed' ? `close #${pull_number}` : `update #${pull_number}`);
        },
      );
    octokitMock.rest.pulls.create.mockReset().mockImplementation(async () => {
      calls.push('create');
      return { data: { number: 300, html_url: 'https://github.com/octo-org/octo-repo/pull/300' } };
    });
    octokitMock.rest.issues.createComment
      .mockReset()
      .mockImplementation(
        async ({ issue_number, body }: { issue_number: number; body: string }) => {
          calls.push(`comment #${issue_number}: ${body}`);
        },
      );
    octokitMock.rest.issues.addLabels
      .mockReset()
      .mockImplementation(async ({ issue_number }: { issue_number: number }) => {
        calls.push(`label #${issue_number}`);
      });
    octokitMock.rest.issues.listComments
      .mockReset()
      .mockImplementation(async () => ({ data: prComments.map((body) => ({ body })) }));
    octokitMock.rest.repos.compareCommitsWithBasehead
      .mockReset()
      .mockImplementation(
        async ({ basehead, per_page }: { basehead: string; per_page?: number }) => {
          compared.push(basehead);
          return {
            data: {
              total_commits: branchCommits.length,
              // The real API returns the newest 250 commits unless asked to page.
              commits: (per_page
                ? branchCommits.slice(0, per_page)
                : branchCommits.slice(-250)
              ).map((c) => ({
                sha: c.sha,
                author: null,
                commit: {
                  message: `${c.subject}\n\nbody`,
                  author: { name: c.author.split('@')[0], email: c.author },
                  committer: { name: c.committer.split('@')[0], email: c.committer },
                },
              })),
            },
          };
        },
      );
  });

  it('deletes legacy branches before pushing, whether or not they have an open PR', async () => {
    remoteRefs = [
      `${BRANCH}/202606080746`,
      `${BRANCH}/202606220814`,
      `${BRANCH}-other`,
      'chore/other',
    ];

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
    octokitMock.rest.pulls.list.mockImplementationOnce(async () => ({
      data: openPrs.map(toPullsListItem),
    }));

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
    octokitMock.rest.git.deleteRef.mockRejectedValueOnce(
      new Error('Resource not accessible by integration'),
    );

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

    expect(error.message).toContain(
      `git push to ${BRANCH} failed (exit 1): remote: error: cannot lock ref`,
    );
    expect(error.message).toContain('https://x-access-token:***@github.com');
    expect(error.message).not.toContain(TOKEN);
    expect(calls).not.toContain('create');
  });

  describe('when the branch already exists', () => {
    const OWN = { author: BOT, committer: BOT };
    const MANUAL = { author: 'dev@example.com', committer: 'dev@example.com' };
    const MARKER = '<!-- prune-supply-chain-overrides-action:manual-commits remote-sha -->';
    const lease = `--force-with-lease=refs/heads/${BRANCH}:remote-sha`;
    const comments = () => calls.filter((c) => c.startsWith('comment #300: '));

    beforeEach(() => {
      remoteBranch = { sha: 'remote-sha', tree: 'remote-tree' };
      branchCommits = [{ sha: 'aaaaaaa1', subject: 'chore: prune', ...OWN }];
    });

    it('does not push when the branch already has the same tree, and updates the open PR', async () => {
      remoteBranch = { sha: 'remote-sha', tree: 'local-tree' };
      openPrs = [{ number: 300, head: BRANCH }];
      branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });

      const pr = await run();

      expect(pr.number).toBe(300);
      expect(calls).toEqual(['update #300']);
    });

    it('force-pushes over a branch that only has the commit of an earlier run', async () => {
      openPrs = [{ number: 300, head: BRANCH }];

      const pr = await run();

      expect(pr.number).toBe(300);
      expect(calls).toEqual(['push', 'update #300']);
      expect(pushArgs).toContain(lease);
      expect(warnings).toEqual([]);
    });

    it('force-pushes over manual commits when no PR is open for the branch', async () => {
      branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });

      await run();

      expect(calls).toEqual(['push', 'create']);
      expect(pushArgs).toContain(lease);
    });

    describe('with an open PR', () => {
      beforeEach(() => {
        openPrs = [{ number: 300, head: BRANCH }];
      });

      it('keeps commits added on top of the earlier run and comments on the PR instead', async () => {
        branchCommits.push({ sha: 'bbbbbbb2c0ffee', subject: 'build(dist): rebuild', ...MANUAL });

        const pr = await run();

        expect(pr).toEqual({ number: 300, url: `https://github.com/${REPO}/pull/300` });
        expect(compared).toEqual(['base-sha...remote-sha']);
        expect(calls).toEqual([expect.stringMatching(/^comment #300: /)]);
        const [comment] = comments();
        expect(comment).toContain(MARKER);
        expect(comment).toContain('- bbbbbbb `build(dist): rebuild` (dev)');
        expect(comment).not.toContain('aaaaaaa');
        expect(comment).toContain(`starts \`${BRANCH}\` over and opens a new pull request`);
        expect(comment).toContain('`lodash` (`4.17.21`) — unused');
        expect(warnings).toEqual([
          `Did not update ${BRANCH}: it has 1 commit(s) that this action did not create, and PR #300 is still open. Merge or close the PR to let the next run update the branch.`,
        ]);
      });

      it('treats the earlier commit as manual once someone rewrites it', async () => {
        branchCommits = [
          { sha: 'aaaaaaa1', subject: 'chore: prune', ...OWN, committer: MANUAL.committer },
        ];

        await run();

        expect(calls).not.toContain('push');
        expect(comments()[0]).toContain('- aaaaaaa `chore: prune` (41898282+github-actions[bot])');
      });

      it("treats a second commit as manual even when it carries the action's identity", async () => {
        branchCommits.push({ sha: 'bbbbbbb2', subject: 'build(dist): rebuild', ...OWN });

        await run();

        expect(calls).not.toContain('push');
        expect(comments()[0]).toContain(
          '- bbbbbbb `build(dist): rebuild` (41898282+github-actions[bot])',
        );
      });

      it('comments only once while the branch head stays the same', async () => {
        branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });
        prComments = [`${MARKER}\nThis run did not update`];

        await run();

        expect(calls).toEqual([]);
        expect(warnings).toHaveLength(1);
      });

      it('comments again once the branch head moves', async () => {
        branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });
        prComments = [
          '<!-- prune-supply-chain-overrides-action:manual-commits older-sha -->\nThis run did not update',
        ];

        await run();

        expect(calls).toEqual([expect.stringMatching(/^comment #300: /)]);
      });

      it('lists the oldest 10 manual commits and counts the rest, past the API cap of 250', async () => {
        for (let i = 0; i < 300; i++) {
          branchCommits.push({
            sha: `c${String(i).padStart(6, '0')}`,
            subject: `fix ${i}`,
            ...MANUAL,
          });
        }

        await run();

        const [comment] = comments();
        expect(comment).toContain('- c000000 `fix 0` (dev)');
        expect(comment).toContain('- c000009 `fix 9` (dev)');
        expect(comment).not.toContain('fix 10`');
        expect(comment).toContain('- …and 290 more');
        expect(warnings[0]).toContain('it has 300 commit(s)');
      });

      it('treats the earlier commit as manual when only its author differs', async () => {
        branchCommits = [
          { sha: 'aaaaaaa1', subject: 'chore: prune', ...OWN, author: MANUAL.author },
        ];

        await run();

        expect(calls).not.toContain('push');
        expect(comments()).toHaveLength(1);
      });

      it('compares against the identity the run committed with', async () => {
        head = { author: 'app@example.com', committer: 'app@example.com' };
        branchCommits = [
          {
            sha: 'aaaaaaa1',
            subject: 'chore: prune',
            author: 'app@example.com',
            committer: 'app@example.com',
          },
        ];

        await run();

        expect(calls).toEqual(['push', 'update #300']);
      });

      it('treats a commit with the default bot identity as manual when the run uses another one', async () => {
        head = { author: 'app@example.com', committer: 'app@example.com' };

        await run();

        expect(calls).not.toContain('push');
        expect(comments()).toHaveLength(1);
      });

      it('leaves labels alone on a PR it does not update', async () => {
        branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });

        await run({ labels: ['dependencies'] });

        expect(calls).toEqual([expect.stringMatching(/^comment #300: /)]);
      });

      it('puts commit subjects in a code span so that mentions and references stay inert', async () => {
        branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix `a` for @someone (#12)', ...MANUAL });

        await run();

        expect(comments()[0]).toContain('- bbbbbbb ``fix `a` for @someone (#12)`` (dev)');
      });

      it('fails without pushing when the comment cannot be posted', async () => {
        branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });
        octokitMock.rest.issues.createComment.mockRejectedValueOnce(
          new Error('Resource not accessible by integration'),
        );

        await expect(run()).rejects.toThrow(
          `Failed to comment on PR #300 about the commits that keep ${BRANCH} from being updated: Resource not accessible by integration`,
        );
        expect(calls).not.toContain('push');
      });

      it('fails without pushing when the commits cannot be compared', async () => {
        octokitMock.rest.repos.compareCommitsWithBasehead.mockRejectedValueOnce(
          new Error('Not Found'),
        );

        await expect(run()).rejects.toThrow(
          `Failed to list the commits on ${BRANCH} that pushing would drop: Not Found`,
        );
        expect(calls).not.toContain('push');
      });
    });

    it('adds labels to the PR it updates', async () => {
      openPrs = [{ number: 300, head: BRANCH }];

      await run({ labels: ['dependencies'] });

      expect(calls).toEqual(['push', 'update #300', 'label #300']);
    });

    it('ignores PRs from forks or other branches even if the API ignores the head filter', async () => {
      openPrs = [
        { number: 211, head: BRANCH, repo: 'someone/octo-repo' },
        { number: 212, head: 'feature/unrelated' },
      ];
      octokitMock.rest.pulls.list.mockImplementationOnce(async () => ({
        data: openPrs.map(toPullsListItem),
      }));
      branchCommits.push({ sha: 'bbbbbbb2', subject: 'fix', ...MANUAL });

      await run();

      expect(calls).toEqual(['push', 'create']);
    });
  });
});
