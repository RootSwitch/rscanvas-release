// Pure threshold evaluation: (a scan document, config) -> conditions.
//
// PORTED FROM alertcanvas/server/rules.js, 2026-07-27, step 2 of the slice 6
// merge.
//
// THE TRIAGE HAD THIS WRONG and the correction is worth stating, because it
// changes what the merge costs. `SLICE-6-PLAN.md` filed `rules.js` under
// assumptions 2 and 6 - SQL inline, and JSON-file transport - implying a
// rewrite against the store. It has **no `require` at all**: 378 lines of pure
// evaluation, no I/O, no database, no clock. What depended on the JSON feed was
// never this module; it was `scanner.js`, which BUILT the document. So the
// engine is a free move and the adapter is the work, which is the opposite of
// how it was sized.
//
// No I/O, no DB, no clock - everything arrives as an argument, which is what
// makes the whole alerting brain testable against a fixture. Keeping that
// property is the point of porting it unchanged rather than "improving" it into
// something that reads the store itself.
//
// --- what differs from the parent, exhaustively -------------------------------
//
//   1. TYPES ADDED throughout. No behaviour change.
//   2. `levelSeverity` returns a typed tuple rather than a bare array.
//   3. SCOPE: `explain()` and `evaluatePing()` are NOT ported yet, deliberately.
//      `explain` powers the Watching view, which is UI that does not exist here
//      until the frontend lands. `evaluatePing` is PingCanvas integration, and
//      BUILD-PLAN puts ping at slice 9 - porting it now would be code with no
//      caller, which is exactly what this merge is avoiding. Both are pure and
//      port the same way when their consumers arrive.
//
// Nothing else differs. The arithmetic, the branch order, the freeze rules and
// the label construction are the parent's, and `tools/test-rules.ts` proves it
// by running the parent's own JavaScript against this over generated documents.
//
// --- the behaviour worth not losing -------------------------------------------
//
// FROZEN IS THE THIRD STATE, and it is the thing AlertCanvas got right that
// this fork arrived at later and less completely. A condition is `crit`, `warn`,
// `null` (normal), OR `frozen`. Frozen means NO EVIDENCE EITHER WAY, so the
// caller advances neither the breach counter nor the clear counter.
//
// It is used in three distinct places, each deliberate:
//
//   * A value that is null or not finite. Counters settling after a restart are
//     not a reading of "normal".
//   * Every interface and metric belonging to a device that is DOWN. Freezing
//     rather than reporting normal is what stops an interface alarm that
//     predates the outage from clearing itself while the device is unreachable.
//   * An interface whose admin or oper status is unknown.
//
// That is the freeze-rather-than-age-out property: an alarm that was true when
// its input was last good does not silently become "resolved" because the input
// went away. Ageing it out would say "fixed" when the truth is "unknown", which
// is the same class as a health check reading absent data as healthy.

/** Kinds where a LOW value is the problem: battery %, runtime, uptime. */
export const LOWER_IS_BAD = new Set(['battery', 'runtime', 'uptime']);

export const METRIC_KINDS = [
    'cpu', 'mem', 'disk', 'temp', 'fan', 'power', 'util',
    'battery', 'runtime', 'outlet', 'uptime', 'meter', 'state',
] as const;

export type Severity = 'crit' | 'warn';

/** One watched thing on one scan. */
export interface Condition {
    key: string;
    /** null means currently normal - the caller needs those to advance clear counters. */
    severity: Severity | null;
    /** No evidence either way: advance NEITHER breach nor clear counters. */
    frozen: boolean;
    kind: string;
    host: string | null;
    code: string | null;
    label: string;
    value: number | null;
    threshold: number | null;
    unit: string;
}

export interface Levels { warn: number | null; crit: number | null }
export interface BoolRule { enabled?: boolean; severity?: Severity }

