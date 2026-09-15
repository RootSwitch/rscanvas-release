// Convert samples_hourly to a monthly-partitioned table, without moving data
// and without queueing readers behind an exclusive lock.
//
//   node tools/partition-rollup.ts --dry-run
//   node tools/partition-rollup.ts
//
// WHY THIS IS NOT ONE TRANSACTION THAT DOES EVERYTHING.
//
// ATTACH PARTITION skips its validation scan only if the table already carries
// a VALID CHECK constraint implying the partition bounds. Adding a valid CHECK
// is itself a full scan of 10GB - and `ALTER TABLE ... ADD CONSTRAINT ... CHECK`
// takes ACCESS EXCLUSIVE for the duration of that scan. Doing the whole
// migration in one transaction would therefore hold an exclusive lock on the
// table that serves every 90-day chart, for as long as the scan takes.
//
// That is the shape rule 7 exists for. A waiting ACCESS EXCLUSIVE request sits
// at the HEAD of the lock queue, so every reader arriving afterwards queues
// behind it even though it would never have conflicted with the reader already
// running. The spike measured a 3.7s reader making a drop wait 1.3s while
// blocking an unrelated dashboard query for 609ms against a 1.7ms norm, and the
// wait scales with whatever long reader happens to be in flight.
//
// So it is split by LOCK STRENGTH rather than by convenience:
//
//   phase 1  ADD CONSTRAINT ... NOT VALID    ACCESS EXCLUSIVE, but instant -
//                                            no scan, catalogue only
//   phase 2  VALIDATE CONSTRAINT             SHARE UPDATE EXCLUSIVE - scans
//                                            10GB but readers are unaffected
//   phase 3  RENAME + CREATE + ATTACH        ACCESS EXCLUSIVE, but every step
//                                            is catalogue-only because the
//                                            constraint is already valid
//
// Only phases 1 and 3 exclude readers, and both are catalogue operations
// measured in milliseconds. Each runs in its own transaction with a
// lock_timeout, so it either acquires promptly and completes or backs off
// having changed nothing. It never queues.
//
// A one-time operation is precisely the one nobody has a retry story for, so
// this one is idempotent: it inspects the current state and resumes from
// wherever it stopped.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const LOCK_TIMEOUT = process.env.MIGRATION_LOCK_TIMEOUT ?? '2s';
const LEGACY_SUFFIX = process.env.LEGACY_SUFFIX ?? 'pre_cutover';

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[partition-rollup]', ...args);
}

interface State {
    exists: boolean;
    partitioned: boolean;
    rows: number;
    minHour: Date | null;
    maxHour: Date | null;
    hasCheck: boolean;
    checkValid: boolean;
}

async function readState(): Promise<State> {
    const res = await onLane('jobs', async (client) => {
        const kind = await client.query(
            `SELECT relkind FROM pg_class WHERE relname = 'samples_hourly'`);
        if (kind.rows.length === 0) {
            return { rows: [{ exists: false }], rowCount: 1 };
        }
        const partitioned = (kind.rows[0] as { relkind: string }).relkind === 'p';

        const chk = await client.query(
            `SELECT conname, convalidated FROM pg_constraint
              WHERE conrelid = 'samples_hourly'::regclass AND contype = 'c'
                AND conname = 'samples_hourly_cutover_ck'`);

        // reltuples, not count(*): an exact count of 64.8M rows costs a scan
        // and this is a precondition check, not a measurement.
        const est = await client.query(
            `SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'samples_hourly'`);

        const span = partitioned
            ? { rows: [{ lo: null, hi: null }] }
            : await client.query(`SELECT min(hour_ts) AS lo, max(hour_ts) AS hi FROM samples_hourly`);

        return {
            rows: [{
                exists: true,
                partitioned,
                rows: Number((est.rows[0] as { n: string })?.n ?? 0),
                minHour: (span.rows[0] as { lo: Date | null })?.lo ?? null,
                maxHour: (span.rows[0] as { hi: Date | null })?.hi ?? null,
                hasCheck: chk.rows.length > 0,
                checkValid: chk.rows.length > 0 && (chk.rows[0] as { convalidated: boolean }).convalidated,
            }],
            rowCount: 1,
        };
    });
    if (!res.ok) throw new Error(`could not read state: ${res.reason}`);
    return res.rows[0] as unknown as State;
}

