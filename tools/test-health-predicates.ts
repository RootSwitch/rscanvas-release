// Health predicates must fail CLOSED on absent data.
//
//   node tools/test-health-predicates.ts
//
// Deterministic, and that is the point. The chaos suite's `wiring` scenario
// races the ingest worker's first stats message, so a pass there can mean "the
// absent case was handled" or "the absent case never happened" - it cannot
// tell you which. This can.
//
// THE BUG THIS GUARDS. `partitionsUnhealthy` was
//
//     partitions !== null && partitions.healthy === false
//
// which treats MISSING data as healthy. The ingest worker is supposed to
// publish a runway every second; silence means something is wrong. That
// predicate is why a correctly computed alarm sat published-and-unread for a
// whole commit after the field moved inside `kernel` - `undefined` read as
// "no problem".
//
// The class is "a guard whose absent input reads as permission", which is the
// same shape as the authorisation question: default deny, and an unknown is a
// denial rather than an allowance.

import {
    isPartitionHealthy, isReporting, isFresh, isFrontierHealthy,
    isJobsHealthy, isHeartbeatHealthy, isKernelDropFree, JOB_FAILURES_ALARM,
    evaluateWorkers, WORKER_NAMES, STATS_STALE_MS, FRONTIER_STALE_MS,
    isDbSelfHealthy, WRAPAROUND_ALARM_AGE, isRetentionEnforcing, isNotifyDelivering, NOTIFY_FAILURES_ALARM,
    type PartitionState, type FrontierState, type JobRecordState, type KernelUdpState,
    type WorkerName, type WorkerReport, type HealthVerdict, type DbSelfState,
} from '../src/workers/protocol.ts';
import type { HeartbeatStats } from '../src/heartbeat.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

const healthy: PartitionState = {
    ensuredThrough: '2026-08-03', runwayDays: 7, failures: 0,
    consecutiveFailures: 0, healthy: true, alarmBelowDays: 3,
};

console.log('health predicates fail closed on absent data\n');

// --- the absent cases, which are the whole point ------------------------------
for (const [label, input] of [
    ['null', null],
    ['undefined', undefined],
] as const) {
    const v = isPartitionHealthy(input);
    if (!v.healthy && /unknown/i.test(v.problem)) {
        ok(`partition state ${label} is UNHEALTHY and says "unknown"`);
    } else {
        bad(`partition state ${label} read as healthy - absent input read as permission`, v);
    }
}

// A payload that exists but has lost the field - exactly what the nested-field
// bug produced on the reading side.
{
    const v = isPartitionHealthy({ runwayDays: 0 } as unknown as PartitionState);
    if (!v.healthy) ok('a payload missing the healthy flag is UNHEALTHY');
    else bad('a malformed payload read as healthy', v);
}

// --- and it must not fail closed forever --------------------------------------
{
    const v = isPartitionHealthy(healthy);
    if (v.healthy) ok('a genuinely healthy state is healthy');
    else bad('a healthy state was rejected - the predicate would never clear', v);
}

// The distinction that matters operationally: a wiring break and a real runway
// shortage need different fixes, so they must not produce the same message.
{
    const absent = isPartitionHealthy(null);
    const short = isPartitionHealthy({ ...healthy, healthy: false, runwayDays: 1, consecutiveFailures: 4 });
    if (!absent.healthy && !short.healthy && absent.problem !== short.problem) {
        ok('absence and a short runway produce DIFFERENT problem strings');
        console.log(`         absent: ${absent.problem}`);
        console.log(`         short:  ${short.problem}`);
    } else {
        bad('absence and a short runway are indistinguishable');
    }
}

// Two writers now report a runway, and both of them being short produced the
// SAME sentence twice in `problems` - measured against the lab, with no way to
// tell which writer was in trouble. They also fail differently: ingest queues
// through a missing partition, the collector discards on the spot.
{
    const bad_ = { ...healthy, healthy: false, runwayDays: 0, consecutiveFailures: 0 };
    const i = isPartitionHealthy(bad_, 'ingest');
    const c = isPartitionHealthy(bad_, 'collector');
    if (!i.healthy && !c.healthy && i.problem !== c.problem
        && /collector/.test(c.problem) && /DISCARD/i.test(c.problem)) {
        ok('ingest and collector runway problems are distinguishable, and name what each loses');
        console.log(`         collector: ${c.problem}`);
    } else {
        bad('the two writers report identical runway problems', { ingest: i, collector: c });
    }
}

// --- isReporting --------------------------------------------------------------
console.log('');
{
    const v = isReporting(null, 'ingest', true);
    if (!v.healthy) ok('an expected worker publishing nothing is UNHEALTHY');
    else bad('a silent expected worker read as healthy', v);
}
{
    const v = isReporting(null, 'collector', false);
    if (v.healthy) ok('a worker that is not expected to run is fine when silent');
    else bad('a disabled worker was treated as a fault', v);
}
{
    const v = isReporting({ thread: 'ingest' }, 'ingest', true);
    if (!v.healthy) ok('stats with no usable heartbeat are UNHEALTHY');
    else bad('a heartbeat-less payload read as healthy', v);
}
{
    const v = isReporting({ heartbeat: { worstGapMs: 3 } }, 'ingest', true);
    if (v.healthy) ok('a reporting worker with a heartbeat is healthy');
    else bad('a valid payload was rejected', v);
}

