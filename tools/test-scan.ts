// The scan tick against a real database: the machine's decisions arriving in
// rows, and the two properties only an integration can prove.
//
//   1. THE OWED QUEUE IS THE DATABASE. A raise leaves notified_raise=false on
//      the row, so dispatch surviving a crash is a property of the schema,
//      not of the process that happened to be running.
//   2. FREEZE-BEFORE-AGE. An alert whose source vanished only ages toward
//      source-removed while the collector is healthy - a dead collector must
//      not auto-clear a live outage. Proven here by ageing every poll stamp
//      and watching the missing counter STOP.
//
// Scan counts come from CONFIG (raise 2 / clear 2 / missing 20 by default),
// and the loops below run exactly that many scans rather than assuming the
// defaults - the test follows the deployed configuration.
//
// Destructive (it writes devices, entities and alerts), so it refuses to run
// anywhere but a nominated disposable database.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';
import { scanTick, type ScanResult } from '../src/alerts/scan.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const DEV = 'scan-probe';
const CODE = 'SCANPRB';
const KEY = `if:${CODE}:down`;

const sql = async (text: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    const r = await onLane<Record<string, unknown>>('jobs', async (c) => {
        const q = await c.query<Record<string, unknown>>(text, values);
        return { rows: q.rows, rowCount: q.rows.length };
    });
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    return r.rows;
};

const alertFor = async (key: string): Promise<Record<string, unknown> | null> => {
    const rows = await sql(
        `SELECT state, severity, missing_count, clear_reason, notified_raise, notified_clear
           FROM alerts WHERE alert_key = $1 AND state != 'cleared'`, [key]);
    return rows[0] ?? null;
};

const myEvents = (r: ScanResult): string[] =>
    r.events.filter((e) => e.key === KEY).map((e) => e.type);

async function cleanup(): Promise<void> {
    await sql(`DELETE FROM alerts WHERE alert_key IN ($1, $2) OR alert_key = 'watchdog:collector'`,
        [KEY, `device:${DEV}`]);
    await sql(`DELETE FROM entities WHERE code = $1`, [CODE]);
    await sql(`DELETE FROM devices WHERE name = $1`, [DEV]);
}