export interface Override {
    /**
     * code      one entity, by its stable code
     * host-kind every entity of one kind on one device
     * kind      every entity of one kind, everywhere - a DEFAULT expressed as
     *           data. Added 2026-08-19 so "temperature alerts off" is a row an
     *           operator can see and delete, not a code change.
     */
    scope: 'code' | 'host-kind' | 'kind';
    code?: string | null;
    host?: string | null;
    kind: string;
    warn?: number | null;
    crit?: number | null;
    severity?: Severity;
    enabled?: boolean;
}

export interface RulesConfig {
    thresholds: Record<string, Levels | null>;
    ifRules: {
        down: BoolRule;
        errors: Levels | null;
        discards: Levels | null;
        util: Levels | null;
    };
    deviceDown: BoolRule;
    overrides?: Override[];
}

export interface ScanDevice {
    name?: string | null; host?: string | null; status?: string | null;
    /** Quiet 2 (slice 25): the operator declared offline a STATE for this
     *  device, so device-down never raises. Absent means false - older
     *  feeds and the interface-embedded device blocks predate the flag. */
    transient?: boolean | null;
}
export interface ScanInterface {
    id?: string | null;
    code?: string | null;
    name?: string | null;
    alias?: string | null;
    device?: ScanDevice | null;
    adminStatus?: string | null;
    operStatus?: string | null;
    speedBps?: number | null;
    inBps?: number | null;
    outBps?: number | null;
    inErrorsPerSec?: number | null;
    outErrorsPerSec?: number | null;
    inDiscardsPerSec?: number | null;
    outDiscardsPerSec?: number | null;
}
export interface ScanMetric {
    code?: string | null;
    host?: string | null;
    kind: string;
    value?: number | null;
    unit?: string | null;
    display?: string | null;
}
export interface ScanDoc {
    devices?: ScanDevice[];
    interfaces?: ScanInterface[];
    metrics?: ScanMetric[];
}

export interface OverrideIndex { byCode: Map<string, Override>; byHostKind: Map<string, Override>; byKind: Map<string, Override> }

export function buildOverrideIndex(overrides: Override[] | undefined): OverrideIndex {
    const byCode = new Map<string, Override>();
    const byHostKind = new Map<string, Override>();
    const byKind = new Map<string, Override>();
    for (const o of overrides || []) {
        if (o.scope === 'code' && o.code) byCode.set(`${o.code}|${o.kind}`, o);
        else if (o.scope === 'host-kind' && o.host) byHostKind.set(`${o.host}|${o.kind}`, o);
        else if (o.scope === 'kind') byKind.set(o.kind, o);
    }
    return { byCode, byHostKind, byKind };
}

/**
 * The {warn, crit} pair for one leveled target.
 *
 * null levels means nothing to evaluate: muted, disabled, or no rule at all.
 * The three are distinguished for the Watching view, which is why the `Info`
 * form exists separately from the plain one.
 */
export function resolveLevelsInfo(
    idx: OverrideIndex, defaults: Levels | null | undefined,
    code: string | null, host: string | null, kind: string,
): { levels: Levels | null; source: string; muted: boolean } {
    const o = idx.byCode.get(`${code}|${kind}`) || idx.byHostKind.get(`${host}|${kind}`) || idx.byKind.get(kind);
    if (o) {
        const source = o.scope === 'code' ? 'override' : o.scope === 'host-kind' ? 'host override' : 'kind override';
        if (!o.enabled) return { levels: null, source, muted: true };
        if (o.warn == null && o.crit == null) return { levels: null, source, muted: false };
        return { levels: { warn: o.warn ?? null, crit: o.crit ?? null }, source, muted: false };
    }
    if (!defaults || (defaults.warn == null && defaults.crit == null)) {
        return { levels: null, source: 'none', muted: false };
    }
    return { levels: { warn: defaults.warn ?? null, crit: defaults.crit ?? null }, source: 'default', muted: false };
}

function resolveLevels(
    idx: OverrideIndex, defaults: Levels | null | undefined,
    code: string | null, host: string | null, kind: string,
): Levels | null {
    return resolveLevelsInfo(idx, defaults, code, host, kind).levels;
}

