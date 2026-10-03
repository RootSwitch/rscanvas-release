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
    /** When worstGapMs happened (ISO), null before any gap. DISPLAY. */
    worstGapAt: string | null;
    p50GapMs: number;
    p99GapMs: number;
    thresholdMs: number;
    overThresholdCount: number;
    /** The last HEARTBEAT_WINDOW_MS only: what the health verdict judges. */
    recent: HeartbeatWindow;
}

export interface HeartbeatWindow {
    windowMs: number;
    ticks: number;
    worstGapMs: number;
    overThresholdCount: number;
}

export interface Heartbeat {
    stats: () => HeartbeatStats;
    reset: () => void;
    stop: () => void;
}

// THE VERDICT'S WINDOW (2026-10-02). Everything above `recent` counts from
// process start, and a since-start maximum can only rise: one stall made
// health red until the next restart. Production met it the first morning
// after alpha.5 - its VM host's 06:00 backup held every poll up to 2.2 s,
// and the page still said so that evening. The since-start figures stay,
// because "worst ever, and when" is a fact worth keeping; the verdict reads
// this window, so a stall shows for a quarter of an hour and then clears.
export const HEARTBEAT_WINDOW_MS = 15 * 60_000;
const SLOT_MS = 60_000;

export interface GapWindow {
    record: (gapMs: number, nowMs: number) => void;
    read: (nowMs: number) => HeartbeatWindow;
    clear: () => void;
}

/**
 * Gaps over the last `windowMs`, kept as one-minute slots in a ring, so the
 * window costs a fixed few hundred bytes whatever the tick rate. A slot is
 * reused when its minute comes round again; a slot whose minute is older
 * than the window is skipped on read, which covers a thread that stopped
 * ticking altogether. The window is whole slots, so it spans the current
 * minute and the fourteen before it. Pure over the clock it is handed, so
 * tools/test-heartbeat-window.ts can drive it through an hour in a loop.
 */
export function gapWindow(
    thresholdMs: number, windowMs = HEARTBEAT_WINDOW_MS, slotMs = SLOT_MS,
): GapWindow {
    const n = Math.max(1, Math.ceil(windowMs / slotMs));
    const minute = new Float64Array(n).fill(-Infinity);
    const ticks = new Float64Array(n);
    const over = new Float64Array(n);
    const worst = new Float64Array(n);
    return {
        record: (gapMs, nowMs) => {
            const k = Math.floor(nowMs / slotMs);
            const i = k % n;
            if (minute[i] !== k) {
                minute[i] = k; ticks[i] = 0; over[i] = 0; worst[i] = 0;
            }
            ticks[i]++;
            if (gapMs > thresholdMs) over[i]++;
            if (gapMs > worst[i]) worst[i] = gapMs;
        },
        read: (nowMs) => {
            const k = Math.floor(nowMs / slotMs);
            let t = 0;
            let o = 0;
            let w = 0;
            for (let i = 0; i < n; i++) {
                if (minute[i] <= k - n || minute[i] > k) continue;
                t += ticks[i];
                o += over[i];
                if (worst[i] > w) w = worst[i];
            }
            return { windowMs: n * slotMs, ticks: t, worstGapMs: Number(w.toFixed(1)), overThresholdCount: o };
        },
        clear: () => {
            minute.fill(-Infinity); ticks.fill(0); over.fill(0); worst.fill(0);
        },
    };
}

export function startHeartbeat(
    thread: string,
    intervalMs: number,
    thresholdMs = 50,
): Heartbeat {
    let last = performance.now();
    let worst = 0;
    let worstAt: number | null = null;
    let over = 0;
    let ticks = 0;
    // Gaps are small integers in milliseconds; a bucket map beats keeping every
    // sample when a run is minutes long.
    const buckets = new Map<number, number>();
    const recent = gapWindow(thresholdMs);

    const record = (gap: number, now: number): void => {
        ticks++;
        if (gap > worst) { worst = gap; worstAt = Date.now(); }
        if (gap > thresholdMs) over++;
        const key = gap < 1 ? 0 : Math.round(gap);
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
        recent.record(gap, now);
    };

    const timer = setInterval(() => {
        const now = performance.now();
        // Delay beyond the interval itself is the part that was not ours.
        record(Math.max(0, now - last - intervalMs), now);
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
            worstGapAt: worstAt === null ? null : new Date(worstAt).toISOString(),
            p50GapMs: percentile(50),
            p99GapMs: percentile(99),
            thresholdMs,
            overThresholdCount: over,
            recent: recent.read(performance.now()),
        }),
        reset: () => {
            worst = 0;
            worstAt = null;
            over = 0;
            ticks = 0;
            buckets.clear();
            recent.clear();
            last = performance.now();
        },
        stop: () => clearInterval(timer),
    };
}
