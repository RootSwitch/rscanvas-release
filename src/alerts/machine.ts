// The alert state machine: pending -> active -> clearing -> cleared, as a
// PURE function. No SQL, no I/O, no clock reads - the caller passes `now` in.
//
// Ported from alertcanvas/server/scanner.js, where these transitions live
// interleaved with SQLite statements inside one 170-line transaction callback.
// Splitting the decisions from the writes is not a style preference here: the
// transitions are the part with eleven subtle rules (sticky severity, the
// bounce that must not re-raise, frozen advancing neither counter...), and in
// the parent none of them is testable without a database. Here every one is a
// function call.
//
// The caller (the scan tick in the jobs worker) owns everything this module
// deliberately does not do: reading open alerts, persisting the returned rows,
// dispatching the returned events, and transaction boundaries.
//
// WHY COUNTERS RATHER THAN TIMERS. An alert raises after `raiseScans`
// consecutive breaches and clears after `clearScans` consecutive normals, so
// one bad poll never pages anyone and one good poll never silences a real
// incident. The counters advance per SCAN, which makes the machine's behaviour
// independent of wall-clock jitter - and makes it testable without sleeping.

import { LOWER_IS_BAD, type Condition, type Severity } from './rules.ts';
import { insideClearBand, clearBandThreshold } from './hysteresis.ts';

export type AlertState = 'pending' | 'active' | 'clearing' | 'cleared';
export type AlertEventType = 'raise' | 'escalate' | 'clear';

/**
 * One alert as the machine sees it. The store's row, minus the notification
 * bookkeeping (notified_*, notify_attempts...) which belongs to dispatch and
 * never influences a transition.
 */
export interface AlertRow {
    /** null until the store assigns one; the machine never reads it. */
    id: string | null;
    alertKey: string;
    state: AlertState;
    severity: Severity;
    kind: string;
    host: string | null;
    code: string | null;
    label: string;
    value: number | null;
    peakValue: number | null;
    threshold: number | null;
    unit: string;
    breachCount: number;
    clearCount: number;
    missingCount: number;
    firstBreachTs: Date;
    raisedTs: Date | null;
    /** When the incident went warn-to-crit; null if it never did. A FACT in
     *  the raisedTs/clearedTs family - the notified_escalate settlement bit
     *  is dispatch bookkeeping and stays off this row like its siblings. */
    escalatedTs: Date | null;
    clearedTs: Date | null;
    lastSeenTs: Date;
    clearReason: string | null;
}

export interface MachineConfig {
    /** Consecutive breaching scans before a pending alert raises. Min 1. */
    raiseScans: number;
    /** Consecutive normal scans before an active alert clears. Min 1. */
    clearScans: number;
    /** Scans absent from the input before an open alert ages out. Min 1. */
    missingScans: number;
}

/** What the caller must do with the result of one step. */
export type StepAction =
    | { action: 'none' }
    | { action: 'insert'; row: AlertRow; event: AlertEventType | null }
    | { action: 'update'; row: AlertRow; event: AlertEventType | null }
    | { action: 'delete'; row: AlertRow };

/** More-extreme-of, for peak tracking; direction depends on the kind. */
function peak(kind: string, a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return LOWER_IS_BAD.has(kind) ? Math.min(a, b) : Math.max(a, b);
}

/**
 * Collapse conditions to ONE per alert key, keeping the most severe.
 *
 * Straight from the parent, where the reason was learned in production: two
 * feed entries sharing a key would both try to INSERT the same alert_key, hit
 * the partial unique index, and roll back the WHOLE transaction - halting
 * every raise and clear silently until the duplicate left the feed. Crit
 * beats warn beats normal beats frozen, so a real alarm always wins over a
 * quiet or frozen twin.
 */
export function dedupeConditions(conditions: Condition[]): Condition[] {
    const rank = (c: Condition): number =>
        c.severity === 'crit' ? 3 : c.severity === 'warn' ? 2 : c.frozen ? 0 : 1;
    const byKey = new Map<string, Condition>();
    for (const c of conditions) {
        const prev = byKey.get(c.key);
        if (prev === undefined || rank(c) > rank(prev)) byKey.set(c.key, c);
    }
    return [...byKey.values()];
}

/**
 * Advance one alert (or none) against one condition. Pure: the returned row is
 * a new object, the input row is never mutated.
 */
