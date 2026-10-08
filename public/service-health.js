// The Dashboard's Service health, its PURE half (2026-10-07,
// SLICE-SERVICE-VIEWS-PLAN part A): from /api/dashboard/services' rows and
// the open alerts the page already holds, the counts per kind, the sites
// table and the web/TCP table. No DOM, no fetch - app.js draws what this
// decides, and tools/test-service-health.ts asserts the decisions against
// this same file (parse.js's rule: anything pure that wants a test comes
// out).
//
// A check's state is the ALERT's when it has one raised - the engine has
// already applied the thresholds, overrides and mutes, and a second reading
// of them here would be a second rule. Without one: a run that did not come
// back ok is failing (amber for a path test, whose no-answer alert warns,
// as its card is), and anything not running or not recent is idle.

export const KIND_ORDER = ['path-voice', 'path-tput', 'svc-http', 'svc-tcp'];
export const KIND_LABEL = { 'path-voice': 'Voice', 'path-tput': 'Bandwidth', 'svc-http': 'Web', 'svc-tcp': 'TCP' };
const RANK = { fail: 3, warn: 2, idle: 1, ok: 0 };
export const stateRank = (s) => RANK[s] ?? 0;

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** Raised alerts by check code: the worst severity, and the rule kinds
 *  raised (path-mos, path-loss, ...) so a cell can say which reading it is. */
export function alertsByCode(open) {
    const by = new Map();
    for (const a of open || []) {
        if (a.state !== 'active' && a.state !== 'clearing') continue;
        if (!a.code) continue;
        const cur = by.get(a.code) || { sev: null, kinds: new Set() };
        if (a.severity === 'crit' || (a.severity === 'warn' && cur.sev !== 'crit')) cur.sev = a.severity;
        if (a.kind) cur.kinds.add(a.kind);
        by.set(a.code, cur);
    }
    return by;
}

/** One check: ok, warn, fail or idle, with the words for why. */
export function checkState(c, alerts) {
    if (!c.tracked) return { state: 'idle', why: 'paused' };
    if (!c.lv_ts) return { state: 'idle', why: 'not run yet' };
    const k = c.check || {};
    if (!k.fresh) return { state: 'idle', why: 'no run lately' };
    if (k.outcome === 'busy') return { state: 'idle', why: 'responder busy' };
    const a = alerts.get(c.code);
    if (a && a.sev === 'crit') return { state: 'fail', why: k.outcome === 'ok' ? 'alerting' : (k.text || 'failing') };
    if (k.outcome !== 'ok') {
        const path = c.kind === 'path-voice' || c.kind === 'path-tput';
        const soft = k.outcome === 'wrong-content' || k.outcome === 'too-large';
        return { state: path || soft ? 'warn' : 'fail', why: k.text || 'no verdict' };
    }
    if (a && a.sev === 'warn') return { state: 'warn', why: 'alerting' };
    return { state: 'ok', why: 'ok' };
}

/** How many checks of each kind are ok, warning, failing and idle - the
 *  kinds present only, in KIND_ORDER. */
export function kindCounts(checks, alerts) {
    const out = new Map();
    for (const c of checks) {
        if (!KIND_LABEL[c.kind]) continue;
        const row = out.get(c.kind) || { kind: c.kind, label: KIND_LABEL[c.kind], ok: 0, warn: 0, fail: 0, idle: 0 };
        row[checkState(c, alerts).state]++;
        out.set(c.kind, row);
    }
    return KIND_ORDER.filter((k) => out.has(k)).map((k) => out.get(k));
}

const ok = (c) => c.check?.outcome === 'ok';
const prevOk = (c) => num(c.prev_v5) === 0;

function voiceOf(c, alerts) {
    const s = checkState(c, alerts);
    const mos = ok(c) ? num(c.lv_v4) : null;
    const prev = prevOk(c) ? num(c.prev_v4) : null;
    const lows = [num(c.min_v4), mos].filter((v) => v !== null);
    const l0 = num(c.lv_v0), l1 = num(c.lv_v1), j0 = num(c.lv_v2), j1 = num(c.lv_v3);
    return {
        code: c.code, name: c.name, ...s, lastTs: c.lv_ts,
        mos, mosPrev: prev, mosDelta: mos !== null && prev !== null ? mos - prev : null,
        low24: lows.length > 0 ? Math.min(...lows) : null,
        loss: ok(c) && l0 !== null && l1 !== null ? Math.max(l0, l1) : null,
        lossDir: l0 !== null && l1 !== null ? (l1 > l0 ? 'from' : 'to') : null,
        jitter: ok(c) && j0 !== null && j1 !== null ? Math.max(j0, j1) : null,
        jitterDir: j0 !== null && j1 !== null ? (j1 > j0 ? 'from' : 'to') : null,
        alertKinds: alerts.get(c.code)?.kinds ?? new Set(),
    };
}

