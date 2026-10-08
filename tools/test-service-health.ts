// The Dashboard's Service health, its decisions (2026-10-07,
// SLICE-SERVICE-VIEWS-PLAN part A): public/service-health.js, imported as
// shipped (the dom.js argument - a copy cannot rot in the same direction as
// the original). The operator's rulings it holds: one row per site with
// voice and bandwidth side by side, web and TCP in their own table, each
// against the run before and the day's low.
//
//   node tools/test-service-health.ts

const {
    alertsByCode, checkState, kindCounts, siteRows, serviceRows,
} = await import('../public/service-health.js' as string) as {
    alertsByCode: (open: unknown[]) => Map<string, { sev: string | null; kinds: Set<string> }>;
    checkState: (c: Row, alerts: Map<string, unknown>) => { state: string; why: string };
    kindCounts: (checks: Row[], alerts: Map<string, unknown>) => Array<Record<string, unknown>>;
    siteRows: (checks: Row[], alerts: Map<string, unknown>) => Array<Record<string, any>>;
    serviceRows: (checks: Row[], alerts: Map<string, unknown>) => Array<Record<string, any>>;
};

// An early exit without a verdict must read as FAILURE (the test-walk incident).
process.exitCode = 1;

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};
const near = (l: string, got: number | null, want: number): void => {
    if (got !== null && Math.abs(got - want) < 1e-9) ok(l); else bad(l, `got ${got}, wanted ${want}`);
};

type Row = Record<string, unknown>;
const NOW = new Date().toISOString();
const okCheck = { outcome: 'ok', text: 'ok', fresh: true };
function row(over: Row): Row {
    return {
        code: 'C', kind: 'path-voice', name: 'n', tracked: true, extra: {}, outside: false, device: 'd', location: null,
        lv_ts: NOW, lv_status: null, lv_v0: null, lv_v1: null, lv_v2: null, lv_v3: null, lv_v4: null, lv_v5: 0,
        prev_ts: null, prev_v0: null, prev_v1: null, prev_v2: null, prev_v3: null, prev_v4: null, prev_v5: null,
        runs: 0, ok_runs: 0, min_v0: null, min_v1: null, max_v0: null, max_v1: null, max_v2: null, max_v3: null, min_v4: null,
        check: okCheck, ...over,
    };
}
const voice = (over: Row) => row({ kind: 'path-voice', lv_v0: 0, lv_v1: 0.5, lv_v2: 2, lv_v3: 9, lv_v4: 4.3, ...over });
const tput = (over: Row) => row({ kind: 'path-tput', extra: { mode: 'headroom' }, lv_v0: 200, lv_v1: 150, lv_v2: 30, lv_v3: 3, lv_v4: 20, ...over });
const none = alertsByCode([]);

console.log('service health\n');

console.log('alerts, by check:');
{
    const a = alertsByCode([
        { code: 'A', kind: 'path-loss', severity: 'warn', state: 'active' },
        { code: 'A', kind: 'path-mos', severity: 'crit', state: 'clearing' },
        { code: 'A', kind: 'path-jitter', severity: 'warn', state: 'active' },
        { code: 'B', kind: 'path-mos', severity: 'crit', state: 'pending' },
        { code: null, kind: 'device-down', severity: 'crit', state: 'active' },
    ]);
    eq('the worst raised severity wins, and every raised rule is named',
        [a.get('A')?.sev, [...(a.get('A')?.kinds ?? [])].sort()], ['crit', ['path-jitter', 'path-loss', 'path-mos']]);
    eq('a pending alert has not raised, so it does not colour anything', a.has('B'), false);
    eq('an alert with no code is not a check\'s', a.size, 1);
}

