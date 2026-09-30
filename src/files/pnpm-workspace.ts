import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
  Document,
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  isPair,
  isNode,
  YAMLMap,
  YAMLSeq,
  Scalar,
} from 'yaml';
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
 * place (consumers may choose to remove it via {@link removeKey}). Comments
 * around removed items are handled as described in {@link removeItems}.
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
  const trailing = removeItems(
    node as YAMLSeq,
    (item) => {
      if (isScalar(item) && typeof item.value === 'string' && targets.has(item.value)) {
        removed.push(item.value);
        return true;
      }
      return false;
    },
    () => undefined,
  );
  appendTrailing(node as YAMLSeq, trailing);
  return removed;
}

/**
 * Remove map entries with the given keys. Returns keys actually removed.
 * `subjectOf` names what an entry is about (e.g. the package an override
 * targets); a removed entry's own comment is handed to the next entry only
 * when both share a subject. Comments are otherwise handled as described in
 * {@link removeItems}.
 */
export function removeFromMap(
  doc: Document.Parsed,
  key: string,
  keysToRemove: Iterable<string>,
  subjectOf: (key: string) => string | undefined = () => undefined,
): string[] {
  const node = doc.get(key, true);
  if (!isMap(node)) return [];
  const targets = new Set(keysToRemove);
  const removed: string[] = [];
  const trailing = removeItems(
    node as YAMLMap,
    (pair) => {
      const k = pairKey(pair);
      if (k !== undefined && targets.has(k)) {
        removed.push(k);
        return true;
      }
      return false;
    },
    (pair) => {
      const k = pairKey(pair);
      return k === undefined ? undefined : subjectOf(k);
    },
  );
  appendTrailing(node as YAMLMap, trailing);
  return removed;
}

/** Whether a sequence/map at `key` is empty. */
export function isCollectionEmpty(doc: Document.Parsed, key: string): boolean {
  const node = doc.get(key, true);
  if (isSeq(node)) return node.items.length === 0;
  if (isMap(node)) return node.items.length === 0;
  return false;
}

/**
 * Remove the top-level `key`. Comment paragraphs above it that are separated
 * from it by a blank line (section headers) move to the next top-level key, or
 * to the end of the document when it was the last one.
 */
export function removeKey(doc: Document.Parsed, key: string): void {
  if (!isMap(doc.contents)) {
    doc.delete(key);
    return;
  }
  const trailing = removeItems(
    doc.contents as YAMLMap,
    (pair) => pairKey(pair) === key,
    () => undefined,
  );
  if (trailing.length > 0) {
    doc.comment = joinParagraphs([...trailing, ...trailingParagraphs(doc.comment)]) ?? null;
  }
}

function pairKey(item: unknown): string | undefined {
  if (!isPair(item)) return undefined;
  return isScalar(item.key) ? String(item.key.value) : String(item.key);
}

type CommentHolder = { commentBefore?: string | null; spaceBefore?: boolean };

function commentHolder(item: unknown): CommentHolder | undefined {
  if (isPair(item)) return isNode(item.key) ? (item.key as CommentHolder) : undefined;
  return isNode(item) ? (item as CommentHolder) : undefined;
}

/**
 * Split a leading comment into section headers and the paragraph sitting
 * directly on the item (`own`). yaml marks a blank line between the comment
 * and the item with a trailing newline, in which case every paragraph is a
 * header.
 */
function splitComment(comment: string | null | undefined): { headers: string[]; own?: string } {
  if (!comment) return { headers: [] };
  const text = comment.replace(/\r\n/g, '\n');
  const paras = text.replace(/\n+$/, '').split(/\n{2,}/);
  if (text.endsWith('\n')) return { headers: paras };
  return { headers: paras.slice(0, -1), own: paras[paras.length - 1] };
}

/** Inverse of {@link splitComment}; headers alone keep a blank line below them. */
function buildComment(headers: string[], own: string | undefined): string | undefined {
  if (own !== undefined) return joinParagraphs([...headers, own]);
  return headers.length > 0 ? `${joinParagraphs(headers)}\n` : undefined;
}

function joinParagraphs(paras: string[]): string | undefined {
  return paras.length > 0 ? paras.join('\n\n') : undefined;
}

/**
 * Remove the items matching `shouldRemove` from `coll` while keeping comments
 * that belong to what survives. A removed item's leading comment is split by
 * {@link splitComment}: headers move to the next surviving item, and the item's
 * own paragraph moves only to a next surviving item with the same subject that
 * has no own paragraph of its own; otherwise it is dropped. Headers left in a
 * removed item's value (its trailing comment) are carried the same way, and a
 * blank line before a removed item is kept before the next survivor. Returns
 * the headers left over when no item survives after them.
 */
function removeItems(
  coll: YAMLMap | YAMLSeq,
  shouldRemove: (item: unknown) => boolean,
  subjectOf: (item: unknown) => string | undefined,
): string[] {
  // yaml stores the first item's leading comment on the collection itself.
  const firstComment = coll.commentBefore;
  const kept: unknown[] = [];
  let headers: string[] = [];
  let pendingOwn: Array<{ text: string; subject: string | undefined }> = [];
  let pendingSpace = false;

  coll.items.forEach((item: unknown, index) => {
    const holder = commentHolder(item);
    const comment = index === 0 ? (firstComment ?? holder?.commentBefore) : holder?.commentBefore;
    const split = splitComment(comment);

    if (shouldRemove(item)) {
      if (index === 0) coll.commentBefore = undefined;
      headers.push(...split.headers);
      if (split.own !== undefined) pendingOwn.push({ text: split.own, subject: subjectOf(item) });
      const value = isPair(item) ? item.value : undefined;
      if (isMap(value) || isSeq(value)) headers.push(...trailingParagraphs(value.comment));
      if (holder?.spaceBefore || split.headers.length > 0) pendingSpace = true;
      return;
    }

    const subject = subjectOf(item);
    const inherited =
      split.own === undefined && subject !== undefined
        ? pendingOwn.filter((c) => c.subject === subject).map((c) => c.text)
        : [];
    const becameFirst = kept.length === 0 && index !== 0;
    if (holder && (headers.length > 0 || inherited.length > 0 || becameFirst || pendingSpace)) {
      if (index === 0) coll.commentBefore = undefined;
      const own = split.own ?? (inherited.length > 0 ? joinParagraphs(inherited) : undefined);
      holder.commentBefore = buildComment([...headers, ...split.headers], own);
      holder.spaceBefore = kept.length === 0 ? false : holder.spaceBefore || pendingSpace;
    }
    headers = [];
    pendingOwn = [];
    pendingSpace = false;
    kept.push(item);
  });

  coll.items = kept as typeof coll.items;
  return headers;
}

/** A trailing comment sits on no item, so all of its paragraphs are headers. */
function trailingParagraphs(comment: string | null | undefined): string[] {
  const { headers, own } = splitComment(comment);
  return own === undefined ? headers : [...headers, own];
}

function appendTrailing(coll: YAMLMap | YAMLSeq, trailing: string[]): void {
  if (trailing.length > 0) {
    coll.comment = joinParagraphs([...trailingParagraphs(coll.comment), ...trailing]);
  }
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
