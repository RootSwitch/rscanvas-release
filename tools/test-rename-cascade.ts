// The rename cascade and the address move, against a SCRATCH database.
//
// The 2026-09-01 review's finding 7: renaming a device carried its alerts
// and threshold overrides and silently left three more name-keyed rows
// behind - a maintenance window scoped to it, a notify policy scoped to
// it, and every board shape bound to it. Each is the kind of failure that
// surfaces days later as "the thing I set up stopped working". The fix
// carries all five in one statement (store/ops.ts renameDevice), and this
// suite proves it on real rows, because a jsonb rewrite over an array of
// shapes is exactly the SQL a unit test cannot reach.
//
// It also proves the address move (setDeviceAddress), the one gap on the
// release list a forker could not work around: until 2026-09-15 the only
// way to re-address a device was delete and re-add.
//
// LIVE and DESTRUCTIVE on the database it is pointed at - it plants and
// deletes its own rows by name, but it is refused outright on a database
// whose name does not say scratch (src/safety.ts):
//
//   DATABASE_URL=postgres://...@localhost:5432/rscanvas_test node tools/test-rename-cascade.ts
//   npm run test:rename

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

process.exitCode = 1;
assertDestructiveTarget('test-rename-cascade', CONFIG.databaseUrl);

let pass = 0, fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(l); else bad(l, { got, want });
};

/** One raw statement on the interactive lane, rows back or a thrown refusal. */
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const r = await onLane<T>('interactive', async (c) => {
        const res = await c.query(sql, params);
        return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    });
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    return r.rows;
};

const OLD = 'rename-test-old';
const NEW = 'rename-test-new';
const OTHER = 'rename-test-bystander';
const TAKEN = 'rename-test-taken';       // a name whose policy already stands
const BOARD = 'rename-test-board';
const HOST = '192.0.2.201';
const HOST2 = '192.0.2.202';

async function cleanup(): Promise<void> {
    await q(`DELETE FROM boards WHERE name = $1`, [BOARD]);
    await q(`DELETE FROM maintenance_windows WHERE scope = 'device' AND target = ANY($1::text[])`, [[OLD, NEW, OTHER, TAKEN]]);
    // The clash step's standing policy is under a name no device carries;
    // an aborted run leaves it, and it would collide on the next plant.
    await q(`DELETE FROM notify_policy WHERE scope = 'device' AND target = ANY($1::text[])`, [[OLD, NEW, OTHER, TAKEN, OTHER + '-x']]);
    await q(`DELETE FROM entities WHERE device_id IN (SELECT id FROM devices WHERE name = ANY($1::text[]))`, [[OLD, NEW, OTHER, TAKEN]]);
    await q(`DELETE FROM devices WHERE name = ANY($1::text[])`, [[OLD, NEW, OTHER, TAKEN]]);
}