export function step(
    row: AlertRow | null, c: Condition, cfg: MachineConfig, now: Date,
): StepAction {
    const raiseScans = Math.max(1, cfg.raiseScans);
    const clearScans = Math.max(1, cfg.clearScans);

    if (c.frozen) {
        // No usable reading: advance NEITHER counter. The alert keeps exactly
        // its state, but counts as seen so the missing machinery does not
        // start aging out an alarm whose source merely stopped reporting a
        // number for a scan.
        if (row === null) return { action: 'none' };
        return {
            action: 'update',
            row: { ...row, missingCount: 0, lastSeenTs: now },
            event: null,
        };
    }

    if (c.severity !== null) {
        if (row === null) {
            // First breach. Born pending - unless one scan is all it takes,
            // in which case it raises in the same step rather than waiting a
            // scan to notice its own counter.
            const fresh: AlertRow = {
                id: null,
                alertKey: c.key,
                state: 'pending',
                severity: c.severity,
                kind: c.kind,
                host: c.host,
                code: c.code,
                label: c.label,
                value: c.value,
                peakValue: c.value,
                threshold: c.threshold,
                unit: c.unit,
                breachCount: 1,
                clearCount: 0,
                missingCount: 0,
                firstBreachTs: now,
                raisedTs: null,
                escalatedTs: null,
                clearedTs: null,
                lastSeenTs: now,
                clearReason: null,
            };
            if (fresh.breachCount >= raiseScans) {
                return {
                    action: 'insert',
                    row: { ...fresh, state: 'active', raisedTs: now },
                    event: 'raise',
                };
            }
            return { action: 'insert', row: fresh, event: null };
        }

        // Severity is STICKY at the worst level once an alert has been
        // raised: a bouncy metric straddling the crit line must not
        // downgrade-then-"escalate" on every wobble - the parent's example
        // was one GPU inference run producing one escalate per scan. History
        // then records the incident's true worst. A PENDING alert still
        // tracks the live severity: nothing has been sent yet, so raising at
        // the current level is honest.
        const wasSeverity = row.severity;
        const sticky = row.state !== 'pending' && wasSeverity === 'crit' && c.severity !== 'crit';
        const next: AlertRow = {
            ...row,
            severity: sticky ? 'crit' : c.severity,
            label: c.label,
            value: c.value,
            peakValue: peak(c.kind, row.peakValue, c.value),
            // The threshold sticks WITH the severity - a crit incident must
            // show the crit limit it crossed, not the warn limit the value
            // happens to sit above right now.
            threshold: sticky ? row.threshold : c.threshold,
            unit: c.unit,
            missingCount: 0,
            lastSeenTs: now,
        };

        if (next.state === 'pending') {
            next.breachCount = row.breachCount + 1;
            if (next.breachCount >= raiseScans) {
                return {
                    action: 'update',
                    row: { ...next, state: 'active', raisedTs: now },
                    event: 'raise',
                };
            }
            return { action: 'update', row: next, event: null };
        }

        // A breach while clearing is the bounce: back to active, the clear
        // counter starts over, and NO event - the raise was already sent and
        // the incident never ended.
        if (next.state === 'clearing') {
            next.state = 'active';
            next.clearCount = 0;
        }
        if (wasSeverity === 'warn' && c.severity === 'crit') {
            // The transition is recorded ON THE ROW, not only as the event:
            // the event can be skipped (a maintenance window, a policy, a
            // channel down mid-pass), and for as long as it was only an
            // event, a skipped escalate was LOST - severity is sticky, so
            // this branch never fires twice, and nothing anywhere owed the
            // operator the crit. escalated_ts is the fact the owed-escalate
            // queue reads; the store opens the debt in the same statement
            // that persists it (DECISIONS-2026-09-01 ruling 1).
            return { action: 'update', row: { ...next, escalatedTs: now }, event: 'escalate' };
        }
        return { action: 'update', row: next, event: null };
    }

    // A normal reading.
    if (row === null) return { action: 'none' };
    if (row.state === 'pending') {
        // Never raised, now normal: it simply never happened. Deleting rather
        // than clearing keeps history to real incidents.
        return { action: 'delete', row };
    }

    // HYSTERESIS. A normal reading that is still INSIDE the clear band below
    // the threshold is HELD: the incident neither breaches nor clears, and
    // the clear counter does not advance. This reuses the frozen outcome
    // exactly - state kept, seen-timestamp refreshed, no event - rather than
    // inventing a fourth state. Applies only to raised alerts (active or
    // clearing); a pending one was deleted above, because nothing was sent
    // and there is nothing to protect from churn.
    //
    // The band is judged against the threshold ON THE ROW, which is the one
    // the incident actually crossed (sticky through a crit, per the rule
    // above) - unless the rule has since been LOOSENED past it, when the
    // line that applies now is the one (clearBandThreshold says why: a
    // stored line alone wedged such an alert open for good).
    // A reading inside the band still updates the displayed value, so an
    // operator watching it fall sees it fall.
    if (insideClearBand(c.kind, c.value, clearBandThreshold(c.kind, row.threshold, c.threshold))) {
        return {
            action: 'update',
            row: { ...row, value: c.value ?? row.value, missingCount: 0, lastSeenTs: now },
            event: null,
        };
    }

    const next: AlertRow = { ...row, missingCount: 0, lastSeenTs: now };
    if (next.state === 'active') {
        next.state = 'clearing';
        next.clearCount = 1;
    } else if (next.state === 'clearing') {
        next.clearCount = row.clearCount + 1;
    }
    if (c.value !== null) next.value = c.value;
    if (next.state === 'clearing' && next.clearCount >= clearScans) {
        return {
            action: 'update',
            row: { ...next, state: 'cleared', clearedTs: now, clearReason: 'normal' },
            event: 'clear',
        };
    }
    return { action: 'update', row: next, event: null };
}

/**
 * Advance one open alert that had NO condition this scan: the source was
 * untracked, un-watched, or renamed.
 *
 * The CALLER decides whether aging is allowed at all this scan - the parent's
 * rule, kept: while the owning feed itself is bad, absent alerts freeze
 * rather than age, so a dead collector cannot auto-clear a live outage. Here
 * that translates to the scan tick checking collector staleness before
 * calling this at all.
 */
export function stepMissing(row: AlertRow, cfg: MachineConfig, now: Date): StepAction {
    const missingScans = Math.max(1, cfg.missingScans);
    const next: AlertRow = { ...row, missingCount: row.missingCount + 1 };
    if (next.missingCount < missingScans) {
        return { action: 'update', row: next, event: null };
    }
    if (next.state === 'pending') return { action: 'delete', row };
    return {
        action: 'update',
        row: { ...next, state: 'cleared', clearedTs: now, clearReason: 'source-removed' },
        event: 'clear',
    };
}
