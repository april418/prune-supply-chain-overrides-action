import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { PrunerError } from '../util/errors.js';
import { removeOverrideKeys } from './json-text.js';

export interface PackageJsonData {
  filePath: string;
  raw: string;
  /**
   * Parsed JSON. Edit it only through helpers such as {@link removeOverrides},
   * which keep `text` in step; {@link savePackageJson} writes `text`.
   */
  json: Record<string, unknown>;
  /** The file's content with the edits applied so far, formatted as the original. */
  text: string;
}

export async function loadPackageJson(cwd: string): Promise<PackageJsonData | null> {
  const filePath = path.join(cwd, 'package.json');
  try {
    await access(filePath);
  } catch {
    return null;
  }
  const raw = await readFile(filePath, 'utf8');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new PrunerError(`Failed to parse package.json: ${(err as Error).message}`, err);
  }
  return {
    filePath,
    raw,
    json,
    text: raw,
  };
}

/** Remove `keys` from `overrides`, cutting them out of `text` so its formatting stays. */
export function removeOverrides(data: PackageJsonData, keys: string[]): void {
  removeFromObjectField(data.json, 'overrides', keys);
  data.text = removeOverrideKeys(data.text, keys);
}

export async function savePackageJson(data: PackageJsonData): Promise<void> {
  const next = data.text;
  if (next === data.raw) return;
  await writeFile(data.filePath, next, 'utf8');
  data.raw = next;
}

/** Remove keys from an object field. Returns keys actually removed. */
export function removeFromObjectField(
  json: Record<string, unknown>,
  field: string,
  keysToRemove: Iterable<string>,
): string[] {
  const value = json[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const obj = value as Record<string, unknown>;
  const targets = new Set(keysToRemove);
  const removed: string[] = [];
  for (const key of Object.keys(obj)) {
    if (targets.has(key)) {
      delete obj[key];
      removed.push(key);
    }
  }
  if (Object.keys(obj).length === 0) delete json[field];
  return removed;
}
