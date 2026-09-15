// Trigram index maintenance: does it actually maintain BOTH indexes?
//
// sync_recent_trgm_indexes used to manage one index per partition. On
// 2026-07-27 free text was widened from `msg` to `msg OR host`, which is only
// worth having if the host index exists on every recent partition - otherwise
// the OR degrades into a sequential scan on half of every query and the
// symptom is a search that is merely slow, which nobody reports as a bug.
//
// THE SCANNER RULE APPLIES HERE, and it is the whole reason this file exists.
// The function's output is "here is what needed doing", and a function that
// never looks at `host` produces exactly the same clean output as one that
// looked and found nothing wrong. So the test PLANTS A KNOWN POSITIVE - it
// drops a host index that should be there - and requires the function to name
// it. Without that step this file would pass against the pre-change function.
//
// Also checks the caller's half. The function now reports "<partition>:<column>"
// rather than a bare partition name, and OPS.createTrgmIndexConcurrently parses
// it back apart to build the DDL. That parse is a whitelist on both halves, and
// the negative cases below are what say so.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

/** Calls that must be REFUSED before any SQL is built. */
const REJECT: Array<[string, string]> = [
    ['messages_20260726; DROP TABLE devices:msg', 'a partition name carrying SQL'],
    ['messages_20260726:raw', 'a column outside the two that are indexed'],
    ['messages_20260726:msg; DROP TABLE devices', 'a column name carrying SQL'],
    ['devices:msg', 'a table that is not a messages partition'],
    ['messages_20260726', 'no column at all, the pre-change shape'],
];