/** One short transaction, bounded by lock_timeout. Backs off rather than queueing. */
async function lockedStep(label: string, sql: string[]): Promise<boolean> {
    const res = await onLane('jobs', async (client) => {
        await client.query('BEGIN');
        try {
            await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
            for (const s of sql) await client.query(s);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        return { rows: [], rowCount: 0 };
    });
    if (res.ok) { log(`  ${label}: done`); return true; }
    log(`  ${label}: lane refused (${res.reason})`);
    return false;
}

async function main(): Promise<void> {
    const before = await readState();
    log(`database ${CONFIG.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);

    if (!before.exists) {
        log('samples_hourly does not exist - nothing to migrate; sql/slice5.sql creates it partitioned');
        return;
    }
    if (before.partitioned) {
        log('samples_hourly is already partitioned - nothing to do');
        return;
    }
    if (before.minHour === null || before.maxHour === null) {
        log('samples_hourly is empty - drop and recreate it from sql/slice5.sql instead');
        return;
    }

    // The legacy partition covers everything already present. Its upper bound is
    // the start of the month AFTER the newest row, so the first real monthly
    // partition begins on a month boundary rather than mid-month.
    const lo = new Date(Date.UTC(before.minHour.getUTCFullYear(), before.minHour.getUTCMonth(), 1));
    const hi = new Date(Date.UTC(before.maxHour.getUTCFullYear(), before.maxHour.getUTCMonth() + 1, 1));
    const loIso = lo.toISOString();
    const hiIso = hi.toISOString();
    const legacyName = `samples_hourly_${LEGACY_SUFFIX}`;

    log(`rows ${before.rows.toLocaleString()} (estimate), span ${before.minHour.toISOString()} .. ${before.maxHour.toISOString()}`);
    log(`legacy partition ${legacyName} will cover [${loIso}, ${hiIso})`);
    log(`lock_timeout ${LOCK_TIMEOUT} on every exclusive step`);

    if (DRY_RUN) { log('dry run, nothing applied'); return; }

    // --- phase 1: NOT VALID check. Exclusive but catalogue-only. -------------
    if (!before.hasCheck) {
        const ok = await lockedStep('phase 1, add NOT VALID check', [
            `ALTER TABLE samples_hourly ADD CONSTRAINT samples_hourly_cutover_ck
             CHECK (hour_ts >= '${loIso}'::timestamptz AND hour_ts < '${hiIso}'::timestamptz) NOT VALID`,
        ]);
        if (!ok) { log('backed off having changed nothing - retry when the table is quieter'); process.exit(1); }
    } else {
        log('  phase 1: constraint already present');
    }

    // --- phase 2: validate. Long, but SHARE UPDATE EXCLUSIVE. ----------------
    //
    // No lock_timeout here on purpose: this scans 10GB and takes as long as it
    // takes, and it does NOT exclude readers. Bounding it would abort useful
    // work for no availability benefit.
    const state1 = await readState();
    if (!state1.checkValid) {
        log('  phase 2: validating (scans the table, readers unaffected)');
        const t0 = performance.now();
        const res = await onLane('jobs', async (client) => {
            await client.query('ALTER TABLE samples_hourly VALIDATE CONSTRAINT samples_hourly_cutover_ck');
            return { rows: [], rowCount: 0 };
        });
        if (!res.ok) { log(`  phase 2 failed: ${res.reason}`); process.exit(1); }
        log(`  phase 2: validated in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } else {
        log('  phase 2: constraint already valid');
    }

    // --- phase 3: rename, create parent, attach. All catalogue-only. ---------
    //
    // One transaction so there is no window in which samples_hourly does not
    // exist. With the constraint valid, ATTACH proves the bounds from the
    // catalogue and skips the scan, so the exclusive lock is held for
    // milliseconds.
    const ok3 = await lockedStep('phase 3, rename + create + attach', [
        `ALTER TABLE samples_hourly RENAME TO ${legacyName}`,
        `CREATE TABLE samples_hourly (
            entity_id int NOT NULL,
            hour_ts   timestamptz NOT NULL,
            n         int NOT NULL,
            a0 double precision, a1 double precision, a2 double precision,
            a3 double precision, a4 double precision, a5 double precision,
            m0 double precision, m1 double precision,
            st smallint,
            PRIMARY KEY (entity_id, hour_ts)
         ) PARTITION BY RANGE (hour_ts)`,
        `ALTER TABLE samples_hourly ATTACH PARTITION ${legacyName}
         FOR VALUES FROM ('${loIso}') TO ('${hiIso}')`,
    ]);
    if (!ok3) {
        log('backed off - samples_hourly is unchanged and still serves reads');
        process.exit(1);
    }

    // --- verify ---------------------------------------------------------------
    const after = await readState();
    log(`after: partitioned=${after.partitioned}`);

    // Verify by SUMMING THE PARTITIONS, not by reading the parent.
    //
    // The first version compared the parent's reltuples before and after and
    // reported "row estimate moved 100.0% (64,800,060 -> -1)". A partitioned
    // parent holds no rows of its own and Postgres reports reltuples = -1 for
    // "not yet analysed", so the check was comparing a real count against a
    // sentinel and firing every time. A warning that always fires is a warning
    // nobody reads.
    const counts = await OPS.partitionStats();
    let summed = 0;
    if (counts.ok) {
        for (const r of counts.rows.filter((x) => x.parent === 'samples_hourly')) {
            summed += Number(r.est_rows);
            log(`  ${r.partition_name}: ${Number(r.est_rows).toLocaleString()} rows, ${r.pretty}`);
        }
    }

    const drift = Math.abs(summed - before.rows) / Math.max(1, before.rows);
    if (drift > 0.01) {
        log(`WARNING rows across partitions (${summed.toLocaleString()}) differ from before `
            + `(${before.rows.toLocaleString()}) by ${(drift * 100).toFixed(1)}%`);
        log('  ATTACH moves no data, so this should be zero. Investigate before proceeding.');
    } else {
        log(`verified: ${summed.toLocaleString()} rows across partitions, unchanged from before`);
    }

    log('done - no data was moved and nothing was dropped; DETACH PARTITION reverses this');
}

main()
    .catch((err) => {
        console.error('partition-rollup failed:', err);
        process.exitCode = 1;
    })
    .finally(() => closeAll());
