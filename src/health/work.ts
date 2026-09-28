// Is the collector keeping its promise? The judgement half, so a test can
// reach it without a server and four workers - the same split as
// devices/onboard.ts and boards/source.ts, and for the same reason: the rule
// that decides is the part worth pinning, and a route cannot be pinned.
//
// WHY THIS EXISTS AT ALL, because a second health endpoint looks redundant
// until you have met both failures. /api/health/live answers "is this process
// running JavaScript" and answers it perfectly - one line, no auth, no
// database, so its latency is a pure event-loop trace. That is the right
// instrument for a thread held by synchronous work, which is how the parent
// suite's rollup took a Pi off the air for 66 seconds at a time.
//
// It cannot see the opposite failure, and this fork has now met it: at 30k
// entities the scheduler starved, 1,472 devices went unpolled, throughput
// fell 77% - and the box was 100% IDLE, the heartbeat clean at worst_ms=4.3
// with over_50ms=0. A probe that measures whether the process can respond
// will report perfect health for a process that responds instantly and does
// nothing. Liveness and usefulness are different properties and only one of
// them had an instrument.

/** The fields of the collector's snapshot this judgement reads. Structural on
 *  purpose: the snapshot crosses a thread boundary as a plain object, and this
 *  module must not narrow away the rest of it. */
export interface CollectorLag {
    pollLagP50Ms: number;
    pollLagP95Ms: number;
    concurrency: number;
    downConcurrency: number;
    inFlight: number;
    inFlightDown: number;
    skippedNoSlot: number;
}

export interface WorkHealth {
    status: number;
    body: Record<string, unknown>;
}

/**
 * THE MEDIAN, NOT THE 95th - AND THE FIRST VERSION OF THIS COMMENT GAVE THE
 * WRONG REASON, which is worth keeping because the wrong reason is the
 * intuitive one.
 *
 * It said p95 lands on the standing dead tier, from a reading of p50 448ms
 * against p95 182,232ms. That reading was taken four seconds after a restart
 * and was CATCH-UP, not steady state. Measured properly a day into the run,
 * with the same 78 dead devices still dead: p50 920ms and **p95 1,093ms**.
 * The collector's percentiles are over POLL EVENTS, and a dead device is
 * repolled only every ~195s, so the dead tier is about 0.8% of events - it
 * cannot reach the 95th percentile of that population.
 *
 * THE TRAP IS REAL BUT IT LIVES ONE LEVEL DOWN, in which population you take
 * the percentile OVER. At the same instant as those numbers, percentiled over
 * DEVICES rather than poll events: p50 995ms and **p95 83,115ms**. There, 78
 * of 1,550 is 5.03%, the 95th percentile lands squarely on the tier that is
 * dead on purpose, and an alarm would be red forever. Same fleet, same
 * moment, 76x apart - the choice of population matters more than the choice
 * of percentile.
 *
 * So the reason to read p50 is not that p95 is permanently broken here. It is
 * that p50 says something unambiguous - HALF the fleet has missed a cycle -
 * while p95 is the number that spikes hardest on catch-up (182s against
 * p50's 159s four seconds after a restart) and the one that inverts meaning
 * if anybody ever recomputes it per device.
 *
 * p95 still travels in the body, because the number that is wrong to alarm on
 * is often the right one to read once somebody is already looking.
 */
/**
 * IS THE DATABASE TAKING THE WORK? (2026-09-28, the outage drill.)
 *
 * PostgreSQL was stopped for three minutes on an installed box, and this
 * route answered 200 throughout: the collector kept polling on time, so by
 * the only measure the route had, the work was being done - while nothing
 * reached the database and ingest held 9,000 messages in memory. A monitor
 * pointed here, which is what the route is for, would never have known.
 *
 * Two witnesses, because each misses a case the other catches. The alert scan
 * reaches the database on a timer on every box, syslog or not - it is how a
 * quiet install learns of an outage - but it runs only as often as it is
 * configured to. Ingest knows within one flush, but only while something is
 * being sent. Either one failing past the limit is enough.
 */
