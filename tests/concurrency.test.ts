import { describe, expect, it } from 'vitest';
import { findFirst } from '../src/util/concurrency.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe('findFirst', () => {
  it('keeps at most `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await findFirst([...Array(20).keys()], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return undefined;
    });
    expect(result).toBeUndefined();
    expect(peak).toBe(4);
  });

  it('starts no call after a value is found and waits for the ones in flight', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const result = await findFirst([...Array(20).keys()], 3, async (i) => {
      started.push(i);
      await tick();
      finished.push(i);
      return i === 0 ? 'found' : undefined;
    });
    expect(result).toBe('found');
    expect(started).toEqual([0, 1, 2]);
    expect(finished.sort()).toEqual([0, 1, 2]);
  });

  it('returns the value of the first call to settle with one', async () => {
    const result = await findFirst([30, 1], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(result).toBe(1);
  });

  it('rejects with the error of a failed call and starts no further call', async () => {
    const started: number[] = [];
    const promise = findFirst([...Array(20).keys()], 2, async (i) => {
      started.push(i);
      await tick();
      if (i === 0) throw new Error('boom');
      return undefined;
    });
    await expect(promise).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });
});
