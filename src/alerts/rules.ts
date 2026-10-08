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

/** Kinds where a LOW value is the problem: battery %, runtime, uptime - and
 *  a service check's certificate days (slice 58). */
export const LOWER_IS_BAD = new Set(['battery', 'runtime', 'uptime', 'svc-cert', 'path-mos', 'path-tput']);

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
    /** Service checks' yes/no rules (slice 58); their levelled ones live in
     *  thresholds under 'svc-ms' and 'svc-cert'. Absent means both on, crit. */
    services?: { down: BoolRule; content: BoolRule; pathDown?: BoolRule };
    overrides?: Override[];
}

export interface ScanDevice {
    name?: string | null; host?: string | null; status?: string | null;
    /** Quiet 2 (slice 25): the operator declared offline a STATE for this
     *  device, so device-down never raises. Absent means false - older
     *  feeds and the interface-embedded device blocks predate the flag. */
    transient?: boolean | null;
    /** Slice 54: the operator muted this device, so NOTHING of it raises -
     *  device-down, interfaces, sensors. Absent means false. */
    muted?: boolean | null;
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
/**
 * One service check as the scan read it (slice 58). Classified by the
 * caller from the stored outcome code, so this module keeps its property of
 * importing nothing: the engine judges, it does not decode.
 */
export interface ScanService {
    code?: string | null;
    /** The owning device's name. */
    host?: string | null;
    name?: string | null;
    /** Its last run is within three of its own intervals. */
    fresh?: boolean;
    /** No evidence either way: never run, or the prober's own failure. */
    unknown?: boolean;
    /** Why it is not serving, in words, or null when it is. */
    downReason?: string | null;
    /** It answered with something an assertion could judge. */
    answered?: boolean;
    /** It carries an assertion at all. */
    hasAssertion?: boolean;
    /** The assertion failed (or could not read the body); null when not judged. */
    contentFailed?: boolean | null;
    httpStatus?: number | null;
    totalMs?: number | null;
    /** The run before's response time, when it answered (2026-10-07). */
    prevTotalMs?: number | null;
    /** An https check: its certificate rule exists even on a run that never saw one. */
    tls?: boolean;
    certDays?: number | null;
    /** svc-http, svc-tcp, or path-voice (slice 60), which has rules of its own. */
    kind?: string;
    /** A voice test's last call, both ways; null when it did not run. */
    voice?: { lossTo: number; lossFrom: number; jitterTo: number; jitterFrom: number; mos: number | null } | null;
    /** A throughput test's last calls, Mbps each way; null when they did not run. */
    tput?: { mbpsTo: number; mbpsFrom: number } | null;
}
export interface ScanDoc {
    devices?: ScanDevice[];
    interfaces?: ScanInterface[];
    metrics?: ScanMetric[];
    services?: ScanService[];
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

/** The four rules every interface carries, in the engine's words. */
export const IF_RULE_KINDS = ['if-down', 'if-errors', 'if-discards', 'if-util'] as const;

/** The yes/no rules: no levels, so an override is on or off and nothing else.
 *  An ENABLED override of one is how a port alerts under a device-wide mute
 *  (manual link-down, 2026-10-02) - resolveBoolInfo already honoured it. */
export const BOOL_RULE_KINDS: ReadonlySet<string> = new Set(['if-down', 'device-down', 'svc-down', 'svc-content', 'path-down']);

/** The four rules a service check carries (slice 58): two yes/no, two levelled. */
export const SERVICE_RULE_KINDS = ['svc-down', 'svc-content', 'svc-ms', 'svc-cert'] as const;

/** The four a voice test carries (slice 60): no answer, and three readings. */
export const PATH_RULE_KINDS = ['path-down', 'path-loss', 'path-jitter', 'path-mos'] as const;

/** The two a throughput test carries (slice 61): no answer, and the rate. */
export const THROUGHPUT_RULE_KINDS = ['path-down', 'path-tput'] as const;

const SERVICE_BOOL_DEFAULT: BoolRule = { enabled: true, severity: 'crit' };
/** WARN, not crit: a responder that does not answer costs a MEASUREMENT, not a
 *  service - and the box it runs on has its own device-down alert, crit,
 *  if it is gone. */
const PATH_DOWN_DEFAULT: BoolRule = { enabled: true, severity: 'warn' };

/** What governs one target today: which tier, whether it is muted, and the
 *  levels when the kind has levels. */
export interface RuleInfo { source: string; muted: boolean; levels: Levels | null }

/**
 * THE RULE THAT GOVERNS ONE TARGET, for any kind evaluate() judges. The device
 * page and the alert detail both show provenance, and each used to pick its
 * own defaults: the alert detail skipped if-down entirely (a bool rule), so a
 * muted link alert never said MUTED, and the device page never resolved
 * interface rules at all. One function picks the same defaults evaluate()
 * picks for each kind and runs the same resolver, so neither surface can
 * disagree with the engine.
 *
 * A kind evaluate() ignores answers source 'none' even when an override row
 * names it: the engine skips such kinds, so calling the row live would be
 * the page promising something the scan never does.
 */
export function resolveRuleInfo(
    idx: OverrideIndex, config: RulesConfig, kind: string, code: string | null, host: string | null,
): RuleInfo {
    if (kind === 'if-down' || kind === 'device-down') {
        const b = resolveBoolInfo(idx, kind === 'if-down' ? config.ifRules.down : config.deviceDown, code, host, kind);
        return { source: b.source, muted: b.muted, levels: null };
    }
    if (kind === 'svc-down' || kind === 'svc-content') {
        const d = kind === 'svc-down' ? config.services?.down : config.services?.content;
        const b = resolveBoolInfo(idx, d ?? SERVICE_BOOL_DEFAULT, code, host, kind);
        return { source: b.source, muted: b.muted, levels: null };
    }
    if (kind === 'path-down') {
        const b = resolveBoolInfo(idx, config.services?.pathDown ?? PATH_DOWN_DEFAULT, code, host, kind);
        return { source: b.source, muted: b.muted, levels: null };
    }
    if (kind === 'svc-ms' || kind === 'svc-cert' || kind === 'path-loss' || kind === 'path-jitter' || kind === 'path-mos'
        || kind === 'path-tput') {
        const info = resolveLevelsInfo(idx, config.thresholds[kind], code, host, kind);
        return { source: info.source, muted: info.muted, levels: info.levels };
    }
    const defaults = kind === 'if-errors' ? config.ifRules.errors
        : kind === 'if-discards' ? config.ifRules.discards
            : kind === 'if-util' ? config.ifRules.util
                : (METRIC_KINDS as readonly string[]).includes(kind) ? config.thresholds[kind]
                    : undefined;
    const known = kind === 'if-errors' || kind === 'if-discards' || kind === 'if-util'
        || (METRIC_KINDS as readonly string[]).includes(kind);
    if (!known) return { source: 'none', muted: false, levels: null };
    const info = resolveLevelsInfo(idx, defaults, code, host, kind);
    return { source: info.source, muted: info.muted, levels: info.levels };
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
    // A MUTED DEVICE EMITS NO CONDITION OF ANY KIND (slice 54). Not a frozen
    // one, not a quiet one: absent, exactly as a muted interface's rule is
    // absent, so its open alerts go missing and retire as source-removed and
    // nothing new can raise. Collected before any rule runs because the
    // interface loop's embedded device blocks would otherwise reach
    // deviceRule for a device the roster feed has already said is muted.
    const mutedDevices = new Set<string>();
    for (const d of doc.devices || []) if (d && d.name && d.muted === true) mutedDevices.add(d.name);
    for (const i of doc.interfaces || []) {
        if (i && i.device && i.device.name && i.device.muted === true) mutedDevices.add(i.device.name);
    }
    const deviceRule = (name?: string | null, host?: string | null, status?: string | null,
        transient?: boolean | null): void => {
        if (!name || seenDevices.has(name)) return;
        seenDevices.add(name);
        if (mutedDevices.has(name)) return;
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
        if (mutedDevices.has(dev)) continue;
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
        if (mutedDevices.has(m.host ?? '')) continue;
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

    // --- service checks (slice 58) ---
    //
    // Four rules per check, each its own key so each can be muted on its own:
    // down (not serving), content (answering, wrong content - never "down",
    // the operator's ruling), response time, certificate days. The device's
    // own state governs them as it governs a sensor: muted emits nothing,
    // down FREEZES (the device's alert already says it, and an outside
    // service hung off an edge router must not page twenty times when the
    // router goes), transient-down quiets. A check with no recent run, or
    // whose prober failed, freezes too - no evidence is not "up".
    for (const s of doc.services || []) {
        if (!s || !s.code) continue;
        const host = s.host ?? null;
        if (mutedDevices.has(host ?? '')) continue;
        const code = s.code;
        const name = `${host} ${s.name ?? code}`;
        const noData = s.fresh !== true || s.unknown === true;

        // --- a throughput test (slice 61): no answer, and the rate ---
        // The rate rule has NO default: only the operator knows what a link
        // should carry, so it exists once they say (an override), and judges
        // the SLOWER direction, naming it.
        if (s.kind === 'path-tput') {
            const downR = resolveBool(idx, config.services?.pathDown ?? PATH_DOWN_DEFAULT, code, host, 'path-down');
            const rateLv = resolveLevels(idx, config.thresholds['path-tput'], code, host, 'path-tput');
            const frozenAll = downDevices.has(host ?? '') || noData;
            const quiet = !noData && transientDown.has(host ?? '');
            if (downR) {
                const reason = frozenAll ? null : s.downReason ?? null;
                out.push({
                    key: `svc:${code}:down`, severity: reason !== null ? downR.severity : null, frozen: frozenAll && !quiet,
                    kind: 'path-down', host, code, label: reason !== null ? `${name}: ${reason}` : name,
                    value: null, threshold: null, unit: '',
                });
            }
            if (rateLv) {
                const t = s.tput ?? null;
                if (frozenAll || t === null) {
                    out.push({ key: `svc:${code}:tput`, severity: null, frozen: !(frozenAll && quiet), kind: 'path-tput', host, code, label: `${name} throughput`, value: null, threshold: null, unit: 'Mbps' });
                } else {
                    const [v, dir] = t.mbpsFrom < t.mbpsTo ? [t.mbpsFrom, 'from the site'] : [t.mbpsTo, 'toward the site'];
                    const [sev, thr] = levelSeverity('path-tput', v, rateLv);
                    out.push({
                        key: `svc:${code}:tput`, severity: sev, frozen: false, kind: 'path-tput', host, code,
                        label: `${name} throughput ${dir}`, value: round2(v), threshold: thr, unit: 'Mbps',
                    });
                }
            }
            continue;
        }

        // --- a voice test (slice 60): no answer, loss, jitter, MOS ---
        // Loss and jitter are judged on the WORSE direction and the label
        // says which, since "4% lost" is half an answer to "where".
        if (s.kind === 'path-voice') {
            const downR = resolveBool(idx, config.services?.pathDown ?? PATH_DOWN_DEFAULT, code, host, 'path-down');
            const lossLv = resolveLevels(idx, config.thresholds['path-loss'], code, host, 'path-loss');
            const jitLv = resolveLevels(idx, config.thresholds['path-jitter'], code, host, 'path-jitter');
            const mosLv = resolveLevels(idx, config.thresholds['path-mos'], code, host, 'path-mos');
            const v = s.voice ?? null;
            const worse = (to: number, from: number): [number, string] => (from > to ? [from, 'from the site'] : [to, 'toward the site']);
            const rules: Array<[string, string, string, Levels | null, [number, string] | null]> = [];
            if (lossLv) rules.push([`svc:${code}:loss`, 'path-loss', '%', lossLv, v ? worse(v.lossTo, v.lossFrom) : null]);
            if (jitLv) rules.push([`svc:${code}:jitter`, 'path-jitter', 'ms', jitLv, v ? worse(v.jitterTo, v.jitterFrom) : null]);
            if (mosLv) rules.push([`svc:${code}:mos`, 'path-mos', '', mosLv, v && v.mos !== null ? [v.mos, 'worse direction'] : null]);
            const word: Record<string, string> = { 'path-loss': 'loss', 'path-jitter': 'jitter', 'path-mos': 'MOS' };
            if (downDevices.has(host ?? '') || noData) {
                const quiet = !noData && transientDown.has(host ?? '');
                if (downR) out.push({ key: `svc:${code}:down`, severity: null, frozen: !quiet, kind: 'path-down', host, code, label: name, value: null, threshold: null, unit: '' });
                for (const [key, kind, unit] of rules) {
                    out.push({ key, severity: null, frozen: !quiet, kind, host, code, label: `${name} ${word[kind]}`, value: null, threshold: null, unit });
                }
                continue;
            }
            if (downR) {
                const reason = s.downReason ?? null;
                out.push({
                    key: `svc:${code}:down`, severity: reason !== null ? downR.severity : null, frozen: false,
                    kind: 'path-down', host, code, label: reason !== null ? `${name}: ${reason}` : name,
                    value: null, threshold: null, unit: '',
                });
            }
            for (const [key, kind, unit, levels, reading] of rules) {
                // No call, no reading: a responder that did not answer (or
                // was busy) freezes these - path-down speaks for it.
                if (reading === null || !Number.isFinite(reading[0])) {
                    out.push({ key, severity: null, frozen: true, kind, host, code, label: `${name} ${word[kind]}`, value: null, threshold: null, unit });
                    continue;
                }
                const [sev, thr] = levelSeverity(kind, reading[0], levels as Levels);
                out.push({
                    key, severity: sev, frozen: false, kind, host, code,
                    label: kind === 'path-mos' ? `${name} ${word[kind]}` : `${name} ${word[kind]} ${reading[1]}`,
                    value: round2(reading[0]), threshold: thr, unit,
                });
            }
            continue;
        }

        const downRule = resolveBool(idx, config.services?.down ?? SERVICE_BOOL_DEFAULT, code, host, 'svc-down');
        const contentRule = s.hasAssertion === true
            ? resolveBool(idx, config.services?.content ?? SERVICE_BOOL_DEFAULT, code, host, 'svc-content') : null;
        const msLevels = resolveLevels(idx, config.thresholds['svc-ms'], code, host, 'svc-ms');
        const certLevels = s.tls === true ? resolveLevels(idx, config.thresholds['svc-cert'], code, host, 'svc-cert') : null;
        const keys: Array<[string, string, string, string]> = [];
        if (downRule) keys.push([`svc:${code}:down`, 'svc-down', name, '']);
        if (contentRule) keys.push([`svc:${code}:content`, 'svc-content', `${name} content`, '']);
        if (msLevels) keys.push([`svc:${code}:ms`, 'svc-ms', `${name} response time`, 'ms']);
        if (certLevels) keys.push([`svc:${code}:cert`, 'svc-cert', `${name} certificate`, 'days']);
        const noEvidence = s.fresh !== true || s.unknown === true;
        if (downDevices.has(host ?? '') || noEvidence) {
            const quiet = !noEvidence && transientDown.has(host ?? '');
            for (const [key, kind, label, unit] of keys) {
                out.push({ key, severity: null, frozen: !quiet, kind, host, code, label, value: null, threshold: null, unit });
            }
            continue;
        }
        if (downRule) {
            const reason = s.downReason ?? null;
            out.push({
                key: `svc:${code}:down`, severity: reason !== null ? downRule.severity : null, frozen: false,
                kind: 'svc-down', host, code, label: reason !== null ? `${name}: ${reason}` : name,
                value: s.httpStatus ?? null, threshold: null, unit: '',
            });
        }
        if (contentRule) {
            // Judged only on an answer: a service that is down says nothing
            // about its content, so the content rule freezes beside it.
            const judged = s.answered === true && s.contentFailed !== null && s.contentFailed !== undefined;
            out.push({
                key: `svc:${code}:content`, severity: judged && s.contentFailed === true ? contentRule.severity : null,
                frozen: !judged, kind: 'svc-content', host, code, label: `${name} content`,
                value: null, threshold: null, unit: '',
            });
        }
        if (msLevels) {
            // TWO SLOW RUNS IN A ROW (2026-10-07, the operator): one slow run
            // raised and cleared by itself - the lab's first day had two,
            // a 2.9 s Google and a 2.65 s DNS-over-TCP, each a message each
            // way. So the alert is the MILDER of this run and the one before:
            // warn needs both over warn, crit both over crit, and a run before
            // that did not answer (or none at all) starts no streak.
            const v = s.answered === true ? s.totalMs : null;
            const frozen = typeof v !== 'number' || !Number.isFinite(v);
            const prev = typeof s.prevTotalMs === 'number' && Number.isFinite(s.prevTotalMs) ? s.prevTotalMs : null;
            const [sev, thr] = frozen ? [null, null]
                : prev === null ? [null, levelSeverity('svc-ms', v as number, msLevels)[1]]
                    : levelSeverity('svc-ms', Math.min(v as number, prev), msLevels);
            out.push({
                key: `svc:${code}:ms`, severity: sev, frozen, kind: 'svc-ms', host, code,
                label: `${name} response time`, value: frozen ? null : round2(v as number), threshold: thr, unit: 'ms',
            });
        }
        if (certLevels) {
            const v = s.certDays;
            const frozen = typeof v !== 'number' || !Number.isFinite(v);
            const [sev, thr] = frozen ? [null, null] : levelSeverity('svc-cert', v as number, certLevels);
            out.push({
                key: `svc:${code}:cert`, severity: sev, frozen, kind: 'svc-cert', host, code,
                label: `${name} certificate`, value: frozen ? null : round2(v as number), threshold: thr, unit: 'days',
            });
        }
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