async function main(): Promise<void> {
    console.log('rename carries every name-keyed row; a move keeps the device\n');
    await cleanup();

    // --- the fixture ---------------------------------------------------------
    // Each device gets its OWN uptime code: the column is unique, and the
    // first run of this suite planted both with one code and fell over on
    // the second insert before reaching anything it was written to prove.
    for (const [name, host, code] of [[OLD, HOST, 'RN01'], [OTHER, HOST2, 'RN02']] as const) {
        const f = await OPS.forceAddDevice(name, host, 161, '2c', 'SNMP_COMMUNITY', 30, code);
        if (!f.ok || f.rows[0]?.outcome !== 'added') throw new Error(`could not plant ${name}`);
    }
    await q(`INSERT INTO maintenance_windows (scope, target, starts_ts, ends_ts, note)
             VALUES ('device', $1, now(), now() + interval '1 hour', 'rename test'),
                    ('device', $2, now(), now() + interval '1 hour', 'bystander')`, [OLD, OTHER]);
    await q(`INSERT INTO notify_policy (scope, target, note) VALUES ('device', $1, 'rename test'), ('device', $2, 'bystander')`, [OLD, OTHER]);
    // Four shapes: bound with the generated label, bound with a label the
    // operator changed, a bystander device, and a text shape with no bind.
    const doc = {
        shapes: [
            { id: 'g1', kind: 'device', label: OLD, bind: OLD, x: 0, y: 0, w: 190, h: 100 },
            { id: 'g2', kind: 'device', label: 'Core switch (my label)', bind: OLD, x: 210, y: 0, w: 190, h: 100 },
            { id: 'g3', kind: 'device', label: OTHER, bind: OTHER, x: 420, y: 0, w: 190, h: 100 },
            { id: 't1', kind: 'text', label: OLD, x: 0, y: 130, w: 190, h: 40 },
        ],
    };
    await q(`INSERT INTO boards (name, collection, doc) VALUES ($1, 'wall', $2::jsonb)`, [BOARD, JSON.stringify(doc)]);

    // --- the rename ----------------------------------------------------------
    const r = await OPS.renameDevice(OLD, NEW);
    if (!r.ok) throw new Error(`rename refused (${r.reason})`);
    const row = r.rows[0]!;
    eq('one device renamed', row.renamed, 1);
    eq('its maintenance window carried', row.windows, 1);
    eq('its notify policy carried', row.policies, 1);
    eq('the one board holding it rewritten', row.boards, 1);

    const win = await q<{ target: string; n: string }>(
        `SELECT target, count(*)::text AS n FROM maintenance_windows WHERE scope = 'device' AND target = ANY($1::text[]) GROUP BY target ORDER BY target`,
        [[OLD, NEW, OTHER]]);
    // ORDER BY target puts the bystander first ("b" before "n"); the
    // expectation is written in that order rather than the order of
    // thought, which the first live run got wrong.
    eq('window rows: the new name has one, the old none, the bystander untouched',
        win.map((w) => `${w.target}=${w.n}`), [`${OTHER}=1`, `${NEW}=1`]);
    const pol = await q<{ target: string }>(
        `SELECT target FROM notify_policy WHERE scope = 'device' AND target = ANY($1::text[]) ORDER BY target`, [[OLD, NEW, OTHER]]);
    eq('policy rows: the same', pol.map((p) => p.target), [OTHER, NEW]);

    const b = await q<{ doc: { shapes: Array<Record<string, unknown>> } }>(`SELECT doc FROM boards WHERE name = $1`, [BOARD]);
    const shapes = b[0]!.doc.shapes;
    eq('shape order and count survive the rewrite', shapes.map((s) => s.id), ['g1', 'g2', 'g3', 't1']);
    eq('a bound shape follows the rename in bind AND its generated label', [shapes[0]!.bind, shapes[0]!.label], [NEW, NEW]);
    eq('a bound shape whose label the operator changed keeps that label', [shapes[1]!.bind, shapes[1]!.label], [NEW, 'Core switch (my label)']);
    eq('the bystander device is untouched', [shapes[2]!.bind, shapes[2]!.label], [OTHER, OTHER]);
    eq('a text shape with no bind is untouched even when its label matches', [shapes[3]!.bind, shapes[3]!.label], [undefined, OLD]);
    eq('geometry survives', [shapes[1]!.x, shapes[1]!.w], [210, 190]);

    // --- a rename that cannot be carried is refused WHOLE --------------------
    const taken = await OPS.forceAddDevice(TAKEN, '192.0.2.203', 161, '2c', 'SNMP_COMMUNITY', 30, 'RN03');
    if (!taken.ok) throw new Error('could not plant the taken device');
    await q(`INSERT INTO notify_policy (scope, target, note) VALUES ('device', $1, 'standing policy')`, [OTHER + '-x']);
    // OTHER renamed to a name that already has a policy: the UNIQUE bites,
    // and the store lets the SQL error PROPAGATE (pool.ts turns only a
    // statement timeout into a refused outcome) - so the refusal is a
    // THROWN unique violation naming the policy table, which is what the
    // route catches and answers 409 with. The first draft of this step
    // awaited an outcome and the throw ended the suite; that was the
    // moment the route's missing catch was found.
    let clash: { code?: string; table?: string } | null = null;
    try {
        await OPS.renameDevice(OTHER, OTHER + '-x');
    } catch (err) {
        clash = err as { code?: string; table?: string };
    }
    if (clash !== null && clash.code === '23505' && clash.table === 'notify_policy') {
        ok('renaming onto a name with a standing policy is refused as a unique violation on notify_policy');
    } else bad('the clash was not refused as expected', clash);
    const still = await q<{ name: string }>(`SELECT name FROM devices WHERE name = ANY($1::text[]) ORDER BY name`, [[OTHER, OTHER + '-x']]);
    eq('and the device keeps its old name - nothing half-applied', still.map((d) => d.name), [OTHER]);
    const winStill = await q<{ target: string }>(`SELECT target FROM maintenance_windows WHERE scope = 'device' AND target = $1`, [OTHER]);
    eq('its window is still under the old name', winStill.length, 1);
    await q(`DELETE FROM notify_policy WHERE scope = 'device' AND target = $1`, [OTHER + '-x']);

    // --- the address move ------------------------------------------------------
    // A force-added device has no entities - that is what force-add means -
    // so the history the move must keep is planted here, one interface, the
    // way the corpse-broom suite plants its fixture. The first live run
    // asserted kept history on a device that had none.
    const idBefore = await q<{ id: string }>(`SELECT id::text AS id FROM devices WHERE name = $1`, [NEW]);
    const ins = await OPS.insertEntity(idBefore[0]!.id, 'if', '1', 'Ethernet 1', 'fixture', null, null, 'RNIF1', null, true);
    if (!ins.ok) throw new Error(`could not plant the entity (${ins.reason})`);
    await q(`UPDATE devices SET consecutive_failures = 5, last_poll_ts = now(), reach_state = 'up' WHERE name = $1`, [NEW]);
    const mv = await OPS.setDeviceAddress(NEW, '192.0.2.250', 1161);
    if (!mv.ok) throw new Error(`move refused (${mv.reason})`);
    eq('the move returns the new address and port', [mv.rows[0]!.host, mv.rows[0]!.snmp_port], ['192.0.2.250', 1161]);
    const after = await q<{ host: string; snmp_port: number; consecutive_failures: number; last_poll_ts: string | null; reach_state: string; id: string }>(
        `SELECT id::text AS id, host(host) AS host, snmp_port, consecutive_failures, last_poll_ts, reach_state FROM devices WHERE name = $1`, [NEW]);
    const a = after[0]!;
    eq('stored address and port changed', [a.host, a.snmp_port], ['192.0.2.250', 1161]);
    eq('failures reset so the new address is not born down', a.consecutive_failures, 0);
    eq('last_poll_ts cleared so the scheduler polls it first', a.last_poll_ts, null);
    eq('reach state back to unknown for the sweep to re-establish', a.reach_state, 'unknown');
    const mvPortKept = await OPS.setDeviceAddress(NEW, '192.0.2.251', null);
    eq('a move with no port keeps the port', mvPortKept.ok ? mvPortKept.rows[0]!.snmp_port : -1, 1161);
    const ent = await q<{ n: string }>(`SELECT count(*)::text AS n FROM entities WHERE device_id = $1::bigint AND code = 'RNIF1'`, [a.id]);
    eq('the planted entity stays with the device across both moves (history kept)', ent[0]!.n, '1');
    const none = await OPS.setDeviceAddress('rename-test-nobody', '192.0.2.9', null);
    eq('moving a device that does not exist changes nothing', none.ok ? none.rows.length : -1, 0);

    await cleanup();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error('rename-cascade test threw:', err);
    process.exitCode = 1;
}).finally(() => { void closeAll(); });
