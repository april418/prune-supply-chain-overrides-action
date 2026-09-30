// Run the bundled dist/index.js against throwaway pnpm and npm projects, with
// the real npm registry and package managers, the way a consumer's workflow
// would. Unit tests stub the network and the package managers, so they cannot
// catch a dependency bundled into dist that breaks at runtime (e.g. undici
// 8.11.0 breaking Node's fetch).
//
// The projects live in temp directories because pnpm treats any package.json
// under this repository as a workspace project.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SMOKE_DIST points at another build, e.g. to check the test catches a known-bad one.
const distEntry = path.resolve(process.env.SMOKE_DIST ?? 'dist/index.js');

const scenarios = [
  {
    name: 'pnpm',
    // is-number@7.0.0 was published in 2018, so both entries are stale.
    files: {
      'package.json': JSON.stringify({
        name: 'smoke',
        private: true,
        dependencies: { 'is-number': '7.0.0' },
      }),
      'pnpm-workspace.yaml': `# header that must survive
minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  - is-number
overrides:
  is-number@<7.0.0: '^7.0.0'
`,
    },
    resolve: ['pnpm', ['install', '--lockfile-only', '--ignore-scripts']],
    lockfile: 'pnpm-lock.yaml',
    removed: ['minimumReleaseAgeExclude:is-number', 'overrides:is-number@<7.0.0'],
    kept: [],
  },
  {
    name: 'npm',
    // is-odd@3.0.1 depends on is-number@^6, so only the <7.0.0 override holds
    // anything back; the <5.0.0 one is redundant.
    files: {
      'package.json': JSON.stringify({
        name: 'smoke',
        version: '1.0.0',
        private: true,
        dependencies: { 'is-odd': '3.0.1' },
        overrides: { 'is-number@<5.0.0': '^7.0.0', 'is-number@<7.0.0': '^7.0.0' },
      }),
    },
    resolve: ['npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']],
    lockfile: 'package-lock.json',
    removed: ['overrides:is-number@<5.0.0'],
    kept: ['is-number@<7.0.0'],
  },
];

const failures = [];
for (const scenario of scenarios) {
  for (const failure of runScenario(scenario)) failures.push(`[${scenario.name}] ${failure}`);
}
if (failures.length > 0) {
  console.error(`smoke test failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`smoke test passed: ${scenarios.map((s) => s.name).join(', ')}`);

function runScenario({ files, resolve, lockfile, removed: expectedRemoved, kept }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prune-smoke-'));
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  execFileSync(resolve[0], resolve[1], { cwd: dir, stdio: 'inherit' });

  const tracked = [...Object.keys(files), lockfile];
  const snapshot = () =>
    Object.fromEntries(tracked.map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));
  const before = snapshot();
  const outputFile = path.join(dir, 'github-output');
  writeFileSync(outputFile, '');
  const result = spawnSync(process.execPath, [distEntry], {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      'INPUT_WORKING-DIRECTORY': '.',
      INPUT_TARGETS: 'minimumReleaseAgeExclude,overrides,trustPolicyExclude,onlyBuiltDependencies',
      INPUT_REGISTRY: 'https://registry.npmjs.org',
      'INPUT_DRY-RUN': 'true',
      'INPUT_CREATE-PR': 'false',
      'INPUT_PR-BRANCH': 'smoke',
      'INPUT_PR-TITLE': 'smoke',
      'INPUT_COMMIT-MESSAGE': 'smoke',
    },
  });

  const failures = [];
  if (result.status !== 0) failures.push(`dist/index.js exited with ${result.status}`);
  const reports = JSON.parse(parseOutputs(readFileSync(outputFile, 'utf8')).pruned ?? '[]');
  const removed = reports.flatMap((r) => r.removed.map((e) => `${r.pruner}:${e.key}`));
  const skipped = reports.flatMap((r) => r.skipped.map((e) => e.key));
  for (const key of expectedRemoved) {
    if (!removed.includes(key)) failures.push(`expected ${key} to be pruned`);
  }
  for (const key of kept) {
    if (!skipped.includes(key)) failures.push(`expected ${key} to be kept`);
  }
  for (const [file, content] of Object.entries(snapshot())) {
    if (content !== before[file]) failures.push(`dry-run modified ${file}`);
  }
  return failures;
}

/** Parse the `name<<delimiter` blocks @actions/core writes to GITHUB_OUTPUT. */
function parseOutputs(text) {
  const out = {};
  const re = /^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm;
  for (const m of text.matchAll(re)) out[m[1]] = m[3];
  return out;
}
