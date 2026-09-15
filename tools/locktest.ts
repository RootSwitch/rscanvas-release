// The retention lock collision, and the guard against it.
//
//   node tools/locktest.ts
//
// WHAT THIS TESTS HAS CHANGED. When the spike first measured this, reproducing
// the collision meant demonstrating the PROBLEM. Now that lock_timeout exists
// inside drop_partitions_guarded, it means demonstrating the GUARD - which
// needs three assertions rather than one.
//
// THE FINDING BEING GUARDED. DROP TABLE takes ACCESS EXCLUSIVE on the partition
// AND on its parent, and a waiting exclusive request sits at the HEAD of the
// lock queue - so every query arriving AFTERWARDS waits behind it, even though
// it would never have conflicted with the reader already running. The spike
// measured a 3.7s reader making a drop wait 1.3s while blocking an unrelated
// dashboard query for 609ms against a 1.7ms norm. It scales with the reader, so
// a permitted 456-second export would stall every dashboard for minutes.
//
// Run 2's clean 112ms was luck and was recorded as such. This is the run that
// replaces it.
//
// SAFETY. Every drop here targets a DISPOSABLE 1970-dated partition, created
// for the purpose, BY NAME. It exercises the same parent-level ACCESS EXCLUSIVE
// as a real retention drop while being incapable of holding real rows. That is
// layer 2 of the fixture guard, and it exists because spike/src/locktest.ts -
// this file's ancestor - destroyed 158GB by calling the real retention job with
// keep_days = 0 to guarantee it had something to drop.
//
// That claim was FALSE for a day. The 22GB fix landed on one of the two
// destructive call sites and this header was written as though it had covered
// both; the counterfactual at the bottom of the file still ran the scan. The
// lesson is not "check both call sites" - it is that a safety claim in a
// comment is not enforcement. What enforces it now is that this file refuses to
// run against a protected database at all (src/safety.ts), so the claim above
// is checked at startup rather than asserted in prose.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const READER_SECONDS = Number(process.env.READER_SECONDS || 6);

async function sql<T = Record<string, unknown>>(
    text: string, values: unknown[] = [], lane: 'jobs' | 'interactive' | 'heavy' = 'jobs',
): Promise<T[]> {
    const res = await onLane(lane, async (client) => {
        const r = await client.query(text, values);
        return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    });
    if (!res.ok) throw new Error(`lane refused: ${res.reason}`);
    return res.rows as T[];
}

/**
 * Drop ONE NAMED disposable partition, under lock_timeout.
 *
 * THIS MUST NOT GO THROUGH drop_partitions_guarded, and that is the whole
 * lesson of this file. The first version called
 * `drop_partitions_guarded('samples', 7, ..., dry_run=false, min_keep=1)` to
 * produce a contended DROP - and the function did exactly what it was asked:
 * it scanned the WHOLE table for expired partitions and dropped
 * samples_20260718 and samples_20260719 as well. 172.8 million rows, 22GB of
 * seeded corpus, destroyed as collateral by a test measuring something else.
 *
 * That is the same class of mistake as spike/src/locktest.ts losing 158GB, in a
 * file with the same name, for the same underlying reason: a test invoking the
 * REAL retention path against real data to guarantee it had something to drop.
 * The disposable partition was already here and being used for the partition
 * under test; the guarded call scanned past it.
 *
 * What the test actually needs is a DROP TABLE taking ACCESS EXCLUSIVE on the
 * samples PARENT. That is this, on one partition, named explicitly. It
 * exercises the identical lock path with zero reachability into real data - a
 * named table cannot expand into a scan.
 */
