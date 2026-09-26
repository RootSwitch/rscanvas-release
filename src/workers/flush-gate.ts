// The ingest worker's flush timer, as a gate that cannot go stale.
//
// FOUND 2026-09-24 in the lab-5 ingest run (RESULTS-INGEST-2026-09-24.md). At
// the end of the 5,000 traps/s step, 104 received traps were still in memory
// more than a minute after the generator stopped, and were written only when
// the next step's traffic arrived. The design promises a write within
// FLUSH_MS (300 ms) of the first queued row.
//
// The mechanism was one missing assignment. The worker kept the timer handle
// in a variable and treated "handle is not null" as "a flush is scheduled".
// flush() cleared the handle - but only AFTER its `if (flushing) return` - so
// a timer that FIRED while another flush was running left its dead handle in
// place. From then on every enqueue saw a handle and scheduled nothing, the
// end-of-flush re-arm saw a handle and scheduled nothing, and rows under the
// FLUSH_ROWS threshold waited for enough further traffic to force a flush -
// on a quiet source, indefinitely. The handle said "armed" about a timer that
// had already gone off.
//
// So the gate owns the handle, and the timer clears it BEFORE it fires. A
// fired timer can therefore never look armed, whatever the fire does.
// tools/test-flush-gate.ts drives the exact sequence and fails against the
// old ordering.

export interface TimerApi {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}

export interface FlushGate {
    /** Schedule one fire after the delay, unless one is already pending. */
    armIfIdle(): void;
    /** Cancel the pending fire, if any (a flush is starting anyway). */
    disarm(): void;
    /** Whether a fire is pending - for tests and the snapshot. */
    armed(): boolean;
}

const REAL_TIMERS: TimerApi = {
    set: (fn, ms) => {
        const t = setTimeout(fn, ms);
        // Never keep the worker alive for a flush: shutdown drains explicitly.
        t.unref();
        return t;
    },
    clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export function makeFlushGate(fire: () => void, delayMs: number, timers: TimerApi = REAL_TIMERS): FlushGate {
    let handle: unknown = null;
    return {
        armIfIdle() {
            if (handle !== null) return;
            handle = timers.set(() => {
                // Cleared FIRST: the fire may find a flush already running and
                // return early, and that must not leave this gate looking armed.
                handle = null;
                fire();
            }, delayMs);
        },
        disarm() {
            if (handle === null) return;
            timers.clear(handle);
            handle = null;
        },
        armed() { return handle !== null; },
    };
}
