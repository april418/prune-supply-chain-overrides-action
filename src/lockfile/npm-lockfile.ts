import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { PrunerError } from '../util/errors.js';
import type { PnpmLockfile } from './pnpm-lockfile.js';

/**
 * The lockfile npm maintains for the project at `cwd`: `npm-shrinkwrap.json`
 * takes precedence over `package-lock.json`, as in npm. Null when neither exists.
 */
export async function findNpmLockfile(cwd: string): Promise<string | null> {
  for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
    const filePath = path.join(cwd, name);
    try {
      await access(filePath);
      return filePath;
    } catch {
      // try the next name
    }
  }
  return null;
}

/**
 * Load the npm lockfile (see {@link findNpmLockfile}) into the same shape as
 * {@link loadPnpmLockfile}. Returns null when there is none, and throws for
 * lockfileVersion 1, which has no `packages` map. Only installed packages
 * (`node_modules/...` entries) count; workspace projects and links are not
 * resolved versions.
 */
export async function loadNpmLockfile(cwd: string): Promise<PnpmLockfile | null> {
  const filePath = await findNpmLockfile(cwd);
  if (!filePath) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new PrunerError(`Failed to parse ${filePath}: ${(err as Error).message}`, err);
  }
  if (Number(parsed.lockfileVersion) < 2) {
    throw new PrunerError(
      `${filePath} is lockfileVersion ${String(parsed.lockfileVersion)}; regenerate it with npm 7 or later.`,
    );
  }

  const resolvedVersions = new Map<string, Set<string>>();
  const packages = (parsed.packages ?? {}) as Record<string, { version?: string; link?: boolean }>;
  for (const [location, entry] of Object.entries(packages)) {
    const at = location.lastIndexOf('node_modules/');
    if (at === -1 || entry.link || typeof entry.version !== 'string') continue;
    const name = location.slice(at + 'node_modules/'.length);
    const bucket = resolvedVersions.get(name) ?? new Set<string>();
    bucket.add(entry.version);
    resolvedVersions.set(name, bucket);
  }

  return {
    filePath,
    filePaths: [filePath],
    lockfileVersion: String(parsed.lockfileVersion ?? ''),
    resolvedVersions,
    recordedOverrides: {},
    raw: parsed,
  };
}