export interface WriteSignals {
    /** The jobs worker's record for the alert scan, or null when jobs are off. */
    scan: { lastOkAt: string | null; lastRunAt: string | null; consecutiveFailures: number; lastDetail: string } | null;
    /** From the ingest snapshot; null when ingest has not reported. */
    ingest: { writeFailingMs?: number; queued: number } | null;
    nowMs: number;
    limitMs: number;
}

export function databaseVerdict(w: WriteSignals): { failing: false } | { failing: true; reason: string; detail: string } {
    const held = w.ingest?.queued ?? 0;
    const holding = held > 0
        ? ` Ingest is holding ${held.toLocaleString('en-US')} messages in memory and writes them when the database answers; past 50,000 the oldest are shed.`
        : '';
    const s = w.scan;
    if (s !== null && s.consecutiveFailures > 0) {
        const okAt = s.lastOkAt === null ? Number.NaN : Date.parse(s.lastOkAt);
        const forMs = Number.isFinite(okAt) ? w.nowMs - okAt : Number.NaN;
        // Never succeeded since start: count failures instead of time, two
        // being the fewest that cannot be one unlucky query.
        if (forMs >= w.limitMs || (!Number.isFinite(forMs) && s.consecutiveFailures >= 2)) {
            return {
                failing: true,
                reason: 'alert-scan-failing',
                detail: `the alert scan has failed${Number.isFinite(forMs) ? ` for ${Math.round(forMs / 1000)}s` : ` ${s.consecutiveFailures} times in a row`}`
                    + ` (${s.lastDetail || 'no detail'}).${holding}`,
            };
        }
    }
    const f = w.ingest?.writeFailingMs ?? 0;
    if (f >= w.limitMs) {
        return {
            failing: true,
            reason: 'ingest-write-stalled',
            detail: `the database has refused ingest's writes for ${Math.round(f / 1000)}s.${holding}`,
        };
    }
    return { failing: false };
}

export function workHealth(
    stats: CollectorLag | null, limitMs: number, collectorEnabled: boolean,
    writes: WriteSignals | null = null,
): WorkHealth {
    // First, and whether or not this instance polls: a database that takes
    // no work is the worst state the box can be in, and a reporting-only
    // instance with a dead database is broken all the same.
    if (writes !== null) {
        const db = databaseVerdict(writes);
        if (db.failing) return { status: 503, body: { ok: false, reason: db.reason, detail: db.detail } };
    }
    // A reporting-only instance is not a broken one. Answering 503 here would
    // teach an operator that this endpoint is noise, which costs more than
    // the check is worth.
    if (!collectorEnabled) return { status: 200, body: { ok: true, reason: 'collector-disabled' } };

    if (stats === null) {
        return {
            status: 503,
            body: {
                ok: false,
                reason: 'collector-not-ready',
                detail: 'the collector has not reported yet - normal for a few seconds after a restart',
            },
        };
    }

    const lagMs = stats.pollLagP50Ms;
    const keepingUp = lagMs <= limitMs;
    return {
        status: keepingUp ? 200 : 503,
        body: {
            ok: keepingUp,
            ...(keepingUp ? {} : { reason: 'poll-lag' }),
            // Everything needed to ACT, in the body a human reads after the
            // monitor has gone red. skippedNoSlot and inFlight are here
            // because together they name the difference between "busy" and
            // "starved", and that distinction is invisible from the outside:
            // both look like a quiet box.
            pollLagP50Ms: stats.pollLagP50Ms,
            limitMs,
            pollLagP95Ms: stats.pollLagP95Ms,
            concurrency: stats.concurrency,
            downConcurrency: stats.downConcurrency,
            inFlight: stats.inFlight,
            inFlightDown: stats.inFlightDown,
            skippedNoSlot: stats.skippedNoSlot,
            detail: keepingUp
                ? 'the collector is keeping up'
                : `the median poll is ${Math.round(lagMs / 1000)}s late against a `
                    + `${Math.round(limitMs / 1000)}s budget - if the box is idle and inFlight is `
                    + 'far below concurrency, the scheduler is starved rather than busy',
        },
    };
}
