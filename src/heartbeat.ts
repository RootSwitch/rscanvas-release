// The measurement that matters. ARCHITECTURE.md rule 6.
//
// A 10ms setInterval whose worst gap is how long every other user of this
// thread was stuck. Wall-clock timing will happily report a fast operation that
// blocked the loop for its entire duration; this will not. It found all five
// blocking incidents in the parent suite.
//
// Rule 6 also says this is a PERMANENT FIXTURE rather than a one-off
// measurement: one runs in every thread and the worst gap is exported on
// /api/health, because "which thread stalled" is the question the isolation
// design exists to answer.
//
// Promoted unchanged in behaviour from spike/src/heartbeat.ts.

export interface HeartbeatStats {
    thread: string;
    ticks: number;
    worstGapMs: number;
    p50GapMs: number;
    p99GapMs: number;
    thresholdMs: number;
    overThresholdCount: number;
}

export interface Heartbeat {
    stats: () => HeartbeatStats;
    reset: () => void;
    stop: () => void;
}

export function startHeartbeat(
    thread: string,
    intervalMs: number,
    thresholdMs = 50,
): Heartbeat {
    let last = performance.now();
    let worst = 0;
    let over = 0;
    let ticks = 0;
    // Gaps are small integers in milliseconds; a bucket map beats keeping every
    // sample when a run is minutes long.
    const buckets = new Map<number, number>();

    const record = (gap: number): void => {
        ticks++;
        if (gap > worst) worst = gap;
        if (gap > thresholdMs) over++;
        const key = gap < 1 ? 0 : Math.round(gap);
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
    };

    const timer = setInterval(() => {
        const now = performance.now();
        // Delay beyond the interval itself is the part that was not ours.
        record(Math.max(0, now - last - intervalMs));
        last = now;
    }, intervalMs);
    // Never hold the process open on the heartbeat alone.
    timer.unref();

    const percentile = (p: number): number => {
        if (ticks === 0) return 0;
        const target = Math.ceil((p / 100) * ticks);
        const keys = [...buckets.keys()].sort((a, b) => a - b);
        let seen = 0;
        for (const k of keys) {
            seen += buckets.get(k) ?? 0;
            if (seen >= target) return k;
        }
        return keys.length > 0 ? (keys.at(-1) as number) : 0;
    };

    return {
        stats: () => ({
            thread,
            ticks,
            worstGapMs: Number(worst.toFixed(1)),
            p50GapMs: percentile(50),
            p99GapMs: percentile(99),
            thresholdMs,
            overThresholdCount: over,
        }),
        reset: () => {
            worst = 0;
            over = 0;
            ticks = 0;
            buckets.clear();
            last = performance.now();
        },
        stop: () => clearInterval(timer),
    };
}
