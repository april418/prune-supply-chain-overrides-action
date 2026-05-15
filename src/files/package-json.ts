import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { PrunerError } from '../util/errors.js';

export interface PackageJsonData {
  filePath: string;
  raw: string;
  /** Parsed JSON. Mutations are written back via {@link savePackageJson}. */
  json: Record<string, unknown>;
  /** Indentation string detected from the source ("  ", "\t", etc.). */
  indent: string;
  /** Whether the file ends with a newline. */
  trailingNewline: boolean;
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
    indent: detectIndent(raw),
    trailingNewline: raw.endsWith('\n'),
  };
}

export async function savePackageJson(data: PackageJsonData): Promise<void> {
  let next = JSON.stringify(data.json, null, data.indent);
  if (data.trailingNewline) next += '\n';
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

function detectIndent(raw: string): string {
  for (const line of raw.split('\n')) {
    const match = /^([ \t]+)\S/.exec(line);
    if (match) return match[1]!;
  }
  return '  ';
}