// --- isFresh ------------------------------------------------------------------
console.log('');
{
    const v = isFresh(STATS_STALE_MS + 1000, 'ingest');
    if (!v.healthy && /wedged/.test(v.problem)) {
        ok('stats older than the staleness bound are UNHEALTHY');
    } else {
        bad('stale stats read as healthy - a wedged worker would be invisible', v);
    }
}
{
    const v = isFresh(500, 'ingest');
    if (v.healthy) ok('fresh stats are healthy');
    else bad('fresh stats were rejected', v);
}

// --- the rollup frontier ------------------------------------------------------
//
// The failure this predicate exists for is the quietest in the system: the
// rollup wedges, guard 5 correctly refuses to expire any raw partition, and
// disk grows ~11GB a day behind a 200 OK until ENOSPC lands on ingest about a
// month later. Every absence therefore has to be unhealthy, and each for its
// own stated reason - "never read", "never ran" and "far behind" need three
// different fixes.
console.log('');
const freshFrontier: FrontierState = {
    throughTs: new Date(Date.now() - 3_600_000).toISOString(),
    lagHours: 1, readAt: new Date().toISOString(), alarmAboveHours: 25,
};

for (const [label, input] of [
    ['null', null],
    ['undefined', undefined],
] as const) {
    const v = isFrontierHealthy(input, true);
    if (!v.healthy) ok(`frontier state ${label} is UNHEALTHY`);
    else bad(`frontier state ${label} read as healthy`, v);
}
{
    const v = isFrontierHealthy({ ...freshFrontier, readAt: null }, true);
    if (!v.healthy && /unreadable/i.test(v.problem)) {
        ok('a frontier that was never successfully READ is UNHEALTHY');
    } else {
        bad('an unread frontier read as healthy - a wedged jobs worker would be invisible', v);
    }
}
{
    const v = isFrontierHealthy({ ...freshFrontier, throughTs: null, lagHours: null }, true);
    if (!v.healthy && /never run/i.test(v.problem)) {
        ok('a rollup that has NEVER RUN is UNHEALTHY - guard 5 would defer everything forever');
    } else {
        bad('a never-run rollup read as healthy', v);
    }
}
{
    const v = isFrontierHealthy({ ...freshFrontier, lagHours: 200 }, true);
    if (!v.healthy && /behind/i.test(v.problem)) ok('a frontier 200 hours behind is UNHEALTHY');
    else bad('a stalled frontier read as healthy', v);
}
{
    // The young-install grace (2026-09-28): a brand-new install read red for
    // its first hour, because the rollup cannot run before a complete hour.
    const never = { ...freshFrontier, throughTs: null, lagHours: null };
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    if (isFrontierHealthy({ ...never, devices: 40, firstDeviceAt: ago(0.5) }, true).healthy) {
        ok('never ran, first device added 30 min ago: green - its first pass is not due yet');
    } else bad('a young install went red');
    const old = isFrontierHealthy({ ...never, devices: 40, firstDeviceAt: ago(5) }, true);
    if (!old.healthy && /never run/i.test(old.problem)) ok('never ran, devices added 5 h ago: RED - it should have run');
    else bad('an old never-ran rollup was excused', old);
    if (isFrontierHealthy({ ...never, devices: 0, firstDeviceAt: null }, true).healthy) {
        ok('no devices at all: green - nothing to roll up, nothing to expire');
    } else bad('an empty install went red');
    const noTimes = isFrontierHealthy({ ...never, devices: 40, firstDeviceAt: null }, true);
    if (!noTimes.healthy) ok('devices with no add time (an old install) get no grace');
    else bad('an install without add times was excused');
}

