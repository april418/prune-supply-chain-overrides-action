import { access } from 'node:fs/promises';
import path from 'node:path';
import * as core from '@actions/core';
import type { ActionInputs, PackageManager, PrunerName } from './types.js';

const ALL_PRUNERS: readonly PrunerName[] = [
  'minimumReleaseAgeExclude',
  'overrides',
  'trustPolicyExclude',
  'onlyBuiltDependencies',
] as const;

export function readActionInputs(): ActionInputs {
  const workingDirectory = core.getInput('working-directory') || '.';
  const targetsInput = core.getInput('targets') || ALL_PRUNERS.join(',');
  const targets = targetsInput
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as PrunerName[];
  for (const t of targets) {
    if (!ALL_PRUNERS.includes(t)) {
      throw new Error(`Unknown target "${t}". Valid: ${ALL_PRUNERS.join(', ')}`);
    }
  }
  const packageManager = (core.getInput('package-manager') || 'auto') as PackageManager | 'auto';
  if (packageManager !== 'auto' && packageManager !== 'pnpm' && packageManager !== 'npm') {
    throw new Error(`Invalid package-manager "${packageManager}". Valid: auto, pnpm, npm`);
  }
  const labels = (core.getInput('pr-labels') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    workingDirectory,
    targets,
    packageManager,
    registry: core.getInput('registry') || 'https://registry.npmjs.org',
    dryRun: core.getBooleanInput('dry-run'),
    createPr: core.getBooleanInput('create-pr'),
    prBranch: core.getInput('pr-branch') || 'chore/prune-supply-chain-overrides',
    prTitle: core.getInput('pr-title') || 'chore: prune stale supply-chain overrides',
    prBase: core.getInput('pr-base') || '',
    prLabels: labels,
    commitMessage: core.getInput('commit-message') || 'chore: prune stale supply-chain overrides',
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN || '',
  };
}

export async function detectPackageManager(
  cwd: string,
  hint: PackageManager | 'auto',
): Promise<PackageManager> {
  if (hint !== 'auto') return hint;
  const hasPnpmWorkspace = await fileExists(path.join(cwd, 'pnpm-workspace.yaml'));
  const hasPnpmLock = await fileExists(path.join(cwd, 'pnpm-lock.yaml'));
  if (hasPnpmWorkspace || hasPnpmLock) return 'pnpm';
  return 'npm';
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