function resolveBoolInfo(
    idx: OverrideIndex, defaults: BoolRule | null | undefined,
    code: string | null, host: string | null, kind: string,
): { rule: { severity: Severity } | null; source: string; muted: boolean } {
    const o = idx.byCode.get(`${code}|${kind}`) || idx.byHostKind.get(`${host}|${kind}`) || idx.byKind.get(kind);
    if (o) {
        const source = o.scope === 'code' ? 'override' : o.scope === 'host-kind' ? 'host override' : 'kind override';
        if (!o.enabled) return { rule: null, source, muted: true };
        return {
            rule: { severity: o.severity || (defaults && defaults.severity) || 'crit' },
            source, muted: false,
        };
    }
    if (!defaults || !defaults.enabled) return { rule: null, source: 'none', muted: false };
    return { rule: { severity: defaults.severity || 'crit' }, source: 'default', muted: false };
}

function resolveBool(
    idx: OverrideIndex, defaults: BoolRule | null | undefined,
    code: string | null, host: string | null, kind: string,
): { severity: Severity } | null {
    return resolveBoolInfo(idx, defaults, code, host, kind).rule;
}

function levelSeverity(
    kind: string, value: number, levels: Levels,
): [Severity | null, number | null] {
    if (LOWER_IS_BAD.has(kind)) {
        if (levels.crit != null && value <= levels.crit) return ['crit', levels.crit];
        if (levels.warn != null && value <= levels.warn) return ['warn', levels.warn];
        return [null, levels.warn ?? levels.crit];
    }
    if (levels.crit != null && value >= levels.crit) return ['crit', levels.crit];
    if (levels.warn != null && value >= levels.warn) return ['warn', levels.warn];
    return [null, levels.warn ?? levels.crit];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** "UPS1-Load 5%" -> "UPS1-Load", falling back to the kind. */
function metricName(m: ScanMetric): string {
    if (m.display) {
        const cut = String(m.display).replace(/\s+[-\d.].*$/, '').trim();
        if (cut) return cut;
    }
    return m.kind;
}

/**
 * "<host> <name>", plus the rule kind when the name does not already say it.
 *
 * "compute-01 GPU (util)" tells you WHICH threshold bucket fired, where a bare
 * "compute-01 GPU" reads as noise. Skipped when redundant: CPU/cpu, Batt/battery.
 */
function metricLabel(m: ScanMetric): string {
    const name = metricName(m);
    const n = name.toLowerCase();
    const k = String(m.kind).toLowerCase();
    const redundant = n.startsWith(k) || k.startsWith(n);
    return `${m.host} ${name}${redundant ? '' : ` (${m.kind})`}`;
}

function ifLabel(i: ScanInterface): string {
    const dev = (i.device && i.device.name) || String(i.id || '').split(':')[0];
    return `${dev} ${i.name}${i.alias ? ` (${i.alias})` : ''}`;
}

export function evaluate(doc: ScanDoc, config: RulesConfig): Condition[] {
    const idx = buildOverrideIndex(config.overrides);
    const out: Condition[] = [];

    // --- device down (deduped per host; suppresses that device's other rules) --
    //
    // Preferred source is the feed's devices[] roster, which lists every device
    // with ANY tracked value - so a sensor-only VM or a UPS gets up/down alarms
    // too. Older feeds have no roster, and the interface entries' embedded
    // device blocks fill in, covering only devices that export an interface.
    const downDevices = new Set<string>();
    const transientDown = new Set<string>();
    const seenDevices = new Set<string>();
    const deviceRule = (name?: string | null, host?: string | null, status?: string | null,
        transient?: boolean | null): void => {
        if (!name || seenDevices.has(name)) return;
        seenDevices.add(name);
        const rule = resolveBool(idx, config.deviceDown, null, name, 'device-down');
        if (!rule) return;   // muted: no alarm, and its metrics evaluate normally
        const isDown = status === 'down';
        // An earlier version of this comment ruled that a transient device
        // going away "still freezes its interface and metric rules below,
        // because no evidence either way is true regardless of WHY the
        // device is not answering". That ruling was REVERSED 2026-09-01
        // (DECISIONS-2026-09-01 ruling 4), from the operator's own fleet:
        // six devices marked transient, four still carrying if-down crits,
        // one open since 08-28. The declaration's meaning - quiet 2's own
        // words below - is that this device's absence "is not a fault", and
        // that claim extends to everything the absent device would
        // otherwise be testifying about. So a transient device that is DOWN
        // quiets its interfaces and metrics the same way it quiets its own
        // device-down: severity null, not frozen, and open alerts clear
        // through the ordinary counters. A NIC that drops while the device
        // is PRESENT still alerts - that half is information, and it is the
        // half the ruling deliberately kept.
        if (isDown) downDevices.add(name);
        if (isDown && transient === true) transientDown.add(name);
        // Quiet 2 (slice 25): for a declared-transient device, down emits
        // severity null - the watchdog's healthy pattern - so an alert that
        // was open when the operator flipped the flag clears through the
        // ordinary counters. Not frozen, not absent: null severity is an
        // active claim of "this is not a fault", which is exactly what the
        // declaration means.
        out.push({
            key: `device:${name}`,
            severity: isDown && transient !== true ? rule.severity : null, frozen: false,
            kind: 'device-down', host: name, code: null,
            label: `${name} (${host || '?'}) device`,
            value: null, threshold: null, unit: '',
        });
    };
    if (Array.isArray(doc.devices)) {
        for (const d of doc.devices || []) deviceRule(d && d.name, d && d.host, d && d.status, d && d.transient);
    }
    for (const i of doc.interfaces || []) {
        const d = i.device || {};
        deviceRule(d.name || String(i.id || '').split(':')[0], d.host, d.status, d.transient);
    }

    // --- interfaces ---
    for (const i of doc.interfaces || []) {
        if (!i || !i.code) continue;   // no stable key - nothing to alert on
        const dev = (i.device && i.device.name) || String(i.id || '').split(':')[0];
        const label = ifLabel(i);

        // A down device already alerted above. Do not pile on per-interface
        // alerts whose real cause is the device - FREEZE instead of reporting
        // normal, so an interface alert that predates the device outage does
        // not clear while the device is unreachable.
        //
        // Unless the device is DECLARED TRANSIENT (ruling 4): its absence is
        // expected behaviour, so its interfaces are quieted rather than
        // frozen - the same severity-null claim quiet 2 makes for the device
        // itself - and an if-down raised while a roaming laptop's NIC was
        // present clears when the laptop leaves instead of paging across a
        // week of declared-expected absence.
        if (downDevices.has(dev)) {
            const quiet = transientDown.has(dev);
            for (const aspect of ['down', 'errors', 'discards', 'util']) {
                out.push({
                    key: `if:${i.code}:${aspect}`, severity: null, frozen: !quiet,
                    kind: `if-${aspect}`, host: dev, code: i.code, label: `${label} ${aspect}`,
                    value: null, threshold: null, unit: '',
                });
            }
            continue;
        }

        const downRule = resolveBool(idx, config.ifRules.down, i.code, dev, 'if-down');
        if (downRule) {
            const known = i.operStatus !== 'unknown' && i.adminStatus !== 'unknown';
            const isDown = i.adminStatus === 'up' && i.operStatus !== 'up';
            out.push({
                key: `if:${i.code}:down`, severity: known && isDown ? downRule.severity : null,
                frozen: !known,
                kind: 'if-down', host: dev, code: i.code, label: `${label} link`,
                value: null, threshold: null, unit: '',
            });
        }

        const rates: Array<[string, string, number, string]> = [
            ['errors', 'if-errors', Math.max(i.inErrorsPerSec ?? -1, i.outErrorsPerSec ?? -1), 'pps'],
            ['discards', 'if-discards', Math.max(i.inDiscardsPerSec ?? -1, i.outDiscardsPerSec ?? -1), 'pps'],
        ];
        for (const [aspect, kind, worst, unit] of rates) {
            const levels = resolveLevels(
                idx, config.ifRules[aspect as 'errors' | 'discards'], i.code, dev, kind);
            if (!levels) continue;
            // Null rates (counters settling) AND garbage non-numbers both
            // freeze - neither is evidence of normal.
            const frozen = !Number.isFinite(worst) || worst < 0;
            const [sev, thr] = frozen ? [null, null] : levelSeverity(kind, worst, levels);
            out.push({
                key: `if:${i.code}:${aspect}`, severity: sev, frozen,
                kind, host: dev, code: i.code, label: `${label} ${aspect}`,
                value: frozen ? null : round2(worst), threshold: thr, unit,
            });
        }

        const utilLevels = resolveLevels(idx, config.ifRules.util, i.code, dev, 'if-util');
        if (utilLevels && (i.speedBps ?? 0) > 0) {
            const worstBps = Math.max(i.inBps ?? -1, i.outBps ?? -1);
            const frozen = !Number.isFinite(worstBps) || worstBps < 0;
            const pct = frozen ? null : (worstBps * 100) / (i.speedBps as number);
            const [sev, thr] = frozen ? [null, null] : levelSeverity('if-util', pct as number, utilLevels);
            out.push({
                key: `if:${i.code}:util`, severity: sev, frozen,
                kind: 'if-util', host: dev, code: i.code, label: `${label} utilization`,
                value: frozen ? null : round2(pct as number), threshold: thr, unit: '%',
            });
        }
    }

    // --- host metrics ---
    for (const m of doc.metrics || []) {
        if (!m || !m.code) continue;                        // no stable key
        if (!(METRIC_KINDS as readonly string[]).includes(m.kind)) continue;  // future kinds: ignore until configured
        const levels = resolveLevels(idx, config.thresholds[m.kind], m.code, m.host ?? null, m.kind);
        if (!levels) continue;
        if (downDevices.has(m.host ?? '')) {
            // Transient-down quiets metrics too, UNIFORMLY with interfaces
            // (ruling 4): two different absence behaviours on one
            // declared-transient device would be a rule enforced in one
            // place and not another. A CPU alert raised while the laptop
            // was present clears on departure - the incident survives in
            // Recently Cleared and re-raises on return if still true.
            // Non-transient devices keep freeze-on-down exactly as before:
            // a dead switch must never auto-clear its alerts.
            out.push({
                key: `metric:${m.code}`, severity: null,
                frozen: !transientDown.has(m.host ?? ''),
                kind: m.kind, host: m.host ?? null, code: m.code,
                label: metricLabel(m),
                value: null, threshold: null, unit: m.unit || '',
            });
            continue;
        }
        const frozen = typeof m.value !== 'number' || !Number.isFinite(m.value);
        const [sev, thr] = frozen ? [null, null] : levelSeverity(m.kind, m.value as number, levels);
        out.push({
            key: `metric:${m.code}`, severity: sev, frozen,
            kind: m.kind, host: m.host ?? null, code: m.code,
            label: metricLabel(m),
            value: frozen ? null : round2(m.value as number), threshold: thr, unit: m.unit || '',
        });
    }

    return out;
}

export interface Reboot { code: string; host: string | null; from: number; to: number }

/**
 * An uptime metric whose value went BACKWARDS since the previous scan.
 *
 * Pure: the caller owns persisting the previous values. The 30s guard absorbs
 * sampling jitter, since the reading and its timestamp are not taken at the
 * same instant. Note that sysUpTime wraps at about 497 days, which is
 * indistinguishable from a reboot.
 */
export function detectReboots(prev: Map<string, number>, metrics: ScanMetric[]): Reboot[] {
    const out: Reboot[] = [];
    for (const m of metrics || []) {
        if (!m || m.kind !== 'uptime' || !m.code) continue;
        // Only a real number counts. Number(null) is 0 and Number('') is 0, so
        // an unreadable uptime must not be allowed to look like a reboot.
        if (typeof m.value !== 'number' || !Number.isFinite(m.value)) continue;
        const v = m.value;
        const p = prev.get(m.code);
        if (p != null && v < p - 30) out.push({ code: m.code, host: m.host ?? null, from: p, to: v });
    }
    return out;
}
