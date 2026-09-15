// Quantify the parent suite's login defect, and prove the fix.
//
// All four parent apps call `crypto.scryptSync` in verifyPassword, on
// POST /api/login, which an unauthenticated caller can drive. The measured cost
// was 30ms of blocked event loop per call. This runs both forms side by side
// under a 10ms heartbeat so the difference is a number rather than an argument.
//
// It measures the CRYPTO in isolation, with no database and no HTTP, which is
// the point: if the async form still blocked, everything built on top of it
// would be measuring the wrong thing.
//
//   node tools/scrypt-blocking.ts
//
// A note on what async scrypt actually buys. It does not make the work free -
// it moves it to the libuv threadpool, which has UV_THREADPOOL_SIZE threads (4
// by default) shared with fs and dns. Concurrent logins therefore queue against
// each other. Queueing on a worker pool is a latency problem for the people
// logging in; blocking the loop is an outage for everyone else, including the
// poller. That asymmetry is the entire argument, and the concurrency section
// below measures the part that is NOT free.

import crypto from 'node:crypto';
import { startHeartbeat } from '../src/heartbeat.ts';
import { hashPassword, verifyPassword, SCRYPT } from '../src/auth/password.ts';

const ROUNDS = Number(process.env.ROUNDS || 20);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const MAX_MEM = 64 * 1024 * 1024;

/**
 * Let the timer phase run before reading heartbeat stats.
 *
 * Without this the burst measurement reported a worst gap of 0ms for 226ms of
 * solid blocking, which is a flatly impossible number. `await Promise.all(...)`
 * resolves in a MICROTASK, and microtasks drain before timers, so stats() ran
 * before the late heartbeat tick had a chance to fire and stop() then killed
 * the interval. The instrument was reading itself before the thing it measures
 * had happened.
 *
 * Caught by this file's own guard, which refuses to pass when the defect fails
 * to reproduce. That guard existed because a comparison where the control does
 * nothing cannot demonstrate anything - and it turned out to catch a bug in the
 * measurement rather than a quiet subject.
 */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
}

function syncVerify(password: string, salt: Buffer, expected: Buffer): boolean {
    const actual = crypto.scryptSync(password, salt, expected.length, { ...SCRYPT, maxmem: MAX_MEM });
    return crypto.timingSafeEqual(actual, expected);
}