console.log('\none check\'s state:');
{
    const st = (c: Row, al = none) => checkState(c, al).state;
    eq('paused, never run, and stale are idle, before anything else',
        [st(voice({ tracked: false })), st(voice({ lv_ts: null })), st(voice({ check: { ...okCheck, fresh: false } }))], ['idle', 'idle', 'idle']);
    eq('a busy responder is idle - a gap, not a fault', st(voice({ check: { outcome: 'busy', text: 'busy', fresh: true } })), 'idle');
    eq('a web check that did not come back is failing',
        st(row({ kind: 'svc-http', lv_v5: 1, check: { outcome: 'timeout', text: 'no answer in time', fresh: true } })), 'fail');
    eq('the wrong content is serving, not well: warning',
        st(row({ kind: 'svc-http', check: { outcome: 'wrong-content', text: 'x', fresh: true } })), 'warn');
    eq('a path test with no answer warns, as its card and its alert do',
        st(voice({ check: { outcome: 'refused', text: 'refused', fresh: true } })), 'warn');
    const warned = alertsByCode([{ code: 'C', kind: 'path-mos', severity: 'warn', state: 'active' }]);
    const crit = alertsByCode([{ code: 'C', kind: 'path-mos', severity: 'crit', state: 'active' }]);
    eq('an ok run with a warning raised is a warning - the engine has applied the thresholds', st(voice({}), warned), 'warn');
    eq('...and with a critical raised, failing', st(voice({}), crit), 'fail');
    eq('an ok run with nothing raised is ok', st(voice({})), 'ok');
}

console.log('\nthe counts:');
{
    const checks = [
        voice({ code: 'v1' }), voice({ code: 'v2', tracked: false }), tput({ code: 't1' }),
        row({ code: 'h1', kind: 'svc-http', check: { outcome: 'timeout', text: 'x', fresh: true } }),
        row({ code: 'h2', kind: 'svc-http' }),
    ];
    eq('by kind, voice then bandwidth then web, the kinds present only', kindCounts(checks, none), [
        { kind: 'path-voice', label: 'Voice', ok: 1, warn: 0, fail: 0, idle: 1 },
        { kind: 'path-tput', label: 'Bandwidth', ok: 1, warn: 0, fail: 0, idle: 0 },
        { kind: 'svc-http', label: 'Web', ok: 1, warn: 0, fail: 1, idle: 0 },
    ]);
}

console.log('\nthe sites table - one row per site, voice and bandwidth side by side:');
{
    const checks = [
        voice({ code: 'v-a', device: 'Branch A', location: 'Kearney', lv_v4: 3.42, prev_v4: 4.03, prev_v5: 0, min_v4: 2.94 }),
        tput({ code: 't-a', device: 'Branch A', lv_v0: 200, lv_v1: 143, prev_v0: 200, prev_v1: 162.5, prev_v5: 0, min_v0: 199, min_v1: 120 }),
        voice({ code: 'v-b', device: 'Branch B', lv_v4: 4.4, prev_v4: 4.4, prev_v5: 0 }),
        tput({ code: 't-c', device: 'Branch C' }),
        row({ code: 'h', kind: 'svc-http', device: 'Branch A' }),
    ];
    const rows = siteRows(checks, none);
    eq('three sites, the web check not among them', rows.map((r) => r.device).sort(), ['Branch A', 'Branch B', 'Branch C']);
    const a = rows.find((r) => r.device === 'Branch A')!;
    eq('Branch A carries both tests, and its location', [a.voice?.code, a.tput?.code, a.location], ['v-a', 't-a', 'Kearney']);
    near('MOS against the run before', a.voice.mosDelta, 3.42 - 4.03);
    eq('the 24 h low is the day\'s minimum', a.voice.low24, 2.94);
    eq('the worse direction of loss and jitter, named', [a.voice.loss, a.voice.lossDir, a.voice.jitter, a.voice.jitterDir], [0.5, 'from', 9, 'from']);
    near('throughput against the run before: the direction that moved most', a.tput.delta, (143 - 162.5) / 162.5 * 100);
    eq('  and which one it was', a.tput.deltaDir, 'from');
    eq('Branch C has bandwidth and no voice', [rows.find((r) => r.device === 'Branch C')!.voice, rows.find((r) => r.device === 'Branch C')!.tput?.code], [null, 't-c']);
    eq('worst MOS first when nothing is alerting', rows.map((r) => r.device), ['Branch A', 'Branch B', 'Branch C']);

    const loud = alertsByCode([{ code: 't-c', kind: 'path-tput', severity: 'warn', state: 'active' }]);
    eq('...but an alerting site comes before a low MOS', siteRows(checks, loud).map((r) => r.device)[0], 'Branch C');
}