function tputOf(c, alerts) {
    const s = checkState(c, alerts);
    const to = ok(c) ? num(c.lv_v0) : null, from = ok(c) ? num(c.lv_v1) : null;
    const pTo = prevOk(c) ? num(c.prev_v0) : null, pFrom = prevOk(c) ? num(c.prev_v1) : null;
    const pct = (now, before) => (now !== null && before !== null && before > 0 ? (now - before) / before * 100 : null);
    const dTo = pct(to, pTo), dFrom = pct(from, pFrom);
    // The direction that moved most is the one worth naming.
    let delta = null, deltaDir = null;
    if (dTo !== null || dFrom !== null) {
        if (dFrom === null || (dTo !== null && Math.abs(dTo) >= Math.abs(dFrom))) { delta = dTo; deltaDir = 'to'; }
        else { delta = dFrom; deltaDir = 'from'; }
    }
    const lows = [num(c.min_v0), num(c.min_v1), to, from].filter((v) => v !== null);
    return {
        code: c.code, name: c.name, ...s, lastTs: c.lv_ts, mode: c.extra?.mode ?? null,
        to, from, delta, deltaDir, low24: lows.length > 0 ? Math.min(...lows) : null,
        loadedMs: ok(c) ? num(c.lv_v2) : null, efMs: ok(c) ? num(c.lv_v3) : null, idleMs: ok(c) ? num(c.lv_v4) : null,
        alertKinds: alerts.get(c.code)?.kinds ?? new Set(),
    };
}

/** The worse of two tests of one kind: by state, then by the reading. */
function worse(a, b, reading) {
    if (stateRank(a.state) !== stateRank(b.state)) return stateRank(a.state) > stateRank(b.state) ? a : b;
    const ra = reading(a), rb = reading(b);
    if (ra === null) return b;
    if (rb === null) return a;
    return ra <= rb ? a : b;
}

/**
 * THE SITES TABLE, one row per device with voice or throughput tests (the
 * operator's ruling: voice and bandwidth side by side). A device with two
 * tests of one kind shows the worse and counts the rest. Worst first: by
 * the row's worst state, then the lowest MOS, then the name.
 */
export function siteRows(checks, alerts) {
    const by = new Map();
    for (const c of checks) {
        if (c.kind !== 'path-voice' && c.kind !== 'path-tput') continue;
        const row = by.get(c.device) || { device: c.device, location: c.location ?? null, voice: null, voiceMore: 0, tput: null, tputMore: 0 };
        if (c.kind === 'path-voice') {
            const v = voiceOf(c, alerts);
            if (row.voice) row.voiceMore++;
            row.voice = row.voice ? worse(row.voice, v, (x) => x.mos) : v;
        } else {
            const t = tputOf(c, alerts);
            if (row.tput) row.tputMore++;
            row.tput = row.tput ? worse(row.tput, t, (x) => (x.to === null || x.from === null ? null : Math.min(x.to, x.from))) : t;
        }
        by.set(c.device, row);
    }
    const rows = [...by.values()].map((r) => {
        const states = [r.voice?.state, r.tput?.state].filter(Boolean);
        const lasts = [r.voice?.lastTs, r.tput?.lastTs].filter(Boolean).map((t) => Date.parse(t));
        return {
            ...r,
            state: states.reduce((w, s) => (stateRank(s) > stateRank(w) ? s : w), 'ok'),
            lastTs: lasts.length > 0 ? new Date(Math.max(...lasts)).toISOString() : null,
        };
    });
    return rows.sort((a, b) => stateRank(b.state) - stateRank(a.state)
        || (a.voice?.mos ?? 99) - (b.voice?.mos ?? 99)
        || String(a.device).localeCompare(String(b.device)));
}

/** THE WEB AND TCP TABLE: one row per check, worst first, then by name. */
export function serviceRows(checks, alerts) {
    return checks
        .filter((c) => c.kind === 'svc-http' || c.kind === 'svc-tcp')
        .map((c) => {
            const s = checkState(c, alerts);
            const cert = c.kind === 'svc-http' ? num(c.lv_v2) : null;
            return {
                code: c.code, device: c.device, name: c.name, kind: c.kind, ...s, lastTs: c.lv_ts,
                ms: ok(c) ? num(c.lv_v0) : null, status: num(c.lv_status), certDays: cert,
                availability: c.runs > 0 ? c.ok_runs / c.runs * 100 : null, runs: c.runs,
            };
        })
        .sort((a, b) => stateRank(b.state) - stateRank(a.state) || String(a.name).localeCompare(String(b.name)));
}
