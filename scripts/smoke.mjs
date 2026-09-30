// Run the bundled dist/index.js against a throwaway pnpm project, with the
// real npm registry and pnpm, the way a consumer's workflow would. Unit tests
// stub the network and pnpm, so they cannot catch a dependency bundled into
// dist that breaks at runtime (e.g. undici 8.11.0 breaking Node's fetch).
//
// The project lives in a temp directory because pnpm treats any package.json
// under this repository as a workspace project.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SMOKE_DIST points at another build, e.g. to check the test catches a known-bad one.
const distEntry = path.resolve(process.env.SMOKE_DIST ?? 'dist/index.js');
const dir = mkdtempSync(path.join(tmpdir(), 'prune-smoke-'));

// is-number@7.0.0 was published in 2018, so both entries below are stale.
writeFileSync(
  path.join(dir, 'package.json'),
  JSON.stringify({ name: 'smoke', private: true, dependencies: { 'is-number': '7.0.0' } }),
);
writeFileSync(
  path.join(dir, 'pnpm-workspace.yaml'),
  `# header that must survive
minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  - is-number
overrides:
  is-number@<7.0.0: '^7.0.0'
`,
);
execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
  cwd: dir,
  stdio: 'inherit',
});

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

const outputs = parseOutputs(readFileSync(outputFile, 'utf8'));
const removed = JSON.parse(outputs.pruned ?? '[]').flatMap((r) =>
  r.removed.map((e) => `${r.pruner}:${e.key}`),
);
for (const expected of ['minimumReleaseAgeExclude:is-number', 'overrides:is-number@<7.0.0']) {
  if (!removed.includes(expected)) failures.push(`expected ${expected} to be pruned`);
}
for (const [file, content] of Object.entries(snapshot())) {
  if (content !== before[file]) failures.push(`dry-run modified ${file}`);
}

if (failures.length > 0) {
  console.error(`smoke test failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`smoke test passed: pruned ${removed.join(', ')}`);

function snapshot() {
  const files = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
  return Object.fromEntries(files.map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));
}

/** Parse the `name<<delimiter` blocks @actions/core writes to GITHUB_OUTPUT. */
function parseOutputs(text) {
  const out = {};
  const re = /^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm;
  for (const m of text.matchAll(re)) out[m[1]] = m[3];
  return out;
}
