// The corpse broom against a real database: does it collect the rows the
// planner parks, and NOTHING it should not?
//
//   DATABASE_URL=postgres://...@localhost:5432/rscanvas_test node tools/test-corpse-broom.ts
//
// A scratch-DB test, because the predicate is SQL and the offline suite
// cannot hold it - which is how AUDIT-2026-09-01-PM finding 8 lived for an
// afternoon: the broom took tracked=false, the planner parked by clearing
// snmp_index, and no test ever planted a parked row and watched it go. The
// HANDOFF's 09-08 watch was going to read zero for every planner-parked
// corpse and be mistaken for the loop closing. This is the test the auditor
// said should land before the 8th.
//
// It plants its own device through Force Add's own op, so the destructive
// scope is one device it created, and it refuses any non-disposable
// database by the same interlock every destructive tool obeys.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

process.exitCode = 1;
assertDestructiveTarget('test-corpse-broom', CONFIG.databaseUrl);

let pass = 0, fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(l); else bad(l, { got, want });
};

/** One raw statement on the collector lane, rows back or a thrown refusal. */
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const r = await onLane<T>('collector', async (c) => {
        const res = await c.query(sql, params);
        return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    });
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    return r.rows;
};

const DEV = 'broom-test-device';
const HOST = '192.0.2.222';

async function main(): Promise<void> {
    // Start clean: a previous aborted run must not pre-load the fixture.
    await q(`DELETE FROM entities WHERE device_id IN (SELECT id FROM devices WHERE name = $1)`, [DEV]);
    await q(`DELETE FROM devices WHERE name = $1`, [DEV]);

    const forced = await OPS.forceAddDevice(DEV, HOST, 161, '2c', 'SNMP_COMMUNITY', 30, 'BRM1');
    if (!forced.ok || forced.rows[0]?.outcome !== 'added') throw new Error('could not plant the device');
    const idRow = await q<{ id: string }>(`SELECT id::text AS id FROM devices WHERE name = $1`, [DEV]);
    const deviceId = idRow[0]!.id;

    // The fixture, one row per predicate branch. Every corpse shares its
    // name with the living row "Ethernet 4" except the orphan, which has no
    // sibling at all. A null idx plants the row indexed and then PARKS it -
    // snmp_index cleared - exactly as the planner's eviction does.
    const plant = async (idx: string | null, name: string, code: string, tracked: boolean,
        staleDays: number | null): Promise<void> => {
        const r = await OPS.insertEntity(deviceId, 'if', idx ?? `tmp-${code}`, name, 'fixture', null, null, code, null, tracked);
        if (!r.ok || r.rows.length === 0) throw new Error(`could not plant ${code}`);
        await q(
            `UPDATE entities SET lv_ts = now() - interval '30 days',
                    lv_stale_since = CASE WHEN $2::int IS NULL THEN NULL
                                          ELSE now() - make_interval(days => $2::int) END,
                    snmp_index = CASE WHEN $3 THEN NULL ELSE snmp_index END
              WHERE id = $1::bigint`, [r.rows[0]!.id, staleDays, idx === null]);
    };

    await plant('9', 'Ethernet 4', 'LIVE', true, null);           // the living generation
    await q(`UPDATE entities SET lv_ts = now() WHERE code = 'LIVE' AND device_id = $1::bigint`, [deviceId]);
    await plant(null, 'Ethernet 4', 'PARK', true, 8);             // finding 8's row
    await plant('7', 'Ethernet 4', 'UNTR', false, 8);             // the original path
    await plant('8', 'Ethernet 4', 'TRCK', true, 8);              // the operator's call
    await plant('6', 'Ethernet 9', 'ORPH', false, 8);             // no living sibling
    await plant(null, 'Ethernet 4', 'YNG', true, 2);              // parked, not yet a week

    console.log('the broom, against a real table:');
    const swept = await OPS.pruneCorpseInterfaces(7);
    if (!swept.ok) throw new Error(`broom refused (${swept.reason})`);
    eq('it removed exactly two rows', swept.rows[0]?.n, '2');

    const left = await q<{ code: string }>(
        `SELECT code FROM entities WHERE device_id = $1::bigint ORDER BY code`, [deviceId]);
    const codes = left.map((r) => r.code);
    eq('the PARKED corpse is gone - finding 8, the row the planner produces',
        codes.includes('PARK'), false);
    eq('the untracked corpse is gone - the original path still works',
        codes.includes('UNTR'), false);
    eq('the tracked, indexed corpse stays - the operator has not spoken',
        codes.includes('TRCK'), true);
    eq('the orphan stays - a row with no living sibling is history, not a clone',
        codes.includes('ORPH'), true);
    eq('the young park stays - the week has not passed',
        codes.includes('YNG'), true);
    eq('the living generation is untouched', codes.includes('LIVE'), true);

    console.log('\nfinding 9, the untrack that could not reach a parked row:');
    const byCode = await OPS.setEntitiesTrackedByCode(deviceId, ['YNG'], [false]);
    eq('untracking a PARKED row by code changes it',
        byCode.ok ? byCode.rows.map((r) => r.tracked) : 'refused', [false]);
    const again = await OPS.setEntitiesTrackedByCode(deviceId, ['YNG'], [false]);
    eq('and a repeat is a named no-op, not a second success', again.ok ? again.rows.length : -1, 0);

    console.log('\nruling 10, pending has an expiry:');
    const fresh = await q<{ status: string }>(
        `SELECT ${OPS_STATUS('d')} AS status FROM devices d WHERE id = $1::bigint`, [deviceId]);
    eq('a never-seen device added just now reads pending', fresh[0]?.status, 'pending');
    await q(`UPDATE devices SET added_ts = now() - interval '2 days' WHERE id = $1::bigint`, [deviceId]);
    const aged = await q<{ status: string }>(
        `SELECT ${OPS_STATUS('d')} AS status FROM devices d WHERE id = $1::bigint`, [deviceId]);
    eq('past the horizon it reads down - the promise expired', aged[0]?.status, 'down');

    // Tear down what this planted, and only that.
    await q(`DELETE FROM entities WHERE device_id = $1::bigint`, [deviceId]);
    await q(`DELETE FROM devices WHERE id = $1::bigint`, [deviceId]);
}

// The one status definition, imported rather than copied - the test must
// judge the SHIPPED fragment.
import { deviceStatusSql as OPS_STATUS } from '../src/store/ops.ts';

main().then(async () => {
    await closeAll();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}).catch(async (err) => {
    console.error('FAIL -', (err as Error).message);
    await closeAll();
    process.exit(1);
});
