import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Light-weight .npmrc representation that preserves line ordering and comments.
 * We treat each non-empty, non-comment line as `key=value`. Sequence-style keys
 * (e.g. `key[]=...`) are stored verbatim and considered when removing entries.
 */
export interface NpmrcData {
  filePath: string;
  raw: string;
  lines: string[];
}

export async function loadNpmrc(cwd: string): Promise<NpmrcData | null> {
  const filePath = path.join(cwd, '.npmrc');
  try {
    await access(filePath);
  } catch {
    return null;
  }
  const raw = await readFile(filePath, 'utf8');
  return { filePath, raw, lines: raw.split('\n') };
}

export async function saveNpmrc(data: NpmrcData): Promise<void> {
  const next = data.lines.join('\n');
  if (next === data.raw) return;
  await writeFile(data.filePath, next, 'utf8');
  data.raw = next;
}

/** Return all values for a given key, including `key[]=` style. */
export function readArrayKey(data: NpmrcData, key: string): string[] {
  const prefix = `${key}=`;
  const arrayPrefix = `${key}[]=`;
  const out: string[] = [];
  for (const line of data.lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    if (trimmed.startsWith(arrayPrefix)) {
      out.push(trimmed.slice(arrayPrefix.length).trim());
    } else if (trimmed.startsWith(prefix)) {
      out.push(trimmed.slice(prefix.length).trim());
    }
  }
  return out;
}

/** Remove all `key=value` / `key[]=value` lines where `value` is in `values`. */
export function removeArrayValues(data: NpmrcData, key: string, values: Iterable<string>): string[] {
  const prefix = `${key}=`;
  const arrayPrefix = `${key}[]=`;
  const targets = new Set(values);
  const removed: string[] = [];
  data.lines = data.lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(arrayPrefix)) {
      const v = trimmed.slice(arrayPrefix.length).trim();
      if (targets.has(v)) {
        removed.push(v);
        return false;
      }
    } else if (trimmed.startsWith(prefix)) {
      const v = trimmed.slice(prefix.length).trim();
      if (targets.has(v)) {
        removed.push(v);
        return false;
      }
    }
    return true;
  });
  return removed;
}
