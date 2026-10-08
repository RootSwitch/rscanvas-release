// Service checks: when each one starts. Pure - the clock and the start
// function are injected, so tools/test-service-checks.ts drives it with a
// fake clock and counts.
//
// THE CONCURRENCY MODEL IS tcpcheck.ts's, carried over: NO POOL. Each check
// starts on a fixed spacing from the previous start and runs with its own
// timer, so the outstanding count is bounded by the arithmetic rather than
// by a slot a dead service could hold:
//
//     outstanding <= ceil(timeout / spacing) + 1
//
// whatever the number of checks - the header of tcpcheck.ts owns the proof
// and exports the formula; this file only keeps the spacing honest.
//
// THE GRID is the poll schedule's (src/collector/schedule.ts): each check is
// due on a grid stepped by its own interval, its first point at a stable
// offset (a hash of its code), so a restart does not move it and checks
// added together do not fire together. Lateness past a whole interval
// re-anchors rather than paying the backlog back as a burst.
//
// SKIP, NEVER OVERLAP: a check still running when it comes due again is
// skipped and counted, never started twice.

import { firstDueMs, nextDueMs, scheduleOffsetMs, type CheckDef, type CheckKind } from './model.ts';

export interface ScheduledCheck {
    id: string;
    code: string;
    kind: CheckKind;
    def: CheckDef;
    /** The owning device's address - what a pinned or host-less check connects to. */
    deviceHost: string;
    deviceName: string;
    name: string;
    /** The device's ping round trip as of the last load (slice 60, voice). */
    deviceRttMs?: number | null;
}

interface Slot {
    check: ScheduledCheck;
    offsetMs: number;
    intervalMs: number;
    dueMs: number;
    inFlight: boolean;
}

export class CheckScheduler {
    private slots = new Map<string, Slot>();
    private lastStartMs = -Infinity;
    /** Starts skipped because the previous run of the same check was still going. */
    skippedInFlight = 0;
    started = 0;

    private readonly spacingMs: number;
    private readonly now: () => number;
    private readonly start: (c: ScheduledCheck, atMs: number) => void;

    constructor(spacingMs: number, now: () => number, start: (c: ScheduledCheck, atMs: number) => void) {
        this.spacingMs = spacingMs;
        this.now = now;
        this.start = start;
    }

    /**
     * Replace the set of checks. A check whose code and interval are
     * unchanged keeps its place on the grid - a reload must not reset every
     * schedule - and keeps an in-flight run's guard.
     */
    setChecks(checks: readonly ScheduledCheck[]): void {
        const next = new Map<string, Slot>();
        const now = this.now();
        for (const c of checks) {
            const intervalMs = c.def.intervalS * 1000;
            const prev = this.slots.get(c.code);
            if (prev !== undefined && prev.intervalMs === intervalMs) {
                next.set(c.code, { ...prev, check: c });
                continue;
            }
            const offsetMs = scheduleOffsetMs(c.code, intervalMs);
            next.set(c.code, {
                check: c, offsetMs, intervalMs,
                dueMs: firstDueMs(now, intervalMs, offsetMs),
                inFlight: prev?.inFlight ?? false,
            });
        }
        this.slots = next;
    }

    get size(): number { return this.slots.size; }

    get inFlight(): number {
        let n = 0;
        for (const s of this.slots.values()) if (s.inFlight) n++;
        return n;
    }

    /**
     * Start every check that is due. Starts are handed out with their
     * spaced start times - the caller sets the timers - in due order, so a
     * burst of due checks drains at one per spacing and never all at once.
     */
    tick(): void {
        const now = this.now();
        const due = [...this.slots.values()].filter((s) => s.dueMs <= now).sort((a, b) => a.dueMs - b.dueMs);
        for (const s of due) {
            const was = s.dueMs;
            s.dueMs = nextDueMs(was, now, s.intervalMs, s.offsetMs);
            if (s.inFlight) { this.skippedInFlight++; continue; }
            s.inFlight = true;
            const at = Math.max(now, this.lastStartMs + this.spacingMs);
            this.lastStartMs = at;
            this.started++;
            this.start(s.check, at);
        }
    }

    /** A run ended. A check removed while it ran is simply gone. */
    finished(code: string): void {
        const s = this.slots.get(code);
        if (s !== undefined) s.inFlight = false;
    }
}