// A FROZEN READING MUST NOT PASS AS A CURRENT ONE.
//
// The case AlertCanvas's readFeed separates and this file did not: the jobs
// worker is alive and publishing, but cannot reach job_state. refreshFrontier
// leaves the object untouched, so lagHours keeps reporting the last GOOD value
// while real lag grows. Every other predicate passes - the worker has a
// heartbeat and fresh stats - so health stayed 200 through it.
{
    const stale = {
        ...freshFrontier,
        readAt: new Date(Date.now() - FRONTIER_STALE_MS - 60_000).toISOString(),
    };
    const v = isFrontierHealthy(stale, true);
    if (!v.healthy && /FROZEN/.test(v.problem)) {
        ok('a frontier whose last READ is stale is UNHEALTHY, even though its lag figure looks fine');
        console.log(`         ${v.problem}`);
    } else {
        bad('a frozen lag figure read as current - a jobs worker that cannot see the database '
            + 'would report healthy', v);
    }

    // The control: the same object with a recent read must still pass, or the
    // predicate has simply been made to fail always.
    const fresh = isFrontierHealthy({ ...stale, readAt: new Date().toISOString() }, true);
    if (fresh.healthy) ok('and the same frontier read a moment ago is healthy, so it is the AGE that fails it');
    else bad('a freshly read frontier was rejected', fresh);

    // Unreadable-never and unreadable-now are different problems, as are all
    // five states AlertCanvas separates.
    const never = isFrontierHealthy({ ...freshFrontier, readAt: null }, true);
    if ((never as { problem: string }).problem !== (v as { problem: string }).problem) {
        ok('"never read" and "not read recently" are distinguishable');
    } else {
        bad('never-read and stale-read produce the same problem string');
    }
}
{
    const v = isFrontierHealthy(freshFrontier, true);
    if (v.healthy) ok('a frontier one hour behind is healthy');
    else bad('a normal frontier was rejected - the predicate would never clear', v);
}
{
    // Not a fault when the worker is switched off: that has its own startup
    // warning, and reporting it here every second trains people to ignore it.
    const v = isFrontierHealthy(null, false);
    if (v.healthy) ok('a disabled jobs worker is not a frontier fault');
    else bad('a disabled jobs worker was reported as a frontier fault', v);
}
{
    const a = isFrontierHealthy({ ...freshFrontier, readAt: null }, true);
    const b = isFrontierHealthy({ ...freshFrontier, throughTs: null, lagHours: null }, true);
    const c = isFrontierHealthy({ ...freshFrontier, lagHours: 200 }, true);
    if (new Set([a, b, c].map((v) => (v as { problem: string }).problem)).size === 3) {
        ok('unreadable, never-run and far-behind produce THREE different problem strings');
    } else {
        bad('the three frontier failures are indistinguishable');
    }
}

// --- the enumeration itself ---------------------------------------------------
//
// THE POINT OF THIS SECTION is not that the jobs worker is checked. It is that
// forgetting a worker cannot happen again.
//
// protocol.ts was built to close "computed correctly, wired to nothing" and was
// scoped to the two workers in the bug that prompted it; the jobs worker, added
// later, then had no verdict of any kind. Adding one would fix the instance.
// What fixes the class is that health iterates WORKER_NAMES and main must
// supply a Record<WorkerName, WorkerReport>, so a missing key is a compile
// error rather than an oversight.
//
// The compile-time half cannot be asserted at runtime, so what is checked here
// is the other half: that every declared worker actually produces a verdict.
console.log('');
{
    const silent = (expected: boolean): WorkerReport => ({ stats: null, expected, reportAgeMs: null });
    const reports = Object.fromEntries(
        WORKER_NAMES.map((n) => [n, silent(true)]),
    ) as Record<WorkerName, WorkerReport>;

    const verdicts = evaluateWorkers(reports);
    const problems = verdicts.filter((v) => !v.healthy).map((v) => (v as { problem: string }).problem);

    const missing = WORKER_NAMES.filter((n) => !problems.some((p) => p.includes(n)));
    if (missing.length === 0) {
        ok(`all ${WORKER_NAMES.length} declared workers produce a verdict when silent `
            + `(${WORKER_NAMES.join(', ')})`);
    } else {
        bad('a declared worker produces NO verdict when silent', missing);
    }

    // The control. If every worker were reported unhealthy unconditionally, the
    // assertion above would pass while the predicates measured nothing.
    const healthyReports = Object.fromEntries(
        WORKER_NAMES.map((n) => [n, {
            stats: { heartbeat: { worstGapMs: 2 } }, expected: true, reportAgeMs: 100,
        }]),
    ) as Record<WorkerName, WorkerReport>;
    if (evaluateWorkers(healthyReports).every((v) => v.healthy)) {
        ok('and all of them clear when every worker is reporting and fresh');
    } else {
        bad('a reporting, fresh worker was still unhealthy - the enumeration never clears',
            evaluateWorkers(healthyReports).filter((v) => !v.healthy));
    }
}

// === THE CONSUMPTION SWEEP ====================================================
//
// Everything above tests predicates that were written after a bug. This section
// is the exhaustive version: every field in protocol.ts marked VERDICT gets a
// control that CORRUPTS IT AND WATCHES THE VERDICT FLIP.
//
// WHY A SHARED TYPE IS NOT ENOUGH. Three wiring bugs here shared one shape -
// partitions nested inside kernel, the jobs worker absent from health, readAt
// published and never aged. All three typechecked. In all three the producer
// and consumer agreed perfectly about the field's TYPE. What was missing every
// time was proof that the consumer used the field for the thing it was
// published to express. A type proves shape; only a control proves consumption.
//
// FOUR RULES, and the fourth is the one that makes the rest mean anything:
//
//   1. Assert the BASELINE is healthy first. A control that corrupts a field
//      while some other predicate is already failing would pass with the
//      consumer deleted - which is exactly how the first sigterm fix passed
//      against a regressed drain().
//   2. Corrupt ONE field.
//   3. Assert the verdict flips.
//   4. Assert the problem NAMES that field, not some other one. An unhealthy
//      verdict for the wrong reason is a control that has not run.
//
// Three modes per field, because a field can be guarded against one and open to
// the others - which is precisely what happened to readAt:
//
//   ABSENT  missing, null, or the whole payload never published
//   STALE   present, correctly typed, describing a moment that has passed
//   WRONG   present, current, and false

