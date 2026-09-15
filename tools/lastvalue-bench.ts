// Decide the denormalised last-value columns by measurement.
//
//   ADMIN_PASSWORD=... sudo -E tools/lastvalue-bench.sh   (for the cold runs)
//   node tools/lastvalue-bench.ts                          (warm only)
//
// WHY THIS IS NOT ALREADY DECIDED. The handoff records the parent's verdict -
// denormalised last-value columns on entities were "rejected for the Pi because
// it trades write amplification for read speed" - and ARCHITECTURE.md section 7
// defers the question with "needs its own measured session".
//
// That verdict was reached on a DIFFERENT ENGINE and must not be inherited.
// It was measured against better-sqlite3, where every write was synchronous,
// serialised behind a single writer, and on the same thread as everything
// else, so write amplification was the scarcest thing in the system. On
// Postgres with an async driver and per-lane pools the collector is already
// writing, has reserved capacity nothing else can consume, and an UPDATE rides
// the same connection in the same lane. The trade may invert.
//
// The read being measured is the /api/devices shape, which cost the parent
// 5,200 queries and 141ms per page load at 100 devices.
//
// Both sides are timed through the store's own interactive lane so the
// comparison includes everything a real request pays, not just the SQL.

import { OPS, closeAll } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';

const REPEATS = Number(process.env.REPEATS || 7);
/** Collector-created entities start here; below it is spike fixture. */
const REAL_FROM = 100_000;

interface Timing { label: string; ms: number[]; rows: number; refused: string | null }

function summarise(t: Timing): { label: string; p50: number; min: number; max: number; rows: number; refused: string | null } {
    if (t.ms.length === 0) {
        return { label: t.label, p50: 0, min: 0, max: 0, rows: 0, refused: t.refused };
    }
    const s = [...t.ms].sort((a, b) => a - b);
    return {
        label: t.label,
        p50: Number((s[Math.floor(s.length / 2)] as number).toFixed(1)),
        min: Number((s[0] as number).toFixed(1)),
        max: Number((s[s.length - 1] as number).toFixed(1)),
        rows: t.rows,
        refused: t.refused,
    };
}

/**
 * A refusal is a RESULT, not a crash.
 *
 * The first version threw on `!res.ok`, and so destroyed the single most
 * important finding this benchmark can produce: that the samples-shaped read
 * exceeds the interactive lane's 2s statement timeout at the 30,000-entity
 * ceiling. "This query cannot be served on the lane that serves dashboards" is
 * the answer to the question being asked, and the tool exited non-zero on it.
 */
async function timeIt(
    label: string,
    run: () => Promise<{ ok: boolean; rowCount?: number; timing?: { execMs: number }; reason?: string }>,
): Promise<Timing> {
    const ms: number[] = [];
    let rows = 0;
    let refused: string | null = null;
    for (let i = 0; i < REPEATS; i++) {
        const res = await run();
        if (!res.ok) { refused = res.reason ?? 'refused'; break; }
        ms.push(res.timing?.execMs ?? 0);
        rows = res.rowCount ?? 0;
    }
    return { label, ms, rows, refused };
}

