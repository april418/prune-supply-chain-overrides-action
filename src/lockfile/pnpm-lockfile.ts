import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseIni } from 'ini';
import { PrunerError } from '../util/errors.js';

export interface PnpmLockfile {
  /** The root lockfile, or the first project lockfile when lockfiles are not shared. */
  filePath: string;
  /** Every lockfile merged into this view (see {@link findPnpmLockfiles}). */
  filePaths: string[];
  lockfileVersion: string;
  /** Aggregated map of package name -> set of resolved versions referenced in the lockfile. */
  resolvedVersions: Map<string, Set<string>>;
  /** Root-level `overrides` block recorded in the lockfile, if any. */
  recordedOverrides: Record<string, string>;
  /** Raw parsed object (for advanced use cases). */
  raw: Record<string, unknown>;
}

/**
 * Load the project's lockfiles as one view: resolved versions and recorded
 * overrides are merged across every file {@link findPnpmLockfiles} returns.
 * Returns null when there is none.
 */
export async function loadPnpmLockfile(cwd: string): Promise<PnpmLockfile | null> {
  const filePaths = await findPnpmLockfiles(cwd);
  if (filePaths.length === 0) return null;
  const parts = await Promise.all(filePaths.map(parseLockfileFile));
  const resolvedVersions = new Map<string, Set<string>>();
  const recordedOverrides: Record<string, string> = {};
  for (const part of parts) {
    for (const [name, versions] of part.resolvedVersions) {
      const bucket = resolvedVersions.get(name) ?? new Set<string>();
      for (const v of versions) bucket.add(v);
      resolvedVersions.set(name, bucket);
    }
    Object.assign(recordedOverrides, part.recordedOverrides);
  }
  return {
    filePath: filePaths[0]!,
    filePaths,
    lockfileVersion: parts[0]!.lockfileVersion,
    resolvedVersions,
    recordedOverrides,
    raw: parts[0]!.raw,
  };
}

/**
 * Paths of the lockfiles pnpm maintains for the project at `cwd`: the root
 * `pnpm-lock.yaml`, or, with `sharedWorkspaceLockfile: false` (or
 * `shared-workspace-lockfile=false` in .npmrc), every `pnpm-lock.yaml` below
 * `cwd` outside node_modules. Only existing files are returned, sorted.
 */
export async function findPnpmLockfiles(cwd: string): Promise<string[]> {
  if (await lockfilesAreShared(cwd)) {
    const root = path.join(cwd, 'pnpm-lock.yaml');
    try {
      await access(root);
      return [root];
    } catch {
      return [];
    }
  }
  const found: string[] = [];
  await collectLockfiles(cwd, found);
  return found.sort();
}

async function lockfilesAreShared(cwd: string): Promise<boolean> {
  const workspace = await readOptional(path.join(cwd, 'pnpm-workspace.yaml'));
  if (workspace !== null) {
    const parsed = parseYaml(workspace) as Record<string, unknown> | null;
    if (parsed?.sharedWorkspaceLockfile === false) return false;
  }
  const npmrc = await readOptional(path.join(cwd, '.npmrc'));
  if (npmrc !== null) {
    const value = parseIni(npmrc)['shared-workspace-lockfile'];
    if (value === false || value === 'false') return false;
  }
  return true;
}

async function collectLockfiles(dir: string, found: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await collectLockfiles(path.join(dir, entry.name), found);
    } else if (entry.isFile() && entry.name === 'pnpm-lock.yaml') {
      found.push(path.join(dir, entry.name));
    }
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function parseLockfileFile(
  filePath: string,
): Promise<Omit<PnpmLockfile, 'filePath' | 'filePaths'>> {
  const raw = await readFile(filePath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw) as Record<string, unknown>;
  } catch (err) {
    throw new PrunerError(`Failed to parse ${filePath}: ${(err as Error).message}`, err);
  }
  const lockfileVersion = String(parsed.lockfileVersion ?? '');
  const resolvedVersions = new Map<string, Set<string>>();

  for (const section of ['packages', 'snapshots'] as const) {
    const block = parsed[section];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      for (const id of Object.keys(block)) {
        const parsedId = parsePackageId(id);
        if (!parsedId) continue;
        let bucket = resolvedVersions.get(parsedId.name);
        if (!bucket) {
          bucket = new Set();
          resolvedVersions.set(parsedId.name, bucket);
        }
        bucket.add(parsedId.version);
      }
    }
  }

  const importers = parsed.importers as Record<string, unknown> | undefined;
  if (importers) {
    for (const importer of Object.values(importers)) {
      if (!importer || typeof importer !== 'object') continue;
      for (const dep of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const deps = (importer as Record<string, unknown>)[dep] as
          | Record<string, { specifier?: string; version?: string }>
          | undefined;
        if (!deps) continue;
        for (const [name, info] of Object.entries(deps)) {
          if (!info || typeof info.version !== 'string') continue;
          const version = stripVersionSuffix(info.version);
          if (!version) continue;
          let bucket = resolvedVersions.get(name);
          if (!bucket) {
            bucket = new Set();
            resolvedVersions.set(name, bucket);
          }
          bucket.add(version);
        }
      }
    }
  }

  const overrides = parsed.overrides as Record<string, string> | undefined;
  const recordedOverrides: Record<string, string> = {};
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'string') recordedOverrides[k] = v;
    }
  }

  return { lockfileVersion, resolvedVersions, recordedOverrides, raw: parsed };
}

/**
 * Parse a pnpm-lock package id such as `fast-uri@3.1.2`, `@next/swc-linux-x64-gnu@16.2.6`,
 * or `react@19.2.5(@types/react@19.2.14)`. Peer-dep parentheses and `_hash`
 * suffixes are stripped before the name/version split so that an `@` inside
 * the suffix does not confuse the parser.
 */
function parsePackageId(id: string): { name: string; version: string } | null {
  const stripped = stripVersionSuffix(id);
  const atIndex = stripped.lastIndexOf('@');
  if (atIndex <= 0) return null;
  const name = stripped.slice(0, atIndex);
  const version = stripped.slice(atIndex + 1);
  if (!version) return null;
  return { name, version };
}

/** Strip suffixes like "(peer-spec)" or "_..." from a resolved version. */
function stripVersionSuffix(version: string): string {
  const paren = version.indexOf('(');
  if (paren !== -1) version = version.slice(0, paren);
  const underscore = version.indexOf('_');
  if (underscore !== -1) version = version.slice(0, underscore);
  return version.trim();
}