async function main(): Promise<void> {
    console.log('scrypt on the event loop');
    console.log(`  parameters  N=${SCRYPT.N}, r=${SCRYPT.r}, p=${SCRYPT.p}`);
    console.log(`  rounds      ${ROUNDS}`);
    console.log(`  threadpool  UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}`);
    console.log('');

    const stored = await hashPassword('a-representative-password');
    const [, , saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64 as string, 'base64');
    const expected = Buffer.from(hashB64 as string, 'base64');

    // --- the parent's behaviour ---------------------------------------------
    const hbSync = startHeartbeat('sync', 10, 50);
    await new Promise((r) => setTimeout(r, 200)); // let the heartbeat settle
    hbSync.reset();

    const tSync = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
        syncVerify('a-representative-password', salt, expected);
        // Yield, so the heartbeat has a chance to fire between calls. Without
        // this the loop never runs at all and the gap is one huge number rather
        // than the per-call cost, which overstates the case.
        await new Promise((r) => setImmediate(r));
    }
    const syncMs = performance.now() - tSync;
    await settle();
    const syncStats = hbSync.stats();
    hbSync.stop();

    console.log('crypto.scryptSync - what all four parent apps do');
    console.log(`  wall clock        ${syncMs.toFixed(0)}ms for ${ROUNDS} verifications`);
    console.log(`  per call          ${(syncMs / ROUNDS).toFixed(1)}ms`);
    console.log(`  heartbeat worst   ${syncStats.worstGapMs}ms`);
    console.log(`  gaps over 50ms    ${syncStats.overThresholdCount}`);

    // --- ours -----------------------------------------------------------------
    const hbAsync = startHeartbeat('async', 10, 50);
    await new Promise((r) => setTimeout(r, 200));
    hbAsync.reset();

    const tAsync = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
        await verifyPassword('a-representative-password', stored);
    }
    const asyncMs = performance.now() - tAsync;
    await settle();
    const asyncStats = hbAsync.stats();
    hbAsync.stop();

    console.log('\ncrypto.scrypt (async) - what RSCanvas does');
    console.log(`  wall clock        ${asyncMs.toFixed(0)}ms for ${ROUNDS} verifications`);
    console.log(`  per call          ${(asyncMs / ROUNDS).toFixed(1)}ms`);
    console.log(`  heartbeat worst   ${asyncStats.worstGapMs}ms`);
    console.log(`  gaps over 50ms    ${asyncStats.overThresholdCount}`);

    // --- what async does NOT fix ---------------------------------------------
    const hbConc = startHeartbeat('concurrent', 10, 50);
    await new Promise((r) => setTimeout(r, 200));
    hbConc.reset();

    const tConc = performance.now();
    const latencies = await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            const t = performance.now();
            await verifyPassword('a-representative-password', stored);
            return performance.now() - t;
        }),
    );
    const concMs = performance.now() - tConc;
    await settle();
    const concStats = hbConc.stats();
    hbConc.stop();
    latencies.sort((a, b) => a - b);

    console.log(`\n${CONCURRENCY} concurrent verifications - the threadpool, not the loop`);
    console.log(`  wall clock        ${concMs.toFixed(0)}ms`);
    console.log(`  fastest           ${(latencies[0] as number).toFixed(1)}ms`);
    console.log(`  slowest           ${(latencies[latencies.length - 1] as number).toFixed(1)}ms`);
    console.log(`  heartbeat worst   ${concStats.worstGapMs}ms`);
    console.log(`  gaps over 50ms    ${concStats.overThresholdCount}`);
    console.log('  (the slowest waited for a threadpool thread. That is latency for the');
    console.log('   person logging in, not a stall for everyone else.)');

    // --- the case that actually breaks: a burst of logins -------------------
    //
    // One scryptSync is about 32ms, which is under the 50ms threshold, so the
    // single-call comparison above understates the defect. The parent's real
    // exposure is CONCURRENT logins: JavaScript cannot overlap synchronous
    // work, so N simultaneous attempts serialise into one unbroken stall of
    // N x 32ms, during which nothing polls, no datagram drains, and every other
    // request waits. That is the outage, and it is what the async form removes.
    const hbBurst = startHeartbeat('sync-burst', 10, 50);
    await new Promise((r) => setTimeout(r, 200));
    hbBurst.reset();

    const tBurst = performance.now();
    // Written as Promise.all to mirror the async case exactly. It changes
    // nothing: the callbacks run one after another on the loop regardless,
    // which is the entire problem.
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            syncVerify('a-representative-password', salt, expected);
        }),
    );
    const burstMs = performance.now() - tBurst;
    await settle();
    const burstStats = hbBurst.stats();
    hbBurst.stop();

    console.log(`\n${CONCURRENCY} concurrent verifications, SYNC - the parent's outage case`);
    console.log(`  wall clock        ${burstMs.toFixed(0)}ms`);
    console.log(`  heartbeat worst   ${burstStats.worstGapMs}ms`);
    console.log(`  gaps over 50ms    ${burstStats.overThresholdCount}`);
    console.log('  (nothing else ran for that entire window. In SNMPCanvas the loop');
    console.log('   this freezes is also the poll loop.)');

    // --- verdict ---------------------------------------------------------------
    const failures: string[] = [];

    if (burstStats.worstGapMs < 50) {
        failures.push(
            `${CONCURRENCY} concurrent scryptSync calls produced a worst gap of only `
            + `${burstStats.worstGapMs}ms. The defect did not reproduce, so this run cannot `
            + 'demonstrate the fix either.',
        );
    }
    if (concStats.worstGapMs >= 50) {
        failures.push(`the async burst blocked the loop for ${concStats.worstGapMs}ms - rule 4 is violated`);
    }
    if (asyncStats.overThresholdCount > 0) {
        failures.push(`async scrypt blocked the loop past 50ms ${asyncStats.overThresholdCount} times`);
    }
    if (concStats.overThresholdCount > 0) {
        failures.push(`concurrent async scrypt blocked the loop past 50ms ${concStats.overThresholdCount} times`);
    }
    console.log('');
    if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL - ${f}`);
        process.exit(1);
    }
    console.log('PASS');
    console.log(`  one scryptSync stalls the loop for ${syncStats.worstGapMs}ms (${(syncMs / ROUNDS).toFixed(1)}ms of work)`);
    console.log(`  ${CONCURRENCY} at once stall it for ${burstStats.worstGapMs}ms, ${burstStats.overThresholdCount} gaps over 50ms`);
    console.log(`  the same ${CONCURRENCY} async: worst gap ${concStats.worstGapMs}ms, ${concStats.overThresholdCount} over 50ms, in ${concMs.toFixed(0)}ms wall clock`);
    console.log('  ARCHITECTURE.md rule 4 holds, and the defect it names is reproduced beside it');
}

main().catch((err) => {
    console.error('scrypt blocking test failed:', err);
    process.exit(1);
});
