// Prove the heavy lane's admission policy before anything is built on top of
// it. BUILD-PLAN slice 1, done-when criterion 4:
//
//   "Driving 8 concurrent searches against the 4-connection lane returns
//    structured busy responses within ~2s, not 20s waits, and waitMs is
//    visible separately from execMs in the logs."
//
// The failure this exists to prevent is specific and was measured in phase 2:
// six concurrent heavy queries against four connections produced 20.7 seconds
// of user-visible latency, while every individual query finished well inside
// its 30s statement_timeout. The timeout never fired because the query was not
// slow - the QUEUE was. That is the fork's own bug class, relocated from the
// event loop to the pool queue and made invisible to the mechanism meant to
// catch it.
//
//   node tools/admission-test.ts
//   CONCURRENCY=8 PROBE_SECONDS=3 node tools/admission-test.ts

import { OPS, LANES, laneState, closeAll } from '../src/store/index.ts';
import { startHeartbeat } from '../src/heartbeat.ts';
import { CONFIG } from '../src/config.ts';

const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const PROBE_SECONDS = Number(process.env.PROBE_SECONDS || 3);
const CAPACITY = LANES.heavy.max;
const WAIT_CEILING = LANES.heavy.connectionTimeoutMs;

interface Attempt {
    id: number;
    admitted: boolean;
    waitMs: number;
    execMs: number;
    inFlightSeen?: number;
    capacity?: number;
}

