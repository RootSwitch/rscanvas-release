// Tests that need a real PostgreSQL, run against a SCRATCH database the
// caller has just built with the full schema (review 2026-09-01, section 5c
// items 5, 10 and 11, owed until 2026-10-01; 12 to 19 added since):
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
//  13. THE ROLLUP PURGE (sql/slice60.sql). A device delete and a check's
//      removal queue their entities in the same statement; the census finds
//      what was deleted before the queue existed; the drain purges only what
//      the rollup is an hour past, in batches, and never a living entity's.
//  14. REPEATING MAINTENANCE WINDOWS (sql/slice61.sql). maintenance_active()
//      opens an occurrence on its days at its local time for its minutes -
//      past midnight, across daylight saving, in its own zone - and the
//      owed query, the alert read and the clear settlement honour it.
//  15. RESTARTS (sql/slice62.sql). The poll write that stores the uptime
//      records a judged restart - the event, the device row, planned when a
//      window is open - and nothing on a failed poll; the collector and the
//      scan read back what they need; deleting the device takes them.
//  16. ACKNOWLEDGEMENT (sql/slice62.sql). Who and the note, renotify skips
//      it, again replaces, taken back restores, a cleared alert refuses it;
//      and a restart alert's clear is settled without an email, alone.
//  17. THE DEVICE TIMELINE (OPS.deviceTimeline). Every kind of row, the
//      device's own only - not another device's, not a pending alert, not
//      an acknowledgement's audit line - newest first; windows on its
//      location and one occurrence of its application's schedule; audit
//      only with the permission; the window and the limit respected.
//  18. THE AVAILABILITY REPORT (sql/slice63.sql). The ping roll-up from the
//      oldest probe, maintenance probes counted apart, idempotent over an
//      hour; the report's probes, hours measured, outages carried in from
//      before the period, blips, planned downtime; ping retention never
//      ahead of the roll-up; the cascade on delete.
//  19. NOTES (sql/slice64.sql). Stored as written, blank is none, on the roster.
//  20. CHANGE FROM NORMAL (sql/slice65.sql). The week from the hourly rollup
//      (the current hour and day eight left out, a stale row dropped), the
//      last minutes from raw, the scan's judgement - one sensor, a room of
//      four on three, a down witness, a mute, an include - the device page's
//      read, the room's holds (a member, for a sensor window after the room
//      clears, a window, a policy, an overlap), and the cascade on delete.

import pg from 'pg';
import { OPS, closeAll } from '../src/store/index.ts';
import { changeScan, DEFAULT_RULES } from '../src/alerts/scan.ts';
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

