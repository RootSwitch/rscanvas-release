// Every predicate admission treats as indexed, EXPLAINed against a seeded
// fixture, with the plan required to show the index and the rows required to
// match what was planted.
//
// TWO ADMISSION RULES HAVE NOW SHIPPED ON A FALSE OR UNVERIFIED INDEXING
// PREMISE, which is why this is a standing check rather than a one-off:
//
//   1. ip: - the rule assumed a btree served `<<=`. It does, but only via a
//      planner support function nobody had checked (PG >= 14), and the first
//      proposed "fix" (>= network() AND <= broadcast()) would have silently
//      emptied ip: at every prefix below /32. Row agreement caught it, not
//      the plan shape - which is why this test checks BOTH.
//   2. free text - admission decided "the window is trigram-indexed" from a
//      DATE WINDOW while the actual index (the host half of the BitmapOr)
//      did not exist for six hours on a fresh deployment. The window said
//      indexed; pg_index said otherwise; the 3,355ms-scan shape the rule
//      exists to prevent ran for six hours as a CPU ramp.
//
// A predicate admission calls indexed and the planner cannot serve is exactly
// that shape, and this test is the ip: EXPLAIN work turned into a regression.
//
// METHOD. enable_seqscan=off, and the EXPLAIN half runs against THE
// PARTITION with ONLY the predicate under test - no time window. The first
// version kept the window, and the calibration negative caught it in one
// run: the window's own ts index turned every plan into a Bitmap scan with
// the unindexed predicate demoted to a Filter, so "no Seq Scan" was true of
// every claim including the false one. The question is "can an index serve
// THIS predicate on A partition", and stripping the window is what makes a
// predicate with no index plan as the partition Seq Scan that answers it.
// Row agreement then runs the REAL query - window, parent table, default
// settings - against planted rows whose matches are known. The fixture
// INCLUDES a row that matches only via the host branch of the free-text OR,
// because that branch's absence is precisely what the date window failed to
// see.
//
// THE INSTRUMENT IS CALIBRATED with a planted negative: `app ILIKE` has no
// index anywhere by decision (SLICE-6-PLAN), so the checker must REPORT a
// Seq Scan for it. If the negative ever shows an index, either someone built
// one (update the admission rules - the door-open note in SLICE-6-PLAN) or
// the checker stopped seeing, and both need a human.
//
// Destructive (writes messages, creates indexes on the fixture partition), so
// it refuses to run anywhere but a nominated disposable database.

import { internalUnsafeLane as onLane, closeAll } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const TAG = `idxclaim-${process.pid}`;

const sql = async (text: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    const r = await onLane<Record<string, unknown>>('jobs', async (c) => {
        const q = await c.query<Record<string, unknown>>(text, values);
        return { rows: q.rows, rowCount: q.rows.length };
    });
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    return r.rows;
};

/** EXPLAIN with seqscan discouraged; returns the flattened plan as text. */
const planFor = async (query: string, values: unknown[]): Promise<string> => {
    const r = await onLane<Record<string, unknown>>('jobs', async (c) => {
        await c.query('BEGIN');
        try {
            await c.query('SET LOCAL enable_seqscan = off');
            const q = await c.query(`EXPLAIN (FORMAT JSON) ${query}`, values);
            return { rows: q.rows as Array<Record<string, unknown>>, rowCount: q.rows.length };
        } finally {
            await c.query('ROLLBACK');
        }
    });
    if (!r.ok) throw new Error(`lane refused the EXPLAIN (${r.reason})`);
    return JSON.stringify(r.rows[0]);
};

interface Claim {
    label: string;
    /** The predicate ALONE, as buildWhere emits it - EXPLAINed per-partition. */
    predicate: string;
    values: unknown[];
    /** Substring(s) that must appear in the plan - index names or node types. */
    planMust: string[];
    /** Substring(s) that must NOT appear. */
    planMustNot: string[];
    /** msg values of the planted rows this predicate must return. */
    expectRows: string[];
}

