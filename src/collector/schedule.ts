// When a device's next poll is due: a fixed grid, stepped by the interval.
//
// THE DRIFT THIS REPLACES (2026-09-30). A device was due one interval after
// its last poll FINISHED (devices.last_poll_ts), so every cycle added the
// poll's own duration and the wait for the next dispatch tick. Measured on
// the operator's network: 31.01 s between polls of a 30 s device, steady over
// 1,973 polls in a day - 3% fewer samples than configured, and a perfectly
// polled interface reading 97% coverage in a traffic report. The rates were
// never wrong (they use the real elapsed time); the schedule was.
//
// The grid lives in devices.poll_anchor_ts (slice 56): the time the last
// poll was DUE. A poll that starts close to that time keeps the grid, so the
// next is due exactly one interval later however long this one takes. A poll
// that starts well past it - a backlog, a restart, the down lane's throttle -
// re-anchors on when it actually started, so lateness is never paid back as
// a burst of catch-up polls.
//
// Pure, so tools/test-poll-schedule.ts holds it without a database.

/** Late by more than this share of the interval, a poll starts a new grid. */
export const REANCHOR_FRACTION = 0.25;

export interface PollTiming {
    /** How late the poll started against when it was due, ms; null on a first poll. */
    lagMs: number | null;
    /** What to store as poll_anchor_ts: when this poll was due, or when it started. */
    anchorMs: number;
}

/**
 * The lag of a poll starting at `startMs`, and the anchor to store for it.
 * `lastPollMs` null means never polled (or reset, as an address change
 * does): the grid starts here. `anchorMs` null means no grid yet - the first
 * poll after upgrading - and last_poll_ts stands in for it once.
 */
export function pollTiming(
    lastPollMs: number | null, anchorMs: number | null, intervalS: number, startMs: number,
): PollTiming {
    if (lastPollMs === null) return { lagMs: null, anchorMs: startMs };
    const intervalMs = intervalS * 1000;
    const dueMs = (anchorMs ?? lastPollMs) + intervalMs;
    const lagMs = Math.max(0, startMs - dueMs);
    return { lagMs, anchorMs: lagMs <= intervalMs * REANCHOR_FRACTION ? dueMs : startMs };
}