interface Corruption<T> {
    field: string;
    mode: 'ABSENT' | 'STALE' | 'WRONG';
    corrupt: (baseline: T) => T;
    /** The problem string must identify what was corrupted. */
    names: RegExp;
}

function control<T>(
    label: string, baseline: T, verdict: (v: T) => HealthVerdict, cases: Array<Corruption<T>>,
): void {
    console.log(`\n  ${label}`);
    const base = verdict(baseline);
    if (!base.healthy) {
        bad(`${label}: THE BASELINE IS NOT HEALTHY - every corruption below would "pass" `
            + 'with the consumer deleted', base);
        return;
    }
    ok(`${label}: baseline is healthy, so a flip below is caused by the corruption`);

    for (const c of cases) {
        const v = verdict(c.corrupt(baseline));
        if (v.healthy) {
            bad(`${label}.${c.field} [${c.mode}]: corrupting it changed NOTHING - `
                + 'either the consumer ignores this field or it is not VERDICT');
        } else if (!c.names.test(v.problem)) {
            bad(`${label}.${c.field} [${c.mode}]: unhealthy, but for the wrong reason`, v.problem);
        } else {
            ok(`${label}.${c.field} [${c.mode}] flips the verdict and names it`);
        }
    }
}

// --- PartitionState, both writers ---------------------------------------------
//
// STALE is absent from this table deliberately and the reason is a property of
// the structure: every field is recomputed from the clock at snapshot time, so
// a partition block cannot freeze while its worker publishes, and a worker that
// has STOPPED publishing is caught by isFresh. That composition is asserted
// below rather than assumed.
for (const worker of ['ingest', 'collector'] as const) {
    control<PartitionState | null>(
        `PartitionState (${worker})`,
        healthy,
        (p) => isPartitionHealthy(p, worker),
        [
            {
                field: 'the whole block', mode: 'ABSENT',
                corrupt: () => null,
                names: new RegExp(`${worker} worker published no partition state`),
            },
            {
                field: 'healthy', mode: 'ABSENT',
                corrupt: (p) => {
                    const { healthy: _drop, ...rest } = p as PartitionState;
                    return rest as PartitionState;
                },
                names: /no healthy flag/,
            },
            {
                field: 'healthy', mode: 'WRONG',
                corrupt: (p) => ({ ...(p as PartitionState), healthy: false, runwayDays: 0 }),
                names: /runway is 0 days/,
            },
        ],
    );
}

// The DISPLAY fields that are quoted in the verdict's text still owe a check
// that they arrive there - that is their whole contract.
{
    const v = isPartitionHealthy(
        { ...healthy, healthy: false, runwayDays: 2, consecutiveFailures: 9 }, 'ingest');
    if (!v.healthy && /2 days/.test(v.problem) && /9 consecutive/.test(v.problem)) {
        ok('runwayDays and consecutiveFailures are DISPLAY, and both reach the problem string');
    } else {
        bad('a quoted display field did not reach the problem string', v);
    }
}

// --- FrontierState ------------------------------------------------------------
control<FrontierState | null>(
    'FrontierState',
    freshFrontier,
    (f) => isFrontierHealthy(f, true),
    [
        {
            field: 'the whole block', mode: 'ABSENT',
            corrupt: () => null,
            names: /published no frontier state/,
        },
        {
            field: 'readAt', mode: 'ABSENT',
            corrupt: (f) => ({ ...(f as FrontierState), readAt: null }),
            names: /never successfully read/,
        },
        {
            // The third wiring bug, anchored as a regression.
            field: 'readAt', mode: 'STALE',
            corrupt: (f) => ({
                ...(f as FrontierState),
                readAt: new Date(Date.now() - FRONTIER_STALE_MS - 60_000).toISOString(),
            }),
            names: /FROZEN/,
        },
        {
            field: 'readAt', mode: 'WRONG',
            corrupt: (f) => ({ ...(f as FrontierState), readAt: 'not a timestamp' }),
            names: /not a parseable timestamp/,
        },
        {
            field: 'throughTs', mode: 'ABSENT',
            corrupt: (f) => ({ ...(f as FrontierState), throughTs: null }),
            names: /never run/,
        },
        {
            // Found by the sweep: null lagHours beside a present throughTs used
            // to skip the comparison entirely and return healthy.
            field: 'lagHours', mode: 'ABSENT',
            corrupt: (f) => ({ ...(f as FrontierState), lagHours: null }),
            names: /internally inconsistent/,
        },
        {
            field: 'lagHours', mode: 'WRONG',
            corrupt: (f) => ({ ...(f as FrontierState), lagHours: 200 }),
            names: /hours behind/,
        },
        {
            // Also found by the sweep: a missing threshold made every
            // comparison false, disabling the check rather than failing it.
            field: 'alarmAboveHours', mode: 'ABSENT',
            corrupt: (f) => {
                const { alarmAboveHours: _drop, ...rest } = f as FrontierState;
                return rest as FrontierState;
            },
            names: /threshold/,
        },
        {
            field: 'alarmAboveHours', mode: 'WRONG',
            corrupt: (f) => ({ ...(f as FrontierState), alarmAboveHours: Number.NaN }),
            names: /threshold/,
        },
    ],
);

