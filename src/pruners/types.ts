import type { NpmRegistry } from '../registry/npm-registry.js';
import type { PnpmWorkspaceData } from '../files/pnpm-workspace.js';
import type { PackageJsonData } from '../files/package-json.js';
import type { NpmrcData } from '../files/npmrc.js';
import type { PnpmLockfile } from '../lockfile/pnpm-lockfile.js';
import type { Logger } from '../util/logger.js';
import type { PackageManager, PrunerReport } from '../types.js';

export interface PrunerContext {
  cwd: string;
  packageManager: PackageManager;
  registry: NpmRegistry;
  workspace: PnpmWorkspaceData | null;
  packageJson: PackageJsonData | null;
  npmrc: NpmrcData | null;
  lockfile: PnpmLockfile | null;
  now: Date;
  logger: Logger;
}

export interface Pruner {
  name: PrunerReport['pruner'];
  run(ctx: PrunerContext): Promise<PrunerReport>;
}
