import type { PackageManager } from '../types.js';
import { findPnpmLockfiles, loadPnpmLockfile, type PnpmLockfile } from './pnpm-lockfile.js';
import { findNpmLockfile, loadNpmLockfile } from './npm-lockfile.js';

/** How to find, read and regenerate a package manager's lockfiles. */
export interface LockfileManager {
  /** Display name of the lockfile, for messages. */
  name: string;
  /** Existing lockfile paths, as the ones to back up, restore and commit. */
  find(cwd: string): Promise<string[]>;
  load(cwd: string): Promise<PnpmLockfile | null>;
  /** Command that re-resolves the lockfiles without installing packages. */
  resolveCommand: { command: string; args: string[] };
}

const pnpm: LockfileManager = {
  name: 'pnpm-lock.yaml',
  find: findPnpmLockfiles,
  load: loadPnpmLockfile,
  resolveCommand: {
    command: 'pnpm',
    args: ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
  },
};

const npm: LockfileManager = {
  name: 'package-lock.json',
  async find(cwd) {
    const filePath = await findNpmLockfile(cwd);
    return filePath ? [filePath] : [];
  },
  load: loadNpmLockfile,
  resolveCommand: {
    command: 'npm',
    args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  },
};

export function lockfileManager(packageManager: PackageManager): LockfileManager {
  return packageManager === 'npm' ? npm : pnpm;
}