// --- HeartbeatStats -----------------------------------------------------------
//
// The verdict was inline in main.ts, where no control could reach it, and it
// branched on overThresholdCount while the guard beside it validated
// worstGapMs. A payload with a good worstGapMs and no overThresholdCount passed
// both and reported every thread within threshold.
//
// Since 2026-10-02 the verdict reads `recent`, the last fifteen minutes, and
// the since-start fields are display: corrupting them must change NOTHING
// (the latch control below), and corrupting `recent` must flip it.
const win = (ticks: number, worstGapMs: number, overThresholdCount: number): HeartbeatStats['recent'] =>
    ({ windowMs: 15 * 60_000, ticks, worstGapMs, overThresholdCount });
const healthyThread: HeartbeatStats = {
    thread: 'ingest', ticks: 1000, worstGapMs: 12, worstGapAt: null, p50GapMs: 10, p99GapMs: 11,
    thresholdMs: 50, overThresholdCount: 0, recent: win(1000, 12, 0),
};
control<HeartbeatStats[]>(
    'HeartbeatStats',
    [healthyThread],
    (ts) => isHeartbeatHealthy(ts),
    [
        {
            field: 'recent', mode: 'ABSENT',
            corrupt: ([t]) => {
                const { recent: _drop, ...rest } = t as HeartbeatStats;
                return [rest as HeartbeatStats];
            },
            names: /no usable recent window/,
        },
        {
            field: 'recent.overThresholdCount', mode: 'ABSENT',
            corrupt: ([t]) => {
                const { overThresholdCount: _drop, ...rest } = (t as HeartbeatStats).recent;
                return [{ ...(t as HeartbeatStats), recent: rest as HeartbeatStats['recent'] }];
            },
            names: /no usable recent window/,
        },
        {
            field: 'recent.ticks', mode: 'WRONG',
            corrupt: ([t]) => [{ ...(t as HeartbeatStats), recent: { ...(t as HeartbeatStats).recent, ticks: NaN } }],
            names: /no usable recent window/,
        },
        {
            field: 'recent.overThresholdCount', mode: 'WRONG',
            // SUSTAINED: 70 of 1000 ticks is 7%, far past the 0.1% rate.
            corrupt: ([t]) => [{ ...(t as HeartbeatStats), recent: win(1000, 210, 70) }],
            names: /sustained past/,
        },
        {
            field: 'recent.worstGapMs', mode: 'WRONG',
            // ACUTE: one gap over 500ms is a real stall whatever the rate.
            corrupt: ([t]) => [{ ...(t as HeartbeatStats), recent: win(1000, 900, 1) }],
            names: /stalled 900ms in one tick in the last 15 min/,
        },
    ],
);

// --- THE LATCH (production, 2026-10-02) ---------------------------------------
//
// The acute bound read the since-start maximum, which never falls: a 06:00
// backup on the VM host held polls up to 2.2 s and health stayed red until a
// restart. A stall that left the window must read healthy, its record kept;
// and a bad quarter-hour after a month of clean uptime must still fail,
// which the since-start rate diluted below the bound.
{
    const morningAfter: HeartbeatStats = {
        ...healthyThread, thread: 'collector', ticks: 1_700_000, worstGapMs: 2213,
        worstGapAt: '2026-10-02T11:00:41.000Z', overThresholdCount: 40, recent: win(90_000, 31, 0),
    };
    const v = isHeartbeatHealthy([morningAfter]);
    if (v.healthy) ok('a 2,213 ms stall that has left the window is healthy - the old bound held it forever');
    else bad('a stall outside the window still fails health', v);

    const lateBadDay: HeartbeatStats = {
        ...healthyThread, thread: 'collector', ticks: 260_000_000, worstGapMs: 180,
        overThresholdCount: 9_000, recent: win(90_000, 180, 900),
    };
    const v2 = isHeartbeatHealthy([lateBadDay]);
    if (!v2.healthy && /collector is over 50ms on 1\.00% of ticks in the last 15 min/.test(v2.problem)) {
        ok('1% of ticks stalling now FAILS after a month of uptime - since start it read 0.003%');
    } else {
        bad('a bad quarter-hour was diluted by uptime', v2);
    }
}