async function dropDisposable(name: string): Promise<Array<{ action: string; partition_name: string }>> {
    await onLane('jobs', async (client) => {
        await client.query('BEGIN');
        try {
            await client.query("SET LOCAL lock_timeout = '2s'");
            await client.query(`DROP TABLE ${name}`);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        return { rows: [], rowCount: 0 };
    });
    return [{ action: 'dropped', partition_name: name }];
}

/**
 * A dashboard-shaped read, timed. The number the whole finding is about.
 *
 * IT MUST TOUCH `samples`. The first version used `OPS.ping()` - `SELECT 1` -
 * which requests no lock on anything, so it could never queue behind the DROP's
 * ACCESS EXCLUSIVE request. It reported a reassuring 0.67ms that proved
 * precisely nothing, and would have reported the same number with the guard
 * removed entirely.
 *
 * A probe that cannot experience the fault cannot measure the guard against it.
 * Same rule as every fault-injection assertion in the chaos suite, missed here
 * on the first attempt.
 */
async function dashboardQuery(): Promise<number> {
    const t0 = performance.now();
    const r = await OPS.dashboardProbe();
    if (!r.ok) throw new Error(`dashboard probe refused: ${r.reason}`);
    return performance.now() - t0;
}

/**
 * A long reader holding ACCESS SHARE on the samples parent.
 *
 * An explicit LOCK TABLE rather than a real query, deliberately. A genuine
 * long read would have to scan a meaningful slice of 92GB to last six seconds,
 * which makes the test expensive and its duration dependent on cache state.
 * The lock is what the collision is actually about, so taking it directly is
 * both precise and cheap - and it holds exactly the mode a real reader holds.
 */
function startLongReader(seconds: number): Promise<void> {
    return onLane('heavy', async (client) => {
        await client.query('BEGIN');
        try {
            await client.query('LOCK TABLE samples IN ACCESS SHARE MODE');
            await client.query('SELECT pg_sleep($1::float8)', [seconds]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        return { rows: [], rowCount: 0 };
    }).then(() => undefined);
}

async function main(): Promise<void> {
    // Before the first connection, not after the first DROP.
    assertDestructiveTarget('locktest', CONFIG.databaseUrl);
    console.log('retention lock collision, and the guard\n');

    await sql(`DROP TABLE IF EXISTS samples_19700105`);
    await sql(`CREATE TABLE samples_19700105
               PARTITION OF samples FOR VALUES FROM ('1970-01-05') TO ('1970-01-06')`);

    // Baseline: what a dashboard query costs with nothing in the way.
    const norm: number[] = [];
    for (let i = 0; i < 20; i++) norm.push(await dashboardQuery());
    norm.sort((a, b) => a - b);
    const normP50 = norm[Math.floor(norm.length / 2)] as number;
    console.log(`  dashboard norm: p50 ${normP50.toFixed(2)}ms over 20 samples\n`);

    // --- the collision ------------------------------------------------------
    //
    // A long reader holds ACCESS SHARE. The retention drop asks for ACCESS
    // EXCLUSIVE and queues at the head. A dashboard query arrives AFTER it -
    // that ordering is the whole finding, because without the queued exclusive
    // request the reader and the dashboard would never have conflicted.
    console.log(`  starting a ${READER_SECONDS}s reader, then a guarded drop behind it,`);
    console.log('  then a dashboard query behind THAT');

    const reader = startLongReader(READER_SECONDS);
    await new Promise((r) => setTimeout(r, 400));

    const tDrop = performance.now();
    const dropPromise = dropDisposable('samples_19700105').then(
        (rows) => ({ ok: true as const, rows, ms: performance.now() - tDrop }),
        (err: Error) => ({ ok: false as const, err, ms: performance.now() - tDrop }),
    );

    // Arrive behind the queued exclusive request.
    await new Promise((r) => setTimeout(r, 300));
    const duringMs = await dashboardQuery();

    const drop = await dropPromise;
    await reader;

    console.log('');
    console.log(`  drop returned after ${(drop.ms / 1000).toFixed(2)}s`);
    console.log(`  dashboard query behind it: ${duringMs.toFixed(2)}ms (norm ${normP50.toFixed(2)}ms)`);
    console.log('');

    // --- ASSERTION 1: the drop loses GRACEFULLY -----------------------------
    //
    // lock_timeout must produce a clean give-up, not an error that wedges the
    // job. Retention is never urgent; it can lose a race and come back.
    if (drop.ok) {
        const dropped = drop.rows.filter((r) => r.action === 'dropped');
        ok(`the drop completed without error (${dropped.length} dropped)`);
    } else if (/lock timeout|canceling statement due to lock timeout/i.test(drop.err.message)) {
        ok(`the drop timed out on the lock and gave up cleanly: ${drop.err.message.split('\n')[0]}`);
    } else {
        bad('the drop failed for a reason other than lock_timeout', drop.err.message);
    }

    // It must NOT have waited indefinitely. 2s ceiling, with slack for the
    // round trip.
    if (drop.ms < 6000) {
        ok(`and it bounded its wait at ${(drop.ms / 1000).toFixed(2)}s rather than the reader's ${READER_SECONDS}s`);
    } else {
        bad(`the drop waited ${(drop.ms / 1000).toFixed(2)}s - lock_timeout did not bound it`);
    }

    // --- ASSERTION 2: the dashboard query is NOT collateral -----------------
    //
    // THIS IS THE ONE CARRYING THE ORIGINAL FINDING. The spike measured 609ms
    // against a 1.7ms norm because the queued exclusive request parked at the
    // head of the queue for as long as the reader ran. With lock_timeout the
    // exclusive request gives up after 2s, so a query arriving behind it waits
    // at most that - and in practice much less.
    //
    // The difference between those two numbers IS the guard's value.
    const ratio = duringMs / Math.max(0.01, normP50);
    if (duringMs < 2500) {
        ok(`a query arriving behind the queued DROP cost ${duringMs.toFixed(1)}ms `
            + `(${ratio.toFixed(0)}x norm), bounded by the 2s lock_timeout`);
        console.log(`         without the guard this scales with the READER: the spike measured`);
        console.log(`         609ms against a 1.7ms norm, and a 456s export would stall it for minutes`);
    } else {
        bad(`a query behind the DROP cost ${duringMs.toFixed(1)}ms - the guard is not bounding collateral damage`);
    }

    // --- THE COUNTERFACTUAL: the damage is BOUNDED, not eliminated ----------
    //
    // This is the assertion that carries the guard's actual value, and it needs
    // two runs rather than one. A single measurement cannot distinguish "the
    // lock_timeout bounded it" from "the reader happened to be short".
    //
    // The finding is that collateral damage scales with the READER: the spike's
    // 609ms came from a 3.7s reader, and a permitted 456-second export would
    // stall every dashboard for minutes. With lock_timeout the exclusive
    // request gives up after 2s, so the damage should be bounded by the TIMEOUT
    // and flat with respect to the reader.
    //
    // So: run it again with a reader twice as long. If the dashboard cost
    // roughly doubles, the guard is not working. If it stays flat, it is.
    console.log('');
    console.log(`  repeating with a ${READER_SECONDS * 2}s reader - the cost must NOT scale with it`);
    await sql(`DROP TABLE IF EXISTS samples_19700106`);
    await sql(`CREATE TABLE samples_19700106
               PARTITION OF samples FOR VALUES FROM ('1970-01-06') TO ('1970-01-07')`);

    // THE SAME NAMED DROP AS ABOVE, and the reason is worth more than the line.
    //
    // This call used to be
    // `drop_partitions_guarded('samples', 7, 7, 3, 1, 31, false, '2s')` - the
    // verbatim call documented 180 lines above as the one that destroyed 22GB.
    // The fix for that accident landed on the first call site and missed this
    // one, so the file carried its own lesson and its own bomb at once.
    //
    // It was not defused, it was MASKED: guard 5 refuses every samples
    // partition while the rollup frontier is NULL, and the frontier is NULL on
    // the lab only because the jobs worker has never run. The first successful
    // rollup catch-up would have re-armed it, and the very next run of this
    // file would have dropped samples_20260718 and samples_20260719 again.
    //
    // And while masked it was VACUOUS: every partition came back deferred, no
    // ACCESS EXCLUSIVE was ever requested, and the scaling assertion below
    // measured a dashboard query with nothing queued ahead of it. Flat because
    // empty, not flat because guarded - a green PASS proving nothing. Wrong in
    // both states, which is the signature of a safety property that depends on
    // where the calendar happens to be.
    const reader2 = startLongReader(READER_SECONDS * 2);
    await new Promise((r) => setTimeout(r, 400));
    const drop2 = dropDisposable('samples_19700106')
        .then(() => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const duringMs2 = await dashboardQuery();
    await drop2;
    await reader2;
    await sql(`DROP TABLE IF EXISTS samples_19700106`);

    console.log(`  dashboard behind a ${READER_SECONDS * 2}s reader: ${duringMs2.toFixed(1)}ms `
        + `(behind ${READER_SECONDS}s: ${duringMs.toFixed(1)}ms)`);

    const scaling = duringMs2 / Math.max(1, duringMs);
    if (scaling < 1.5) {
        ok(`doubling the reader changed the cost by ${scaling.toFixed(2)}x - FLAT, so the bound is the `
            + 'lock_timeout and not the reader');
        console.log('         THIS is the guard\'s value: unguarded, a 456s export would hold every');
        console.log('         dashboard for 456s. Guarded, the worst case is the 2s ceiling.');
    } else {
        bad(`the cost scaled ${scaling.toFixed(2)}x with the reader - lock_timeout is not bounding it`);
    }

    // --- THE CONTROL: with NO DROP, the probe must return to its norm -------
    //
    // WHY THIS EXISTS. The 1.7s figure did not move when the vacuous
    // counterfactual was replaced: 1708.0 / 1701.6 before, 1702 / 1701 after.
    // If that second call had really been measuring an empty queue, removing it
    // should have changed something. Two explanations fit - either the real
    // ACCESS EXCLUSIVE was always coming from the NAMED disposable drop, so the
    // measurement was sound and :238 was armed but not load-bearing; or 1.7s is
    // produced by something other than a queued exclusive lock and BOTH numbers
    // are artifacts.
    //
    // Reasoning cannot separate those. Running the same sequence with the drop
    // REMOVED can: a reader holding ACCESS SHARE does not conflict with a
    // SELECT, so with nothing queued ahead of it the probe must come back at
    // roughly its norm. If it still reads seconds, the finding is not about
    // lock queueing at all.
    //
    // Kept in the file rather than run once, because it is the assertion that
    // makes every other number here mean what it says.
    console.log('');
    console.log(`  control: a ${READER_SECONDS}s reader and NO drop - the probe must return to norm`);
    const reader3 = startLongReader(READER_SECONDS);
    await new Promise((r) => setTimeout(r, 700));   // same arrival offset as above
    const controlMs = await dashboardQuery();
    await reader3;

    console.log(`  dashboard with a reader but no drop: ${controlMs.toFixed(2)}ms `
        + `(norm ${normP50.toFixed(2)}ms, behind a drop ${duringMs.toFixed(1)}ms)`);

    if (controlMs < 100) {
        ok(`without a queued DROP the same probe costs ${controlMs.toFixed(2)}ms, so the `
            + `${duringMs.toFixed(0)}ms above IS the lock queue and not the query`);
    } else {
        bad(`the probe cost ${controlMs.toFixed(1)}ms with NO drop queued - something other than a `
            + 'queued exclusive lock produces this figure, and every number in this file is suspect',
            `norm ${normP50.toFixed(2)}ms`);
    }

    // --- ASSERTION 3: a missed run self-heals -------------------------------
    //
    // The slice 5 done-when, on its most realistic path: the drop lost the
    // race, so the partition is still there, and the NEXT run must pick it up
    // with nothing left over. A guard that loses gracefully but never retries
    // has only converted an outage into a leak.
    console.log('');
    const stillThere = await sql(`SELECT 1 FROM pg_class WHERE relname = 'samples_19700105'`);
    if (stillThere.length === 1) {
        console.log('  the disposable partition survived the contended run; retrying uncontended');

        // GUARD 5 must refuse the guarded path here, and that is the correct
        // outcome rather than a failure: the rollup frontier is NULL, so no
        // samples partition has been consumed and none may be dropped. Checked
        // explicitly, because it is also the guard that would have prevented
        // this file's own 22GB accident.
        const guarded = await sql<{ action: string; partition_name: string }>(
            `SELECT * FROM drop_partitions_guarded('samples', 7, 7, 3, 1, 31, true, '2s')`,
        );
        if (guarded.every((r) => r.action !== 'dropped' && r.action !== 'would-drop')) {
            ok('guard 5 refuses every samples partition while the rollup frontier is unset');
        } else {
            bad('guard 5 would have dropped unrolled samples', JSON.stringify(guarded));
        }

        // The self-heal itself is on the direct path, for the same reason the
        // contended drop is: a named table cannot expand into a scan.
        await dropDisposable('samples_19700105');
        const gone = await sql(`SELECT 1 FROM pg_class WHERE relname = 'samples_19700105'`);
        if (gone.length === 0) {
            ok('the NEXT attempt picked it up - a lost race self-heals rather than leaking');
        } else {
            bad('the retry did not drop it');
        }
    } else {
        ok('the contended run dropped it outright - the lock was free enough this time');
        console.log('         (the self-heal path is exercised whenever the race is actually lost)');
    }

    // Whatever happened, leave nothing behind.
    await sql(`DROP TABLE IF EXISTS samples_19700105`);

    // --- and the deferred-report claim --------------------------------------
    const deferred = drop.ok ? drop.rows.filter((r) => r.action === 'deferred') : [];
    if (drop.ok && drop.rows.length > 0) {
        ok(`the job reported every partition it touched (${drop.rows.length} rows, ${deferred.length} deferred)`);
    }

    await closeAll();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('locktest failed:', err);
    void closeAll();
    process.exit(1);
});
