// The scan tick: the store's last values -> rules -> the state machine ->
// persisted transitions and events owed.
//
// This is the fork's version of AlertCanvas's tick(), with one structural
// difference that simplifies everything downstream: THE FEED IS THE STORE.
// The parent read snmp-status.json written by another process, so half its
// scanner was feed hygiene - BOM stripping, shape checks, clock-skewed
// staleness. Here the collector writes lv_* columns in the same database, so
// "is the feed alive" collapses to "has the collector polled recently", one
// question the roster query answers.
//
// What is deliberately KEPT from the parent's hygiene, because it is about
// truth rather than transport:
//
//   * THE WATCHDOG CONDITION. "All quiet" and "not looking" must never look
//     the same, so a collector that stops writing raises an alert through the
//     same machinery as everything else - which also means it CLEARS through
//     that machinery when polling resumes, rather than needing special-case
//     recovery code.
//   * THE FREEZE-BEFORE-AGE RULE. An alert whose source is missing only ages
//     toward source-removed while the collector itself is HEALTHY. A dead
//     collector must not auto-clear a live outage: absence of evidence is
//     only evidence of absence when someone was looking.
//   * STALE RATES ARE NOT READINGS. lv_* older than three poll intervals maps
//     to null, so rules freeze on it. Three is the parent's multiplier.
//   * ALERT TRUTH SURVIVES SAMPLE EXPIRY. Evaluation reads the lv_* columns
//     on entities and never touches samples_* - retention may drop every raw
//     partition without changing what is alerting. This is a PROPERTY the
//     machine depends on, not an accident of implementation: test-scan proves
//     the whole lifecycle (raise, clear, freeze, age) against an entity with
//     zero samples rows, so a refactor that makes evaluation read samples_*
//     fails a test that names the property.
//
// Dispatch is NOT here. The scan persists what is owed (notified_raise /
// notified_clear false) and returns the events; the notify module drains that
// queue and owns delivery, retry and backoff. The split means a scan is never
// blocked by a slow SMTP server, and an alert raised while notify was broken
// still notifies when it recovers - the queue is the database, not memory.
//
// The claim above was true at THIS altitude and false one level up for the
// whole life of the jobs worker: dispatch and retryPass ran inside the same
// runOnce slot as scanTick, so a dead relay's serial timeouts stalled every
// subsequent scan anyway (2026-09-01 review). The jobs worker now runs
// 'alerts:notify' as its own job - a module split that is not carried into
// the SCHEDULING is only half a split.

import { CONFIG } from '../config.ts';
import { OPS, type AlertRecord } from '../store/index.ts';
import { isGhostInterface } from './ghosts.ts';
import { mergeOverrides } from './overrides.ts';
import {
    evaluate, type Condition, type RulesConfig, type ScanDoc, type ScanInterface,
    type ScanMetric,
} from './rules.ts';
import {
    step, stepMissing, dedupeConditions,
    type AlertRow, type AlertEventType, type MachineConfig,
} from './machine.ts';

/**
 * The parent's shipped defaults, carried verbatim (alertcanvas/server/db.js).
 * Only the interface and device rules are exercised until the collector polls
 * more than interfaces; the metric thresholds sit ready for when it does.
 */
export const DEFAULT_RULES: RulesConfig = {
    thresholds: {
        cpu: { warn: 85, crit: 95 },
        mem: { warn: 85, crit: 95 },
        disk: { warn: 85, crit: 95 },
        temp: { warn: 45, crit: 55 },
        util: { warn: 70, crit: 90 },
        battery: { warn: 50, crit: 20 },
        runtime: { warn: 600, crit: 300 },
        fan: null,
        power: null,
        outlet: null,
        uptime: null,
        meter: null,
        state: { warn: null, crit: 1 },
    },
    ifRules: {
        down: { enabled: true, severity: 'crit' },
        errors: { warn: 1, crit: 10 },
        discards: { warn: 5, crit: 50 },
        util: { warn: 80, crit: 95 },
    },
    deviceDown: { enabled: true, severity: 'crit' },
    overrides: [],
};

