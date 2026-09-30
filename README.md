# prune-supply-chain-overrides-action

GitHub Action that prunes stale supply-chain mitigation entries from your pnpm /
npm project and opens a pull request with the cleanup.

When you mitigate a supply-chain risk by adding entries to your
`pnpm-workspace.yaml` — for example, listing `next` under
`minimumReleaseAgeExclude` so that an urgent security release can be installed
before it has aged 7 days — those entries become **dead weight** after time
passes. They make later audits noisier and they keep the mitigation surface
larger than it needs to be.

This action runs on a schedule, checks each entry against the npm registry and
the current lockfile, removes only the entries that are demonstrably safe to
remove, and opens a pull request for review.

## What gets pruned

| Field | When it is removed |
| --- | --- |
| `minimumReleaseAgeExclude` (pnpm) | The most recently published version of the package that is resolved in `pnpm-lock.yaml` is at least `minimumReleaseAge` minutes old. |
| `trustPolicyExclude` (pnpm) | The most recently published resolved version is at least `trustPolicyIgnoreAfter` minutes old. |
| `overrides` (pnpm) | Removing the override and running `pnpm install --lockfile-only` produces a lockfile in which every resolved version of the target package still satisfies the override's range, apart from versions outside the override's selector that were already resolved before. |
| `onlyBuiltDependencies` (pnpm) | The package is no longer in the dependency graph, or its currently-resolved version does not declare `preinstall` / `install` / `postinstall` scripts. |

Entries that the action cannot verify (e.g. the registry has no publish time,
or the simulation fails) are kept and reported under "Skipped" in the PR body.

## Usage

```yaml
# .github/workflows/prune-supply-chain.yml
name: Prune supply-chain overrides

on:
  schedule:
    - cron: '0 6 * * 1' # every Monday 06:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json

      - uses: april418/prune-supply-chain-overrides-action@v1
        with:
          working-directory: .
```

