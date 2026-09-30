import { PrunerError } from '../util/errors.js';

interface Member {
  key: string;
  /** Index of the key's opening quote. */
  start: number;
  valueStart: number;
  /** Index just past the value. */
  end: number;
}

/**
 * Remove `keys` from the top-level `overrides` object of a JSON document by
 * cutting their text out, so everything else (line endings, inline arrays,
 * key order) stays byte for byte. `overrides` itself is removed when it
 * becomes empty. Keys that are not present are ignored.
 */
export function removeOverrideKeys(text: string, keys: Iterable<string>): string {
  for (const key of keys) {
    const root = scanObject(text, text.indexOf('{'));
    const rootIndex = root.findIndex((m) => m.key === 'overrides');
    const overrides = root[rootIndex];
    if (!overrides || text[overrides.valueStart] !== '{') continue;
    const members = scanObject(text, overrides.valueStart);
    const index = members.findIndex((m) => m.key === key);
    if (index === -1) continue;
    text =
      members.length === 1
        ? removeMember(text, root, rootIndex)
        : removeMember(text, members, index);
  }
  return text;
}

/**
 * Cut member `index` out together with the separator that belongs to it: the
 * text up to the next key when one follows, else the comma after the previous
 * value.
 */
function removeMember(text: string, members: Member[], index: number): string {
  const member = members[index]!;
  const next = members[index + 1];
  if (next) return text.slice(0, member.start) + text.slice(next.start);
  const previous = members[index - 1];
  if (previous) return text.slice(0, previous.end) + text.slice(member.end);
  return text.slice(0, member.start) + text.slice(member.end);
}

function scanObject(text: string, open: number): Member[] {
  if (open < 0 || text[open] !== '{') throw new PrunerError('Expected a JSON object');
  const members: Member[] = [];
  let i = skipWhitespace(text, open + 1);
  while (text[i] !== '}') {
    if (text[i] !== '"') throw new PrunerError(`Unexpected character in JSON at ${i}`);
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    let j = skipWhitespace(text, keyEnd);
    if (text[j] !== ':') throw new PrunerError(`Expected ":" in JSON at ${j}`);
    j = skipWhitespace(text, j + 1);
    const end = skipValue(text, j);
    members.push({ key, start: i, valueStart: j, end });
    i = skipWhitespace(text, end);
    if (text[i] === ',') i = skipWhitespace(text, i + 1);
  }
  return members;
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

function skipValue(text: string, i: number): number {
  if (text[i] === '"') return skipString(text, i);
  if (text[i] === '{' || text[i] === '[') {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (c === '"') {
        j = skipString(text, j);
        continue;
      }
      if (c === '{' || c === '[') depth += 1;
      if (c === '}' || c === ']') depth -= 1;
      j += 1;
      if (depth === 0) return j;
    }
    throw new PrunerError('Unterminated JSON value');
  }
  let j = i;
  while (j < text.length && !/[\s,}\]]/.test(text[j]!)) j += 1;
  return j;
}