async function main(): Promise<void> {
    // A device with a full complement of interfaces, chosen from real ones.
    // Any live device will do here - this only needs an id to bench against,
    // so the lane and the busy list are the trivial ones.
    const devices = await OPS.duePollTargets(1, 'live', CONFIG.pollDownAfter, []);
    const deviceId = devices.ok && devices.rows[0] ? devices.rows[0].id : '10000';

    console.log('last-value columns: measured, not inherited');
    console.log(`  repeats ${REPEATS}, device ${deviceId}, fleet scope entity_id >= ${REAL_FROM}`);
    console.log('');

    // --- the read, per device ------------------------------------------------
    const perDeviceSamples = await timeIt('per device, from samples',
        () => OPS.latestFromSamples(deviceId));
    const perDeviceEntities = await timeIt('per device, from last-value columns',
        () => OPS.latestFromEntities(deviceId));

    // --- the read, whole fleet: what /api/devices actually needs -------------
    const fleetSamples = await timeIt('whole fleet, from samples',
        () => OPS.fleetLatestFromSamples(REAL_FROM));
    const fleetEntities = await timeIt('whole fleet, from last-value columns',
        () => OPS.fleetLatestFromEntities(REAL_FROM));

    // --- at the ceiling: 30,000 fixture entities over the 92GB corpus --------
    //
    // The mock fleet's 2,160 entities are below the scale at which either shape
    // hurts, and the question is how they SCALE. The seeded fixture is the only
    // thing on this box at the design ceiling.
    if (process.env.SKIP_FIXTURE !== '1') {
        const filled = await OPS.backfillFixtureLastValues(40_000);
        if (filled.ok) console.log(`\n  (populated lv_* for ${Number(filled.rows[0]?.n ?? 0).toLocaleString()} fixture entities)`);
    }
    const fixtureSamples = await timeIt('30k entities, from samples',
        () => OPS.fixtureLatestFromSamples());
    const fixtureUnbounded = await timeIt('30k entities, from samples (jobs lane, no timeout)',
        () => OPS.fixtureLatestFromSamplesUnbounded());
    const fixtureLateral = await timeIt('30k entities, samples via LATERAL (best query)',
        () => OPS.fixtureLatestLateral());
    const fixtureEntities = await timeIt('30k entities, from last-value columns',
        () => OPS.fixtureLatestFromEntities());

    const rows = [
        perDeviceSamples, perDeviceEntities, fleetSamples, fleetEntities,
        fixtureSamples, fixtureUnbounded, fixtureLateral, fixtureEntities,
    ].map(summarise);
    console.log('  read shape                                        p50      min      max    rows');
    for (const r of rows) {
        if (r.refused !== null) {
            console.log(`  ${r.label.padEnd(46)} REFUSED: ${r.refused}`);
            continue;
        }
        console.log(`  ${r.label.padEnd(46)} ${String(r.p50).padStart(7)}ms `
            + `${String(r.min).padStart(6)}ms ${String(r.max).padStart(6)}ms ${String(r.rows).padStart(7)}`);
    }

    const dev = (rows[0] as { p50: number }).p50 / Math.max(0.01, (rows[1] as { p50: number }).p50);
    const fleet = (rows[2] as { p50: number }).p50 / Math.max(0.01, (rows[3] as { p50: number }).p50);
    const ceiling = (rows[5] as { p50: number }).p50 / Math.max(0.01, (rows[7] as { p50: number }).p50);
    const vsLateral = (rows[6] as { p50: number }).p50 / Math.max(0.01, (rows[7] as { p50: number }).p50);
    console.log('');
    console.log(`  per device: last-value is ${dev.toFixed(1)}x faster`);
    console.log(`  whole fleet: last-value is ${fleet.toFixed(1)}x faster`);
    const breached = (rows[4] as { refused: string | null }).refused;
    if (breached !== null) {
        console.log(`  AT THE CEILING the samples read is REFUSED by the interactive lane (${breached}).`);
        console.log('  That is not a slow read, it is a read that cannot be served to a dashboard.');
    }
    console.log(`  AT THE CEILING vs DISTINCT ON: last-value is ${ceiling.toFixed(0)}x faster`);
    console.log(`  AT THE CEILING vs the BEST samples query (LATERAL): last-value is ${vsLateral.toFixed(1)}x faster`);

    console.log('');
    console.log('  The write cost is measured separately, by running the collector with');
    console.log('  LAST_VALUE_WRITES=1 and =0 and comparing collector poll time and the');
    console.log('  collector lane. A read benchmark alone would answer half the question.');

    await closeAll();
}

main().catch((err) => {
    console.error('lastvalue-bench failed:', err);
    void closeAll();
    process.exit(1);
});
