// The rollup's arithmetic, asserted against a synthetic fixture.
//
//   node tools/test-rollup.ts
//
// Uses disposable 1970-dated entities and partitions, so it can never touch the
// seeded corpus - the same layer-2 device the retention guard test uses.
//
// Three claims, and the third is a control that must fail.

import { internalUnsafeLane as onLane, closeAll } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
    const res = await onLane('jobs', async (client) => {
        const r = await client.query(text, values);
        return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    });
    if (!res.ok) throw new Error(`lane refused: ${res.reason}`);
    return res.rows as T[];
}

const E1 = 900001;
const E2 = 900002;

async function setup(): Promise<void> {
    await sql(`CREATE TABLE IF NOT EXISTS samples_19700101
               PARTITION OF samples FOR VALUES FROM ('1970-01-01') TO ('1970-01-02')`);
    // Two monthly rollup partitions, so the boundary claim can be tested.
    await sql(`CREATE TABLE IF NOT EXISTS samples_hourly_197001
               PARTITION OF samples_hourly FOR VALUES FROM ('1970-01-01') TO ('1970-02-01')`);
    await sql(`CREATE TABLE IF NOT EXISTS samples_hourly_197002
               PARTITION OF samples_hourly FOR VALUES FROM ('1970-02-01') TO ('1970-03-01')`);
}

async function teardown(): Promise<void> {
    for (const t of ['samples_19700101', 'samples_hourly_197001', 'samples_hourly_197002']) {
        await sql(`DROP TABLE IF EXISTS ${t}`);
    }
}