console.log('\n12. the checks\' extremes and spread, for checks only (2026-10-07):');
{
    // Device 990001 is 11's. A voice test and a web check beside 11's CPU,
    // all in one hour ten hours back.
    await q(`INSERT INTO entities (id, device_id, kind, name, code, tracked, source) VALUES
             (990021, 990001, 'path-voice', 'Voice X', 'SCRV', true, 'probe'),
             (990022, 990001, 'svc-http', 'Web X', 'SCRW', true, 'probe')`);
    const H2 = (await q<{ h: Date }>(`SELECT date_trunc('hour', now()) - interval '10 hours' AS h`))[0]!.h;
    const t = (min: number): string => new Date(H2.getTime() + min * 60_000).toISOString();
    // Voice: four ok runs (MOS 4.4, 3.5, 3.0, 4.2; loss 0, 1, 2, 0) and one
    // that failed (outcome 2, no readings). Web: two ok (100, 300 ms; DNS 2
    // and 4 ms in v4 - under 3.6, which must not count as a MOS) and one
    // failed. CPU: two readings.
    await q(`INSERT INTO samples (entity_id, ts, v0, v4, v5) VALUES
             (990021, $1, 0, 4.4, 0), (990021, $2, 1, 3.5, 0), (990021, $3, 2, 3.0, 0), (990021, $4, 0, 4.2, 0),
             (990021, $5, NULL, NULL, 2),
             (990022, $1, 100, 2, 0), (990022, $2, 300, 4, 0), (990022, $3, NULL, NULL, 1),
             (990011, $1, 50, NULL, NULL), (990011, $2, 70, NULL, NULL)`,
        [t(1), t(11), t(21), t(31), t(41)]);
    await q(`SELECT * FROM roll_up_samples($1::timestamptz, $2::timestamptz)`, [t(0), t(60)]);
    type HRow = { entity_id: number; a4: number | null; n4: number | null; lo0: number | null; lo4: number | null;
        m4: number | null; q0: number | null; q4: number | null; nok: number | null; mos36: number | null; mos31: number | null };
    const hour = async (): Promise<Map<number, HRow>> => new Map((await q<HRow>(`
        SELECT entity_id, a4, n4, lo0, lo4, m4, q0, q4, nok, mos36, mos31 FROM samples_hourly
         WHERE entity_id IN (990011, 990021, 990022) AND hour_ts = $1`, [t(0)])).map((r) => [r.entity_id, r]));
    let h = await hour();
    const v = h.get(990021), w = h.get(990022), c = h.get(990011);
    eq('voice: the lowest and highest MOS, the lowest loss', v && [v.lo4, v.m4, v.lo0], [3.0, 4.4, 0]);
    eq('voice: four of five runs ok, two under 3.6, one under 3.1', v && [v.nok, v.mos36, v.mos31], [4, 2, 1]);
    const sd = (await q<{ sd: number }>(`SELECT stddev_samp(v4) AS sd FROM samples WHERE entity_id = 990021`))[0]!.sd;
    const fromCols = v && v.q4 !== null && v.a4 !== null && v.n4 !== null
        ? Math.sqrt((v.q4 - v.n4 * v.a4 * v.a4) / (v.n4 - 1)) : null;
    eq(`the standard deviation from the sum of squares is PostgreSQL's own (${sd.toFixed(4)})`, near(fromCols ?? NaN, sd), true);
    eq('web: two of three ok, its fastest and the sum of squares', w && [w.nok, w.lo0, w.q0], [2, 100, 100 * 100 + 300 * 300]);
    eq('web: a v4 under 3.6 is not a MOS - no band counts for anything but voice', w && [w.mos36, w.mos31], [null, null]);
    eq('the CPU beside them: none of the new columns, for anything that is not a check',
        c && [c.lo0, c.q0, c.m4, c.nok, c.mos36], [null, null, null, null, null]);

    // probes_only: the checks' new columns, and nothing else.
    await q(`UPDATE samples_hourly SET a4 = -1, lo4 = NULL, mos36 = NULL WHERE entity_id = 990021 AND hour_ts = $1`, [t(0)]);
    await q(`SELECT * FROM roll_up_samples($1::timestamptz, $2::timestamptz, true)`, [t(0), t(60)]);
    h = await hour();
    eq('probes_only refills a check\'s extremes and leaves its averages alone',
        [h.get(990021)?.lo4, h.get(990021)?.mos36, h.get(990021)?.a4], [3.0, 2, -1]);
    eq('...and does not touch anything else', h.get(990011)?.q0, null);

    // The back-fill: from the oldest sample any check has, to the frontier.
    await q(`UPDATE samples_hourly SET lo4 = NULL, nok = NULL WHERE entity_id IN (990021, 990022) AND hour_ts = $1`, [t(0)]);
    await q(`INSERT INTO job_state (job, through_ts) VALUES ('rollup', $1)
             ON CONFLICT (job) DO UPDATE SET through_ts = excluded.through_ts`, [t(120)]);
    await q(`DELETE FROM job_state WHERE job = 'rollup:checks-backfill'`);
    type B = { hours_written: string; done: boolean; through: Date; until: Date; locked: boolean };
    const b1 = (await q<B>(`SELECT * FROM roll_up_checks_backfill(168)`))[0]!;
    eq('the back-fill covers the checks\' hours up to the frontier, in one step here',
        [b1.done, b1.locked, b1.through.toISOString(), b1.until.toISOString()], [true, false, t(120), t(120)]);
    h = await hour();
    eq('  and the hour has its figures again', [h.get(990021)?.lo4, h.get(990022)?.nok], [3.0, 2]);
    const b2 = (await q<B>(`SELECT * FROM roll_up_checks_backfill(168)`))[0]!;
    eq('once done, another call writes nothing and says done', [Number(b2.hours_written), b2.done], [0, true]);
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

// --- 13. the rollup purge (slice 60) -------------------------------------------
console.log('\n13. a deleted entity\'s hourly rows are queued with the delete and purged behind the rollup:');
{
    const hourly = async (ids: number[]): Promise<number> => Number((await q<{ n: string }>(
        'SELECT count(*) AS n FROM samples_hourly WHERE entity_id = ANY($1::int[])', [ids]))[0]!.n);
    const queue = async (): Promise<number[]> => (await q<{ entity_id: number }>(
        'SELECT entity_id FROM rollup_purge ORDER BY entity_id')).map((r) => r.entity_id);
    const setFrontier = (sql: string) => q(`UPDATE job_state SET through_ts = ${sql} WHERE job = 'rollup'`);
    const drainAll = async (): Promise<{ entities: number; rows: number }> => {
        let entities = 0, rows = 0;
        for (let i = 0; i < 20; i++) {
            const r = await OPS.purgeRollupBatch(2);
            if (!r.ok) throw new Error(`purgeRollupBatch refused: ${r.reason}`);
            entities += r.rows[0]!.entities;
            rows += Number(r.rows[0]!.rows);
            if (r.rows[0]!.entities < 2) break;
        }
        return { entities, rows };
    };

    await setFrontier(`date_trunc('hour', now())`);
    await q(`INSERT INTO devices (id, name, host) VALUES (990003, 'scratch-gone', '192.0.2.3')`);
    await q(`INSERT INTO entities (id, device_id, kind, name, code, tracked, source) VALUES
             (990031, 990003, 'cpu', 'CPU C', 'SCRP', true, 'snmp'),
             (990032, 990003, 'svc-http', 'Intranet', 'SCRQ', true, 'probe')`);
    // Three hours each for the two, and for 990098 - an entity deleted
    // before the queue existed, which only the census can find.
    await q(`INSERT INTO samples_hourly (entity_id, hour_ts, n)
             SELECT e, date_trunc('hour', now()) - make_interval(hours => h), 1
               FROM unnest(ARRAY[990031, 990032, 990098]) e, generate_series(3, 5) h`);

    // The census, first call: it records its start and waits for the rollup.
    const first = await OPS.rollupPurgeCensus();
    if (!first.ok) throw new Error(`rollupPurgeCensus refused: ${first.reason}`);
    eq('the census\'s first call records its partitions and waits for the rollup to pass its start',
        [first.rows[0]!.waiting, (first.rows[0]!.parts_left ?? 0) > 0], [true, true]);
    await q(`UPDATE job_state SET detail = jsonb_set(detail, '{since}', to_jsonb(now() - interval '3 hours'))
              WHERE job = 'rollup:purge-census'`);
    let steps = 0;
    for (; steps < 20; steps++) {
        const c = await OPS.rollupPurgeCensus();
        if (!c.ok) throw new Error(`rollupPurgeCensus refused: ${c.reason}`);
        if (c.rows[0]!.parts_left === 0) break;
    }
    eq('two hours on, it reads one partition a call and queues the entity with no row - and no living one',
        await queue(), [990098]);

    // The app's own deletes queue their ids in the same statement.
    const check = await OPS.deleteCheck('990003', 'SCRQ');
    eq('deleteCheck removes the check', check.ok && check.rows.map((r) => r.name), ['Intranet']);
    const gone = await OPS.deleteDevices(['scratch-gone']);
    eq('deleteDevices removes the device', gone.ok && gone.rows.map((r) => r.name), ['scratch-gone']);
    eq('and both queued their entities', await queue(), [990031, 990032, 990098]);

    // The drain: the census's find is an hour behind the frontier; the
    // deletes made just now are not, and stay queued with their rows.
    let d = await drainAll();
    eq('the drain purges what the rollup has passed: 990098\'s three rows', [d.entities, d.rows], [1, 3]);
    eq('and leaves the fresh deletes queued, rows and all, until the rollup is an hour past them',
        [await queue(), await hourly([990031, 990032])], [[990031, 990032], 6]);
    await setFrontier(`date_trunc('hour', now()) + interval '3 hours'`);
    d = await drainAll();
    eq('once it is, they go, in bounded batches', [d.entities, d.rows, await queue()], [2, 6, []]);
    eq('nothing of the three is left', await hourly([990031, 990032, 990098]), 0);

    // An id in the queue that is a living entity leaves it, its rows kept.
    const living = await hourly([990011]);
    await q(`INSERT INTO rollup_purge (entity_id, queued_ts) VALUES (990011, now() - interval '1 day')`);
    d = await drainAll();
    eq('a living id in the queue leaves it, and its rows stay', [d.entities, d.rows, await hourly([990011]), await queue()],
        [1, 0, living, []]);
    eq('(and it had rows to keep)', living > 0, true);
    await setFrontier('now()');
}

// --- 14. repeating maintenance windows (slice 61) ---------------------------------
console.log('\n14. a repeating window is open on its days, at its local time, for its minutes - and gates as a window does:');
{
    const DEV = 'scratch-backup';
    await q(`INSERT INTO devices (id, name, host) VALUES (990004, $1, '192.0.2.4')`, [DEV]);
    const make = async (days: number[], at: string, minutes: number, tz: string): Promise<string> => {
        const r = await OPS.createMaintenanceSchedule('device', DEV, days, at, minutes, tz, 'scratch', 'test');
        if (!r.ok || r.rows.length !== 1) throw new Error(`schedule refused: ${r.ok ? 'no row' : r.reason}`);
        return r.rows[0]!.id;
    };
    // One at a time: a pg Client runs one query at once (pg warns, and pg 9
    // refuses, on overlapping calls).
    const openAt = async (...at: string[]): Promise<boolean[]> => {
        const out: boolean[] = [];
        for (const t of at) {
            out.push(Number((await q<{ n: string }>(
                `SELECT count(*) AS n FROM maintenance_active($1::timestamptz) WHERE target = $2`, [t, DEV]))[0]!.n) > 0);
        }
        return out;
    };
    const clear = () => q(`DELETE FROM maintenance_schedules WHERE target = $1`, [DEV]);
    const DAILY = [1, 2, 3, 4, 5, 6, 7];

    // The domain controller's, the case that asked for this: every day at 03:00 for 10 minutes.
    await make(DAILY, '03:00', 10, 'America/Chicago');
    eq('every day at 03:00 Chicago (CDT): open from 08:00Z for ten minutes, not a moment either side',
        await openAt('2026-10-10 07:59:59Z', '2026-10-10 08:00Z', '2026-10-10 08:09:59Z', '2026-10-10 08:10Z'),
        [false, true, true, false]);
    eq('in January the same 03:00 is CST, 09:00Z', await openAt('2027-01-15 08:05Z', '2027-01-15 09:05Z'), [false, true]);
    await clear();

    // 2026-10-10 is a Saturday.
    await make([1, 2, 3, 4, 5], '03:00', 10, 'America/Chicago');
    eq('weekdays only: open Friday at 03:05, closed Saturday at 03:05', await openAt('2026-10-09 08:05Z', '2026-10-10 08:05Z'), [true, false]);
    await clear();
    await make([6], '23:30', 60, 'America/Chicago');
    eq('Saturdays at 23:30 for an hour: open at 23:45, and past midnight at 00:15 Sunday',
        await openAt('2026-10-11 04:45Z', '2026-10-11 05:15Z'), [true, true]);
    eq('closed at 00:30 Sunday, and at 23:45 on Friday and on Sunday',
        await openAt('2026-10-11 05:30Z', '2026-10-10 04:45Z', '2026-10-12 04:45Z'), [false, false, false]);
    await clear();

    // Daylight saving, as measured when the slice was written.
    await make(DAILY, '02:30', 30, 'America/Chicago');
    eq('2026-03-08, when 02:30 does not exist: open 08:30Z-09:00Z, which is 03:30-04:00 CDT',
        await openAt('2026-03-08 08:15Z', '2026-03-08 08:45Z', '2026-03-08 09:00Z'), [false, true, false]);
    await clear();
    await make(DAILY, '01:30', 30, 'America/Chicago');
    eq('2026-11-01, when 01:30 happens twice: open for the second (CST, 07:30Z), not the first (06:30Z)',
        await openAt('2026-11-01 06:45Z', '2026-11-01 07:45Z'), [false, true]);
    await clear();
    await make(DAILY, '03:00', 10, 'Europe/London');
    eq('the zone is the schedule\'s own: 03:00 in London (BST) is 02:00Z', await openAt('2026-10-10 02:05Z', '2026-10-10 08:05Z'), [true, false]);
    await clear();

    // What may be stored.
    const unknown = await OPS.createMaintenanceSchedule('device', DEV, [1], '03:00', 10, 'Mars/Olympus', null, 'test');
    eq('a zone the database does not know makes no row (one would break every reader)', unknown.ok && unknown.rows.length, 0);
    let refused = '';
    try {
        await OPS.createMaintenanceSchedule('device', DEV, [1], '03:00', 721, 'UTC', null, 'test');
    } catch (err) {
        refused = (err as { code?: string }).code ?? 'threw';
    }
    eq('the table itself refuses an occurrence over 12 hours', refused, '23514');

    // The gate, through the app's own statements, with an occurrence open now.
    const startedAgo = (await q<{ t: string }>(
        `SELECT to_char((now() AT TIME ZONE 'UTC') - interval '5 minutes', 'HH24:MI') AS t`))[0]!.t;
    const sid = await make(DAILY, startedAgo, 30, 'UTC');
    const listed = await OPS.maintenanceSchedules();
    const mine = listed.ok ? listed.rows.find((r) => r.id === sid) : undefined;
    // Started five minutes ago, to the minute: 24 or 25 minutes still to run.
    const left = mine?.next_ends ? (mine.next_ends.getTime() - Date.now()) / 60_000 : -1;
    eq('the list says it is open now, until its occurrence ends', [mine?.active, left > 23.5 && left <= 25.5], [true, true]);
    const raise = async (): Promise<string> => (await q<{ id: string }>(
        `INSERT INTO alerts (alert_key, state, severity, kind, host, label, first_breach_ts, raised_ts, last_seen_ts)
         VALUES ($1, 'active', 'crit', 'device-down', $2, 'not answering', now(), now(), now()) RETURNING id::text AS id`,
        [`device:${DEV}`, DEV]))[0]!.id;
    const owed = async (): Promise<boolean> => {
        const r = await OPS.alertsOwingRaise();
        if (!r.ok) throw new Error(`alertsOwingRaise refused: ${r.reason}`);
        return r.rows.some((a) => a.host === DEV);
    };
    const first = await raise();
    eq('a device-down raised while it is open is owed no page', await owed(), false);
    const shown = await OPS.getAlert(first);
    eq('and reads as in maintenance', shown.ok && shown.rows[0]?.in_maintenance, true);
    await q(`UPDATE alerts SET state = 'cleared', cleared_ts = now(), clear_reason = 'recovered' WHERE id = $1::bigint`, [first]);
    await OPS.settleInWindowClears();
    eq('its clear, inside the occurrence and of a raise nobody was sent, is settled without a page',
        (await q<{ c: boolean }>(`SELECT notified_clear AS c FROM alerts WHERE id = $1::bigint`, [first]))[0]?.c, true);
    await raise();
    eq('a second outage, still active...', await owed(), false);
    const gone = await OPS.cancelMaintenanceSchedule(sid);
    eq('...is owed its page the moment the schedule is removed', [gone.ok && gone.rows.length, await owed()], [1, true]);
    await q(`DELETE FROM alerts WHERE host = $1`, [DEV]);
}

// --- 15. restarts (slice 62) ---------------------------------------------------
console.log('\n15. a restart is recorded by the poll write that stores the uptime it was judged from:');
{
    const DEV = 'scratch-restart';
    const ID = '990005';
    await q(`INSERT INTO devices (id, name, host) VALUES ($1::bigint, $2, '192.0.2.5')`, [ID, DEV]);
    const poll = (uptime: number, upBefore: number | null) => OPS.recordDevicePoll(
        ID, true, null, null, null, false, null, null, null, uptime, null, null, null, null, null, upBefore);
    const events = async () => q<{ up: number; planned: boolean; boot_age: number }>(
        `SELECT up_before_s AS up, planned, extract(epoch FROM now() - boot_ts)::float8 AS boot_age
           FROM reboot_events WHERE device_id = $1::bigint ORDER BY id`, [ID]);
    const row = async () => (await q<{ seen: boolean; up: number | null; planned: boolean | null; uptime: number }>(
        `SELECT reboot_seen_ts IS NOT NULL AS seen, reboot_up_before_s AS up, reboot_planned AS planned, uptime_s AS uptime
           FROM devices WHERE id = $1::bigint`, [ID]))[0]!;

    const first = await poll(86_400, null);
    eq('an ordinary poll records no restart', [first.ok, (await events()).length, (await row()).seen], [true, 0, false]);
    await poll(40, 86_400);
    const ev = await events();
    eq('a judged restart: one event, the uptime before, not planned', ev.map((e) => [e.up, e.planned]), [[86_400, false]]);
    eq('its boot time is the write\'s now() less the new uptime', ev[0] !== undefined && ev[0].boot_age > 39 && ev[0].boot_age < 45, true);
    eq('and the device row carries it, beside the new uptime', await row(), { seen: true, up: 86_400, planned: false, uptime: 40 });

    // The judgement's inputs, as the collector receives them: the uptime and
    // the DATABASE's age of the last good poll.
    await q(`UPDATE devices SET last_poll_ts = now() - interval '1 hour', poll_anchor_ts = NULL,
                                last_seen_ts = now() - interval '90 seconds' WHERE id = $1::bigint`, [ID]);
    const due = await OPS.duePollTargets(1000, 'live', 3, []);
    const mine = due.ok ? due.rows.find((d) => d.id === ID) : undefined;
    eq('duePollTargets hands the collector the last uptime and its age by the database clock',
        mine && [mine.uptime_s, mine.since_seen_s !== null && mine.since_seen_s >= 89 && mine.since_seen_s < 95], [40, true]);
    const scan = await OPS.alertScanDevices();
    const s = scan.ok ? scan.rows.find((d) => d.name === DEV) : undefined;
    eq('the scan reads the restart\'s age and its uptime before',
        s && [s.reboot_age_s !== null && s.reboot_age_s < 30, s.reboot_up_before_s, s.reboot_planned], [true, 86_400, false]);

    // PLANNED is decided when the restart is recorded: a window open now.
    const startedAgo = (await q<{ t: string }>(
        `SELECT to_char((now() AT TIME ZONE 'UTC') - interval '5 minutes', 'HH24:MI') AS t`))[0]!.t;
    const sched = await OPS.createMaintenanceSchedule('device', DEV, [1, 2, 3, 4, 5, 6, 7], startedAgo, 30, 'UTC', 'scratch', 'test');
    await poll(20, 50);
    eq('a restart inside a maintenance window is recorded as planned', (await events()).map((e) => e.planned), [false, true]);
    eq('and the device row says so', (await row()).planned, true);
    if (sched.ok && sched.rows[0]) await OPS.cancelMaintenanceSchedule(sched.rows[0].id);

    const failed = await OPS.recordDevicePoll(ID, false, null, null, null, false, null, null, null, null, null, null, null, null, null, 999);
    eq('a FAILED poll records nothing, whatever it is handed', [failed.ok, (await events()).length], [true, 2]);

    await OPS.deleteDevices([DEV]);
    eq('deleting the device takes its restarts (the cascade)', (await events()).length, 0);
}

// --- 16. acknowledgement (slice 62) ----------------------------------------------
console.log('\n16. an acknowledgement names who and why, stops renotify, and belongs to the incident:');
{
    const HOST = 'scratch-ack';
    const raise = async (kind = 'device-down', state = 'active'): Promise<string> => (await q<{ id: string }>(
        `INSERT INTO alerts (alert_key, state, severity, kind, host, label, first_breach_ts, raised_ts, last_seen_ts,
                             notified_raise, cleared_ts)
         VALUES ($1, $2, 'crit', $3, $4, 'scratch ack', now() - interval '5 hours', now() - interval '5 hours', now(),
                 true, CASE WHEN $2 = 'cleared' THEN now() END)
         RETURNING id::text AS id`, [`${kind}:${HOST}:${Math.random()}`, state, kind, HOST]))[0]!.id;
    const owing = async (id: string): Promise<boolean> => {
        const r = await OPS.alertsOwingRenotify(1);
        if (!r.ok) throw new Error(`alertsOwingRenotify refused: ${r.reason}`);
        return r.rows.some((a) => a.id === id);
    };
    const who = async (id: string) => (await q<{ by: string | null; note: string | null; at: boolean }>(
        `SELECT acked_by AS by, ack_note AS note, acked_ts IS NOT NULL AS at FROM alerts WHERE id = $1::bigint`, [id]))[0];

    const id = await raise();
    eq('a crit raised five hours ago is owed a renotify at a one-hour interval', await owing(id), true);
    const a1 = await OPS.ackAlert(id, 'alice', 'ISP ticket 4471');
    eq('acknowledged: the row names who and the note, and the route gets the label to audit',
        [a1.ok && a1.rows[0]?.label, await who(id)], ['scratch ack', { by: 'alice', note: 'ISP ticket 4471', at: true }]);
    eq('and renotify skips it - DECISIONS-2026-09-01 ruling 2, honoured since before this slice', await owing(id), false);
    const shown = await OPS.uiAlert(id);
    eq('the alert page reads it, and the alert itself is unchanged - still active',
        shown.ok && [shown.rows[0]?.state, shown.rows[0]?.acked_by, shown.rows[0]?.ack_note], ['active', 'alice', 'ISP ticket 4471']);
    await OPS.ackAlert(id, 'bob', null);
    eq('acknowledging again replaces the who and the note', await who(id), { by: 'bob', note: null, at: true });
    const u1 = await OPS.unackAlert(id);
    eq('taken back: all three cleared, and renotify applies again', [u1.ok && u1.rows.length, await who(id), await owing(id)],
        [1, { by: null, note: null, at: false }, true]);
    const u2 = await OPS.unackAlert(id);
    eq('taking back what nobody acknowledged changes nothing', u2.ok && u2.rows.length, 0);
    await q(`UPDATE alerts SET state = 'cleared', cleared_ts = now(), clear_reason = 'recovered' WHERE id = $1::bigint`, [id]);
    const a2 = await OPS.ackAlert(id, 'alice', null);
    eq('a cleared alert cannot be acknowledged - it is history', [a2.ok && a2.rows.length, (await who(id))?.at], [0, false]);

    // A restart alert's clear is settled without an email; nothing else is.
    const restart = await raise('reboot', 'cleared');
    const down = await raise('device-down', 'cleared');
    const settled = await OPS.settleRestartClears([restart, down]);
    const flags = await q<{ c: boolean }>(
        `SELECT notified_clear AS c FROM alerts WHERE id = ANY($1::bigint[]) ORDER BY id`, [[restart, down]]);
    eq('settleRestartClears settles the restart alert\'s clear and only that',
        [settled.ok && settled.rows.map((r) => r.id), flags.map((r) => r.c)], [[restart], [true, false]]);
    await q(`DELETE FROM alerts WHERE host = $1`, [HOST]);
}

// --- 17. the device timeline (IDEAS-2026-10-15 item 4) -----------------------------
console.log('\n17. one device\'s timeline: every kind, its own rows only, newest first, audit for admins:');
{
    const DEV = 'scratch-timeline';
    const ID = '990006';
    await q(`INSERT INTO devices (id, name, host, location, application) VALUES ($1::bigint, $2, '192.0.2.6', 'Rack 9', 'App T')`, [ID, DEV]);
    await q(`INSERT INTO devices (id, name, host) VALUES (990007, 'scratch-other', '192.0.2.7')`);
    await q(`INSERT INTO entities (device_id, kind, name, code) VALUES ($1::int, 'cpu', 'cpu', 'TL01')`, [ID]);
    const ago = (min: number): string => `now() - interval '${min} minutes'`;
    const alert = (key: string, host: string, cols: string, vals: string) => q(
        `INSERT INTO alerts (alert_key, state, severity, kind, host, label, first_breach_ts, last_seen_ts, code${cols})
         VALUES ($1, 'cleared', 'crit', 'cpu', $2, $1, now() - interval '3 days', now(), 'TL01'${vals})`, [key, host]);
    // One incident with all four moments, one older than the window except
    // its clear, one pending that never raised, and one on another device.
    await alert('tl-a', DEV, ', raised_ts, escalated_ts, cleared_ts, clear_reason, acked_ts, acked_by, ack_note',
        `, ${ago(120)}, ${ago(90)}, ${ago(58)}, 'normal', ${ago(100)}, 'alice', 'ticket 9'`);
    await alert('tl-c', DEV, ', raised_ts, cleared_ts, clear_reason', `, ${ago(1800)}, ${ago(1200)}, 'normal'`);
    await q(`INSERT INTO alerts (alert_key, state, severity, kind, host, label, first_breach_ts, last_seen_ts)
             VALUES ('tl-pending', 'pending', 'warn', 'cpu', $1, 'never raised', now(), now())`, [DEV]);
    await alert('tl-other', 'scratch-other', ', raised_ts', `, ${ago(30)}`);
    await q(`INSERT INTO reachability_events (device_id, ts, from_state, to_state, rtt_ms) VALUES
             ($1::bigint, ${ago(50)}, 'up', 'down', NULL), ($1::bigint, ${ago(49)}, 'down', 'up', 0.4),
             (990007, ${ago(45)}, 'up', 'down', NULL)`, [ID]);
    await q(`INSERT INTO reboot_events (device_id, ts, boot_ts, up_before_s, planned)
             VALUES ($1::bigint, ${ago(179)}, ${ago(180)}, 86400, false)`, [ID]);
    await q(`INSERT INTO maintenance_windows (scope, target, starts_ts, ends_ts, note, created_by) VALUES
             ('device', $1, ${ago(240)}, ${ago(230)}, 'patching', 'bob'),
             ('location', 'Rack 9', ${ago(300)}, ${ago(290)}, NULL, 'bob'),
             ('device', 'scratch-other', ${ago(200)}, ${ago(190)}, NULL, 'bob')`, [DEV]);
    // A daily schedule on its application, started six hours ago (UTC):
    // exactly one occurrence falls in the last 24 hours, whatever the hour.
    const six = (await q<{ t: string }>(
        `SELECT to_char((now() AT TIME ZONE 'UTC') - interval '6 hours', 'HH24:MI') AS t`))[0]!.t;
    const sched = await OPS.createMaintenanceSchedule('application', 'App T', [1, 2, 3, 4, 5, 6, 7], six, 30, 'UTC', 'nightly', 'test');
    await q(`INSERT INTO audit (ts, actor_username, action, target, detail) VALUES
             (${ago(10)}, 'bob', 'threshold.set', $1 || '/cpu', '{}'),
             (${ago(12)}, 'bob', 'device.mute', '2 device(s)', jsonb_build_object('names', jsonb_build_array($1::text, 'x'))),
             (${ago(15)}, 'bob', 'threshold.set', 'code TL01', '{}'),
             (${ago(16)}, 'bob', 'alert.ack', $1 || ' (192.0.2.6) cpu', '{}'),
             (${ago(17)}, 'bob', 'device.mute', '1 device(s)', '{"names": ["scratch-other"]}'),
             (${ago(18)}, 'bob', 'threshold.set', 'scratch-other/cpu', '{}')`, [DEV]);

    const tl = await OPS.deviceTimeline(DEV, 24, true, 300);
    const rows = tl.ok ? tl.rows : [];
    eq('every kind, newest first, nothing of another device, no pending alert, no ack audit line',
        rows.map((r) => r.kind === 'audit' ? `audit ${String(r.data?.action)}` : r.kind),
        ['audit threshold.set', 'audit device.mute', 'audit threshold.set', 'reach', 'reach', 'alert-clear',
            'alert-escalate', 'alert-ack', 'alert-raise', 'restart', 'maintenance', 'maintenance', 'maintenance', 'alert-clear']);
    const a = rows.find((r) => r.kind === 'alert-ack');
    eq('an acknowledgement carries who and the note; a clear its reason',
        [a?.data?.by, a?.data?.note, rows.find((r) => r.kind === 'alert-clear')?.data?.reason], ['alice', 'ticket 9', 'normal']);
    const r = rows.find((x) => x.kind === 'restart');
    eq('a restart sits at the time it came back, with its uptime before', [r?.data?.upBefore, r?.data?.planned], [86400, false]);
    const m = rows.filter((x) => x.kind === 'maintenance');
    const mins = (x: (typeof rows)[number]): number => Math.round((x.until!.getTime() - x.ts.getTime()) / 60_000);
    eq('windows on the device and its location, and the ONE occurrence of its application\'s schedule, each with its end',
        m.map((x) => [x.data?.scope, x.data?.repeating, mins(x)]),
        [['device', false, 10], ['location', false, 10], ['application', true, 30]]);
    eq('the older incident shows only its clear - its raise is outside the window', rows.at(-1)?.text, 'tl-c');
    const noAudit = await OPS.deviceTimeline(DEV, 24, false, 300);
    eq('without the audit permission there are no audit rows', noAudit.ok && noAudit.rows.filter((x) => x.kind === 'audit').length, 0);
    const short = await OPS.deviceTimeline(DEV, 1, true, 300);
    eq('an hour back holds only the last hour', short.ok && short.rows.map((x) => x.kind),
        ['audit', 'audit', 'audit', 'reach', 'reach', 'alert-clear']);
    const capped = await OPS.deviceTimeline(DEV, 24, true, 3);
    eq('and the limit keeps the newest', capped.ok && capped.rows.length, 3);

    if (sched.ok && sched.rows[0]) await OPS.cancelMaintenanceSchedule(sched.rows[0].id);
    await q(`DELETE FROM maintenance_windows WHERE created_by = 'bob'`);
    await q(`DELETE FROM audit WHERE actor_username = 'bob'`);
    await q(`DELETE FROM alerts WHERE host IN ($1, 'scratch-other')`, [DEV]);
    await OPS.deleteDevices([DEV, 'scratch-other']);
}

// --- 18. the availability report (sql/slice63.sql) ---------------------------------
console.log('\n18. minute probes rolled up by the hour, maintenance apart; the report from them and the sweep:');
{
    const DEV = 'scratch-avail';
    const ID = '990008';
    await q(`INSERT INTO devices (id, name, host, location) VALUES ($1::bigint, $2, '192.0.2.8', 'Closet A')`, [ID, DEV]);
    // Two whole hours, three and two hours back: 60 probes each, 2 misses in
    // the first, 5 in the second - which a device-scope window covers whole.
    const A = `date_trunc('hour', now()) - interval '3 hours'`;
    const B = `date_trunc('hour', now()) - interval '2 hours'`;
    await q(`INSERT INTO ping_samples (device_id, ts, rtt_ms)
             SELECT $1::bigint, ${A} + make_interval(mins => g), CASE WHEN g < 2 THEN NULL ELSE 0.5 END
               FROM generate_series(0, 59) g`, [ID]);
    await q(`INSERT INTO ping_samples (device_id, ts, rtt_ms)
             SELECT $1::bigint, ${B} + make_interval(mins => g), CASE WHEN g < 5 THEN NULL ELSE 0.5 END
               FROM generate_series(0, 59) g`, [ID]);
    await q(`INSERT INTO maintenance_windows (scope, target, starts_ts, ends_ts, note, created_by)
             VALUES ('device', $1, ${B}, ${B} + interval '1 hour', 'firmware', 'avail-test')`, [DEV]);

    const rollAll = async (): Promise<number> => {
        let chunks = 0;
        for (;;) {
            const r = await OPS.rollUpPingChunk(24, 5);
            if (!r.ok || !r.rows[0]) throw new Error(`roll-up refused: ${r.ok ? 'no row' : r.reason}`);
            chunks++;
            if (r.rows[0].caught_up || chunks > 10) return chunks;
        }
    };
    await rollAll();
    const hours = async () => q<{ h: string; p: number; m: number; pp: number; pm: number }>(
        `SELECT to_char(hour_ts, 'HH24') AS h, probes AS p, misses AS m, planned_probes AS pp, planned_misses AS pm
           FROM ping_hourly WHERE device_id = $1::bigint ORDER BY hour_ts`, [ID]);
    const first = await hours();
    eq('the first roll-up starts at the oldest probe: two hours, every probe counted, the window\'s hour planned whole',
        first.map((r) => [r.p, r.m, r.pp, r.pm]), [[60, 2, 0, 0], [60, 5, 60, 5]]);
    await q(`UPDATE job_state SET through_ts = through_ts - interval '3 hours' WHERE job = 'rollup:ping'`);
    await rollAll();
    eq('rolled again over the same hours, it rewrites them whole - nothing counted twice',
        (await hours()).map((r) => [r.p, r.m, r.pp, r.pm]), [[60, 2, 0, 0], [60, 5, 60, 5]]);

    // The sweep's transitions: one down before the period that ends ten
    // minutes in, a 30 s blip and a two-minute outage in hour A, and ten
    // minutes down inside the window in hour B.
    const LO = `(now() - interval '2 days')::date::timestamp AT TIME ZONE 'UTC'`;
    await q(`INSERT INTO reachability_events (device_id, ts, from_state, to_state) VALUES
             ($1::bigint, ${LO} - interval '1 hour', 'up', 'down'),
             ($1::bigint, ${LO} + interval '10 minutes', 'down', 'up'),
             ($1::bigint, ${A} + interval '5 minutes', 'up', 'down'),
             ($1::bigint, ${A} + interval '5 minutes 30 seconds', 'down', 'up'),
             ($1::bigint, ${A} + interval '20 minutes', 'up', 'down'),
             ($1::bigint, ${A} + interval '22 minutes', 'down', 'up'),
             ($1::bigint, ${A} + interval '40 minutes', 'up', 'degraded'),
             ($1::bigint, ${A} + interval '41 minutes', 'degraded', 'up'),
             ($1::bigint, ${B} + interval '10 minutes', 'up', 'down'),
             ($1::bigint, ${B} + interval '20 minutes', 'down', 'up')`, [ID]);
    const days = (await q<{ f: string; t: string }>(
        `SELECT to_char(now() - interval '2 days', 'YYYY-MM-DD') AS f, to_char(now(), 'YYYY-MM-DD') AS t`))[0]!;
    const frontier = (await q<{ t: Date }>(`SELECT through_ts AS t FROM job_state WHERE job = 'rollup:ping'`))[0]!.t;
    const rep = await OPS.availabilityReport(days.f, days.t, 'UTC', frontier);
    const mine = rep.ok ? rep.rows.find((r) => r.device === DEV) : undefined;
    eq('the report: both hours\' probes, the window\'s apart, two hours measured',
        mine && [Number(mine.probes), Number(mine.misses), Number(mine.planned_probes), Number(mine.planned_misses), mine.hours_measured],
        [120, 7, 60, 5, 2]);
    const expectTotal = (await q<{ n: number }>(`SELECT ceil(extract(epoch FROM $1::timestamptz - (${A})) / 3600)::int AS n`, [frontier]))[0]!.n;
    eq('and measured against the hours since it was first probed, not since the period began', mine?.hours_total, expectTotal);
    eq('outages: the one carried in from before the period and the two-minute one; the 30 s blip apart; degraded is not down',
        mine && [mine.outages, mine.blips, mine.longest_s, mine.down_s], [2, 1, 600, 750]);
    eq('the ten minutes down inside the window are planned, not an outage', mine?.planned_down_s, 600);

    // Retention never deletes a probe the roll-up has not taken.
    await q(`INSERT INTO ping_samples (device_id, ts, rtt_ms) VALUES ($1::bigint, now(), 0.5)`, [ID]);
    await q(`UPDATE job_state SET through_ts = ${B} WHERE job = 'rollup:ping'`);
    await OPS.prunePingSamples(0);
    const left = await q<{ before_b: number; after: number }>(
        `SELECT count(*) FILTER (WHERE ts < ${B})::int AS before_b, count(*) FILTER (WHERE ts >= ${B})::int AS after
           FROM ping_samples WHERE device_id = $1::bigint`, [ID]);
    eq('with the frontier at hour B, a zero-day prune takes hour A\'s probes and keeps B\'s and the new one',
        left[0], { before_b: 0, after: 61 });

    await q(`DELETE FROM maintenance_windows WHERE created_by = 'avail-test'`);
    await OPS.deleteDevices([DEV]);
    eq('deleting the device takes its hours with it (the cascade)',
        (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ping_hourly WHERE device_id = $1::bigint`, [ID]))[0]?.n, 0);
}

// --- 19. notes (sql/slice64.sql) -------------------------------------------------
console.log('\n19. a device\'s notes are stored as written, blank is none, and the roster carries them:');
{
    const DEV = 'scratch-notes';
    await q(`INSERT INTO devices (id, name, host) VALUES (990009, $1, '192.0.2.9')`, [DEV]);
    const text = 'Owner: Jordan Kim\nAsset tag 004417';
    const w = await OPS.setDeviceNotes(DEV, `${text}\n\n  `);
    const rosterNotes = async (): Promise<string | null | undefined> => {
        const r = await OPS.uiDevices();
        return r.ok ? r.rows.find((x) => x.name === DEV)?.notes : undefined;
    };
    eq('saved with its line break, the trailing blank lines trimmed, and read back from the roster',
        [w.ok && w.rows.length, await rosterNotes()], [1, text]);
    await OPS.setDeviceNotes(DEV, '   ');
    eq('blank is none - NULL, one state', await rosterNotes(), null);
    const nobody = await OPS.setDeviceNotes('no-such-device', 'x');
    eq('a device that does not exist changes nothing', nobody.ok && nobody.rows.length, 0);
    await OPS.deleteDevices([DEV]);
}

// --- 20. change from normal (sql/slice65.sql) ---------------------------------------
console.log('\n20. change from normal: the week from the rollup, the last minutes from raw, the scan\'s judgement, and the holds:');
{
    const LOC = 'Scratch Closet';
    // Three servers and a switch in one room, and a lone server in another.
    await q(`INSERT INTO devices (id, name, host, location, stencil, last_poll_ts) VALUES
             (990020, 'scratch-tc-a', '192.0.2.20', $1, 'server', now()),
             (990021, 'scratch-tc-b', '192.0.2.21', $1, 'server', now()),
             (990022, 'scratch-tc-c', '192.0.2.22', $1, 'switch', now()),
             (990023, 'scratch-tc-d', '192.0.2.23', $1, 'server', now()),
             (990024, 'scratch-tc-lone', '192.0.2.24', 'Scratch Attic', 'server', now())`, [LOC]);
    await q(`INSERT INTO entities (id, device_id, kind, name, code, tracked) VALUES
             (990201, 990020, 'temp', 'Temp: SYSTIN', 'TCA1', true),
             (990202, 990020, 'temp', 'Temp: Package id 0', 'TCA2', true),
             (990203, 990021, 'temp', 'Temp: mlx5-pci-0100:sensor0', 'TCB1', true),
             (990204, 990022, 'temp', 'Temp: CPU temperature', 'TCC1', true),
             (990205, 990023, 'temp', 'Temp: temp1', 'TCD1', true),
             (990206, 990024, 'temp', 'Temp: AUXTIN1', 'TCL1', true),
             (990207, 990024, 'temp', 'Temp: da1', 'TCL2', false),
             (990208, 990023, 'temp', 'Temp: Module0', 'TCD2', true)`);
    // A week of hourly means: 100 hours cycling 40, 40.5, 41, 41.5 - median
    // 40.75, quartiles 40.375 and 41.125. The current hour and one eight days
    // back read 99, and must not count. The DIMM has ten hours: learning.
    await q(`INSERT INTO samples_hourly (entity_id, hour_ts, n, a0)
             SELECT e, date_trunc('hour', now()) - make_interval(hours => g + 1), 120, 40 + (g % 4) * 0.5
               FROM unnest(ARRAY[990201, 990202, 990203, 990204, 990205, 990206]) e, generate_series(0, 99) g
             UNION ALL SELECT e, date_trunc('hour', now()), 120, 99
               FROM unnest(ARRAY[990201, 990202, 990203, 990204, 990205, 990206]) e
             UNION ALL SELECT e, date_trunc('hour', now()) - interval '8 days', 120, 99
               FROM unnest(ARRAY[990201, 990202, 990203, 990204, 990205, 990206]) e
             UNION ALL SELECT 990208, date_trunc('hour', now()) - make_interval(hours => g + 1), 120, 40
               FROM generate_series(0, 9) g
             UNION ALL SELECT 990207, date_trunc('hour', now()) - make_interval(hours => g + 1), 120, 40
               FROM generate_series(0, 99) g`);
    // An untracked sensor's row from when it was tracked: the refresh drops it.
    await q(`INSERT INTO temp_baselines (entity_id, base_ts, hours, med, q1, q3)
             VALUES (990207, now() - interval '1 day', 100, 40, 39, 41)`);
    const ref = await OPS.refreshTempBaselines(7);
    eq('the refresh runs and drops at least the stale row', ref.ok && (ref.rows[0]?.dropped ?? 0) >= 1, true);
    const base = await q<{ id: number; hours: number; med: number; q1: number; q3: number }>(`
        SELECT entity_id AS id, hours, med, q1, q3 FROM temp_baselines
         WHERE entity_id BETWEEN 990201 AND 990208 ORDER BY entity_id`);
    const b1 = base.find((x) => x.id === 990201);
    eq('a tracked temperature\'s week: 100 hours, median 40.75, quartiles 40.375 / 41.125 - the current hour and day 8 left out',
        b1 && [b1.hours, near(b1.med, 40.75), near(b1.q1, 40.375), near(b1.q3, 41.125)], [100, true, true, true]);
    eq('every tracked temperature gets one, work-driven too (including counts from the next scan)',
        base.map((x) => x.id), [990201, 990202, 990203, 990204, 990205, 990206, 990208]);
    eq('the learning DIMM is kept with its ten hours', base.find((x) => x.id === 990208)?.hours, 10);

    // The last 20 minutes at 30 s: A's board at 60 (a dead fan), B's NIC and
    // C's switch chip 4 C warm for the last ten (the room), D at its week, A's
    // CPU at 90 (work), the lone server's board at 60.
    await q(`INSERT INTO samples (entity_id, ts, v0)
             SELECT e, now() - make_interval(secs => g * 30 + 5),
                    CASE e WHEN 990201 THEN 60 WHEN 990202 THEN 90 WHEN 990206 THEN 60 WHEN 990205 THEN 40.75
                           WHEN 990203 THEN CASE WHEN g < 20 THEN 45 ELSE 40.75 END
                           WHEN 990204 THEN CASE WHEN g < 20 THEN 44.5 ELSE 40.75 END END
               FROM unnest(ARRAY[990201, 990202, 990203, 990204, 990205, 990206]) e, generate_series(0, 39) g`);
    const rec = await OPS.tempChangeRecent([990203], 600, 1200);
    eq('the recent read: B\'s last 10 minutes are 20 readings at 45, its last 20 are 40 with median 42.875',
        rec.ok && rec.rows.map((r) => [r.n10, r.r10, r.n20, r.r20]), [[20, 45, 40, 42.875]]);

    const judge = async (cfg = DEFAULT_RULES) => {
        const all = await changeScan(cfg);
        return Object.fromEntries(all.filter((c) => /TC[A-Z]\d$|Scratch/.test(c.key))
            .map((c) => [c.key, [c.severity, c.frozen, c.value]]));
    };
    eq('THE SCAN: A\'s board and the lone board raise; B, C and D read normal; the room of four raises on three; the CPU, the learning DIMM and the untracked disk take no part; a room of one is not a room',
        await judge(), {
            'change:TCA1': ['warn', false, 19.3], 'change:TCB1': [null, false, 2.1], 'change:TCC1': [null, false, 1.9],
            'change:TCD1': [null, false, 0], 'change:TCL1': ['warn', false, 19.3],
            [`temp-room:location:${LOC}`]: ['warn', false, 3.8],
        });
    const room = (await changeScan(DEFAULT_RULES)).find((c) => c.key === `temp-room:location:${LOC}`);
    eq('the room\'s label names the three, warmest first', room?.label,
        `${LOC} (location): 3 of 4 devices warmer than their week - scratch-tc-a, scratch-tc-b, scratch-tc-c`);
    await q(`UPDATE devices SET status = 'down' WHERE id = 990021`);
    const down = await judge();
    eq('B down: its own condition freezes, and the room - three judged, two warm - reads normal',
        [down['change:TCB1'], down[`temp-room:location:${LOC}`]], [[null, true, null], [null, false, 0]]);
    await q(`UPDATE devices SET status = 'up', alerts_muted = true WHERE id IN (990021, 990020)`);
    const muted = await judge();
    eq('A and B muted: nothing of theirs, and a room of two - C and D, one warm - reads normal',
        [muted['change:TCA1'], muted['change:TCB1'], muted[`temp-room:location:${LOC}`]], [undefined, undefined, [null, false, 0]]);
    await q(`UPDATE devices SET alerts_muted = false WHERE id IN (990021, 990020)`);
    const included = await judge({ ...DEFAULT_RULES, overrides: [{ scope: 'code', code: 'TCA2', kind: 'temp-change', enabled: true }] });
    eq('A\'s CPU included on its card: read, and +49 C raises', included['change:TCA2'], ['warn', false, 49.3]);

    const shown = await OPS.uiDeviceEntities('scratch-tc-a');
    const card = shown.ok ? shown.rows.find((r) => r.code === 'TCA1') : undefined;
    eq('the device page reads the week and the stencil with the entities - no extra query',
        card && [card.base_hours, card.base_med, card.stencil], [100, 40.75, 'server']);

    // The holds, on alert rows as the scan would write them.
    const alert = async (key: string, kind: string, host: string | null, code: string | null): Promise<string> => (await q<{ id: string }>(
        `INSERT INTO alerts (alert_key, state, severity, kind, host, code, label, first_breach_ts, raised_ts, last_seen_ts)
         VALUES ($1, 'active', 'warn', $2, $3, $4, 'scratch change', now() - interval '10 minutes', now() - interval '9 minutes', now())
         RETURNING id::text AS id`, [key, kind, host, code]))[0]!.id;
    const roomId = await alert(`temp-room:location:${LOC}`, 'temp-room', null, null);
    const memberId = await alert('change:TCA1', 'temp-change', 'scratch-tc-a', 'TCA1');
    const loneId = await alert('change:TCL1', 'temp-change', 'scratch-tc-lone', 'TCL1');
    const flags = async (id: string) => {
        const r = await OPS.getAlert(id);
        const a = r.ok ? r.rows[0] : undefined;
        return a && [a.in_maintenance, a.under_policy, a.in_group, a.group_overlap];
    };
    eq('a sensor in a room whose alert is open is HELD; one in another room is not',
        [(await flags(memberId))?.[2], (await flags(loneId))?.[2]], [true, false]);
    await q(`INSERT INTO maintenance_windows (scope, target, starts_ts, ends_ts, note, created_by)
             VALUES ('location', $1, now() - interval '1 minute', now() + interval '1 hour', 'closet work', 'tc-test')`, [LOC]);
    eq('a window on the location holds the room\'s alert, and not the attic\'s sensor',
        [(await flags(roomId))?.[0], (await flags(loneId))?.[0]], [true, false]);
    await q(`DELETE FROM maintenance_windows WHERE created_by = 'tc-test'`);
    await q(`INSERT INTO notify_policy (scope, target, note, created_by) VALUES ('location', $1, NULL, 'tc-test')`, [LOC]);
    eq('a policy on the location covers the room\'s alert', (await flags(roomId))?.[1], true);
    await q(`DELETE FROM notify_policy WHERE created_by = 'tc-test'`);
    eq('with both gone, the room\'s alert is held by nothing', await flags(roomId), [false, false, false, false]);
    await q(`UPDATE alerts SET state = 'cleared', cleared_ts = now() - interval '5 minutes' WHERE id = $1::bigint`, [roomId]);
    eq('the room cleared five minutes ago: its member is still held - a cooling room clears before its sensors do',
        (await flags(memberId))?.[2], true);
    await q(`UPDATE alerts SET cleared_ts = now() - interval '25 minutes' WHERE id = $1::bigint`, [roomId]);
    eq('...and released once a sensor window has passed: still hot then is its own fault', (await flags(memberId))?.[2], false);
    await q(`UPDATE alerts SET state = 'active', cleared_ts = NULL WHERE id = $1::bigint`, [roomId]);
    await q(`UPDATE alerts SET state = 'cleared', cleared_ts = now() WHERE id = $1::bigint`, [memberId]);
    eq('a held sensor\'s clear overlapped its room\'s alert - settled with it, no email for a raise nobody got',
        (await flags(memberId))?.[3], true);
    await q(`DELETE FROM alerts WHERE id = ANY($1::bigint[])`, [[roomId, memberId, loneId]]);

    await OPS.deleteDevices(['scratch-tc-a', 'scratch-tc-b', 'scratch-tc-c', 'scratch-tc-d', 'scratch-tc-lone']);
    eq('deleting the devices takes their weeks (the cascade)',
        (await q<{ n: number }>(`SELECT count(*)::int AS n FROM temp_baselines WHERE entity_id BETWEEN 990201 AND 990208`))[0]?.n, 0);
}

await db.end();
await closeAll();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
