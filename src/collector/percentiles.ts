// The collector's poll-timing percentiles, computed once per window.
//
// THE PER-SECOND COST THAT STALLED THE THREAD (2026-09-25). snapshot() runs
// every second, and it used to call pct() four times - lag p50 and p95, poll
// p50 and p95 - each of which copied its window (10,000 to 20,000 entries at
// 30k entities) and sorted the copy with a comparator. A CPU profile of the
// collector thread at 30k put that at 32% of its 50 ms+ stretches
// (RESULTS-30K-CEILING section 6). Now each window is copied once, into a
// Float64Array, whose sort is numeric with no comparator call per step, and
// every percentile asked of it is read from the one sorted copy.
//
// The same answer as before, by construction and by test (test-percentiles):
// the rank formula is unchanged, and for finite numbers a Float64Array's sort
// order is the comparator's `a - b` order.

/**
 * Nearest-rank percentiles of `values`, one per entry of `ps` (0 to 100),
 * rounded to one decimal. An empty window reads 0, as it always has.
 * `values` is not modified.
 */
export function percentiles(values: readonly number[], ps: readonly number[]): number[] {
    if (values.length === 0) return ps.map(() => 0);
    const sorted = Float64Array.from(values).sort();
    return ps.map((p) => {
        const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
        return Number((sorted[Math.max(0, rank)] as number).toFixed(1));
    });
}
