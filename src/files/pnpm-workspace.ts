import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { Document, parseDocument, isMap, isSeq, isScalar, YAMLMap, YAMLSeq, Scalar } from 'yaml';
import { PrunerError } from '../util/errors.js';

const SCALAR_KEYS = [
  'minimumReleaseAge',
  'trustPolicyIgnoreAfter',
  'packageManagerStrict',
  'packageManagerStrictVersion',
  'strictPeerDependencies',
  'blockExoticSubdeps',
  'verifyDepsBeforeRun',
  'trustPolicy',
] as const;

export interface PnpmWorkspaceData {
  /** Resolved absolute path of pnpm-workspace.yaml. */
  filePath: string;
  /** Raw source text. */
  raw: string;
  /** Parsed yaml document (mutable, preserves comments). */
  document: Document.Parsed;
  /** Effective minimumReleaseAge in minutes (0 when unset). */
  minimumReleaseAge: number;
  /** Effective trustPolicyIgnoreAfter in minutes (0 when unset). */
  trustPolicyIgnoreAfter: number;
}

/** Load pnpm-workspace.yaml from `cwd`. Returns null when the file does not exist. */
export async function loadPnpmWorkspace(cwd: string): Promise<PnpmWorkspaceData | null> {
  const filePath = path.join(cwd, 'pnpm-workspace.yaml');
  try {
    await access(filePath);
  } catch {
    return null;
  }
  const raw = await readFile(filePath, 'utf8');
  const document = parseDocument(raw, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw new PrunerError(
      `Failed to parse pnpm-workspace.yaml: ${document.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return {
    filePath,
    raw,
    document,
    minimumReleaseAge: readNumberKey(document, 'minimumReleaseAge') ?? 0,
    trustPolicyIgnoreAfter: readNumberKey(document, 'trustPolicyIgnoreAfter') ?? 0,
  };
}

export async function savePnpmWorkspace(data: PnpmWorkspaceData): Promise<void> {
  const next = data.document.toString({ lineWidth: 0 });
  if (next === data.raw) return;
  await writeFile(data.filePath, next, 'utf8');
  data.raw = next;
}

/** Read the YAML sequence at `key`, returning each item's scalar value. */
export function readSequenceKeys(
  doc: Document.Parsed,
  key: string,
): Array<{ value: string; node: Scalar }> {
  const node = doc.get(key, true);
  if (!node) return [];
  if (!isSeq(node)) {
    throw new PrunerError(`Expected ${key} to be a YAML sequence`);
  }
  const out: Array<{ value: string; node: Scalar }> = [];
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === 'string') {
      out.push({ value: item.value, node: item as Scalar });
    }
  }
  return out;
}

/** Read the YAML map at `key`, returning each entry's key/value. */
export function readMapEntries(
  doc: Document.Parsed,
  key: string,
): Array<{ key: string; value: string }> {
  const node = doc.get(key, true);
  if (!node) return [];
  if (!isMap(node)) {
    throw new PrunerError(`Expected ${key} to be a YAML map`);
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const pair of node.items) {
    const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const v = isScalar(pair.value) ? String(pair.value?.value ?? '') : String(pair.value ?? '');
    out.push({ key: k, value: v });
  }
  return out;
}

/**
 * Remove `values` from the YAML sequence at `key`. Returns the keys actually
 * removed. If the sequence becomes empty, the sequence node itself is left in
 * place (consumers may choose to remove it via {@link removeKey}).
 */
export function removeFromSequence(
  doc: Document.Parsed,
  key: string,
  values: Iterable<string>,
): string[] {
  const node = doc.get(key, true);
  if (!isSeq(node)) return [];
  const targets = new Set(values);
  const removed: string[] = [];
  const seq = node as YAMLSeq;
  seq.items = seq.items.filter((item) => {
    if (isScalar(item) && typeof item.value === 'string' && targets.has(item.value)) {
      removed.push(item.value);
      return false;
    }
    return true;
  });
  return removed;
}

/** Remove map entries with the given keys. Returns keys actually removed. */
export function removeFromMap(
  doc: Document.Parsed,
  key: string,
  keysToRemove: Iterable<string>,
): string[] {
  const node = doc.get(key, true);
  if (!isMap(node)) return [];
  const targets = new Set(keysToRemove);
  const removed: string[] = [];
  const map = node as YAMLMap;
  map.items = map.items.filter((pair) => {
    const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (targets.has(k)) {
      removed.push(k);
      return false;
    }
    return true;
  });
  return removed;
}

/** Whether a sequence/map at `key` is empty. */
export function isCollectionEmpty(doc: Document.Parsed, key: string): boolean {
  const node = doc.get(key, true);
  if (isSeq(node)) return node.items.length === 0;
  if (isMap(node)) return node.items.length === 0;
  return false;
}

export function removeKey(doc: Document.Parsed, key: string): void {
  doc.delete(key);
}

function readNumberKey(doc: Document.Parsed, key: string): number | null {
  const value = doc.get(key);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const _internal = { SCALAR_KEYS };
