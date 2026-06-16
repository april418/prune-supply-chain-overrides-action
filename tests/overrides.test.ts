import { describe, expect, it } from 'vitest';
import { overrideTargetName } from '../src/pruners/overrides.js';

describe('overrideTargetName', () => {
  it('strips a version selector from an unscoped key', () => {
    expect(overrideTargetName('tmp@<0.2.6')).toBe('tmp');
    expect(overrideTargetName('lodash@<=4.17.23')).toBe('lodash');
    expect(overrideTargetName('shell-quote@<1.8.4')).toBe('shell-quote');
    expect(overrideTargetName('ws@<8.21.0')).toBe('ws');
  });

  it('keeps the scope and strips the selector from a scoped key', () => {
    expect(overrideTargetName('@scope/pkg@<1.0.0')).toBe('@scope/pkg');
    expect(overrideTargetName('@babel/core@<7.0.0')).toBe('@babel/core');
  });

  it('returns the name unchanged when there is no selector', () => {
    expect(overrideTargetName('lodash')).toBe('lodash');
    expect(overrideTargetName('@scope/pkg')).toBe('@scope/pkg');
  });

  it('targets the child package in the nested parent>child syntax', () => {
    expect(overrideTargetName('foo>bar@1.0.0')).toBe('bar');
    expect(overrideTargetName('foo@1>@scope/bar@<2.0.0')).toBe('@scope/bar');
    expect(overrideTargetName('foo>bar')).toBe('bar');
  });
});