/**
 * Rules config: defaults, with ALERT_RULES_JSON merged over them. Parsed ONCE
 * at module load and invalid JSON THROWS - the operator who set it believes
 * those thresholds are live, and silently alerting on defaults instead is the
 * "wrong answer cost" failure, not a robustness feature.
 */
export function loadRulesConfig(): RulesConfig {
    if (CONFIG.alertRulesJson.trim() === '') return DEFAULT_RULES;
    let parsed: Partial<RulesConfig>;
    try {
        parsed = JSON.parse(CONFIG.alertRulesJson) as Partial<RulesConfig>;
    } catch (err) {
        throw new Error(`ALERT_RULES_JSON is not valid JSON: ${(err as Error).message}`);
    }
    return {
        thresholds: { ...DEFAULT_RULES.thresholds, ...parsed.thresholds },
        ifRules: { ...DEFAULT_RULES.ifRules, ...parsed.ifRules },
        deviceDown: parsed.deviceDown ?? DEFAULT_RULES.deviceDown,
        overrides: parsed.overrides ?? [],
    };
}

/** SNMP status integers to the feed's words. 1 is up; null is not a reading. */
const statusWord = (s: number | null): string =>
    s === null ? 'unknown' : s === 1 ? 'up' : 'down';

export interface ScanEvent { type: AlertEventType; alertId: string; key: string }

export interface ScanResult {
    devices: number;
    interfaces: number;
    conditions: number;
    open: number;
    events: ScanEvent[];
    collectorHealthy: boolean;
}

const machineCfg = (): MachineConfig => ({
    raiseScans: CONFIG.alertRaiseScans,
    clearScans: CONFIG.alertClearScans,
    missingScans: CONFIG.alertMissingScans,
});

/** AlertRecord (snake_case, store) -> AlertRow (camelCase, machine). */
function toMachineRow(r: AlertRecord): AlertRow {
    return {
        id: r.id,
        alertKey: r.alert_key,
        state: r.state,
        severity: r.severity,
        kind: r.kind,
        host: r.host,
        code: r.code,
        label: r.label,
        value: r.value,
        peakValue: r.peak_value,
        threshold: r.threshold,
        unit: r.unit,
        breachCount: r.breach_count,
        clearCount: r.clear_count,
        missingCount: r.missing_count,
        firstBreachTs: r.first_breach_ts,
        raisedTs: r.raised_ts,
        escalatedTs: r.escalated_ts,
        clearedTs: r.cleared_ts,
        lastSeenTs: r.last_seen_ts,
        clearReason: r.clear_reason,
    };
}

// Every 'update' action from one scan, written as ONE statement at the end of
// the pass rather than one transaction per alert as it goes. This cannot be a
// skip: a breaching alert's value and last_seen_ts genuinely change every scan
// (last_seen_ts IS what the missing machinery reads for liveness), so the
// per-alert form was 171 real transactions a second - the third of the three
// write paths measured on 2026-08-10. Batching changes the transaction count
// and nothing else: same rows, same values, same scan-fails-loudly semantics,
// just at the pass boundary instead of mid-pass.
async function persistBatch(rows: AlertRow[]): Promise<void> {
    if (rows.length === 0) return;
    const r = await OPS.updateAlertStatesBatch({
        ids: rows.map((x) => x.id!),
        states: rows.map((x) => x.state),
        severities: rows.map((x) => x.severity),
        labels: rows.map((x) => x.label),
        values: rows.map((x) => x.value),
        peakValues: rows.map((x) => x.peakValue),
        thresholds: rows.map((x) => x.threshold),
        units: rows.map((x) => x.unit),
        breachCounts: rows.map((x) => x.breachCount),
        clearCounts: rows.map((x) => x.clearCount),
        missingCounts: rows.map((x) => x.missingCount),
        raisedTs: rows.map((x) => x.raisedTs),
        escalatedTs: rows.map((x) => x.escalatedTs),
        clearedTs: rows.map((x) => x.clearedTs),
        lastSeenTs: rows.map((x) => x.lastSeenTs),
        clearReasons: rows.map((x) => x.clearReason),
    });
    if (!r.ok) throw new Error(`alert batch update refused (${r.reason}, ${rows.length} row(s))`);
}