async function main(): Promise<void> {
    console.log('admission policy, heavy lane');
    console.log(`  database      ${CONFIG.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
    console.log(`  capacity      ${CAPACITY} connections`);
    console.log(`  wait ceiling  ${WAIT_CEILING}ms (connectionTimeoutMillis)`);
    console.log(`  exec ceiling  ${LANES.heavy.statementTimeoutMs}ms (statement_timeout)`);
    console.log(`  driving       ${CONCURRENCY} concurrent probes of ${PROBE_SECONDS}s each`);
    console.log('');

    // The heartbeat runs here too. Admission control is main-thread JavaScript,
    // and a semaphore that blocked the loop while "waiting" would be a fine
    // irony to ship.
    const hb = startHeartbeat('admission-test', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);

    const t0 = performance.now();
    const attempts = await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, i): Promise<Attempt> => {
            const res = await OPS.slowProbe(PROBE_SECONDS);
            if (res.ok) {
                return {
                    id: i,
                    admitted: true,
                    waitMs: res.timing.waitMs,
                    execMs: res.timing.execMs,
                };
            }
            if (res.reason === 'busy') {
                return {
                    id: i,
                    admitted: false,
                    waitMs: res.waitMs,
                    execMs: 0,
                    inFlightSeen: res.inFlight,
                    capacity: res.capacity,
                };
            }
            // A statement timeout here would mean the probe outlived the lane's
            // 30s execution limit, which is a misconfigured probe rather than a
            // finding. Say so rather than folding it into the numbers.
            throw new Error(
                `probe ${i} hit statement_timeout at ${res.limitMs}ms - PROBE_SECONDS is too large`,
            );
        }),
    );
    const totalMs = performance.now() - t0;

    const admitted = attempts.filter((a) => a.admitted);
    const busy = attempts.filter((a) => !a.admitted);
    const worstWait = Math.max(...attempts.map((a) => a.waitMs));

    console.log('per attempt, wait and execution measured SEPARATELY:');
    console.log('  id  outcome  waitMs   execMs');
    for (const a of [...attempts].sort((x, y) => x.id - y.id)) {
        const outcome = a.admitted ? 'ok   ' : 'busy ';
        const extra = a.admitted ? '' : `  (inFlight ${a.inFlightSeen}/${a.capacity})`;
        console.log(
            `  ${String(a.id).padStart(2)}  ${outcome}  ${a.waitMs.toFixed(1).padStart(7)}  ${a.execMs.toFixed(1).padStart(7)}${extra}`,
        );
    }

    console.log('');
    console.log(`  admitted        ${admitted.length}`);
    console.log(`  refused busy    ${busy.length}`);
    console.log(`  worst wait      ${worstWait.toFixed(1)}ms`);
    console.log(`  wall clock      ${totalMs.toFixed(1)}ms`);
    console.log(`  heartbeat       worst gap ${hb.stats().worstGapMs}ms over ${hb.stats().ticks} ticks`);
    console.log('');
    console.log('lane state after:', JSON.stringify(laneState('heavy'), null, 2));

    // --- the criteria, checked rather than eyeballed -------------------------
    const failures: string[] = [];

    if (admitted.length !== Math.min(CONCURRENCY, CAPACITY)) {
        failures.push(
            `expected exactly ${Math.min(CONCURRENCY, CAPACITY)} admitted, got ${admitted.length}`,
        );
    }
    if (CONCURRENCY > CAPACITY && busy.length !== CONCURRENCY - CAPACITY) {
        failures.push(`expected ${CONCURRENCY - CAPACITY} refusals, got ${busy.length}`);
    }
    // The whole point: a refusal arrives at the wait ceiling, not at the end of
    // the queue. 20% headroom for timer slop.
    const ceilingWithSlop = WAIT_CEILING * 1.2;
    for (const a of busy) {
        if (a.waitMs > ceilingWithSlop) {
            failures.push(`attempt ${a.id} waited ${a.waitMs.toFixed(1)}ms, ceiling is ${WAIT_CEILING}ms`);
        }
    }
    // Admitted probes must show the cost in execMs, not in waitMs. If these
    // were conflated the 20.7s failure would be invisible again.
    for (const a of admitted) {
        if (a.execMs < PROBE_SECONDS * 900) {
            failures.push(`attempt ${a.id} execMs ${a.execMs.toFixed(1)} is below the ${PROBE_SECONDS}s probe`);
        }
        if (a.waitMs > 500) {
            failures.push(`attempt ${a.id} waited ${a.waitMs.toFixed(1)}ms for a free slot it should have had`);
        }
    }
    if (hb.stats().overThresholdCount > 0) {
        failures.push(`heartbeat exceeded ${CONFIG.heartbeatThresholdMs}ms ${hb.stats().overThresholdCount} times`);
    }

    // --- scenario B: does waitMs measure the QUEUE, or just the timer? -------
    //
    // Every refusal above reported waitMs = the 2,000ms ceiling. That is the
    // right answer, and it is also exactly what a store that timed its own
    // timeout rather than the queue would print. The two are indistinguishable
    // from scenario A alone, and the comfortable reading is the one to
    // distrust.
    //
    // The jobs lane waits instead of refusing: capacity 2, ceiling 30s. Four
    // probes there must produce two immediate admissions and two that wait
    // roughly one probe-length and then succeed. That waited value is a real
    // queueing delay which nothing in the store knows in advance, so it cannot
    // be a constant leaking through.
    console.log('');
    console.log(`scenario B: jobs lane, capacity ${LANES.jobs.max}, ceiling ${LANES.jobs.connectionTimeoutMs}ms (waits rather than refuses)`);
    console.log(`  driving 4 concurrent probes of ${PROBE_SECONDS}s`);

    const queued = await Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
            const res = await OPS.slowProbeQueued(PROBE_SECONDS);
            if (!res.ok) throw new Error(`jobs probe ${i} refused unexpectedly (${res.reason})`);
            return { id: i, waitMs: res.timing.waitMs, execMs: res.timing.execMs };
        }),
    );

    console.log('  id  waitMs   execMs');
    for (const q of queued) {
        console.log(`  ${String(q.id).padStart(2)}  ${q.waitMs.toFixed(1).padStart(7)}  ${q.execMs.toFixed(1).padStart(7)}`);
    }

    const straightThrough = queued.filter((q) => q.waitMs < 500);
    const hadToWait = queued.filter((q) => q.waitMs >= 500);

    if (straightThrough.length !== LANES.jobs.max) {
        failures.push(`scenario B: expected ${LANES.jobs.max} probes admitted immediately, got ${straightThrough.length}`);
    }
    if (hadToWait.length !== 4 - LANES.jobs.max) {
        failures.push(`scenario B: expected ${4 - LANES.jobs.max} probes to queue, got ${hadToWait.length}`);
    }
    for (const q of hadToWait) {
        // A queued probe waits about one probe-length: the slot frees when a
        // predecessor finishes. Not the ceiling, and not zero.
        const expected = PROBE_SECONDS * 1000;
        if (q.waitMs < expected * 0.8 || q.waitMs > expected * 1.4) {
            failures.push(
                `scenario B: probe ${q.id} waited ${q.waitMs.toFixed(1)}ms, expected about ${expected}ms (one probe length)`,
            );
        }
        if (Math.abs(q.waitMs - LANES.jobs.connectionTimeoutMs) < 100) {
            failures.push(`scenario B: probe ${q.id} waitMs equals the lane ceiling - it is timing the timeout, not the queue`);
        }
    }

    hb.stop();
    await closeAll();

    console.log('');
    if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL - ${f}`);
        process.exit(1);
    }
    console.log(`PASS - heavy: ${admitted.length} admitted, ${busy.length} refused inside ${WAIT_CEILING}ms`);
    console.log(`PASS - jobs:  ${straightThrough.length} straight through, ${hadToWait.length} queued and measured as real waiting`);
    console.log('       wait and execution are reported apart, and waitMs tracks the queue rather than the timeout');
}

main().catch((err) => {
    console.error('admission test failed:', err);
    process.exit(1);
});
