// Group alerts (sql/slice55.sql): the judgements, apart from the I/O so
// tools/test-group-alerts.ts can hold them.
//
// A group is a location or an application an operator has opted in. It
// trips when at least min_down of its devices are down AND they are at least
// threshold_pct percent of the devices whose status is known. The share is
// taken over up + down, not over every device: a forced add still waiting
// for first contact, or a ping target whose reach is not yet known, is
// neither evidence of an outage nor of health.
//
// The group alert is ONE alert per group, keyed group:<axis>:<value>, with
// no host - it is about a place or a service, not a device. Its members'
// device-down alerts still raise and show (DECISIONS-2026-09-01 ruling 7,
// "nothing hidden"); only their delivery is held while the group alert is
// open (store/ops.ts, ALERT_IN_GROUP_OUTAGE), as the operator ruled on
// 2026-09-29.
//
// Emitted from the scan beside the watchdog, not from rules.ts evaluate():
// evaluate() is held against the parent suite's rules.js by a differential
// test, and this has no parent.

import type { Condition } from './rules.ts';

export const GROUP_KIND = 'group-down';
/** 'outside' (slice 59) is the outside-services group: its members are the
 *  service checks marked outside, its value always OUTSIDE_VALUE. */
export type GroupAxis = 'location' | 'application' | 'outside';
export const OUTSIDE_VALUE = 'services';

function axisOf(v: string): GroupAxis {
    return v === 'application' || v === 'outside' ? v : 'location';
}

/** One opted-in group with its current counts, as the scan reads it. */
export interface GroupCount {
    axis: string;
    value: string;
    enabled: boolean;
    threshold_pct: number;
    min_down: number;
    up: number;
    down: number;
}

export function groupKey(axis: GroupAxis, value: string): string {
    return `group:${axis}:${value}`;
}

/** The axis and value back out of a key; a value may itself contain ':'. */
export function parseGroupKey(key: string): { axis: GroupAxis; value: string } | null {
    const m = /^group:(location|application|outside):(.+)$/s.exec(key);
    return m ? { axis: m[1] as GroupAxis, value: m[2] as string } : null;
}

/** Whether a group is down by its own rule. */
export function groupTripped(up: number, down: number, thresholdPct: number, minDown: number): boolean {
    const known = up + down;
    return known > 0 && down >= Math.max(1, minDown) && down * 100 >= thresholdPct * known;
}

/**
 * One condition per rule, every scan. An enabled group that is down is crit;
 * everything else - healthy, switched off, emptied by a rename - is a normal
 * reading, so an open group alert clears on the machine's ordinary clear
 * count rather than lingering until it ages out as missing.
 */
export function groupConditions(rows: GroupCount[]): Condition[] {
    return rows.map((r) => {
        const axis = axisOf(r.axis);
        const up = Number(r.up) || 0;
        const down = Number(r.down) || 0;
        const known = up + down;
        const tripped = r.enabled && groupTripped(up, down, Number(r.threshold_pct), Number(r.min_down));
        return {
            key: groupKey(axis, r.value),
            severity: tripped ? 'crit' : null,
            frozen: false,
            kind: GROUP_KIND,
            host: null,
            code: null,
            label: axis === 'outside'
                ? `outside services from RSCanvas: ${down} of ${known} checks failing`
                : `${r.value} (${axis}): ${down} of ${known} devices down`,
            value: known === 0 ? 0 : Math.round((down * 100) / known),
            threshold: Number(r.threshold_pct),
            unit: '%',
        };
    });
}

/**
 * The sentence a group notification carries in place of "value X
 * (threshold Y)": which devices, named - the member notifications it stands
 * in for would each have named one - and the rule it tripped. The count is
 * not repeated: the label beside it already says "4 of 6 devices down"
 * (the first drill's email said it twice, 2026-09-30).
 */
export function groupDetail(down: string[], thresholdPct: number, minDown: number, axis: GroupAxis = 'location'): string {
    const SHOWN = 25;
    const names = down.slice(0, SHOWN).join(', ') + (down.length > SHOWN ? `, and ${down.length - SHOWN} more` : '');
    if (axis === 'outside') {
        // The likeliest cause first: every outside check failing at once is
        // what RSCanvas's own internet going away looks like.
        return (down.length > 0 ? `failing now: ${names} ` : '')
            + `(trips at ${thresholdPct}% and ${minDown} failing) - check RSCanvas's own internet path first; `
            + "these checks' own down notifications are held while this is open";
    }
    return (down.length > 0 ? `down now: ${names} ` : '')
        + `(trips at ${thresholdPct}% and ${minDown} down) - their own device-down notifications are held while this is open`;
}
