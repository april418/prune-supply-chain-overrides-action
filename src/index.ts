import path from 'node:path';
import * as core from '@actions/core';
import { detectPackageManager, readActionInputs } from './config.js';
import { actionsLogger } from './util/logger.js';
import { NpmRegistry } from './registry/npm-registry.js';
import { loadPnpmWorkspace, savePnpmWorkspace } from './files/pnpm-workspace.js';
import { loadPackageJson, savePackageJson } from './files/package-json.js';
import { loadNpmrc, saveNpmrc } from './files/npmrc.js';
import { loadPnpmLockfile } from './lockfile/pnpm-lockfile.js';
import { regeneratePnpmLockfile } from './lockfile/regenerate.js';
import { minimumReleaseAgeExcludePruner, trustPolicyExcludePruner } from './pruners/age-based.js';
import { overridesPruner } from './pruners/overrides.js';
import { onlyBuiltDependenciesPruner } from './pruners/only-built-dependencies.js';
import type { Pruner, PrunerContext } from './pruners/types.js';
import type { PrunerName, PrunerReport } from './types.js';
import { createPullRequest, summarizeRemovals } from './github/pr.js';
import { resolveDefaultBranch } from './github/default-branch.js';
import type { Logger } from './util/logger.js';

const REGISTRY: Record<PrunerName, Pruner> = {
  minimumReleaseAgeExclude: minimumReleaseAgeExcludePruner,
  trustPolicyExclude: trustPolicyExcludePruner,
  overrides: overridesPruner,
  onlyBuiltDependencies: onlyBuiltDependenciesPruner,
};

export async function run(): Promise<void> {
  const inputs = readActionInputs();
  const logger = actionsLogger;
  const cwd = path.resolve(process.cwd(), inputs.workingDirectory);
  logger.info(`Working directory: ${cwd}`);

  const packageManager = await detectPackageManager(cwd, inputs.packageManager);
  logger.info(`Package manager: ${packageManager}`);

  const workspace = await loadPnpmWorkspace(cwd);
  const packageJson = await loadPackageJson(cwd);
  const npmrc = await loadNpmrc(cwd);
  const lockfile = packageManager === 'pnpm' ? await loadPnpmLockfile(cwd) : null;

  if (!workspace && !packageJson) {
    core.setFailed(`No pnpm-workspace.yaml or package.json found in ${cwd}`);
    return;
  }
  if (packageManager === 'pnpm' && !lockfile) {
    logger.warn(
      'pnpm-lock.yaml is missing — release-age and onlyBuiltDependencies pruners will be conservative.',
    );
  }

  const ctx: PrunerContext = {
    cwd,
    packageManager,
    registry: new NpmRegistry(inputs.registry),
    workspace,
    packageJson,
    npmrc,
    lockfile,
    now: new Date(),
    logger,
  };

  const reports: PrunerReport[] = [];
  for (const targetName of inputs.targets) {
    const pruner = REGISTRY[targetName];
    if (!pruner) continue;
    const report = await logger.group(`Pruner: ${targetName}`, async () => {
      const r = await pruner.run(ctx);
      logReport(r);
      return r;
    });
    reports.push(report);
  }

  const changedFiles = await persistChanges(ctx, reports, inputs.dryRun, logger);
  const totalRemoved = summarizeRemovals(reports).length;
  const changed = changedFiles.length > 0 && totalRemoved > 0;
  core.setOutput('changed', changed ? 'true' : 'false');
  core.setOutput('pruned', JSON.stringify(reports));

  if (!changed) {
    logger.info('No stale entries found. Nothing to commit.');
    return;
  }

  if (!inputs.dryRun && packageManager === 'pnpm' && ctx.lockfile) {
    const regenerated = await logger.group('Regenerate pnpm-lock.yaml', async () => {
      return regeneratePnpmLockfile(cwd, logger);
    });
    if (regenerated && !changedFiles.includes(regenerated)) {
      changedFiles.push(regenerated);
    }
  }

  await writeSummary(reports);

  if (inputs.dryRun) {
    logger.info(`[dry-run] ${totalRemoved} entries would be removed across ${changedFiles.length} file(s).`);
    return;
  }
  if (!inputs.createPr) {
    logger.info(`Wrote changes to ${changedFiles.length} file(s); create-pr is false so leaving them in the working tree.`);
    return;
  }
  if (!inputs.githubToken) {
    core.setFailed('github-token is required to create a pull request.');
    return;
  }

  const base = inputs.prBase || (await resolveDefaultBranch(inputs.githubToken, cwd, logger));
  const branch = `${inputs.prBranch}/${formatBranchSuffix(ctx.now)}`;
  const pr = await createPullRequest({
    cwd,
    token: inputs.githubToken,
    branch,
    base,
    title: inputs.prTitle,
    commitMessage: inputs.commitMessage,
    labels: inputs.prLabels,
    changedFiles: [...new Set(changedFiles.map((f) => path.relative(cwd, f)))],
    reports,
    logger,
  });
  core.setOutput('pr-number', String(pr.number));
  core.setOutput('pr-url', pr.url);
}

async function persistChanges(
  ctx: PrunerContext,
  reports: PrunerReport[],
  dryRun: boolean,
  logger: Logger,
): Promise<string[]> {
  const changed = new Set<string>();
  for (const report of reports) {
    for (const entry of report.removed) changed.add(entry.file);
  }
  if (changed.size === 0) return [];
  if (dryRun) {
    logger.info(`[dry-run] Would write ${changed.size} file(s): ${[...changed].join(', ')}`);
    return [...changed];
  }
  if (ctx.workspace) await savePnpmWorkspace(ctx.workspace);
  if (ctx.packageJson) await savePackageJson(ctx.packageJson);
  if (ctx.npmrc) await saveNpmrc(ctx.npmrc);
  return [...changed];
}

function logReport(report: PrunerReport): void {
  if (report.removed.length === 0 && report.skipped.length === 0) {
    core.info('  no entries');
    return;
  }
  for (const entry of report.removed) {
    core.info(`  remove ${entry.key}${entry.value ? ` (${entry.value})` : ''} — ${entry.reason}`);
  }
  for (const entry of report.skipped) {
    core.info(`  keep   ${entry.key} — ${entry.reason}`);
  }
}

async function writeSummary(reports: PrunerReport[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const summary = core.summary.addHeading('Pruned supply-chain overrides', 2);
  for (const report of reports) {
    if (report.removed.length === 0) continue;
    summary.addHeading(report.pruner, 3);
    summary.addTable([
      [
        { data: 'Key', header: true },
        { data: 'Value', header: true },
        { data: 'Reason', header: true },
      ],
      ...report.removed.map((e) => [e.key, e.value ?? '', e.reason]),
    ]);
  }
  await summary.write();
}

function formatBranchSuffix(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) core.debug(err.stack);
});