async function main(): Promise<void> {
    // It drops partitions and DELETEs from `samples` by an entity_id range that
    // the live sequence will eventually reach. Both are fine against a
    // disposable database and neither is fine against the corpus.
    assertDestructiveTarget('test-rollup', CONFIG.databaseUrl);
    console.log('rollup arithmetic\n');
    await teardown();
    await setup();

    try {
        // --- claim 1: the window is clamped to whole hours -------------------
        //
        // Hour 01:00 gets 60 samples. A run covering [00:00, 01:30) must NOT
        // write it from the first half alone, because a later run covering
        // [01:30, 02:00) would then REPLACE that row with the second half -
        // ON CONFLICT DO UPDATE replaces, it does not merge - and n would claim
        // to describe the whole hour. Invisible until raw expires 14 days later.
        await sql(`
            INSERT INTO samples (entity_id, ts, status, rtt_ms, v0)
            SELECT $1, timestamptz '1970-01-01 01:00:00+00' + (g || ' minutes')::interval,
                   1, 5.0, g * 10.0
              FROM generate_series(0, 59) g`, [E1]);

        const partial = await sql<{ hours_written: string; from_clamped: string; to_clamped: string }>(
            `SELECT * FROM roll_up_samples('1970-01-01 00:00:00+00', '1970-01-01 01:30:00+00')`);
        const p = partial[0];
        if (Number(p?.hours_written ?? -1) === 0) {
            ok('a window ending mid-hour writes NO partial hour');
        } else {
            bad('a partial hour was written - a later narrower run would replace it', JSON.stringify(p));
        }

        const full = await sql<{ hours_written: string }>(
            `SELECT * FROM roll_up_samples('1970-01-01 00:00:00+00', '1970-01-01 02:00:00+00')`);
        if (Number(full[0]?.hours_written ?? 0) === 1) {
            ok('a whole-hour window writes the hour once');
        } else {
            bad('expected exactly one hour written', JSON.stringify(full[0]));
        }

        const row = await sql<{ n: string; n0: string; a0: string }>(
            `SELECT n, n0, a0 FROM samples_hourly WHERE entity_id = $1`, [E1]);
        if (Number(row[0]?.n ?? 0) === 60) ok('n is the full 60 samples');
        else bad('n is wrong', JSON.stringify(row[0]));

        // Re-running any covering window must reproduce the hour exactly, which
        // is what "idempotent, and a missed run self-heals" actually requires.
        await sql(`SELECT * FROM roll_up_samples('1969-12-31 00:00:00+00', '1970-01-02 00:00:00+00')`);
        const again = await sql<{ n: string; a0: string }>(
            `SELECT n, a0 FROM samples_hourly WHERE entity_id = $1`, [E1]);
        if (again[0]?.n === row[0]?.n && again[0]?.a0 === row[0]?.a0) {
            ok('re-running a wider window reproduces the hour exactly');
        } else {
            bad('a wider re-run changed the hour', JSON.stringify({ before: row[0], after: again[0] }));
        }

        // --- claim 2: n must count what avg() averaged -----------------------
        //
        // Rates are NULL after a counter reset, an agent restart or a first
        // poll - during trouble. 100 samples, only 5 with a rate.
        await sql(`
            INSERT INTO samples (entity_id, ts, status, rtt_ms, v0)
            SELECT $1, timestamptz '1970-01-01 05:00:00+00' + (g || ' seconds')::interval,
                   1, 5.0, CASE WHEN g < 5 THEN 100.0 ELSE NULL END
              FROM generate_series(0, 99) g`, [E2]);
        await sql(`SELECT * FROM roll_up_samples('1970-01-01 05:00:00+00', '1970-01-01 06:00:00+00')`);

        const trouble = await sql<{ n: string; n0: string; a0: string }>(
            `SELECT n, n0, a0 FROM samples_hourly WHERE entity_id = $1`, [E2]);
        const t = trouble[0];
        if (Number(t?.n ?? 0) === 100 && Number(t?.n0 ?? 0) === 5) {
            ok(`n=100 samples but n0=5 rates - the weight for a0 is 5, not 100`);
        } else {
            bad('per-column count is wrong', JSON.stringify(t));
        }
        if (Math.abs(Number(t?.a0 ?? 0) - 100) < 0.001) {
            ok('a0 is the average of the 5 values that existed');
        } else {
            bad('a0 is wrong', JSON.stringify(t));
        }

        // --- claim 2b: the frontier stops short of rows still committing -----
        //
        // THE WATERMARK CLAIM, and it is asserted here because the failure it
        // guards is invisible everywhere else: a stranded hour just has a
        // smaller n and a slightly wrong average, and once raw expires nothing
        // in the system disagrees with it.
        //
        // A sample's ts is POLL time; its commit is one to ten seconds later.
        // If roll_up_chunk's ceiling were date_trunc('hour', now()), a tick
        // firing just after an hour boundary would roll that hour and advance
        // the frontier past rows that had not landed yet. The frontier only
        // moves forward, so those rows are never rolled - and guard 5 then
        // reads the partition as consumed and lets retention drop them.
        //
        // Checked by what roll_up_chunk REFUSES rather than by what it writes,
        // because the fault needs a race to reproduce and a boundary condition
        // does not. The hour that just ended must be outside the window.
        // THE FRONTIER IS PLACED DELIBERATELY, and the first version of this
        // test did not do that. With no frontier row, roll_up_chunk starts at
        // min(ts) - which in this fixture is 1970 - so `hi` is bounded by
        // max_hours rather than by the ceiling, `to_ts` comes back 56 years
        // behind now, and "the ceiling stops at least five minutes back" passes
        // without the ceiling having been involved at all. Vacuous in exactly
        // the way the chaos suite is being audited for.
        //
        // Ninety minutes back puts lo inside the previous hour, so hi is the
        // CEILING and the assertion is about the thing it names.
        {
            const setFrontier = async (): Promise<void> => {
                await sql(`INSERT INTO job_state (job, through_ts)
                           VALUES ('rollup', date_trunc('hour', now() - interval '90 minutes'))
                           ON CONFLICT (job) DO UPDATE SET through_ts = excluded.through_ts`);
            };

            await setFrontier();
            const r5 = await sql<{ to_ts: string | null }>('SELECT to_ts FROM roll_up_chunk(24, 5)');
            await setFrontier();
            const r90 = await sql<{ to_ts: string | null }>('SELECT to_ts FROM roll_up_chunk(24, 90)');

            const t5 = r5[0]?.to_ts ? new Date(r5[0].to_ts).getTime() : null;
            const t90 = r90[0]?.to_ts ? new Date(r90[0].to_ts).getTime() : null;

            const cutoff = await sql<{ ceiling: string }>(
                `SELECT date_trunc('hour', now() - interval '5 minutes') AS ceiling`);
            const limit = new Date(cutoff[0]?.ceiling ?? 0).getTime();

            if (t5 !== null && t5 <= limit) {
                ok(`the window ends at or before the settled ceiling, `
                    + `${((Date.now() - t5) / 60_000).toFixed(0)} minutes behind now`);
            } else {
                bad('THE CEILING REACHES INTO THE SETTLING WINDOW - rows committing late will be '
                    + 'rolled past, then dropped by retention', JSON.stringify(r5[0]));
            }

            // The control, and it is deterministic rather than dependent on
            // where in the hour the test happens to run. A 90-minute margin
            // must truncate to an EARLIER hour than a 5-minute one, always,
            // because 90 exceeds an hour. Comparing 5 against 0 would only
            // differ during the first five minutes of an hour, so it would
            // report a pass 92% of the time whether or not the parameter was
            // connected to anything.
            if (t5 !== null && t90 !== null && t90 < t5) {
                ok('a larger settle_minutes stops strictly earlier, so the parameter reaches the ceiling');
            } else {
                bad('settle_minutes did not move the ceiling - it is not wired to anything',
                    JSON.stringify({ settle5: r5[0]?.to_ts, settle90: r90[0]?.to_ts }));
            }

            await sql(`DELETE FROM job_state WHERE job = 'rollup'`);
        }

        // The bug this closes: weighting by n instead of n0 inflates a
        // struggling hour to 20x its evidence.
        const weights = await sql<{ by_n: string; by_n0: string }>(`
            SELECT sum(a0 * n) / nullif(sum(n), 0)   AS by_n,
                   sum(a0 * n0) / nullif(sum(n0), 0) AS by_n0
              FROM samples_hourly WHERE entity_id IN ($1, $2)`, [E1, E2]);
        const w = weights[0];
        if (w && Math.abs(Number(w.by_n) - Number(w.by_n0)) > 0.01) {
            ok(`weighting by n gives ${Number(w.by_n).toFixed(2)}, by n0 gives ${Number(w.by_n0).toFixed(2)} - they differ, so the choice matters`);
        } else {
            bad('n and n0 weighting agree - this fixture does not exercise the bug', JSON.stringify(w));
        }

        // --- claim 3: the weighted mean is identical across a partition edge --
        //
        // The SQL is partition-agnostic so this should hold for free. "Should
        // hold for free" is what the last several instrument failures had in
        // common, so it is asserted once and kept.
        await sql(`
            INSERT INTO samples_hourly (entity_id, hour_ts, n, a0, n0)
            VALUES ($1, '1970-01-31 23:00:00+00', 10, 100.0, 10),
                   ($1, '1970-02-01 00:00:00+00', 30, 200.0, 30)`, [E1 + 10]);

        const spanning = await sql<{ w: string }>(`
            SELECT sum(a0 * n0) / nullif(sum(n0), 0) AS w
              FROM samples_hourly
             WHERE entity_id = $1
               AND hour_ts >= '1970-01-31 00:00:00+00' AND hour_ts < '1970-02-02 00:00:00+00'`,
            [E1 + 10]);
        // (100*10 + 200*30) / 40 = 175
        const expected = 175;
        if (Math.abs(Number(spanning[0]?.w ?? 0) - expected) < 0.001) {
            ok(`a window spanning two monthly partitions gives ${expected}, the same as one`);
        } else {
            bad(`cross-partition weighted mean is wrong`, JSON.stringify(spanning[0]));
        }

        // And the control: the naive average must give a DIFFERENT, WRONG
        // answer. If it agreed, this assertion would prove nothing.
        const naive = await sql<{ w: string }>(`
            SELECT avg(a0) AS w FROM samples_hourly
             WHERE entity_id = $1
               AND hour_ts >= '1970-01-31 00:00:00+00' AND hour_ts < '1970-02-02 00:00:00+00'`,
            [E1 + 10]);
        if (Math.abs(Number(naive[0]?.w ?? 0) - expected) > 1) {
            ok(`averaging the averages gives ${Number(naive[0]?.w).toFixed(1)}, which is WRONG - the weighting is load bearing`);
        } else {
            bad('the naive mean agreed, so this test proves nothing', JSON.stringify(naive[0]));
        }
    } finally {
        // Scoped to the 1970 window as well as the id range. `entity_id >=
        // 900000` alone is a bet that the live entities sequence - which starts
        // at 100000 and has no ceiling - never reaches 900000, and every id
        // range this project has treated as reserved has eventually been
        // reached by something. The ts predicate cannot expire.
        await sql(`DELETE FROM samples
                    WHERE entity_id >= 900000
                      AND ts >= '1970-01-01' AND ts < '1971-01-01'`);
        await teardown();
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('rollup test failed:', err);
    void closeAll();
    process.exit(1);
});
