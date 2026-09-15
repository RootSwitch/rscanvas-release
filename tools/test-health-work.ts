// Work-liveness (slice 46). No database, no server, no workers - the
// judgement was extracted precisely so this file could exist.
//
// THE CASE THAT MATTERS MOST IS THE PERCENTILE. p95 is named in protocol.ts
// as the done-when criterion and is the obvious thing to alarm on, and it is
// wrong the moment a fleet carries devices that are down on purpose. A future
// reader "fixing" this to p95 would produce an alarm that is red forever,
// which is the same as no alarm. So the dead-tier case is pinned here with
// the real measured numbers from the 30k run.

import { workHealth, type CollectorLag } from '../src/health/work.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

const LIMIT = 30_000;

/** A healthy 30k fleet, from the run: median poll well inside the interval. */
const healthy: CollectorLag = {
    pollLagP50Ms: 448, pollLagP95Ms: 1095, concurrency: 64,
    downConcurrency: 4, inFlight: 15, inFlightDown: 4, skippedNoSlot: 678838,
};

console.log('work liveness\n');

// --- THE CASE THAT PINS THE PERCENTILE ----------------------------------------
{
    // Real numbers, one day into the 30k run, from the SAME fleet at the SAME
    // instant - the difference is only which population the percentile is
    // taken over:
    //
    //   over poll EVENTS (what the collector publishes)  p50 920   p95  1,093
    //   over DEVICES     (the roster column)             p50 995   p95 83,115
    //
    // 78 of 1,550 devices are dead by design, which is 5.03% of DEVICES and
    // about 0.8% of poll events - so the dead tier reaches p95 in one
    // population and not the other. This fixture is the device-shaped one,
    // which is what somebody recomputing "poll lag p95" from the roster would
    // hand this function. Reading p95 there alarms forever; reading p50 does
    // not, and the fleet really is fine.
    const deviceShaped: CollectorLag = { ...healthy, pollLagP50Ms: 995, pollLagP95Ms: 83_115 };
    const r = workHealth(deviceShaped, LIMIT, true);
    if (r.status === 200 && r.body.ok === true) {
        ok('a huge p95 with a healthy p50 does NOT alarm - the dead tier is not an outage');
    } else bad('a healthy fleet tripped the alarm - this is the p95 mistake', r);
}
{
    // And the alarm must still fire when the LIVE fleet is genuinely late,
    // even though p95 looks no worse than the healthy dead-tier case above.
    // This is the pair that makes the percentile choice testable at all: the
    // two rows differ only in p50.
    const starved: CollectorLag = {
        pollLagP50Ms: 75_290, pollLagP95Ms: 81_677, concurrency: 24,
        downConcurrency: 4, inFlight: 4, inFlightDown: 4, skippedNoSlot: 5_903_070,
    };
    const r = workHealth(starved, LIMIT, true);
    if (r.status === 503 && r.body.reason === 'poll-lag') {
        ok('the real starvation DOES alarm - median 75s against a 30s budget');
    } else bad('starvation was reported healthy', r);
}

// --- THE BOUNDARY -------------------------------------------------------------
{
    const at: CollectorLag = { ...healthy, pollLagP50Ms: LIMIT };
    const over: CollectorLag = { ...healthy, pollLagP50Ms: LIMIT + 1 };
    const a = workHealth(at, LIMIT, true);
    const b = workHealth(over, LIMIT, true);
    if (a.status === 200 && b.status === 503) {
        ok('exactly one interval late is still ok; one millisecond past it is not');
    } else bad('the boundary is off by one', { a: a.status, b: b.status });
}

// --- THE STATUS CODE IS THE POINT ---------------------------------------------
{
    // A monitor reads status codes, not JSON fields. If this ever returns 200
    // with ok:false, every external check goes green through an outage.
    const r = workHealth({ ...healthy, pollLagP50Ms: 999_999 }, LIMIT, true);
    if (r.status === 503 && r.body.ok === false) {
        ok('a breach is a 503, not a 200 carrying bad news in the body');
    } else bad('the breach did not reach the status code', r);
}

// --- INSTANCES WITH NO COLLECTOR ----------------------------------------------
{
    // COLLECTOR_ENABLED defaults to 0. A reporting-only instance answering 503
    // forever teaches the operator that this endpoint is noise, and then the
    // real alarm is ignored too.
    const r = workHealth(null, LIMIT, false);
    if (r.status === 200 && r.body.reason === 'collector-disabled') {
        ok('a collector-less instance is healthy, not broken');
    } else bad('a reporting instance alarmed', r);
}
{
    const r = workHealth(null, LIMIT, true);
    if (r.status === 503 && r.body.reason === 'collector-not-ready') {
        ok('collector enabled but silent is NOT healthy - it is unknown, and unknown is not up');
    } else bad('a silent collector was reported healthy', r);
}

// --- WHAT THE BODY OWES A HUMAN -----------------------------------------------
{
    // The body is read after the monitor has gone red, by somebody deciding
    // what to do. inFlight against concurrency is what separates "busy" from
    // "starved", and from outside the box those look identical.
    const r = workHealth({
        pollLagP50Ms: 75_290, pollLagP95Ms: 81_677, concurrency: 24,
        downConcurrency: 4, inFlight: 4, inFlightDown: 4, skippedNoSlot: 5_903_070,
    }, LIMIT, true);
    const b = r.body;
    const needed = ['pollLagP50Ms', 'pollLagP95Ms', 'limitMs', 'concurrency', 'inFlight', 'skippedNoSlot'];
    const missing = needed.filter((k) => b[k] === undefined);
    if (missing.length === 0) ok('the breach body carries the numbers that name the cause');
    else bad('the breach body is missing fields an operator needs', missing);
}
{
    const r = workHealth({ ...healthy, pollLagP50Ms: 90_000 }, LIMIT, true);
    if (typeof r.body.detail === 'string' && r.body.detail.includes('90s')
        && r.body.detail.includes('30s')) {
        ok('the detail states both the observed lag and the budget, in seconds');
    } else bad('the detail did not name the numbers', r.body.detail);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
