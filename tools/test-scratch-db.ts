// Three tests that need a real PostgreSQL, run against a SCRATCH database the
// caller has just built with the full schema (review 2026-09-01, section 5c
// items 5, 10 and 11, owed until 2026-10-01):
//
//   createdb rscanvas_test     (or tools/make-test-db.sh)
//   DATABASE_URL=...rscanvas_test node src/db/apply-schema.ts --with-retention
//   DATABASE_URL=...rscanvas_test node tools/test-scratch-db.ts
//
// It writes partitions, devices and alerts, so it runs only where
// assertDestructiveTarget (src/safety.ts) allows: the disposable database.
//
//   5. NON-UTC RETENTION. drop_partitions_guarded picks partitions by a cutoff
//      that must be UTC midnight whatever zone the caller's session is in -
//      the review found it computed a line before the function pinned UTC.
//      Run in UTC+14 and UTC-11: at every instant one of them is on a
//      different calendar day from UTC, so the old defect cannot hide.
//  10. EVENT-ALERT UPSERTS (OPS.upsertEventAlerts, the app's own statement):
//      a repeat folds into the open row and adds its count, severity stays
//      what the incident opened at, a key is born again after it cleared, a
//      batch must not carry one key twice, and what many claimed hosts cost.
//  11. ROLLUP WEIGHTING. roll_up_samples writes whole hours only (a window
//      that starts or ends mid-hour is clamped), each with its average AND
//      its count; the Dashboard's sensor query weights by that count - the
//      unweighted mean of hourly means is a different, wrong number - and
//      clamps an hour's coverage at one.

import pg from 'pg';
import { OPS, closeAll } from '../src/store/index.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const near = (a: number | null | undefined, b: number, eps = 1e-6): boolean => a !== null && a !== undefined && Math.abs(a - b) < eps;

const url = process.env.DATABASE_URL ?? '';
assertDestructiveTarget('test-scratch-db', url);

const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.query(sql, args)).rows as T[];

// --- 5. non-UTC retention ----------------------------------------------------
console.log('5. retention picks UTC days whatever the session zone:');
{
    await q(`SELECT ensure_daily_partitions('samples', (now() AT TIME ZONE 'UTC')::date - 20, (now() AT TIME ZONE 'UTC')::date + 1)`);
    // Guard 5: the rollup must have consumed what is dropped.
    await q(`INSERT INTO job_state (job, through_ts) VALUES ('rollup', now())
             ON CONFLICT (job) DO UPDATE SET through_ts = excluded.through_ts`);
    const expected = (await q<{ name: string }>(`
        SELECT format('samples_%s', to_char(d, 'YYYYMMDD')) AS name
          FROM generate_series((now() AT TIME ZONE 'UTC')::date - 20,
                               (now() AT TIME ZONE 'UTC')::date - 8, interval '1 day') AS g(d)
         ORDER BY 1`)).map((r) => r.name);
    const dryRun = async (zone: string): Promise<string[]> => {
        await q(`SET TIME ZONE '${zone}'`);
        const rows = await q<{ action: string; partition_name: string }>(
            `SELECT action, partition_name FROM drop_partitions_guarded('samples', 7, 7, 50, 2, 31, true)`);
        return rows.filter((r) => r.action === 'would-drop').map((r) => r.partition_name).sort();
    };
    const utc = await dryRun('UTC');
    const plus14 = await dryRun('Pacific/Kiritimati');
    const minus11 = await dryRun('Pacific/Pago_Pago');
    await q(`SET TIME ZONE 'UTC'`);
    eq('in UTC: every partition ending on or before UTC midnight 7 days ago, and no other', utc, expected);
    eq('in UTC+14 (Kiritimati): the same partitions', plus14, utc);
    eq('in UTC-11 (Pago Pago): the same partitions', minus11, utc);
    const zones = await q<{ d14: string; d11: string; du: string }>(`
        SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS d14,
               (now() AT TIME ZONE 'Pacific/Pago_Pago')::date::text AS d11,
               (now() AT TIME ZONE 'UTC')::date::text AS du`);
    const z = zones[0]!;
    eq('and one of those zones is on another day from UTC right now, so the test bites',
        z.d14 !== z.du || z.d11 !== z.du, true);

    // Review F13b: the floors are the function's own. A caller passing zeros
    // used to be obeyed - keep_days 0 with min_keep_days 0 dropped everything.
    const refused = async (sql: string): Promise<string> => {
        try { await q(sql); return 'ACCEPTED'; } catch (err) { return (err as Error).message.slice(0, 120); }
    };
    eq('keep_days 0 with a zeroed floor is still refused',
        (await refused(`SELECT * FROM drop_partitions_guarded('samples', 0, 0, 50, 0, 31, true)`)).startsWith('refusing: keep_days 0 is below the floor of 7'), true);
    eq('a NULL keep_days is refused, not read as "nothing is newer"',
        (await refused(`SELECT * FROM drop_partitions_guarded('samples', NULL, 7, 3, 2, 31, true)`)).startsWith('refusing: keep_days is NULL'), true);
    eq('a table other than samples and messages is refused',
        (await refused(`SELECT * FROM drop_partitions_guarded('users', 7, 7, 3, 2, 31, true)`)).startsWith('refusing: retention drops partitions'), true);
    const nullDry = await q<{ action: string }>(`SELECT action FROM drop_partitions_guarded('samples', 7, 7, 50, 2, 31, NULL)`);
    eq('a NULL dry_run is a dry run: it only says what it would drop',
        nullDry.length > 0 && nullDry.every((r) => r.action !== 'dropped'), true);
}

