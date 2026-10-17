// Repeating maintenance windows (slice 61): what a request must say, and the
// sentence that names a schedule - no HTTP and no database here, so the rules
// are asserted offline (tools/test-maintenance-schedule.ts) on the same code
// the route runs.
//
// When a schedule is OPEN is not decided here: that is maintenance_active()
// in sql/slice61.sql, the one definition the notify drain, the alert pages,
// the clear settlement and the wall all read. This module only decides what
// may be stored.

/** An occurrence may last at most this long. Longer, every time, is a notify
 *  policy, which already exists and says so plainly. */
export const SCHEDULE_MAX_MINUTES = 720;

export interface RepeatRequest {
    /** ISO weekdays, Monday 1 .. Sunday 7, sorted and distinct. */
    days: number[];
    /** Local wall-clock start, HH:MM. */
    at: string;
    minutes: number;
    /** The IANA zone the operator meant the time in. */
    tz: string;
}

export type RepeatVerdict = { ok: true; req: RepeatRequest } | { ok: false; detail: string };

/**
 * Validate the `repeat` part of a maintenance request. The zone check is
 * handed in (the route passes the same Intl test the reports use), so this
 * stays free of imports; PostgreSQL checks the zone again on insert.
 */
export function normalizeRepeat(raw: unknown, isZone: (tz: string) => boolean): RepeatVerdict {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, detail: 'repeat must be an object: { days, at, minutes, tz }' };
    }
    const r = raw as Record<string, unknown>;

    if (!Array.isArray(r.days) || r.days.length === 0
        || !r.days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 7)) {
        return { ok: false, detail: 'repeat.days must list weekdays, 1 (Monday) to 7 (Sunday)' };
    }
    const days = [...new Set(r.days as number[])].sort((a, b) => a - b);

    if (typeof r.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.at)) {
        return { ok: false, detail: 'repeat.at must be a local time, HH:MM (24-hour)' };
    }

    if (typeof r.minutes !== 'number' || !Number.isInteger(r.minutes)
        || r.minutes < 1 || r.minutes > SCHEDULE_MAX_MINUTES) {
        return {
            ok: false,
            detail: `repeat.minutes must be 1 to ${SCHEDULE_MAX_MINUTES} - longer, every time, is a notify policy`,
        };
    }

    if (typeof r.tz !== 'string' || !isZone(r.tz)) {
        return { ok: false, detail: 'repeat.tz must be an IANA time zone, such as America/Chicago' };
    }

    return { ok: true, req: { days, at: r.at, minutes: r.minutes, tz: r.tz } };
}

const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/** "10 min", "4 h", "1 h 30 min". */
export function describeLength(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The schedule in words, as the System list, the device page and the audit
 * row all show it: "every day at 03:00 for 10 min", "weekdays at 22:00 for
 * 4 h", "Saturdays at 05:00 for 30 min", "Mon, Wed, Fri at 01:00 for 1 h".
 */
export function describeRepeat(days: number[], at: string, minutes: number): string {
    const set = [...new Set(days)].sort((a, b) => a - b);
    const key = set.join(',');
    const when = key === '1,2,3,4,5,6,7' ? 'every day'
        : key === '1,2,3,4,5' ? 'weekdays'
            : key === '6,7' ? 'weekends'
                : set.length === 1 ? PLURAL[set[0]! - 1]!
                    : set.map((d) => SHORT[d - 1]).join(', ');
    return `${when} at ${at} for ${describeLength(minutes)}`;
}