console.log('\nagainst the previous run, honestly:');
{
    const [r] = siteRows([voice({ lv_v4: 4.1, prev_v4: 4.3, prev_v5: 1 })], none);
    eq('a previous run that failed gives no comparison - not a comparison with nothing', r.voice.mosDelta, null);
    const [s] = siteRows([voice({ lv_v4: 3.0, min_v4: 3.5 })], none);
    eq('the latest run counts toward the low even before its sample is flushed', s.voice.low24, 3.0);
    const [t] = siteRows([voice({ check: { outcome: 'refused', text: 'connection refused', fresh: true }, lv_v4: null, prev_v4: 4.3, prev_v5: 0 })], none);
    eq('a failed run shows no MOS and no comparison, and says why', [t.voice.mos, t.voice.mosDelta, t.voice.why], [null, null, 'connection refused']);
}

console.log('\ntwo tests of one kind on a site - the worse, and how many more:');
{
    const rows = siteRows([
        voice({ code: 'good', device: 'X', lv_v4: 4.4 }), voice({ code: 'bad', device: 'X', lv_v4: 3.2 }),
        tput({ code: 'fast', device: 'X', lv_v0: 900, lv_v1: 900 }), tput({ code: 'slow', device: 'X', lv_v0: 90, lv_v1: 300 }),
    ], none);
    eq('the lower MOS and the slower throughput are shown', [rows[0].voice.code, rows[0].tput.code], ['bad', 'slow']);
    eq('  with one more of each counted', [rows[0].voiceMore, rows[0].tputMore], [1, 1]);
    const warned = alertsByCode([{ code: 'good', kind: 'path-jitter', severity: 'warn', state: 'active' }]);
    eq('an alerting test is worse than a lower reading', siteRows([
        voice({ code: 'good', device: 'X', lv_v4: 4.4 }), voice({ code: 'bad', device: 'X', lv_v4: 3.9 }),
    ], warned)[0].voice.code, 'good');
}

console.log('\nthe web and TCP table:');
{
    const rows = serviceRows([
        row({ code: 'h1', kind: 'svc-http', name: 'Portal', device: 'web', lv_status: 200, lv_v0: 152.4, lv_v2: 41.6, runs: 288, ok_runs: 285 }),
        row({ code: 't1', kind: 'svc-tcp', name: 'DNS over TLS', device: 'edge', lv_v0: 27, lv_v2: 99, runs: 0 }),
        row({ code: 'h2', kind: 'svc-http', name: 'Vendor VPN', device: 'edge', lv_v5: 1, check: { outcome: 'timeout', text: 'no answer in time', fresh: true } }),
        voice({ code: 'v' }),
    ], none);
    eq('web and TCP only, failing first, then by name', rows.map((r) => r.code), ['h2', 't1', 'h1']);
    const portal = rows.find((r) => r.code === 'h1')!;
    near('availability is ok runs over runs in the 24 h', portal.availability, 285 / 288 * 100);
    eq('the certificate is a web check\'s only - v2 means something else on TCP',
        [portal.certDays, rows.find((r) => r.code === 't1')!.certDays], [41.6, null]);
    eq('no runs in the window is no availability, not 0%', rows.find((r) => r.code === 't1')!.availability, null);
    eq('a failing check has no response time to show', rows.find((r) => r.code === 'h2')!.ms, null);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