/**
 * One scan. Not wrapped in a transaction, deliberately, and the reasoning is
 * owed here: each alert's write is self-contained, the jobs worker's runOnce
 * guarantees no second scan overlaps, and dedupeConditions() prevents the
 * duplicate-key rollback that forced the parent's transaction in the first
 * place. A crash mid-scan leaves some alerts one scan ahead of others, which
 * the next tick converges - whereas one transaction around N round trips
 * would hold jobs-lane locks for the whole walk.
 */
export async function scanTick(now = new Date()): Promise<ScanResult> {
    // ENV FIRST, TABLE WINS. loadRulesConfig is the env var parsed as it
    // always was; the table's rows are merged over it so a row the operator
    // saved on the page beats a JSON value they set months ago. Read every
    // scan on the alerts lane - one small query - so a change on the page is
    // live within one scan interval with no reload message. A refused read
    // falls back to the env config and SAYS so, rather than silently
    // evaluating with stale rows; that would be the "wrong answer cost"
    // failure the env parser already refuses to commit.
    let cfg = loadRulesConfig();
    const rows = await OPS.thresholdOverrides('alerts');
    if (rows.ok) cfg = mergeOverrides(cfg, rows.rows);
    else console.warn(`[scan] threshold_overrides unreadable (${rows.reason}) - evaluating with env/default thresholds this scan`);
    const mCfg = machineCfg();

    const devices = await OPS.alertScanDevices();
    if (!devices.ok) throw new Error(`lane refused the device roster (${devices.reason})`);
    const ifaces = await OPS.alertScanInterfaces();
    if (!ifaces.ok) throw new Error(`lane refused the interface view (${ifaces.reason})`);
    const sensors = await OPS.alertScanSensors();
    if (!sensors.ok) throw new Error(`lane refused the sensor view (${sensors.reason})`);

    // The collector's own health, judged FROM THE DATA, never from CONFIG.
    // Three cases, and the discrimination between the first two is the point -
    // the decision/mistake split applied to the roster, the same one the
    // half-configured SMTP channel got:
    //
    //   NO enabled devices     a decision. Healthy-but-idle: nothing to watch
    //                          is not a fault on a fresh install. This is the
    //                          ONLY silent form of not-watching; the decision
    //                          to stop monitoring is expressed by emptying the
    //                          roster, not by switching the collector off
    //                          while devices stay armed - that partial state
    //                          falls through to the fault cases below, which
    //                          is why COLLECTOR_ENABLED is deliberately not
    //                          consulted here.
    //   enabled, NONE polled   A FAULT. The roster query filters unpolled
    //                          devices out, so used alone this case read as
    //                          the one above - a monitoring system watching
    //                          nothing, reporting green. The coverage op
    //                          exists to make it visible.
    //   polled but STALE       a fault, as before.
    //
    // ALL AGES COME FROM POSTGRES (poll_age_s, computed against the same
    // now() that stamped the poll). The previous version compared the jobs
    // worker's JS clock against Postgres timestamps: with the app clock
    // AHEAD, every age inflates and the collector reads stale forever -
    // permanently raising the watchdog AND freezing stepMissing aging via
    // mayAge; with it BEHIND, a dead collector reads fresh. One clock, the
    // database's, because it is the one both sides can see.
    const coverage = await OPS.alertScanCoverage();
    if (!coverage.ok) throw new Error(`lane refused the coverage counts (${coverage.reason})`);
    const cov = coverage.rows[0] ?? { enabled_total: 0, polled_total: 0 };

    let collectorHealthy = true;
    let watchdogLabel = 'collector';
    if (cov.enabled_total === 0) {
        watchdogLabel = 'collector (idle - no devices registered)';
    } else if (cov.polled_total === 0) {
        collectorHealthy = false;
        watchdogLabel = `collector has NEVER POLLED any of ${cov.enabled_total} enabled device(s) - `
            + 'watching nothing while reporting green is the fault this alarm exists for';
    } else if (devices.rows.some((d) => d.snmp_enabled)) {
        // POLLED DEVICES ONLY (slice 35). A ping-only device has no
        // last_poll_ts, so its poll_age_s is null - and null through
        // Math.min becomes 0, which would report the freshest possible
        // collector on a fleet that is not being polled at all. The watchdog
        // that exists to catch a dead collector would have been silenced by
        // adding an ISP to the wall.
        const polled = devices.rows.filter((d) => d.snmp_enabled);
        const youngest = Math.min(...polled.map((d) => d.poll_age_s));
        const widest = Math.max(...polled.map((d) => d.poll_interval_s), 30);
        const limitS = Math.max(3 * widest, 120);
        if (youngest > limitS) {
            collectorHealthy = false;
            watchdogLabel = `collector - newest poll is ${youngest}s old, limit ${limitS}s`;
        }
    }

    const doc: ScanDoc = {
        devices: devices.rows.map((d) => ({
            name: d.name, host: d.host, status: d.status, transient: d.transient,
        })),
        // THE GHOST GATE (src/alerts/ghosts.ts): a row whose went-quiet
        // stamp outlived the horizon leaves the doc entirely, so its
        // conditions go missing and the missing-scans counter retires its
        // alerts as source-removed - the terminal state the freeze rule
        // lacked. Filtered here, not in SQL, so the boundary is a pure
        // function a test can hold.
        interfaces: ifaces.rows.filter((i) => !isGhostInterface(
            i.lv_stale_since, Date.now(), CONFIG.alertStaleHorizonMin * 60_000,
        )).map((i): ScanInterface => ({
            code: i.code,
            name: i.name,
            alias: i.alias,
            device: { name: i.device_name, host: i.device_host, status: i.device_status },
            adminStatus: statusWord(i.fresh ? i.admin_status : null),
            operStatus: statusWord(i.fresh ? i.lv_status : null),
            speedBps: i.speed_bps,
            // Stale rates are not readings: null freezes the rule rather than
            // testifying that the traffic stopped.
            inBps: i.fresh ? i.lv_v0 : null,
            outBps: i.fresh ? i.lv_v1 : null,
            inErrorsPerSec: i.fresh ? i.lv_v2 : null,
            outErrorsPerSec: i.fresh ? i.lv_v3 : null,
            inDiscardsPerSec: i.fresh ? i.lv_v4 : null,
            outDiscardsPerSec: i.fresh ? i.lv_v5 : null,
        })),
        // THE METRICS ARRAY, FED AT LAST. AlertCanvas's engine has carried
        // metric thresholds since slice 6 - the kinds, the levels, the
        // lower-is-bad set for battery and runtime, the frozen third state,
        // the label construction - with `metrics: []` hard-coded beneath it
        // because nothing in this fork collected a sensor. The sensors slice
        // collects them; this line is the whole of "sensor thresholds".
        //
        // That is the tell the fix landed at the right level: no new
        // machinery, an EXISTING mechanism finally applying.
        //
        // A stale reading passes value NULL rather than its last number, and
        // evaluate() freezes on a non-finite value - so a sensor nobody has
        // heard from advances neither the breach nor the clear counter,
        // exactly as a stale interface rate does.
        metrics: sensors.rows.map((s): ScanMetric => ({
            code: s.code,
            host: s.device_name,
            kind: s.kind,
            value: s.fresh ? s.value : null,
            unit: s.unit,
            display: s.name,
        })),
    };

    const conditions = evaluate(doc, cfg);

    // The watchdog rides the same machinery as every real alert: raised by
    // the counters, cleared by the counters, visible in history. Severity
    // null while healthy keeps an earlier alarm clearing normally.
    conditions.push({
        key: 'watchdog:collector',
        severity: collectorHealthy ? null : 'crit',
        frozen: false,
        kind: 'watchdog',
        host: null,
        code: null,
        label: watchdogLabel,
        value: null,
        threshold: null,
        unit: '',
    });

    const collapsed = dedupeConditions(conditions);

    const openRes = await OPS.openAlerts();
    if (!openRes.ok) throw new Error(`lane refused the open set (${openRes.reason})`);
    // EVENT ROWS NEVER ENTER THE MACHINE. They are born active by the ingest
    // path and cleared by TTL (clearEventAlertsTtl below); no condition ever
    // reproduces them, so if they reached this map stepMissing would read
    // "no condition this scan" and age them out - the scan fighting the TTL,
    // with whichever ran last winning. Slice 10's whole design rests on the
    // edge-versus-standing-condition boundary; this filter is that boundary
    // in code.
    const open = new Map<string, AlertRecord>(
        openRes.rows.filter((r) => r.kind !== 'event').map((r) => [r.alert_key, r]));

    const events: ScanEvent[] = [];
    const toPersist: AlertRow[] = [];

    for (const c of collapsed) {
        const rec = open.get(c.key);
        open.delete(c.key);
        const act = step(rec === undefined ? null : toMachineRow(rec), c, mCfg, now);

        if (act.action === 'none') continue;
        if (act.action === 'delete') {
            // WRITE-IN-LOOP-OK: a state TRANSITION, not a per-scan write - a
            // pending alert lapsing fires once per lapse. Steady-state rate
            // ~0; the sustained 171/s was the update path, now batched below.
            const r = await OPS.deleteAlert(act.row.id!);
            if (!r.ok) throw new Error(`alert delete refused (${r.reason})`);
            continue;
        }
        if (act.action === 'insert') {
            // WRITE-IN-LOOP-OK: a state TRANSITION - fires once per NEW
            // breach, not per scan, and the RETURNING id feeds the event it
            // may emit. Burst-bounded by transitions per scan (the fault
            // window's worst is tens), not by fleet size.
            const r = await OPS.insertAlert({
                alertKey: act.row.alertKey,
                state: act.row.state,
                severity: act.row.severity,
                kind: act.row.kind,
                host: act.row.host,
                code: act.row.code,
                label: act.row.label,
                value: act.row.value,
                peakValue: act.row.peakValue,
                threshold: act.row.threshold,
                unit: act.row.unit,
                breachCount: act.row.breachCount,
                firstBreachTs: act.row.firstBreachTs,
                raisedTs: act.row.raisedTs,
                lastSeenTs: act.row.lastSeenTs,
            });
            if (!r.ok) throw new Error(`alert insert refused (${r.reason})`);
            const stored = r.rows[0];
            if (act.event !== null && stored !== undefined) {
                events.push({ type: act.event, alertId: stored.id, key: act.row.alertKey });
            }
            continue;
        }
        toPersist.push(act.row);
        if (act.event !== null) {
            events.push({ type: act.event, alertId: act.row.id!, key: act.row.alertKey });
        }
    }

    // Anything still open had NO condition this scan: its source left the
    // roster. Aging is gated on collector health - the freeze-before-age rule.
    if (collectorHealthy) {
        for (const rec of open.values()) {
            const act = stepMissing(toMachineRow(rec), mCfg, now);
            if (act.action === 'delete') {
                // WRITE-IN-LOOP-OK: a state TRANSITION - an alert aging out
                // fires once, not per scan.
                const r = await OPS.deleteAlert(rec.id);
                if (!r.ok) throw new Error(`alert delete refused (${r.reason})`);
                continue;
            }
            if (act.action === 'update') {
                toPersist.push(act.row);
                if (act.event !== null) {
                    events.push({ type: act.event, alertId: rec.id, key: rec.alert_key });
                }
            }
        }
    }

    // The whole pass's updates, one statement. Ordering note that matters: an
    // alert appears at most ONCE per scan (step consumes it from `open`, and
    // stepMissing only sees what step never touched), so the batch cannot
    // carry two rows for one id and last-write-wins never arises.
    await persistBatch(toPersist);

    // The event-alert TTL, gated on INGEST liveness rather than
    // collectorHealthy - the per-source freeze scoping the slice-10 design
    // named as the trap to avoid (a stale SNMP collector must not freeze the
    // clearing of syslog-sourced alarms, and a dead syslog feed must not
    // CLEAR them either: silence is not evidence the pattern stopped). The
    // gate lives inside the statement; a frozen pass clears nothing and
    // costs one query.
    const ttlRes = await OPS.clearEventAlertsTtl();
    if (!ttlRes.ok) throw new Error(`event TTL clear refused (${ttlRes.reason})`);

    return {
        devices: devices.rows.length,
        interfaces: ifaces.rows.length,
        conditions: collapsed.length,
        open: openRes.rows.length,
        events,
        collectorHealthy,
    };
}