// --- 11. rollup weighting ----------------------------------------------------
console.log('\n11. the rollup writes whole hours, and averages over hours are weighted:');
{
    // samples_hourly is partitioned by month; a fresh schema has none yet.
    await q(`SELECT ensure_monthly_partitions('samples_hourly', (now() - interval '1 month')::date, (now() + interval '1 month')::date)`);
    await q(`INSERT INTO devices (id, name, host) VALUES (990001, 'scratch-dev', '192.0.2.1')`);
    await q(`INSERT INTO entities (id, device_id, kind, name, code, tracked) VALUES
             (990011, 990001, 'cpu', 'CPU A', 'SCRA', true),
             (990012, 990001, 'cpu', 'CPU B', 'SCRB', true)`);
    const H = (await q<{ h: Date }>(`SELECT date_trunc('hour', now()) - interval '6 hours' AS h`))[0]!.h;
    const at = (hours: number, sec = 0): string => new Date(H.getTime() + hours * 3600_000 + sec * 1000).toISOString();
    // A, hour 1: ten readings of 100 and two missing. Hour 2: two readings of 400.
    // A, the half hour BEFORE hour 1: readings a mid-hour window must not roll up.
    // B, hour 3: 130 readings of 50 - more than a 30 s poll fills an hour.
    await q(`INSERT INTO samples (entity_id, ts, v0)
             SELECT 990011, $1::timestamptz + make_interval(secs => g * 30), 100 FROM generate_series(0, 9) g
             UNION ALL SELECT 990011, $1::timestamptz + make_interval(secs => 600 + g * 30), NULL FROM generate_series(0, 1) g
             UNION ALL SELECT 990011, $2::timestamptz + make_interval(secs => g * 30), 400 FROM generate_series(0, 1) g
             UNION ALL SELECT 990011, $3::timestamptz + make_interval(secs => g * 30), 999 FROM generate_series(0, 9) g
             UNION ALL SELECT 990012, $4::timestamptz + make_interval(secs => g * 27), 50 FROM generate_series(0, 129) g`,
        [at(1), at(2), at(0, 1800), at(3)]);
    const r = (await q<{ hours_written: string; from_clamped: Date; to_clamped: Date }>(
        `SELECT * FROM roll_up_samples($1::timestamptz, $2::timestamptz)`, [at(0, 1800), at(4, 900)]))[0]!;
    eq('a window from half past to quarter past is clamped to whole hours',
        [r.from_clamped.toISOString(), r.to_clamped.toISOString()], [at(1), at(4)]);
    const rows = await q<{ entity_id: number; hour: string; n: number; n0: number; a0: number }>(`
        SELECT entity_id, to_char(hour_ts AT TIME ZONE 'UTC', 'HH24') AS hour, n, n0, a0
          FROM samples_hourly WHERE entity_id IN (990011, 990012) ORDER BY entity_id, hour_ts`);
    eq('the partial hour before it is not written; three whole hours are', rows.length, 3);
    const a1 = rows.find((x) => x.entity_id === 990011 && x.n === 12);
    eq('hour 1: 12 samples, 10 with a reading, averaging 100', a1 && [a1.n, a1.n0, Number(a1.a0)], [12, 10, 100]);
    const a2 = rows.find((x) => x.entity_id === 990011 && x.n === 2);
    eq('hour 2: 2 readings averaging 400', a2 && [a2.n0, Number(a2.a0)], [2, 400]);

    // The Dashboard's own query over the three hours.
    const dash = await OPS.dashboardSensors(new Date(at(-2)), new Date(at(1)), new Date(at(4)), 10);
    if (!dash.ok) throw new Error(`dashboardSensors refused: ${dash.reason}`);
    const A = dash.rows.find((x) => x.code === 'SCRA');
    const B = dash.rows.find((x) => x.code === 'SCRB');
    eq('A\'s mean is weighted by readings: (10 x 100 + 2 x 400) / 12 = 150, not (100 + 400) / 2 = 250',
        near(A?.mean_pct, 150), true);
    eq('A\'s peak is the highest reading', A?.peak_pct, 400);
    eq('B\'s hour, 130 readings at a 30 s interval (108%), counts as one covered hour, not more',
        near(B?.cov_h, 1), true);
    eq('A\'s two thin hours count as the fraction of each they covered', near(A?.cov_h, (10 + 2) * 30 / 3600), true);
}