async function main(): Promise<void> {
    assertDestructiveTarget('test-scan', CONFIG.databaseUrl);
    console.log('scan tick: machine decisions arriving in rows\n');
    console.log(`  (raiseScans=${CONFIG.alertRaiseScans}, clearScans=${CONFIG.alertClearScans}, `
        + `missingScans=${CONFIG.alertMissingScans})\n`);

    await cleanup();

    // --- fixture: one polled device, one tracked interface, oper DOWN ------
    const dev = await OPS.upsertDevice(DEV, '127.0.0.1', 161, '2c', 'SNMP_COMMUNITY', 30);
    if (!dev.ok) throw new Error('device fixture failed');
    const devId = dev.rows[0]!.id;
    await OPS.recordDevicePoll(devId, true, DEV, null, null, false, null);
    const ent = await OPS.insertEntity(devId, 'if', '999', 'eth0', null, 'uplink', 1e9, CODE);
    if (!ent.ok || ent.rows[0] === undefined) throw new Error('entity fixture failed');
    const entId = ent.rows[0].id;
    await OPS.refreshEntity(entId, 'eth0', null, 'uplink', 1e9, 1, 2);
    // admin up, oper DOWN, fresh rates: the if-down crit condition.
    await OPS.updateLastValues(entId, new Date(), 2, 1.0, [0, 0, 0, 0, 0, 0], null);

    try {
        // --- raise, at exactly raiseScans -------------------------------------
        let raised: string[] = [];
        for (let i = 1; i <= CONFIG.alertRaiseScans; i++) {
            const r = await scanTick();
            raised = raised.concat(myEvents(r));
            if (i < CONFIG.alertRaiseScans) {
                const a = await alertFor(KEY);
                if (a?.state !== 'pending') {
                    bad(`scan ${i}: expected pending, got ${JSON.stringify(a?.state)}`);
                }
            }
        }
        const active = await alertFor(KEY);
        if (active?.state === 'active' && raised.join() === 'raise') {
            ok(`pending for ${CONFIG.alertRaiseScans - 1} scan(s), then ACTIVE with exactly one raise`);
        } else {
            bad('the raise did not arrive as configured', JSON.stringify({ active, raised }));
        }
        if (active?.notified_raise === false) {
            ok('and the raise is OWED on the row (notified_raise=false) - the queue is the database');
        } else {
            bad('notified_raise did not start false', JSON.stringify(active));
        }

        // --- clear, at exactly clearScans -------------------------------------
        await OPS.updateLastValues(entId, new Date(), 1, 1.0, [1000, 1000, 0, 0, 0, 0], null);
        let cleared: string[] = [];
        for (let i = 1; i <= CONFIG.alertClearScans; i++) {
            const r = await scanTick();
            cleared = cleared.concat(myEvents(r));
        }
        const done = await sql(
            `SELECT state, clear_reason, notified_clear FROM alerts
              WHERE alert_key = $1 ORDER BY id DESC LIMIT 1`, [KEY]);
        if (done[0]?.state === 'cleared' && done[0]?.clear_reason === 'normal'
            && cleared.join() === 'clear') {
            ok(`clearing for ${CONFIG.alertClearScans - 1} scan(s), then CLEARED normal with exactly one clear`);
        } else {
            bad('the clear did not arrive as configured', JSON.stringify({ done, cleared }));
        }
        if (done[0]?.notified_clear === false) {
            ok('and the clear is owed the same way');
        } else {
            bad('notified_clear did not start false');
        }

        // --- freeze-before-age -------------------------------------------------
        // Re-raise, remove the source, and count one missing scan while the
        // collector is healthy.
        await OPS.updateLastValues(entId, new Date(), 2, 1.0, [0, 0, 0, 0, 0, 0], null);
        for (let i = 0; i < CONFIG.alertRaiseScans; i++) await scanTick();
        await sql(`UPDATE entities SET tracked = false WHERE id = $1::bigint`, [entId]);
        await scanTick();
        const counting = await alertFor(KEY);
        if (Number(counting?.missing_count) === 1) {
            ok('source removed, collector healthy: the missing counter advances');
        } else {
            bad('the missing counter did not advance', JSON.stringify(counting));
        }

        // Now kill the collector's pulse: every poll stamp ages an hour.
        await sql(`UPDATE devices SET last_poll_ts = last_poll_ts - interval '1 hour'
                    WHERE last_poll_ts IS NOT NULL`);
        const stale = await scanTick();
        const frozen = await alertFor(KEY);
        if (!stale.collectorHealthy && Number(frozen?.missing_count) === 1) {
            ok('collector stale: the missing counter STOPS - a dead collector cannot clear a live outage');
        } else {
            bad('freeze-before-age failed', JSON.stringify({ healthy: stale.collectorHealthy, frozen }));
        }
        const watchdog = await alertFor('watchdog:collector');
        if (watchdog !== null) {
            ok('and the watchdog alert entered the machinery like any other');
        } else {
            bad('no watchdog alert appeared for a stale collector');
        }

        // Pulse restored: aging resumes and completes as source-removed.
        await sql(`UPDATE devices SET last_poll_ts = last_poll_ts + interval '1 hour'
                    WHERE last_poll_ts IS NOT NULL`);
        let sourceRemoved: string[] = [];
        for (let i = 0; i < CONFIG.alertMissingScans; i++) {
            const r = await scanTick();
            sourceRemoved = sourceRemoved.concat(myEvents(r));
            const a = await alertFor(KEY);
            if (a === null) break;
        }
        const aged = await sql(
            `SELECT state, clear_reason FROM alerts
              WHERE alert_key = $1 ORDER BY id DESC LIMIT 1`, [KEY]);
        if (aged[0]?.state === 'cleared' && aged[0]?.clear_reason === 'source-removed'
            && sourceRemoved.join() === 'clear') {
            ok('collector healthy again: the alert ages out as source-removed, one clear event');
        } else {
            bad('aging did not complete', JSON.stringify({ aged, sourceRemoved }));
        }
        const wd = await alertFor('watchdog:collector');
        if (wd === null || wd.state === 'pending') {
            ok('and the watchdog resolved through the normal machinery once polling resumed');
        } else {
            bad('the watchdog is stranded', JSON.stringify(wd));
        }

        // --- NEVER-POLLED IS A FAULT, NOT IDLE -------------------------------
        //
        // The roster query filters last_poll_ts IS NOT NULL, so enabled
        // devices the collector never reached simply did not appear - and an
        // empty roster read as healthy-but-idle. A monitoring system watching
        // nothing, reporting green. The stamps are SAVED AND RESTORED by id,
        // because a test owns its blast radius: NULLing every device's stamp
        // and walking away is the exact move that killed the demo's login.
        const saved = await sql(
            `SELECT id::text AS id, last_poll_ts FROM devices WHERE last_poll_ts IS NOT NULL`);
        await sql(`UPDATE devices SET last_poll_ts = NULL`);
        const unpolled = await scanTick();
        if (!unpolled.collectorHealthy) {
            ok('enabled devices with NONE ever polled is UNHEALTHY - watching nothing is not idle');
        } else {
            bad('an unpolled roster read as healthy-but-idle', JSON.stringify({
                healthy: unpolled.collectorHealthy, devices: unpolled.devices,
            }));
        }
        for (const r of saved) {
            await sql(`UPDATE devices SET last_poll_ts = $2 WHERE id = $1::bigint`,
                [r.id, r.last_poll_ts]);
        }
        const restored = await scanTick();
        if (restored.collectorHealthy) {
            ok('and restoring the stamps restores health - the fault is the data, not a latch');
        } else {
            bad('health did not recover after the stamps were restored');
        }

        // --- ONE CLOCK: the health verdict must survive JS clock skew --------
        //
        // The old implementation compared the jobs worker's JS clock against
        // Postgres timestamps, so an app clock 2 hours AHEAD made every poll
        // read stale forever - the watchdog permanently raised and stepMissing
        // aging permanently frozen via mayAge. The ages now come from
        // Postgres, computed against the same now() that stamped them, so a
        // skewed JS clock must change NOTHING. This control fails against the
        // old code.
        const RealDate = Date;
        const SKEW_MS = 2 * 3600_000;
        // eslint-disable-next-line no-global-assign
        (globalThis as { Date: DateConstructor }).Date = class extends RealDate {
            constructor(...args: unknown[]) {
                if (args.length === 0) super(RealDate.now() + SKEW_MS);
                else super(...(args as [number]));
            }
            static override now(): number { return RealDate.now() + SKEW_MS; }
        } as DateConstructor;
        try {
            const skewed = await scanTick();
            if (skewed.collectorHealthy) {
                ok('a JS clock 2h AHEAD changes nothing - the ages come from the database clock');
            } else {
                bad('JS clock skew made the collector read stale - the health path is still on two clocks');
            }
        } finally {
            (globalThis as { Date: DateConstructor }).Date = RealDate;
        }

        // --- ALERT TRUTH SURVIVES SAMPLE EXPIRY ------------------------------
        //
        // Every raise, clear, freeze and age above happened against an entity
        // with ZERO rows in samples: the scan reads lv_* on entities and
        // never touches the raw partitions, so retention can drop all of them
        // without changing a single alert's evaluation. That has been true of
        // this test by construction since the day it was written; this block
        // turns the accident into a stated property, because the machine now
        // depends on it. A refactor that makes evaluation read samples_*
        // fails HERE, naming the property, rather than at first expiry on
        // day 8 of a soak.
        //
        // The count is measured FIRST, then the counter is calibrated with
        // one planted sample (would zero look the same if the query were
        // broken? yes - so prove the counter can see before believing it),
        // removed afterwards by the entity id this test owns.
        const today = new RealDate().toISOString().slice(0, 10);
        const bare = await sql(
            `SELECT count(*)::int AS n FROM samples WHERE entity_id = $1::int`, [entId]);
        if (bare[0]?.n === 0) {
            ok('the whole lifecycle above ran with ZERO samples rows - alert truth lives in lv_*, '
                + 'and retention may expire every raw partition without touching it');
        } else {
            bad('the fixture has samples rows, so this test no longer proves the property',
                JSON.stringify(bare));
        }
        const part = await OPS.ensureSamplePartitions(today, today);
        if (!part.ok) throw new Error(`could not ensure a partition for the calibration sample (${part.reason})`);
        await sql(`INSERT INTO samples (entity_id, ts, status) VALUES ($1::int, now(), 1)`, [entId]);
        const planted = await sql(
            `SELECT count(*)::int AS n FROM samples WHERE entity_id = $1::int`, [entId]);
        await sql(`DELETE FROM samples WHERE entity_id = $1::int`, [entId]);
        if (planted[0]?.n === 1) {
            ok('and the counter is calibrated - a planted sample IS seen, so the zero was measured');
        } else {
            bad('the planted sample was not seen - the zero above proves nothing', JSON.stringify(planted));
        }
    } finally {
        await cleanup();
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('scan test failed:', err);
    void closeAll();
    process.exit(1);
});
