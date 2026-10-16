/**
 * Calls `fn` on the items with at most `limit` calls in flight and resolves to
 * the value of the first call to settle with something other than undefined,
 * or to undefined when none does. Rejects if any call rejects. No call starts
 * once a value is found or a call rejects, and the calls already in flight are
 * awaited before this settles.
 */
export async function findFirst<T, R>(
  items: Iterable<T>,
  limit: number,
  fn: (item: T) => Promise<R | undefined>,
): Promise<R | undefined> {
  const iterator = items[Symbol.iterator]();
  let found: { value: R } | undefined;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!found && !failed) {
      const next = iterator.next();
      if (next.done) return;
      try {
        const value = await fn(next.value);
        if (value !== undefined) found ??= { value };
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, limit) }, worker));
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  return found?.value;
}