// --- AND THE THREE PROPERTIES THE PORTED METRIC GOT WRONG ---------------------
//
// isHeartbeatHealthy was "worst gap across the process, any occurrence
// fails", which is the number the SUITE used: one loop, everything shared it,
// so any stall meant every user waited. This fork has four loops with
// different tolerances. The controls below are the three ways that ported
// rule misread the new architecture, and each would have kept /api/health at
// 503 permanently.
{
    const busyJobs: HeartbeatStats = {
        thread: 'jobs', ticks: 60_000, worstGapMs: 115, worstGapAt: null, p50GapMs: 10, p99GapMs: 60,
        thresholdMs: 50, overThresholdCount: 509, recent: win(60_000, 115, 509),
    };
    const v = isHeartbeatHealthy([healthyThread, busyJobs]);
    if (v.healthy) {
        ok('a BUSY JOBS THREAD is healthy - blocking is what its own loop is FOR');
    } else {
        bad('the jobs thread was judged on latency', JSON.stringify(v));
    }

    // MONOTONE: overThresholdCount is cumulative from process start and
    // nothing resets it, so "any tick ever" degrades permanently on the first
    // transient. One 150ms blip in twenty minutes must stay healthy.
    const oneBlip: HeartbeatStats = {
        thread: 'ingest', ticks: 120_000, worstGapMs: 151, worstGapAt: null, p50GapMs: 10, p99GapMs: 11,
        thresholdMs: 50, overThresholdCount: 1, recent: win(90_000, 151, 1),
    };
    const v2 = isHeartbeatHealthy([oneBlip]);
    if (v2.healthy) {
        ok('one transient in 120,000 ticks is healthy - the old rule could never recover from it');
    } else {
        bad('a single transient still fails health', JSON.stringify(v2));
    }

    // And the negative control on the same axis: a LATENCY-SENSITIVE thread
    // stalling constantly must still fail, or the loosening went too far.
    const stalling: HeartbeatStats = {
        thread: 'collector', ticks: 10_000, worstGapMs: 120, worstGapAt: null, p50GapMs: 10, p99GapMs: 90,
        thresholdMs: 50, overThresholdCount: 800, recent: win(10_000, 120, 800),
    };
    const v3 = isHeartbeatHealthy([stalling]);
    if (!v3.healthy && /collector/.test(v3.problem ?? '')) {
        ok('and a collector stalling on 8% of ticks still FAILS - the rate is a bound, not an amnesty');
    } else {
        bad('sustained stalling passed', JSON.stringify(v3));
    }
}

// --- KernelUdpState -----------------------------------------------------------
//
// A KERNEL DROP IS NOT A SYMPTOM OF A NEVER-DROP VIOLATION. IT IS THE
// VIOLATION - the exact thing the invariant forbids, and the thing the chaos
// suite's restart scenario exists to prove does not happen. So this is not a
// threshold anybody has to choose: it is zero, already fixed by an invariant
// this project has stated, tested and built guards around. The system's most
// important promise was the one thing health could not see.
//
// The counter is already baselined at bind time in the ingest worker, so
// `syslogDrops` means "drops since this worker started" rather than since boot.
// Monotonic, and therefore sticky: a flood an hour ago is still a violation
// that happened and still needs investigating, and nothing else in the system
// records it.
//
// THE ABSENT CASE MATTERS MOST, and it is why `available` gets its own verdict
// rather than being folded in. `PROC_AVAILABLE === false` means the invariant
// is UNMONITORED, not satisfied - and a deployment where /proc is unreadable
// was reporting perfect health on the metric it cannot read.
const healthyKernel: KernelUdpState = {
    available: true, syslogDrops: 0, trapDrops: 0, rxQueueBytes: 4096,
    peakRxQueueBytes: 65536, systemRcvbufErrors: 0, systemInErrors: 0,
};
control<KernelUdpState | null>(
    'KernelUdpState',
    healthyKernel,
    (k) => isKernelDropFree(k),
    [
        {
            field: 'the whole block', mode: 'ABSENT',
            corrupt: () => null,
            names: /no kernel/i,
        },
        {
            // The case the correction was about: unreadable is UNMONITORED.
            field: 'available', mode: 'ABSENT',
            corrupt: (k) => ({ ...(k as KernelUdpState), available: false,
                syslogDrops: null, trapDrops: null }),
            names: /unmonitored|cannot be read/i,
        },
        {
            field: 'syslogDrops', mode: 'ABSENT',
            corrupt: (k) => ({ ...(k as KernelUdpState), syslogDrops: null }),
            names: /syslog/i,
        },
        {
            field: 'syslogDrops', mode: 'WRONG',
            corrupt: (k) => ({ ...(k as KernelUdpState), syslogDrops: 1 }),
            names: /syslog/i,
        },
        {
            field: 'trapDrops', mode: 'WRONG',
            corrupt: (k) => ({ ...(k as KernelUdpState), trapDrops: 4 }),
            names: /trap/i,
        },
    ],
);

// One drop is the whole finding. A threshold above zero here would be somebody
// quietly deciding how much of the central invariant is acceptable.
{
    const v = isKernelDropFree({ ...healthyKernel, syslogDrops: 1 });
    if (!v.healthy && /1\b/.test(v.problem)) {
        ok('a SINGLE kernel drop degrades health - the threshold is zero, not a judgement');
        console.log(`         ${(v as { problem: string }).problem}`);
    } else {
        bad('one kernel drop did not degrade health', v);
    }
}