`pnpm` must be on `PATH` for any pnpm project. The `overrides` pruner runs
`pnpm install --lockfile-only` to simulate removal, and after **any** prune
the action re-runs `pnpm install --lockfile-only` once more so that
`pnpm-lock.yaml` reflects the post-prune state of `pnpm-workspace.yaml`
(otherwise downstream `pnpm install --frozen-lockfile` fails with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`). The setup shown above
(`pnpm/action-setup` + `actions/setup-node`) covers this.

### Required repository settings

This action opens a pull request with `GITHUB_TOKEN`, so the consumer
repository must allow GitHub Actions to do so. This is a **repository-level
gate** that is independent of the workflow-level `permissions:` block — even
with `pull-requests: write` declared, PR creation fails with
`GitHub Actions is not permitted to create or approve pull requests` until the
setting is flipped.

To enable it:

1. Open **Settings → Actions → General** in your repository
   (`https://github.com/<owner>/<repo>/settings/actions`).
2. Scroll to **Workflow permissions**.
3. Tick **Allow GitHub Actions to create and approve pull requests**.
4. **Save**.

`default_workflow_permissions` can stay on _Read repository contents and
packages permissions_ — the workflow snippet above already declares
`contents: write` and `pull-requests: write` explicitly.

You can verify the result with `gh`:

```sh
gh api repos/<owner>/<repo>/actions/permissions/workflow
# => { "default_workflow_permissions": "read", "can_approve_pull_request_reviews": true }
```

#### Alternatives without flipping the repository setting

If the gate is enforced at the organization or enterprise level and you cannot
toggle it on the repository, pass a token from a non-`GITHUB_TOKEN` principal
to `github-token`:

- **Personal Access Token (PAT)** — simplest. Author of the PR will be your
  user account. Store the PAT in a secret and pass it as `github-token`.
- **GitHub App token** — preferred for fleet use. Create a GitHub App with
  `Contents: Write` and `Pull requests: Write`, install it on the repository,
  and mint an ephemeral token in the workflow via
  [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).
  The PR will be authored by `<your-app>[bot]`.

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `working-directory` | `.` | Path to the project root. |
| `targets` | all | Comma-separated subset of `minimumReleaseAgeExclude,overrides,trustPolicyExclude,onlyBuiltDependencies`. |
| `package-manager` | `auto` | `auto` (detect), `pnpm`, or `npm`. |
| `registry` | `https://registry.npmjs.org` | npm registry to query for publish times and manifests. |
| `dry-run` | `false` | When `true`, do not create a PR or leave changes behind. The report is still emitted, and for pnpm projects the lockfile is still regenerated and verified (see below) before the files are restored. |
| `create-pr` | `true` | When `false`, leave changes in the working tree without opening a PR. |
| `pr-branch` | `chore/prune-supply-chain-overrides` | Branch name for the PR. Reused on every run — see [Repeated runs](#repeated-runs-and-open-prs). |
| `pr-title` | `chore: prune stale supply-chain overrides` | Title of the PR. |
| `pr-base` | default branch | Base branch for the PR. |
| `pr-labels` | _(none)_ | Comma-separated labels to attach to the PR. |
| `commit-message` | `chore: prune stale supply-chain overrides` | Commit message. |
| `github-token` | `${{ github.token }}` | Token used to push and to open the PR. |

### Outputs

| Output | Description |
| --- | --- |
| `changed` | `true` when at least one entry was pruned. |
| `pruned` | JSON report grouped by pruner (matches the PR body). |
| `pr-number` | Number of the opened PR, when `create-pr` is `true`. |
| `pr-url` | URL of the opened PR. |

### Repeated runs and open PRs

The action always uses the `pr-branch` name as-is, so scheduled runs never pile
up duplicate pull requests. When a previous run's PR is still open:

- The branch is force-pushed with the freshly computed prune result (rebased on
  the current base branch), and the PR title and body are updated in place.
- If the new result is identical to what the branch already contains, the push
  is skipped so the PR is not churned with no-op commits.
- Manual commits pushed onto the PR branch are overwritten on the next run —
  treat the PR as machine-owned and put manual fixes in a separate branch.
- Open PRs left behind by versions up to v1.0.4 (which used
  `<pr-branch>/<YYYYMMDDHHMM>` branch names) are closed as superseded and their
  branches deleted once the fixed-branch PR exists.

If you run the action more than once in the same repository (e.g. several
`working-directory` values in a monorepo), give each instance a distinct
`pr-branch` so the runs do not fight over one branch.

## How each pruner decides

### `minimumReleaseAgeExclude`

The pnpm setting `minimumReleaseAge: 10080` blocks installation of any version
that has been public for less than 7 days. Entries in
`minimumReleaseAgeExclude` opt specific packages out of that gate so that, for
example, a freshly released security patch can be installed immediately.

Once the resolved version itself is older than `minimumReleaseAge`, the opt-out
is no longer load-bearing — removing the entry does not change which version
pnpm will install. The action keeps the entry only when at least one
currently-resolved version is younger than the threshold.

### `trustPolicyExclude`

`trustPolicy: no-downgrade` errors when a package's trust level drops compared
to previous releases. `trustPolicyIgnoreAfter` relaxes the rule for legacy
packages older than the threshold. The pruner uses the same age check as
`minimumReleaseAgeExclude` against `trustPolicyIgnoreAfter`.

### `overrides`

Overrides are typically added either to backport a fix
(e.g. `fast-uri: '>=3.1.2'`) or to deduplicate a transitive dependency. Once
the natural resolution catches up, the override is a no-op.

The pruner verifies this by:

1. Backing up `pnpm-workspace.yaml` and `pnpm-lock.yaml`.
2. Removing **one** override entry at a time, on top of the entries already
   accepted for removal, and running
   `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`.
3. Checking that every resolved version of the override's target package in
   the new lockfile that matches the override's selector (the part after `@`
   in the key, e.g. `<0.2.6` in `tmp@<0.2.6`) satisfies the override's range —
   and that the same still holds for every override accepted earlier.
   A version outside the selector is ignored only if it was already resolved
   before any override was removed, so one override per major series
   (`foo@<1.2.0`, `foo@>=2.0.0 <2.3.0`) is not kept alive by the other
   series. A version that newly appears outside the selector still has to
   satisfy the range: pnpm applies an override when the *declared* range
   intersects the selector, so removing `foo@<1.2.0` can let a dependency on
   `foo@>=1.0.0` jump to a later major. A key without a selector, or with one
   that is not a semver range, matches every version.
4. Keeping that state when the entry is removable, or rolling back to the
   last accepted state otherwise.

If `pnpm install` fails or any matching version violates a range, the entry
is kept. Evaluating removals cumulatively matters when several overrides
cover the same package (e.g. `tmp@<=0.2.3` and `tmp@<0.2.6`): each one looks
redundant while the other is in place, but removing both is not safe.

After all pruners run, the regenerated `pnpm-lock.yaml` is checked against
every removed override once more, and the action fails instead of opening a
pull request if any of them no longer holds. With `dry-run: true` the same
regeneration and check run against the pruned files, which are then restored
together with `pnpm-lock.yaml`, so a dry run fails exactly when a real run
would.

### `onlyBuiltDependencies`

The pnpm setting `onlyBuiltDependencies: []` blocks all lifecycle scripts
unless the package is explicitly allow-listed. Entries become redundant when:

- The package is no longer in `pnpm-lock.yaml`, or
- The currently-resolved version no longer declares `preinstall` / `install` /
  `postinstall` scripts (so the allow-list grant has nothing to grant).

The pruner fetches each resolved version's manifest from the npm registry to
inspect its `scripts` field.

## Dry-run / inspecting the report

```yaml
- uses: april418/prune-supply-chain-overrides-action@v1
  id: prune
  with:
    dry-run: 'true'

- run: echo '${{ steps.prune.outputs.pruned }}' | jq
```

## Limitations

- pnpm is the primary supported workflow. `npm` (`package.json#overrides`) is
  detected and partially supported but the `overrides` simulator currently
  relies on `pnpm install --lockfile-only`. Track npm support in
  [#1](https://github.com/april418/prune-supply-chain-overrides-action/issues/1).
- Yarn `resolutions` is not yet supported.
- The action does not currently inspect `auditConfig`, `peerDependencyRules`,
  or `patchedDependencies`. These are out of scope until there is demand.
- For very large monorepos with many overrides, the overrides pruner can be
  slow (one `pnpm install --lockfile-only` per entry).

## Dogfooding

The action's own repository ships with a minimal `.npmrc` that mirrors the
`pnpm-workspace.yaml` settings the action is designed to clean up, so the
project's CI is itself subject to the same supply-chain mitigations the action
manages.

## License

MIT.
