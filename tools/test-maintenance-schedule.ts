// Repeating maintenance windows, offline: what a request must say, the
// sentence that names a schedule, and that every "in maintenance" reader in
// the store goes through maintenance_active().
//
//   node tools/test-maintenance-schedule.ts
//
// When an occurrence is OPEN is SQL (sql/slice61.sql) and is proven against a
// real database in tools/test-scratch-db.ts, section 14 - daylight saving,
// midnight, weekdays, the gate. This file holds what needs no database.

import fs from 'node:fs';
import {
    normalizeRepeat, describeRepeat, describeLength, SCHEDULE_MAX_MINUTES,
} from '../src/alerts/maintenance-schedule.ts';
import { isTimeZone } from '../src/reports/traffic.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};
const good = { days: [1, 2, 3, 4, 5, 6, 7], at: '03:00', minutes: 10, tz: 'America/Chicago' };
const verdict = (over: Record<string, unknown>) => normalizeRepeat({ ...good, ...over }, isTimeZone);
const refused = (over: Record<string, unknown>, mentions: string): boolean => {
    const v = verdict(over);
    return !v.ok && v.detail.includes(mentions);
};

console.log('what a repeating window must say');
{
    const v = verdict({});
    ok('a domain controller\'s nightly backup window is accepted as asked', v.ok && JSON.stringify(v.req) === JSON.stringify(good), JSON.stringify(v));
    const d = verdict({ days: [5, 1, 3, 1] });
    ok('weekdays are sorted and repeats dropped', d.ok && d.req.days.join(',') === '1,3,5', JSON.stringify(d));
    ok('no days is refused', refused({ days: [] }, 'repeat.days'));
    ok('a day outside 1-7 is refused (0 is not Sunday here; ISO says 7)', refused({ days: [0] }, 'repeat.days') && refused({ days: [8] }, 'repeat.days'));
    ok('a fractional or text day is refused', refused({ days: [1.5] }, 'repeat.days') && refused({ days: ['Mon'] }, 'repeat.days'));
    ok('days that are not a list are refused', refused({ days: 'daily' }, 'repeat.days'));
    ok('a time must be HH:MM, 24-hour', refused({ at: '3:00' }, 'repeat.at') && refused({ at: '24:00' }, 'repeat.at')
        && refused({ at: '03:60' }, 'repeat.at') && refused({ at: '03:00:00' }, 'repeat.at') && refused({ at: 300 }, 'repeat.at'));
    ok('midnight and the last minute are times', verdict({ at: '00:00' }).ok && verdict({ at: '23:59' }).ok);
    ok(`an occurrence is 1 to ${SCHEDULE_MAX_MINUTES} minutes`, verdict({ minutes: 1 }).ok && verdict({ minutes: SCHEDULE_MAX_MINUTES }).ok
        && refused({ minutes: 0 }, 'repeat.minutes') && refused({ minutes: SCHEDULE_MAX_MINUTES + 1 }, 'notify policy'));
    ok('minutes must be a whole number', refused({ minutes: 10.5 }, 'repeat.minutes') && refused({ minutes: '10' }, 'repeat.minutes'));
    ok('the zone must be a real IANA name', refused({ tz: 'Mars/Olympus' }, 'repeat.tz') && refused({ tz: '' }, 'repeat.tz'));
    ok('a bare offset is not a zone - it cannot know about daylight saving', refused({ tz: '-05:00' }, 'repeat.tz') && refused({ tz: '+05' }, 'repeat.tz'));
    ok('UTC is a zone', verdict({ tz: 'UTC' }).ok);
    const n = normalizeRepeat(null, isTimeZone);
    ok('no object at all is refused, naming the shape', !n.ok && n.detail.includes('{ days, at, minutes, tz }'));
    ok('nor is a list', !normalizeRepeat([1, 2], isTimeZone).ok);
}

console.log('\nthe sentence that names one');
{
    const eq = (label: string, got: string, want: string) => ok(`${label}: "${want}"`, got === want, `got "${got}"`);
    eq('every day', describeRepeat([1, 2, 3, 4, 5, 6, 7], '03:00', 10), 'every day at 03:00 for 10 min');
    eq('weekdays', describeRepeat([1, 2, 3, 4, 5], '22:00', 240), 'weekdays at 22:00 for 4 h');
    eq('weekends', describeRepeat([6, 7], '05:00', 90), 'weekends at 05:00 for 1 h 30 min');
    eq('one day, in the plural', describeRepeat([6], '05:00', 30), 'Saturdays at 05:00 for 30 min');
    eq('any other set, listed', describeRepeat([5, 1, 3], '01:00', 60), 'Mon, Wed, Fri at 01:00 for 1 h');
    eq('the lengths', [describeLength(1), describeLength(60), describeLength(61), describeLength(720)].join(' / '),
        '1 min / 1 h / 1 h 1 min / 12 h');
}

console.log('\nevery "in maintenance" reader goes through maintenance_active()');
{
    // A reader that still matched maintenance_windows on its own span would
    // never see a repeating window - the 03:00 backup would page as if it
    // had none. The failure is silent, so it is pinned here: in the store,
    // maintenance_windows may be written, listed, cancelled, pruned and
    // renamed, but not asked "is this open at T".
    const src = fs.readFileSync(new URL('../src/store/ops.ts', import.meta.url), 'utf8');
    const spanReads = src.match(/FROM\s+maintenance_windows\s+w\b/g) ?? [];
    ok('no statement reads maintenance_windows by its span', spanReads.length === 0, `${spanReads.length} found`);
    const active = src.match(/maintenance_active\(/g) ?? [];
    ok('the alert predicate (both halves), the clear settlement (both) and the wall read maintenance_active()',
        active.length >= 5, `${active.length} uses`);
    const sql = fs.readFileSync(new URL('../sql/slice61.sql', import.meta.url), 'utf8');
    ok('and maintenance_active() reads both tables', /FROM maintenance_windows w/.test(sql) && /FROM maintenance_schedules s/.test(sql));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
