/**
 * Runs `run` over `items` with at most `limit` promises pending at a time,
 * preserving input order in the results. A handful of worker loops pulling
 * from a shared cursor is all this needs; adding a dependency for it would
 * cost more than the fifteen lines it replaces.
 *
 * The reason this exists at all is GitHub: its secondary rate limits trigger
 * on CONCURRENCY, not only on volume, so an unbounded Promise.all over N
 * targets starts getting throttled precisely when a caller fans out the most.
 * Callers cap the fan-out here instead of each rediscovering that the hard way.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}
