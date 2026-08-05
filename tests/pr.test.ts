import { describe, expect, it } from 'vitest';
import { isSupersededBranch } from '../src/github/pr.js';

describe('isSupersededBranch', () => {
  const branch = 'chore/prune-supply-chain-overrides';

  it('matches legacy timestamped branches', () => {
    expect(isSupersededBranch(branch, `${branch}/202607200707`)).toBe(true);
  });

  it('does not match the fixed branch itself', () => {
    expect(isSupersededBranch(branch, branch)).toBe(false);
  });

  it('does not match suffixes that are not a 12-digit timestamp', () => {
    expect(isSupersededBranch(branch, `${branch}/2026072007`)).toBe(false);
    expect(isSupersededBranch(branch, `${branch}/20260720070700`)).toBe(false);
    expect(isSupersededBranch(branch, `${branch}/not-a-timestamp`)).toBe(false);
    expect(isSupersededBranch(branch, `${branch}/202607200707/extra`)).toBe(false);
  });

  it('does not match unrelated branches', () => {
    expect(isSupersededBranch(branch, 'feature/202607200707')).toBe(false);
    expect(isSupersededBranch(branch, `${branch}-other/202607200707`)).toBe(false);
  });
});
