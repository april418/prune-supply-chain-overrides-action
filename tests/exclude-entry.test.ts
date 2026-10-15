import { describe, expect, it } from 'vitest';
import { parseExcludeEntry } from '../src/pruners/exclude-entry.js';

describe('parseExcludeEntry', () => {
  it('matches a plain name exactly', () => {
    const entry = parseExcludeEntry('next')!;
    expect(entry.matches('next')).toBe(true);
    expect(entry.matches('next-auth')).toBe(false);
    expect(entry.versions).toEqual([]);
    expect(entry.isPattern).toBe(false);
  });

  it('treats * as a wildcard', () => {
    const entry = parseExcludeEntry('@next/*')!;
    expect(entry.matches('@next/env')).toBe(true);
    expect(entry.matches('@next/swc-linux-x64-gnu')).toBe(true);
    expect(entry.matches('next')).toBe(false);
    expect(entry.matches('@nextui/react')).toBe(false);
    expect(entry.isPattern).toBe(true);
  });

  it('lets * match any run of characters, including / and none at all', () => {
    expect(parseExcludeEntry('@next*')!.matches('@next/env')).toBe(true);
    expect(parseExcludeEntry('next*')!.matches('next')).toBe(true);
    expect(parseExcludeEntry('*')!.matches('@a/b')).toBe(true);
  });

  it('anchors the pattern to the whole name', () => {
    expect(parseExcludeEntry('lodash.*')!.matches('x-lodash.merge')).toBe(false);
    expect(parseExcludeEntry('*-loader')!.matches('css-loader-x')).toBe(false);
  });

  it('does not treat other regular expression characters as special', () => {
    const entry = parseExcludeEntry('lodash.*')!;
    expect(entry.matches('lodash.merge')).toBe(true);
    expect(entry.matches('lodashXmerge')).toBe(false);
  });

  it('reads exact versions joined by ||', () => {
    expect(parseExcludeEntry('webpack@4.47.0 || 5.102.1')!.versions).toEqual(['4.47.0', '5.102.1']);
    expect(parseExcludeEntry('webpack@v5.102.1')!.versions).toEqual(['5.102.1']);
    const scoped = parseExcludeEntry('@scope/pkg@1.0.0')!;
    expect(scoped.matches('@scope/pkg')).toBe(true);
    expect(scoped.versions).toEqual(['1.0.0']);
  });

  it('returns null for entries pnpm rejects or that cannot be judged by age', () => {
    expect(parseExcludeEntry('webpack@^5.0.0')).toBeNull();
    expect(parseExcludeEntry('@scope/*@1.0.0')).toBeNull();
    expect(parseExcludeEntry('!next')).toBeNull();
  });
});