// --- 10. event-alert upserts -------------------------------------------------
console.log('\n10. event alerts: one open row per key, folding, sticky severity, rebirth:');
{
    const K = 'event|42|scratch-host';
    const t = (s: number): Date => new Date(Date.UTC(2026, 8, 30, 12, 0, s));
    const open = (key: string) => q<{ state: string; severity: string; value: number; peak_value: number; last_seen_ts: Date; notified_raise: boolean }>(
        `SELECT state, severity, value, peak_value, last_seen_ts, notified_raise FROM alerts WHERE alert_key = $1 ORDER BY id`, [key]);
    const CAP = 20;   // EVENT_ALERT_HOSTS_MAX's default
    const up = (keys: string[], sev: string, count: number, ts: Date) => OPS.upsertEventAlerts(
        keys, keys.map(() => sev), keys.map((k) => k.split('|')[2] ?? ''), keys.map(() => 'scratch rule'),
        keys.map(() => count), keys.map(() => ts), CAP);

    await up([K], 'warn', 3, t(10));
    let rows = await open(K);
    eq('a new key is born active, owing its raise, counting its matches',
        rows.map((x) => [x.state, x.severity, Number(x.value), x.notified_raise]), [['active', 'warn', 3, false]]);
    await up([K], 'crit', 2, t(20));
    await up([K], 'crit', 1, t(5));
    rows = await open(K);
    eq('repeats fold into the one open row, adding their counts', rows.map((x) => [rows.length, Number(x.value), Number(x.peak_value)]), [[1, 6, 6]]);
    eq('the severity stays what the incident opened at, though the rule now says crit', rows[0]?.severity, 'warn');
    eq('last seen only moves forward (an older batch does not pull it back)', rows[0]?.last_seen_ts.toISOString(), t(20).toISOString());

    await q(`UPDATE alerts SET state = 'cleared', cleared_ts = now(), clear_reason = 'ttl' WHERE alert_key = $1`, [K]);
    await up([K], 'crit', 1, t(30));
    rows = await open(K);
    eq('after it cleared, the key is born again as a new incident at the rule\'s current severity',
        rows.map((x) => [x.state, x.severity, Number(x.value)]), [['cleared', 'warn', 6], ['active', 'crit', 1]]);

    await up([K + 'x', K + 'x'], 'warn', 1, t(40));
    rows = await open(K + 'x');
    eq('one batch carrying a key twice folds into one row (it used to be refused)',
        rows.map((x) => [x.state, Number(x.value)]), [['active', 2]]);

    // A flood of claimed hosts - they come from unauthenticated UDP - against
    // the cap, on a rule of its own (43) so the counts are its alone.
    const spoofed = Array.from({ length: 500 }, (_, i) => `event|43|spoofed-${i}`);
    const perHost = async (): Promise<number> => Number((await q<{ n: string }>(
        `SELECT count(*) AS n FROM alerts WHERE alert_key LIKE 'event|43|spoofed-%' AND state = 'active'`))[0]!.n);
    await up(spoofed, 'warn', 1, t(50));
    let over = await open('event|43|*');
    eq(`500 claimed hosts: the first ${CAP} get an alert each`, await perHost(), CAP);
    eq('and the rest are ONE overflow alert, counting their matches',
        over.map((x) => [x.state, Number(x.value)]), [['active', 500 - CAP]]);
    const label = (await q<{ host: string; label: string }>(`SELECT host, label FROM alerts WHERE alert_key = 'event|43|*' AND state = 'active'`))[0];
    eq('which says what it is', label && [label.host, label.label], ['*', `event rule 43: more than ${CAP} hosts`]);
    await up(spoofed, 'warn', 1, t(60));
    over = await open('event|43|*');
    eq('the same flood again opens nothing: the 20 fold into their own rows, the rest into the overflow',
        [await perHost(), over.length, Number(over[0]?.value)], [CAP, 1, 2 * (500 - CAP)]);
    await q(`UPDATE alerts SET state = 'cleared', cleared_ts = now(), clear_reason = 'ttl'
              WHERE alert_key IN ('event|43|spoofed-0', 'event|43|spoofed-1', 'event|43|spoofed-2')`);
    await up(['event|43|late-0', 'event|43|late-1', 'event|43|late-2', 'event|43|late-3'], 'warn', 1, t(70));
    const late = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM alerts WHERE alert_key LIKE 'event|43|late-%' AND state = 'active'`))[0]!.n);
    eq('three per-host alerts clear: three new hosts get their own again, the fourth folds into the overflow',
        [late, Number((await open('event|43|*'))[0]?.value)], [3, 2 * (500 - CAP) + 1]);
    // At the edge of the cap, a key repeated in one batch is still one key.
    await up(Array.from({ length: CAP - 1 }, (_, i) => `event|44|h-${i}`), 'warn', 1, t(80));
    await up(['event|44|edge', 'event|44|edge'], 'warn', 1, t(81));
    eq('19 of 20 held, one new key sent twice: it gets its own alert, whole, and no overflow opens',
        [(await open('event|44|edge')).map((x) => Number(x.value))[0], (await open('event|44|*')).length], [2, 0]);
    // Review F11: keys whose third field is '*' but which are not exactly the
    // overflow key - what a host named `*|1` made before the worker escaped
    // it - are ordinary per-host keys to the statement, held by the cap.
    const sideDoor = Array.from({ length: 30 }, (_, i) => `event|46|*|${i}`);
    await up(sideDoor, 'warn', 1, t(90));
    const sideOpen = Number((await q<{ n: string }>(
        `SELECT count(*) AS n FROM alerts WHERE alert_key LIKE 'event|46|*|%' AND state = 'active'`))[0]!.n);
    eq(`30 keys of the form event|46|*|n: ${CAP} per-host alerts and one overflow carrying the other 10, not 30 alerts`,
        [sideOpen, (await open('event|46|*')).map((x) => Number(x.value))], [CAP, [30 - CAP]]);

    // Review F19: a digest's delivery is logged for every alert it listed, in
    // one statement - and an alert pruned while it was held is skipped, not a
    // failure of the rest.
    const ids = (await q<{ id: string }>(`SELECT id::text AS id FROM alerts WHERE alert_key LIKE 'event|46|*|%' ORDER BY id LIMIT 3`)).map((r) => r.id);
    const logged = await OPS.logNotifications([...ids, '999999999'], ['raise', 'raise', 'raise', 'raise'], 'email', true, 'in a digest of 4');
    const digestRows = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM notifications WHERE detail = 'in a digest of 4' AND channel = 'email'`))[0]!.n);
    eq('a digest logs one row per listed alert, skipping one that no longer exists', [logged.ok, digestRows], [true, 3]);
}

await db.end();
await closeAll();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
