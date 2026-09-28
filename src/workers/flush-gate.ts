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

// --- a failing database, and how often to try it again ---------------------------
//
// THE RETRY FLOOD (2026-09-28, the outage drill). PostgreSQL stopped for three
// minutes under 50 messages a second, and ingest kept every row - requeued,
// then written within two seconds of the database returning - but once the
// requeued backlog passed FLUSH_ROWS, EVERY arriving datagram started another
// flush straight into the refused connection and logged an ALARM: 8,701 lines
// in three minutes, one per message. At the ceiling rate that is 15,000 failed
// connection attempts and log lines a second, spent exactly when the box is
// in trouble. So a failed flush now waits before the next, doubling from 250
// ms to a 2-second cap, and says so on the first three failures and then
// every fifteenth (about every 30 s at the cap) rather than on every one.

/** How long to wait after the Nth failed flush in a row. 0 once one succeeds. */
export function failureBackoffMs(streak: number): number {
    if (!(streak > 0)) return 0;
    return Math.min(2000, 250 * 2 ** Math.min(streak - 1, 10));
}

/** Whether the Nth failure in a row is worth a log line of its own. */
export function shouldLogFailure(streak: number): boolean {
    return streak <= 3 || streak % 15 === 0;
}