async function main(): Promise<void> {
    // It drops an index to plant the positive, so it belongs on a disposable
    // database like every other destructive tool here.
    assertDestructiveTarget('test-trgm-sync', CONFIG.databaseUrl);
    console.log('trgm sync: two indexes per partition, and a planted positive\n');

    // --- the caller's parse, before anything touches the database ------------
    for (const [target, why] of REJECT) {
        try {
            await OPS.createTrgmIndexConcurrently(target);
            bad(`REFUSAL MISSING: ${why} was accepted (${JSON.stringify(target)})`);
        } catch {
            ok(`refused: ${why}`);
        }
    }

    try {
        // --- what the window holds right now ---------------------------------
        const partitions = await onLane<{ relname: string }>('jobs', async (c) => {
            const q = await c.query<{ relname: string }>(
                `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                  WHERE i.inhparent = 'messages'::regclass
                    AND c.relname ~ '^messages_[0-9]{8}$'
                    AND to_date(right(c.relname, 8), 'YYYYMMDD') >= current_date - $1::int
                  ORDER BY c.relname`, [CONFIG.trgmRecentDays]);
            return { rows: q.rows, rowCount: q.rows.length };
        });
        if (!partitions.ok) throw new Error(`lane refused (${partitions.reason})`);

        if (partitions.rows.length === 0) {
            // Not a pass. An empty window means every assertion below would be
            // vacuously true, which is the failure mode this project keeps
            // finding in its own tools.
            bad('NO PARTITION inside the trigram window - this run proves nothing. '
                + 'Ingest something, or widen TRGM_RECENT_DAYS, then re-run.');
            await closeAll();
            console.log(`
FAIL - ${pass} passed, ${fail} failed`);
            process.exit(1);
        }
        ok(`${partitions.rows.length} partition(s) inside the ${CONFIG.trgmRecentDays}-day window`);

        // --- converge, so the planted positive starts from a clean state -----
        const converge = async (): Promise<string[]> => {
            const r = await OPS.syncTrgmIndexes(CONFIG.trgmRecentDays);
            if (!r.ok) throw new Error(`lane refused (${r.reason})`);
            for (const row of r.rows) {
                if (row.action !== 'needs-index') continue;
                const b = await OPS.createTrgmIndexConcurrently(row.partition_name);
                if (!b.ok) throw new Error(`build refused for ${row.partition_name}`);
            }
            return r.rows.map((row) => `${row.action} ${row.partition_name}`);
        };

        await converge();
        const second = await converge();
        if (second.length === 0) {
            ok('a second run reports no work - the function converges rather than churning');
        } else {
            bad('the function still reports work after converging', JSON.stringify(second));
        }

        // Both indexes, on every partition in the window. This is the property
        // the widened free text depends on.
        const missing: string[] = [];
        for (const p of partitions.rows) {
            for (const col of ['msg', 'host']) {
                const r = await onLane<{ n: string | null }>('jobs', async (c) => {
                    const q = await c.query<{ n: string | null }>(
                        'SELECT to_regclass($1)::text AS n', [`${p.relname}_${col}_trgm`]);
                    return { rows: q.rows, rowCount: q.rows.length };
                });
                if (!r.ok) throw new Error(`lane refused (${r.reason})`);
                if (r.rows[0]?.n === null) missing.push(`${p.relname}:${col}`);
            }
        }
        if (missing.length === 0) {
            ok(`both msg AND host trigram indexes exist on all ${partitions.rows.length} `
                + 'partition(s) in the window');
        } else {
            bad('trigram indexes missing after convergence', JSON.stringify(missing));
        }

        // --- THE PLANTED POSITIVE --------------------------------------------
        //
        // host specifically, not msg: a function that still only knows about
        // msg would repair a dropped msg index perfectly and report clean here
        // while the search it exists to serve stays unindexed.
        // A POPULATED partition by preference. Since slice 19 the function
        // reports needs-index for empty and populated partitions alike - it
        // never builds in-function - but a populated one is still the case
        // that matters, because it is the one where building in-function
        // would have blocked ingest.
        const withRows = await onLane<{ relname: string }>('jobs', async (c) => {
            const q = await c.query<{ relname: string }>(
                `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                  WHERE i.inhparent = 'messages'::regclass
                    AND c.relname ~ '^messages_[0-9]{8}$'
                    AND to_date(right(c.relname, 8), 'YYYYMMDD') >= current_date - $1::int
                    AND c.reltuples > 0
                  ORDER BY c.relname DESC LIMIT 1`, [CONFIG.trgmRecentDays]);
            return { rows: q.rows, rowCount: q.rows.length };
        });
        if (!withRows.ok) throw new Error(`lane refused (${withRows.reason})`);
        const victim = withRows.rows[0]?.relname
            ?? partitions.rows[partitions.rows.length - 1]!.relname;
        const idx = `${victim}_host_trgm`;
        // The maintenance lane: on a hardened database the app role cannot
        // drop an index it does not own, and that refusal is the finding
        // slice 19 exists for, not a test fixture problem.
        const dropped = await onLane('maintenance', async (c) => {
            await c.query(`DROP INDEX ${idx}`);
            return { rows: [] as never[], rowCount: 0 };
        });
        if (!dropped.ok) throw new Error(`could not plant the positive (${dropped.reason})`);
        ok(`planted: dropped ${idx}`);

        const r = await OPS.syncTrgmIndexes(CONFIG.trgmRecentDays);
        if (!r.ok) throw new Error(`lane refused (${r.reason})`);
        const found = r.rows.find((row) => row.partition_name === `${victim}:host`);
        if (found !== undefined) {
            ok(`the function FOUND the planted positive and reported it as `
                + `"${found.action} ${found.partition_name}" - it really does look at host`);
        } else {
            bad('THE FUNCTION DID NOT SEE A MISSING HOST INDEX. Every clean result it has '
                + 'ever reported about host means nothing.', JSON.stringify(r.rows));
        }

        // Reported, never built in-function: building there would take SHARE
        // on a partition the ingest writer may be using, and would leave the
        // index owned by the function's owner rather than the role that has
        // to drop it (slice 19). Populated or empty, the answer is the same.
        if (found?.action === 'needs-index') {
            ok('it reports needs-index rather than building in-function, so the writer is '
                + 'never blocked and the index will belong to the role that drops it');
        } else {
            bad('the function did something other than report needs-index', found?.action);
        }

        // Leave it as it was found.
        await converge();
        const after = await onLane<{ n: string | null }>('jobs', async (c) => {
            const q = await c.query<{ n: string | null }>(
                'SELECT to_regclass($1)::text AS n', [idx]);
            return { rows: q.rows, rowCount: q.rows.length };
        });
        if (!after.ok) throw new Error(`lane refused (${after.reason})`);
        if (after.rows[0]?.n !== null) {
            ok('and the caller rebuilt it, so the run leaves the database as it found it');
        } else {
            bad(`${idx} is still missing - this run has left the database worse than it found it`);
        }
    } finally {
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('trgm sync test failed:', err);
    void closeAll();
    process.exit(1);
});
