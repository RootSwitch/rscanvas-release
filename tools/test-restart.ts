// The restart judgement (src/collector/restart.ts), offline.
//
//   node tools/test-restart.ts
//
// The cases are the ones that decide whether a restart alert can be trusted:
// an ordinary poll, a restart in a 30-second gap, the case the parent's
// two-reading detector misses (gone an hour, back with a HIGHER uptime than a
// short one before), the 497-day wrap, a long outage on a drifting clock,
// and every way a reading can be absent.

import { judgeRestart, TOLERANCE_S, UPTIME_WRAP_S } from '../src/collector/restart.ts';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const kind = (prev: number | null, since: number | null, now: number | null): string => judgeRestart(prev, since, now).kind;
const DAY = 86_400;

console.log('restart judgement');

console.log('\nrunning:');
eq('a 60s poll on a box up 23 days reads 60s more', kind(23 * DAY, 60, 23 * DAY + 60), 'running');
eq('the age runs from the END of the last poll, so a reading a poll-length AHEAD is running', kind(1000, 60, 1000 + 60 + 45), 'running');
eq('a reading short by less than the tolerance is running (whole seconds, dispatch delay)',
    kind(1000, 60, 1060 - TOLERANCE_S + 1), 'running');
eq('a day-long outage on a clock 500 ppm slow is running, not a restart', kind(10 * DAY, DAY, 11 * DAY - 43), 'running');

console.log('\nrestarted:');
eq('up 23 days, polled 60s later reading 40s: restarted', judgeRestart(23 * DAY, 60, 40),
    { kind: 'restarted', upBeforeS: 23 * DAY, bootAgoS: 40 });
eq('THE CASE TWO READINGS MISS: up 10 minutes, gone an hour, back up 20 minutes - higher than before, and a restart',
    kind(600, 3600, 1200), 'restarted');
eq('a month-long outage that ended in a restart a day ago', kind(30 * DAY, 30 * DAY, DAY), 'restarted');
eq('short by more than the tolerance', kind(1000, 60, 1060 - TOLERANCE_S - 1), 'restarted');

console.log('\nthe 497-day wrap:');
const nearTop = Math.floor(UPTIME_WRAP_S) - 30;
eq('up 497 days, 60s later reading 30s: the counter wrapped, the device kept running', kind(nearTop, 60, 30), 'wrapped');
eq('the same, with the age understated by a 20s poll: still a wrap', kind(nearTop, 40, 30), 'wrapped');
eq('up 497 days, then a reading that is NOT where the wrap would land: a restart', kind(nearTop, 60, 3000), 'restarted');
eq('a box up 400 days that reads 30s is a restart - nowhere near the ceiling', kind(400 * DAY, 60, 30), 'restarted');

console.log('\nnothing to judge:');
eq('no earlier reading (a first poll, or one whose agent gave none)', kind(null, 60, 30), 'unknown');
eq('no age (never polled successfully before)', kind(500, null, 30), 'unknown');
eq('no reading now', kind(500, 60, null), 'unknown');
eq('a negative or non-finite value is not a reading', [kind(-1, 60, 30), kind(500, Number.NaN, 30), kind(500, 60, Infinity)],
    ['unknown', 'unknown', 'unknown']);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