// --- JobRecordState -----------------------------------------------------------
//
// The fourth instance. Every job's outcome was DISPLAY, so a retention job
// throwing on every run reached the same disk exhaustion the frontier check
// exists to catch - with the rollup healthy and the frontier current the whole
// way, because they are different jobs.
const healthyJob: JobRecordState = {
    name: 'retention:samples', runs: 12, skippedInFlight: 0, failures: 1,
    consecutiveFailures: 0, lastRunAt: new Date().toISOString(),
    lastOkAt: new Date().toISOString(), lastMs: 40, lastDetail: 'nothing expired',
};
control<JobRecordState[] | null>(
    'JobRecordState',
    [healthyJob],
    (j) => isJobsHealthy(j, true),
    [
        {
            field: 'the whole list', mode: 'ABSENT',
            corrupt: () => null,
            names: /published no job records/,
        },
        {
            field: 'consecutiveFailures', mode: 'WRONG',
            corrupt: (j) => [{
                ...((j as JobRecordState[])[0] as JobRecordState),
                consecutiveFailures: JOB_FAILURES_ALARM,
                lastDetail: 'failed: lane refused (busy)',
            }],
            names: /retention:samples/,
        },
    ],
);

// A single lost race is the design working, not a fault: retention gives up on
// a 2s lock_timeout and retries, and the trigram drop defers on contention. A
// threshold that fired on one failure would be turned off within a week.
{
    const v = isJobsHealthy([{ ...healthyJob, consecutiveFailures: JOB_FAILURES_ALARM - 1 }], true);
    if (v.healthy) {
        ok(`${JOB_FAILURES_ALARM - 1} consecutive failures is still healthy - a lost lock race is not a fault`);
    } else {
        bad('one lost race degrades health, which would train everyone to ignore it', v);
    }
}

// --- the compositions the tables above deliberately do not cover ---------------
//
// PartitionState and HeartbeatStats cannot go stale on their own, so their
// STALE mode is covered one level up, by isFresh on the worker's report age.
// That is a claim about how the pieces compose, so it is asserted rather than
// stated.
console.log('\n  composition: staleness is covered one level up');
{
    const reports = Object.fromEntries(WORKER_NAMES.map((n) => [n, {
        stats: { heartbeat: healthyThread }, expected: true, reportAgeMs: 100,
    }])) as Record<WorkerName, WorkerReport>;

    if (evaluateWorkers(reports).every((v) => v.healthy)) {
        ok('baseline: every worker reporting and fresh is healthy');
    } else {
        bad('the composition baseline is not healthy');
    }

    // A perfectly healthy-LOOKING partitions block behind a stale report must
    // still be unhealthy, or a wedged worker's last good numbers read as now.
    const stale = {
        ...reports,
        ingest: { stats: { heartbeat: healthyThread, partitions: healthy }, expected: true,
            reportAgeMs: STATS_STALE_MS + 1000 },
    };
    const v = evaluateWorkers(stale).filter((x) => !x.healthy);
    if (v.length > 0 && /ingest/.test((v[0] as { problem: string }).problem)) {
        ok('a stale ingest report is unhealthy even while its partitions block looks fine');
    } else {
        bad('a stale report with healthy-looking contents passed - frozen numbers read as current');
    }
}

// --- the three known instances, anchored as regressions ------------------------
console.log('\n  the three original wiring bugs, as regressions');
{
    // 1. partitions published where main did not read it - main sees undefined.
    const nested = { kernel: { partitions: healthy } } as unknown as { partitions?: PartitionState };
    const v1 = isPartitionHealthy(nested.partitions, 'ingest');
    if (!v1.healthy) ok('1. a partitions block published to the wrong path reads as UNHEALTHY, not fine');
    else bad('the nested-field bug would pass again', v1);

    // 2. a worker present in the enumeration but publishing nothing.
    const v2 = evaluateWorkers(Object.fromEntries(WORKER_NAMES.map((n) => [n, {
        stats: n === 'jobs' ? null : { heartbeat: healthyThread },
        expected: true, reportAgeMs: 100,
    }])) as Record<WorkerName, WorkerReport>).filter((x) => !x.healthy);
    if (v2.some((x) => /jobs/.test((x as { problem: string }).problem))) {
        ok('2. a silent jobs worker is named - it can no longer be omitted from health');
    } else {
        bad('the missing-worker bug would pass again');
    }

    // 3. readAt frozen while every other field looks current.
    const v3 = isFrontierHealthy({
        ...freshFrontier, readAt: new Date(Date.now() - FRONTIER_STALE_MS - 1).toISOString(),
    }, true);
    if (!v3.healthy) ok('3. a frozen frontier reading is UNHEALTHY even with a healthy lag figure');
    else bad('the frozen-readAt bug would pass again', v3);
}

