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
| `overrides` (pnpm) | Removing the override and running `pnpm install --lockfile-only` produces a lockfile in which every resolved version of the override key still satisfies the original range. |
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

`pnpm` must be on `PATH` for the `overrides` pruner (it runs
`pnpm install --lockfile-only` to simulate removal). The other pruners only need
`node` and the npm registry.

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `working-directory` | `.` | Path to the project root. |
| `targets` | all | Comma-separated subset of `minimumReleaseAgeExclude,overrides,trustPolicyExclude,onlyBuiltDependencies`. |
| `package-manager` | `auto` | `auto` (detect), `pnpm`, or `npm`. |
| `registry` | `https://registry.npmjs.org` | npm registry to query for publish times and manifests. |
| `dry-run` | `false` | When `true`, do not write files or create a PR. The report is still emitted. |
| `create-pr` | `true` | When `false`, leave changes in the working tree without opening a PR. |
| `pr-branch` | `chore/prune-supply-chain-overrides` | Branch prefix. A `YYYYMMDDHHMM` suffix is appended. |
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
2. Removing **one** override entry at a time and running
   `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`.
3. Checking that every resolved version of the override key in the new
   lockfile satisfies the original range.
4. Restoring the backup before testing the next entry.

If `pnpm install` fails or any resolved version violates the range, the entry
is kept.

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
