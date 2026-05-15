import { describe, expect, it } from 'vitest';
import { formatMinutes } from '../src/util/format.js';

describe('formatMinutes', () => {
  it('formats sub-hour values in minutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(30)).toBe('30m');
  });

  it('formats sub-day values in hours and minutes', () => {
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h 30m');
  });

  it('formats multi-day values in days and hours', () => {
    expect(formatMinutes(60 * 24 * 10)).toBe('10d');
    expect(formatMinutes(60 * 24 * 10 + 60)).toBe('10d 1h');
    expect(formatMinutes(60 * 24 * 10 + 30)).toBe('10d');
  });
});