// --- the db self-checks (U0) -------------------------------------------------
//
// Every branch must be reachable by a control: the wraparound alarm exists
// because a real one sat invisible for nine days, and a verdict no fixture
// can fire is the exact shape this file was created to prevent.
{
    const healthyDb: DbSelfState = {
        oldestDatAge: 150_000_000,
        bloat: [{ rel: 'entities', live: 10_000, dead: 9_000 }],
        disks: [{ path: '/', availPct: 60 }],
    };
    const quiet = isDbSelfHealthy(healthyDb).filter((v) => !v.healthy);
    if (quiet.length === 0) ok('db: a healthy snapshot is silent');
    else bad('a healthy db snapshot raised problems', quiet);

    const wrap = isDbSelfHealthy({ ...healthyDb, oldestDatAge: WRAPAROUND_ALARM_AGE + 1 })
        .filter((v) => !v.healthy);
    if (wrap.some((v) => /wraparound/.test((v as { problem: string }).problem))) {
        ok('db: the wraparound alarm fires past the tripwire');
    } else bad('the nine-day wraparound blindness would pass again', wrap);

    const bloat = isDbSelfHealthy({
        ...healthyDb, bloat: [{ rel: 'entities', live: 10_000, dead: 150_000 }],
    }).filter((v) => !v.healthy);
    if (bloat.some((v) => /entities.*dead/.test((v as { problem: string }).problem))) {
        ok('db: 10x churn bloat is named');
    } else bad('the churn-bloat signature would pass silently', bloat);

    const disk = isDbSelfHealthy({
        ...healthyDb, disks: [{ path: '/var/lib/postgresql', availPct: 4 }],
    }).filter((v) => !v.healthy);
    if (disk.some((v) => /free/.test((v as { problem: string }).problem))) {
        ok('db: low disk headroom is named');
    } else bad('a nearly-full data volume would read healthy', disk);

    // ABSENCE IS ITS OWN PROBLEM, three ways - the whole point of the layer.
    const absent = isDbSelfHealthy(null).filter((v) => !v.healthy);
    if (absent.length === 1 && /unmeasured/.test((absent[0] as { problem: string }).problem)) {
        ok('db: a failed self-check query is UNMEASURED, not healthy');
    } else bad('absent db data read as permission', absent);

    const noStat = isDbSelfHealthy({ ...healthyDb, disks: [{ path: '/x', error: 'EACCES' }] })
        .filter((v) => !v.healthy);
    if (noStat.some((v) => v.healthy === false && v.problem.includes('unmeasured for /x'))) {
        ok('db: an unstattable path is UNMEASURED with its path named');
    } else bad('a statfs failure read as healthy disk', noStat);
}

console.log('\nisRetentionEnforcing - a retention that succeeds every run by dropping nothing:');
{
    const job = (name: string, lastDetail: string): JobRecordState => ({ ...healthyJob, name, lastDetail });
    const wouldDrop = [
        job('retention:samples', 'would-drop: samples_20260901, samples_20260902'),
        job('retention:messages', 'would-drop: messages_20260820 | kept-min-partitions: messages_20260821'),
    ];
    const red = isRetentionEnforcing(wouldDrop, true, true);
    if (!red.healthy && /3 partition\(s\)/.test(red.problem) && /RETENTION_DRY_RUN=0/.test(red.problem)) {
        ok('dry run with partitions past their keep date is RED, counts them, and names the fix');
    } else bad('the unbounded-growth case read as healthy, or said nothing useful', red);
    if (isRetentionEnforcing([job('retention:samples', 'nothing expired')], true, true).healthy) {
        ok('dry run on a young install, nothing past its date yet, is green - nothing differs yet');
    } else bad('a young dry-run install went red for nothing');
    if (isRetentionEnforcing(wouldDrop, false, true).healthy) ok('real retention is never this predicate\'s business');
    else bad('real retention went red');
    if (isRetentionEnforcing(wouldDrop, true, false).healthy) ok('jobs off: no retention runs, nothing to judge');
    else bad('jobs-off went red');
    if (isRetentionEnforcing([job('alerts:scan', 'would-drop: x')], true, true).healthy) {
        ok('only the two partition retention jobs are read');
    } else bad('another job\'s detail was misread as retention');
}

console.log('\nisNotifyDelivering - a configured channel that has stopped getting through:');
{
    const email = (n: number) => [{ channel: 'email', trailingFailures: n,
        lastDeliveredTs: '2026-09-28T04:06:36Z', lastAttemptTs: '2026-09-28T04:12:26Z' }];
    const red = isNotifyDelivering(email(NOTIFY_FAILURES_ALARM));
    if (!red.healthy && /"email"/.test(red.problem) && /nobody is being told/.test(red.problem)
        && /04:06:36/.test(red.problem)) {
        ok('three failures in a row is RED, names the channel and when it last delivered');
    } else bad('a dead channel read as healthy, or said nothing useful', red);
    if (isNotifyDelivering(email(NOTIFY_FAILURES_ALARM - 1)).healthy) ok('one short of that is a blip, not an outage');
    else bad('a blip went red');
    if (isNotifyDelivering(email(0)).healthy) ok('a delivering channel is green');
    else bad('a delivering channel went red');
    if (isNotifyDelivering(undefined).healthy && isNotifyDelivering([]).healthy) {
        ok('no channels, or no ledger yet, is isNotifyConfigSane\'s business, not this one\'s');
    } else bad('absent ledger went red');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
