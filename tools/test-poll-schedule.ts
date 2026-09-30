// The poll schedule's grid (src/collector/schedule.ts), offline. The case that
// made it necessary is the first one: a device polled every 31 s against a
// 30 s interval, because each poll counted from when the last one finished.
//
//   node tools/test-poll-schedule.ts

import { pollTiming, REANCHOR_FRACTION } from '../src/collector/schedule.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

// Simulate a device: each poll starts `tickWaitMs` after it is due and takes
// `pollMs`; last_poll_ts is stamped when it finishes, as recordDevicePoll does.
function simulate(polls: number, tickWaitMs: number, pollMs: number, grid: boolean): number {
    const interval = 30;
    let last: number | null = null;
    let anchor: number | null = null;
    let start = 0;
    const starts: number[] = [];
    for (let i = 0; i < polls; i++) {
        const due = last === null ? 0 : (grid ? (anchor ?? last) : last) + interval * 1000;
        start = Math.max(start, due) + tickWaitMs;
        starts.push(start);
        const t = pollTiming(last, grid ? anchor : null, interval, start);
        anchor = t.anchorMs;
        last = start + pollMs;
    }
    // From the second poll: the first starts the grid wherever it happened to run.
    return (starts.at(-1)! - starts[1]!) / (starts.length - 2) / 1000;
}

console.log('the drift, and the grid that removes it:');
eq('finish-anchored, 500 ms tick wait and a 500 ms poll: 31 s between polls',
    Number(simulate(200, 500, 500, false).toFixed(3)), 31);
eq('grid-anchored, the same device: 30 s', Number(simulate(200, 500, 500, true).toFixed(3)), 30);
eq('grid-anchored with a 20 s poll (a dead agent\'s retries): still 30 s',
    Number(simulate(200, 900, 20_000, true).toFixed(3)), 30);

console.log('\none poll at a time:');
const T0 = 1_000_000;
eq('never polled: no lag, the grid starts now', pollTiming(null, null, 30, T0), { lagMs: null, anchorMs: T0 });
eq('first poll after upgrading (no anchor yet): last_poll_ts stands in',
    pollTiming(T0, null, 30, T0 + 30_800), { lagMs: 800, anchorMs: T0 + 30_000 });
eq('on time: the anchor steps by exactly the interval',
    pollTiming(T0 + 5_000, T0, 30, T0 + 30_400), { lagMs: 400, anchorMs: T0 + 30_000 });
eq('started early by the clock (a skew): lag 0, the grid holds',
    pollTiming(T0 + 5_000, T0, 30, T0 + 29_990), { lagMs: 0, anchorMs: T0 + 30_000 });
eq(`late by exactly a quarter interval (${REANCHOR_FRACTION}): still the grid`,
    pollTiming(T0, T0, 30, T0 + 37_500), { lagMs: 7_500, anchorMs: T0 + 30_000 });
eq('later than that: a new grid from when it started, no catch-up burst',
    pollTiming(T0, T0, 30, T0 + 37_501), { lagMs: 7_501, anchorMs: T0 + 37_501 });
eq('after a long outage: re-anchored, not a run of back-to-back polls',
    pollTiming(T0, T0, 30, T0 + 3_600_000), { lagMs: 3_570_000, anchorMs: T0 + 3_600_000 });
eq('the interval is the device\'s own: 300 s', pollTiming(T0, T0, 300, T0 + 301_000), { lagMs: 1_000, anchorMs: T0 + 300_000 });

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
