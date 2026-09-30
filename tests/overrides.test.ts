import { describe, expect, it } from 'vitest';
import { overrideTargetName, parseOverrideKey } from '../src/pruners/overrides.js';

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

  it('does not treat the ">" of a ">=" / ">" selector as the parent>child delimiter', () => {
    expect(overrideTargetName('dompurify@>=1.0.10 <3.4.0')).toBe('dompurify');
    expect(overrideTargetName('brace-expansion@>=2.0.0 <2.1.4')).toBe('brace-expansion');
    expect(overrideTargetName('@scope/pkg@>1.0.0')).toBe('@scope/pkg');
    expect(overrideTargetName('foo@>=1 <2>bar@>=3.0.0 <3.1.0')).toBe('bar');
  });
});

describe('parseOverrideKey', () => {
  it('returns the selector of the target package', () => {
    expect(parseOverrideKey('brace-expansion@>=2.0.0 <2.1.4')).toEqual({
      name: 'brace-expansion',
      selector: '>=2.0.0 <2.1.4',
    });
    expect(parseOverrideKey('foo@1>@scope/bar@<2.0.0')).toEqual({
      name: '@scope/bar',
      selector: '<2.0.0',
    });
    expect(parseOverrideKey('@scope/pkg')).toEqual({ name: '@scope/pkg' });
  });

  it('splits at the first "@" after the name, as pnpm does', () => {
    expect(parseOverrideKey('foo@npm:bar@^1.0.0')).toEqual({
      name: 'foo',
      selector: 'npm:bar@^1.0.0',
    });
    expect(parseOverrideKey('@scope/foo@npm:@scope/bar@1')).toEqual({
      name: '@scope/foo',
      selector: 'npm:@scope/bar@1',
    });
  });
});
