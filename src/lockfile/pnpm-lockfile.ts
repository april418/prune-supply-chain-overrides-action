import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PrunerError } from '../util/errors.js';

export interface PnpmLockfile {
  filePath: string;
  lockfileVersion: string;
  /** Aggregated map of package name -> set of resolved versions referenced in the lockfile. */
  resolvedVersions: Map<string, Set<string>>;
  /** Root-level `overrides` block recorded in the lockfile, if any. */
  recordedOverrides: Record<string, string>;
  /** Raw parsed object (for advanced use cases). */
  raw: Record<string, unknown>;
}

export async function loadPnpmLockfile(cwd: string): Promise<PnpmLockfile | null> {
  const filePath = path.join(cwd, 'pnpm-lock.yaml');
  try {
    await access(filePath);
  } catch {
    return null;
  }
  const raw = await readFile(filePath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw) as Record<string, unknown>;
  } catch (err) {
    throw new PrunerError(`Failed to parse pnpm-lock.yaml: ${(err as Error).message}`, err);
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

  return { filePath, lockfileVersion, resolvedVersions, recordedOverrides, raw: parsed };
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
