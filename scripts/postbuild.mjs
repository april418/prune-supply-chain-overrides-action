import { rmSync } from 'node:fs';

// ncc emits `dist/package.json` with `{ "type": "module" }`. Our root
// package.json already declares ESM, so the marker is redundant — and worse,
// pnpm picks it up as a second workspace project, which trips the
// `verifyDepsBeforeRun: error` check we use to harden the supply chain.
rmSync('dist/package.json', { force: true });