async function main(): Promise<void> {
    assertDestructiveTarget('test-index-claims', CONFIG.databaseUrl);
    console.log('index claims: every predicate admission calls indexed, against the planner\n');

    const ver = await sql('SELECT current_setting($1) AS v', ['server_version_num']);
    const vnum = Number(ver[0]?.v ?? 0);
    if (vnum >= 140000) {
        ok(`server ${vnum}: >= 14, so the <<= btree derivation the ip: rule rests on exists`);
    } else {
        bad(`server ${vnum} is below 14 - the ip: indexing premise is FALSE on this server`);
    }

    // --- fixture: one day's rows under this run's tag -----------------------
    // Fixed UTC "today" values; the rows land in today's partition. The
    // partition needs BOTH trigram indexes to model a covered production
    // partition - built here the way the sync builds them, names and all,
    // because this test asserts against a partition in the covered state.
    // The indexes are deliberately LEFT BEHIND: they are the covered state
    // the sync maintains in production, not fixture data - dropping them
    // would UNcover a partition other tests legitimately search. The rows
    // are the blast radius, and they are removed by tag.
    const part = (await sql(
        `SELECT 'messages_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD') AS p`))[0]?.p as string;
    await sql(`CREATE INDEX IF NOT EXISTS ${part}_msg_trgm ON ${part} USING gin (msg gin_trgm_ops)`);
    await sql(`CREATE INDEX IF NOT EXISTS ${part}_host_trgm ON ${part} USING gin (host gin_trgm_ops)`);

    await sql(`DELETE FROM messages WHERE host LIKE $1 OR msg LIKE $1`, [`${TAG}%`]);
    const rows: Array<[host: string, ip: string, app: string, msg: string]> = [
        [`${TAG}-sw1`, '10.44.1.10', 'sshd', `${TAG} m1 zzfragzz in the body`],
        [`${TAG}-sw1`, '10.44.1.11', 'sshd', `${TAG} m2 plain body`],
        [`${TAG}-sw2`, '10.44.2.10', 'bgpd', `${TAG} m3 plain body`],
        // Matches the free-text OR only via HOST - the branch whose missing
        // index caused the six-hour ramp. If the host gin is absent or the
        // OR stops using it, this row vanishes from the row agreement.
        [`${TAG}-zzfragzz-host`, '10.44.3.10', 'bgpd', `${TAG} m4 plain body`],
        [`${TAG}-sw3`, '10.44.1.12', 'appfragment-here', `${TAG} m5 plain body`],
    ];
    for (const [host, ip, app, msg] of rows) {
        await sql(`INSERT INTO messages (ts, source_ip, proto, facility, severity, host, app, msg, raw)
                   VALUES (now(), $1::inet, 'syslog', 1, 5, $2, $3, $4, $4)`, [ip, host, app, msg]);
    }
    await sql(`ANALYZE ${part}`);

    const W = `ts >= now() - interval '1 hour' AND ts < now() + interval '1 hour'`;

    const CLAIMS: Claim[] = [
        {
            label: 'host = x (the device filter admission leans on)',
            predicate: `host = $1`,
            values: [`${TAG}-sw1`],
            planMust: ['host_ts_idx'],
            planMustNot: ['"Node Type":"Seq Scan"'],
            expectRows: [`${TAG} m1 zzfragzz in the body`, `${TAG} m2 plain body`],
        },
        {
            label: 'source_ip <<= cidr at the /24 floor (the ip: device filter)',
            predicate: `source_ip <<= $1::inet`,
            values: ['10.44.1.0/24'],
            planMust: ['source_ip'],
            planMustNot: ['"Node Type":"Seq Scan"'],
            expectRows: [`${TAG} m1 zzfragzz in the body`, `${TAG} m2 plain body`, `${TAG} m5 plain body`],
        },
        {
            label: 'free text: msg ILIKE OR host ILIKE (BitmapOr, BOTH gin branches)',
            predicate: `(msg ILIKE '%' || $1 || '%' OR host ILIKE '%' || $1 || '%')`,
            values: ['zzfragzz'],
            planMust: ['BitmapOr', 'msg', 'host_trgm'],
            planMustNot: ['"Node Type":"Seq Scan"'],
            expectRows: [`${TAG} m1 zzfragzz in the body`, `${TAG} m4 plain body`],
        },
        {
            label: 'host~ alone (substring on the trigram-indexed column)',
            predicate: `host ILIKE '%' || $1 || '%'`,
            values: ['zzfragzz-host'],
            planMust: ['host_trgm'],
            planMustNot: ['"Node Type":"Seq Scan"'],
            expectRows: [`${TAG} m4 plain body`],
        },
    ];

    for (const c of CLAIMS) {
        const plan = await planFor(`SELECT msg FROM ${part} WHERE ${c.predicate}`, c.values);
        const missing = c.planMust.filter((s) => !plan.includes(s));
        const present = c.planMustNot.filter((s) => plan.includes(s));
        if (missing.length === 0 && present.length === 0) {
            ok(`${c.label}: the planner uses the index the rule assumes`);
        } else {
            bad(`${c.label}: PLAN DISAGREES with the admission rule`,
                `missing=${JSON.stringify(missing)} forbidden=${JSON.stringify(present)}`);
        }
        const got = (await sql(`SELECT msg FROM messages WHERE ${W} AND ${c.predicate}`, c.values))
            .map((r) => r.msg as string).filter((m) => m.startsWith(TAG)).sort();
        const want = [...c.expectRows].sort();
        if (JSON.stringify(got) === JSON.stringify(want)) {
            ok(`  ...and returns exactly the planted rows (${want.length})`);
        } else {
            bad(`  ...ROW DISAGREEMENT - the plan may be fine and the predicate still wrong`,
                `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`);
        }
    }

    // --- the planted negative: app~ has no index, and the checker must see it
    {
        const plan = await planFor(
            `SELECT msg FROM ${part} WHERE app ILIKE '%' || $1 || '%'`, ['appfragment']);
        if (plan.includes('"Node Type":"Seq Scan"')) {
            ok('calibration: app~ (unindexed by decision) plans as a Seq Scan even with '
                + 'seqscan discouraged - the checker can tell indexed from not');
        } else {
            bad('the planted negative did not show a Seq Scan - either an app index now exists '
                + '(revisit SLICE-6-PLAN\'s door-open note) or this checker cannot see', plan.slice(0, 300));
        }
    }

    await sql(`DELETE FROM messages WHERE host LIKE $1 OR msg LIKE $1`, [`${TAG}%`]);
    await closeAll();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('index-claims test failed:', err);
    void closeAll();
    process.exit(1);
});
