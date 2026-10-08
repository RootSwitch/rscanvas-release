// Service checks (slice 58): the definition, the assertion menu, the
// outcome classification, the schedule, the alert rules - and the transport
// against REAL servers on the loopback, http and https, with certificates
// minted by openssl in a temp dir (no openssl is a FAIL, not a skip: the
// TLS half is half the reason this exists).
//
// The measured assertion is tcpcheck.ts's, carried over: checks start on a
// spacing and overlap, so a burst of checks against a server that never
// answers costs (N - 1) x spacing + ONE timeout, never N timeouts - timed
// here, not claimed.
//
//   node tools/test-service-checks.ts

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
    addressRefusal, assertionPasses, certDaysFrom, classifyNetError, classifyTlsAuth, codeExpected,
    classifyIperfError, defaultCheckName, firstDueMs, inWindow, IPERF_CLIENT_INTERRUPTED, isPublicAddress, jsonPathGet, median,
    mosEstimate, nextDueMs,
    OUTCOME, outcomeName, outsideVerdict, parseCheckDef, parseFpingTimes, parseIperfOneWay, parseIperfTcp, throughputCostS,
    throughputFits, voiceReading,
    parseCheckName, parseExpect, sampleOf, scheduleOffsetMs, storedDef,
    type HttpCheckDef, type TcpCheckDef, type ThroughputCheckDef, type VoiceCheckDef,
} from '../src/checks/model.ts';
import { PathGate, type Release } from '../src/checks/pathgate.ts';
import { _lookupsInFlightForTests, _setLookupForTests, runCheck } from '../src/checks/probe.ts';
import { CheckScheduler, type ScheduledCheck } from '../src/checks/scheduler.ts';
import { evaluate, resolveRuleInfo, buildOverrideIndex, type Condition, type RulesConfig } from '../src/alerts/rules.ts';
import { scanServiceOf, type ServiceRow } from '../src/alerts/services.ts';
import { DEFAULT_RULES } from '../src/alerts/scan.ts';
import { maxOutstanding, sweepDurationMs } from '../src/collector/tcpcheck.ts';

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

function http1(raw: Record<string, unknown>): HttpCheckDef {
    const r = parseCheckDef('svc-http', raw);
    if (!r.ok) throw new Error(`fixture refused: ${r.detail}`);
    return r.def as HttpCheckDef;
}

function definitions(): void {
    console.log('the definition:');
    const d = parseCheckDef('svc-http', { url: 'https://example.com/health' });
    eq('defaults: GET, 200-299, 60 s, 10 s, resolve, verify on, no assertion', d.ok ? d.def : d, {
        url: 'https://example.com/health', method: 'GET', expect: '200-299', intervalS: 60, timeoutS: 10,
        connect: 'resolve', verifyTls: true, assertion: null, outside: 'auto',
    });
    const refused = (l: string, kind: 'svc-http' | 'svc-tcp', raw: Record<string, unknown>, has: string): void => {
        const r = parseCheckDef(kind, raw);
        if (!r.ok && r.detail.includes(has)) ok(l); else bad(l, r);
    };
    refused('ftp is refused', 'svc-http', { url: 'ftp://example.com/' }, 'http and https');
    refused('a URL carrying a password is refused, not stripped', 'svc-http', { url: 'https://u:p@example.com/' }, 'in the clear');
    refused('a link-local literal is refused at add time', 'svc-http', { url: 'http://169.254.169.254/latest/meta-data' }, 'link-local');
    refused('so is an IPv6 link-local one', 'svc-http', { url: 'http://[fe80::1]/' }, 'link-local');
    refused('an interval under the 30 s floor', 'svc-http', { url: 'http://x.test/', intervalS: 10 }, 'interval');
    refused('a timeout as long as the interval', 'svc-http', { url: 'http://x.test/', intervalS: 30, timeoutS: 30 }, 'shorter');
    refused('HEAD with an assertion - no body to read', 'svc-http',
        { url: 'http://x.test/', method: 'HEAD', assertion: { type: 'contains', text: 'ok' } }, 'HEAD');
    refused('a JSON path that is an expression', 'svc-http',
        { url: 'http://x.test/', assertion: { type: 'json', path: 'items[0].ok', op: 'equals', values: ['true'] } }, 'dotted path');
    refused('equals with two values', 'svc-http',
        { url: 'http://x.test/', assertion: { type: 'json', path: 'a', op: 'equals', values: ['1', '2'] } }, 'exactly one');
    refused('a range written backwards', 'svc-http', { url: 'http://x.test/', expect: '299-200' }, 'backwards');
    refused('a TCP check needs a port', 'svc-tcp', {}, 'port');
    refused('a TCP check to a link-local host', 'svc-tcp', { host: '169.254.1.1', port: 80 }, 'link-local');
    eq('codes and ranges normalise', parseExpect(' 200 - 204 , 301 '), { ok: true, expect: '200-204,301' });
    eq('a code is expected inside a range, not outside it',
        [codeExpected('200-204,301', 204), codeExpected('200-204,301', 301), codeExpected('200-204,301', 302)], [true, true, false]);
    const t = parseCheckDef('svc-tcp', { port: '443' });
    eq('a TCP check with no host connects to the device', t.ok ? t.def : t, { host: null, port: 443, intervalS: 60, timeoutS: 10, outside: 'auto' });
    eq('a stored definition reads back as itself (the collector re-parses what main wrote)',
        storedDef('svc-http', JSON.parse(JSON.stringify(http1({ url: 'https://x.test/a?b=1', connect: 'pin' })))),
        http1({ url: 'https://x.test/a?b=1', connect: 'pin' }));
    eq('an unknown kind reads back as nothing to run', storedDef('svc-ftp', { url: 'x' }), null);
    eq('default names', [
        defaultCheckName('svc-http', http1({ url: 'https://login.example.com/' })),
        defaultCheckName('svc-http', http1({ url: 'http://x.test:8080/health', method: 'HEAD' })),
        defaultCheckName('svc-tcp', { host: null, port: 22, intervalS: 60, timeoutS: 5 } as TcpCheckDef),
    ], ['login.example.com', 'HEAD x.test:8080/health', 'TCP device:22']);
    const nm = parseCheckName('a\nb', 'x');
    if (!nm.ok) ok('a name with a line break is refused'); else bad('a control character got into a name');
}

function assertions(): void {
    console.log('\nthe assertion menu:');
    const body = JSON.stringify({ status: 'ok', checks: { db: { state: 'up' } }, items: [{ ok: true }], n: 3, gone: null });
    const a = (raw: Record<string, unknown>): boolean => {
        const def = http1({ url: 'http://x.test/', assertion: raw });
        return assertionPasses(def.assertion!, body);
    };
    eq('contains / absent', [a({ type: 'contains', text: '"ok"' }), a({ type: 'absent', text: 'degraded' }),
        a({ type: 'contains', text: 'degraded' })], [true, true, false]);
    eq('a dotted path walks objects and array indexes',
        [jsonPathGet(JSON.parse(body), 'checks.db.state'), jsonPathGet(JSON.parse(body), 'items.0.ok')], ['up', true]);
    eq('equals compares the text form: strings, numbers, booleans, null', [
        a({ type: 'json', path: 'status', op: 'equals', values: ['ok'] }),
        a({ type: 'json', path: 'n', op: 'equals', values: ['3'] }),
        a({ type: 'json', path: 'items.0.ok', op: 'equals', values: ['true'] }),
        a({ type: 'json', path: 'gone', op: 'equals', values: ['null'] }),
    ], [true, true, true, true]);
    eq('not-equals and one-of', [
        a({ type: 'json', path: 'status', op: 'not-equals', values: ['degraded'] }),
        a({ type: 'json', path: 'checks.db.state', op: 'one-of', values: ['up', 'ok'] }),
        a({ type: 'json', path: 'checks.db.state', op: 'one-of', values: ['down'] }),
    ], [true, true, false]);
    eq('a MISSING field fails even not-equals - absence supports no claim',
        a({ type: 'json', path: 'status.code', op: 'not-equals', values: ['x'] }), false);
    const def = http1({ url: 'http://x.test/', assertion: { type: 'json', path: 'status', op: 'equals', values: ['ok'] } });
    eq('a body that is not JSON fails a JSON assertion', assertionPasses(def.assertion!, '<html>ok</html>'), false);
    eq('a byte-order mark does not', assertionPasses(def.assertion!, '\ufeff{"status":"ok"}'), true);
    eq('__proto__ is not a field a path can reach', jsonPathGet({}, '__proto__'), undefined);
}

function classification(): void {
    console.log('\nwhat an outcome means:');
    eq('network errors', ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'ECONNRESET', 'EMFILE', 'HPE_INVALID']
        .map((c) => classifyNetError(c)), ['refused', 'timeout', 'unreachable', 'dns', 'reset', 'ours', 'error']);
    eq('certificate verdicts', ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SOMETHING_NEW'].map(classifyTlsAuth),
    ['tls-expired', 'tls-name', 'tls-untrusted', 'tls-untrusted', 'tls-error']);
    eq('address refusals', ['169.254.169.254', 'fe80::1', '::ffff:169.254.1.1', '0.0.0.0', '224.0.0.1', '10.0.0.1', '127.0.0.1', '::1']
        .map(addressRefusal).map((r) => r === null ? 'ok' : r.split(' ')[0]),
    ['link-local', 'link-local', 'link-local', 'unspecified', 'multicast', 'ok', 'ok', 'ok']);
    eq('outcome codes are frozen numbers - history written today reads the same next year',
        [OUTCOME.ok, OUTCOME['wrong-content'], OUTCOME.ours, outcomeName(10), outcomeName(98)], [0, 10, 99, 'wrong-content', null]);
    eq('the sample layout: v0 total, v1 connect, v2 cert days, v3 assertion, v4 lookup, v5 outcome', sampleOf({
        outcome: 'wrong-content', httpStatus: 200, totalMs: 120, connectMs: 30, dnsMs: 4, certDays: 41.5,
        assertion: 0, peer: '10.0.0.1', detail: '',
    }), { status: 200, rttMs: 120, v: [120, 30, 41.5, 0, 4, 10] });
    eq('certificate days from a notAfter, one decimal',
        certDaysFrom('Jan  2 00:00:00 2030 GMT', Date.parse('2030-01-01T00:00:00Z')), 1);

    console.log('\nwhat counts as outside (slice 59):');
    // The 192.168/16 example is built from its parts ON PURPOSE: the public
    // tree rewrites every literal 192.168 address into 192.0.2.x (TEST-NET-1,
    // which this function rightly calls public) and refuses any that remain,
    // so a literal here would test a different range there - and fail.
    const rfc1918c = ['192', '168', '1', '20'].join('.');
    eq('public addresses are outside; private, shared, loopback, link-local and multicast are not',
        ['20.190.151.68', '2606:4700::1111', '10.1.2.3', '172.20.0.1', rfc1918c, '100.100.1.1', '127.0.0.1',
            '169.254.1.1', '224.0.0.251', 'fd12::1', 'fe80::1', '::1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', 'not-an-ip'].map(isPublicAddress),
        [true, true, false, false, false, false, false, false, false, false, false, false, false, true, false]);
    eq('auto follows the address reached; yes and no are the operator saying so',
        [outsideVerdict('auto', '8.8.8.8'), outsideVerdict('auto', '10.0.0.1'), outsideVerdict('yes', '10.0.0.1'), outsideVerdict('no', '8.8.8.8')],
        [true, false, true, false]);
    eq('an auto run that reached no address cannot say - null, so the store keeps the last verdict',
        [outsideVerdict('auto', null), outsideVerdict('yes', null)], [null, true]);
    const bo = parseCheckDef('svc-http', { url: 'https://x.test/', outside: 'maybe' });
    eq('an outside setting that is not auto, yes or no is refused', bo.ok ? 'accepted' : bo.detail, 'outside is auto, yes or no');
    eq('a check stored before slice 59 reads back as auto',
        (storedDef('svc-tcp', { host: null, port: 22, intervalS: 60, timeoutS: 5 }) as TcpCheckDef).outside, 'auto');
}

function schedule(): void {
    console.log('\nthe schedule:');
    const iv = 60_000;
    const offs = ['AAAA', 'AAAB', 'K7QX', 'Z9Z9'].map((c) => scheduleOffsetMs(c, iv));
    eq('offsets are stable and inside the interval', offs.every((o) => o >= 0 && o < iv) && scheduleOffsetMs('AAAA', iv) === offs[0], true);
    eq('and different codes land in different places', new Set(offs).size, 4);
    eq('first due is the next grid point', firstDueMs(1_000_000, iv, 5_000), 1_025_000);
    eq('on the grid point itself, it is due now', firstDueMs(1_025_000, iv, 5_000), 1_025_000);
    eq('the next run is one interval on', nextDueMs(1_025_000, 1_030_000, iv, 5_000), 1_085_000);
    eq('late by more than an interval re-anchors - no catch-up burst', nextDueMs(1_025_000, 1_200_000, iv, 5_000), 1_205_000);

    let now = 1_000_000;
    const starts: Array<[string, number]> = [];
    const s = new CheckScheduler(20, () => now, (c, at) => { starts.push([c.code, at]); });
    const mk = (code: string, intervalS: number): ScheduledCheck => ({
        id: code, code, kind: 'svc-tcp', def: { host: null, port: 1, intervalS, timeoutS: 5 } as TcpCheckDef,
        deviceHost: '127.0.0.1', deviceName: 'd', name: code,
    });
    const set = [mk('C1', 60), mk('C2', 60), mk('C3', 60)];
    s.setChecks(set);
    now += 60_000;   // every check is due somewhere in the last minute
    s.tick();
    eq('three due checks start once each', starts.length, 3);
    const ats = starts.map(([, at]) => at);
    eq('spaced 20 ms apart, never together', ats.slice(1).map((a, i) => a - (ats[i] as number)), [20, 20]);
    now += 60_000;
    s.tick();
    eq('due again while still running: skipped and counted, never started twice', [starts.length, s.skippedInFlight], [3, 3]);
    for (const c of set) s.finished(c.code);
    now += 60_000;
    s.tick();
    eq('finished, they start again on the next grid point', starts.length, 6);
    for (const c of set) s.finished(c.code);
    const before = starts.length;
    s.setChecks([mk('C1', 60), mk('C2', 60), mk('C3', 60)]);
    s.tick();
    eq('a reload keeps each check on its grid - nothing re-fires', starts.length, before);
    s.setChecks([mk('C1', 60)]);
    eq('a removed check is gone', s.size, 1);
}

function rules(): void {
    console.log('\nthe alert rules:');
    const cfg: RulesConfig = DEFAULT_RULES;
    const row = (over: Partial<ServiceRow>): ServiceRow => ({
        code: 'SVC1', name: 'portal', kind: 'svc-http', has_assertion: true, tls: true,
        lv_status: 200, lv_v0: 120, lv_v1: null, lv_v2: 40, lv_v3: null, lv_v4: null, lv_v5: OUTCOME.ok,
        fresh: true, device_name: 'edge', prev_v0: 120, prev_v5: OUTCOME.ok, ...over,
    });
    const run = (r: ServiceRow, devices = [{ name: 'edge', host: '10.0.0.1', status: 'up' }] as Array<Record<string, unknown>>): Map<string, Condition> =>
        new Map(evaluate({ devices, services: [scanServiceOf(r)] }, cfg).filter((c) => c.kind.startsWith('svc-')).map((c) => [c.key.split(':')[2] as string, c]));
    const sev = (m: Map<string, Condition>): Record<string, string> =>
        Object.fromEntries([...m].map(([k, c]) => [k, c.frozen ? 'frozen' : (c.severity ?? 'normal')]));

    eq('a healthy https check with an assertion: four rules, all normal', sev(run(row({}))),
        { down: 'normal', content: 'normal', ms: 'normal', cert: 'normal' });
    eq('a timeout: down crit, content and response time frozen (no answer, no evidence)',
        sev(run(row({ lv_v5: OUTCOME.timeout, lv_status: null, lv_v0: null, lv_v2: null }))),
        { down: 'crit', content: 'frozen', ms: 'frozen', cert: 'frozen' });
    eq('the down label says why', run(row({ lv_v5: OUTCOME.refused })).get('down')?.label, 'edge portal: connection refused');
    eq('a wrong status names the status', run(row({ lv_v5: OUTCOME['wrong-status'], lv_status: 503 })).get('down')?.label,
        'edge portal: unexpected status 503');
    eq('wrong content: content crit, and NOT down - the operator\'s ruling',
        sev(run(row({ lv_v5: OUTCOME['wrong-content'] }))), { down: 'normal', content: 'crit', ms: 'normal', cert: 'normal' });
    eq('a body too big to judge is a content alert, not a pass', sev(run(row({ lv_v5: OUTCOME['too-large'] }))).content, 'crit');
    // Two slow runs in a row (2026-10-07, the operator): one is a blip.
    eq('slow twice: 3,000 ms warns, 6,000 ms is crit',
        [sev(run(row({ lv_v0: 3000, prev_v0: 3000 }))).ms, sev(run(row({ lv_v0: 6000, prev_v0: 6000 }))).ms], ['warn', 'crit']);
    eq('ONE slow run after a fast one is a blip: nothing - the lab\'s 2.9 s Google',
        [sev(run(row({ lv_v0: 2900, prev_v0: 150 }))).ms, sev(run(row({ lv_v0: 9000, prev_v0: 150 }))).ms], ['normal', 'normal']);
    eq('the milder of the two decides: crit after warn is warn, warn after crit is warn',
        [sev(run(row({ lv_v0: 6000, prev_v0: 3000 }))).ms, sev(run(row({ lv_v0: 3000, prev_v0: 6000 }))).ms], ['warn', 'warn']);
    eq('a run before that got no answer starts no streak, nor does a first run',
        [sev(run(row({ lv_v0: 3000, prev_v0: null, prev_v5: OUTCOME.timeout }))).ms,
            sev(run(row({ lv_v0: 3000, prev_v0: null, prev_v5: null }))).ms], ['normal', 'normal']);
    eq('the value shown is this run\'s, and its threshold the level reached',
        (({ value, threshold }) => [value, threshold])(run(row({ lv_v0: 6000, prev_v0: 3000 })).get('ms') as Condition), [6000, 2000]);
    eq('certificate days are LOWER_IS_BAD: 10 warns, 5 is crit, an expired one is crit and down',
        [sev(run(row({ lv_v2: 10 }))).cert, sev(run(row({ lv_v2: 5 }))).cert,
            sev(run(row({ lv_v2: -3, lv_v5: OUTCOME['tls-expired'], lv_status: null, lv_v0: null }))).cert,
            sev(run(row({ lv_v2: -3, lv_v5: OUTCOME['tls-expired'], lv_status: null, lv_v0: null }))).down],
        ['warn', 'crit', 'crit', 'crit']);
    eq('plain http has no certificate rule, and no assertion means no content rule',
        [...run(row({ tls: false, has_assertion: false })).keys()], ['down', 'ms']);
    eq('a stale check freezes everything - no evidence is not "up"',
        sev(run(row({ fresh: false, lv_v5: OUTCOME.timeout }))), { down: 'frozen', content: 'frozen', ms: 'frozen', cert: 'frozen' });
    eq('so does the prober\'s own failure, and an outcome this build does not know',
        [sev(run(row({ lv_v5: OUTCOME.ours }))).down, sev(run(row({ lv_v5: 77 }))).down], ['frozen', 'frozen']);
    eq('a DOWN device freezes its checks - its own alert already says it',
        sev(run(row({ lv_v5: OUTCOME.timeout }), [{ name: 'edge', host: '10.0.0.1', status: 'down' }])).down, 'frozen');
    eq('a transient device that is away quiets them instead',
        sev(run(row({ lv_v5: OUTCOME.timeout }), [{ name: 'edge', host: '10.0.0.1', status: 'down', transient: true }])).down, 'normal');
    eq('a muted device emits nothing for its checks',
        run(row({ lv_v5: OUTCOME.timeout }), [{ name: 'edge', host: '10.0.0.1', status: 'up', muted: true }]).size, 0);
    const muted: RulesConfig = { ...cfg, overrides: [{ scope: 'code', code: 'SVC1', kind: 'svc-content', enabled: false }] };
    const m = evaluate({ devices: [{ name: 'edge', status: 'up' }], services: [scanServiceOf(row({ lv_v5: OUTCOME['wrong-content'] }))] }, muted)
        .filter((c) => c.kind.startsWith('svc-')).map((c) => c.kind);
    eq('the content rule mutes on its own and down stays', m, ['svc-down', 'svc-ms', 'svc-cert']);
    const idx = buildOverrideIndex(muted.overrides);
    eq('and the page reads the same provenance the engine used',
        [resolveRuleInfo(idx, muted, 'svc-content', 'SVC1', 'edge').muted, resolveRuleInfo(idx, muted, 'svc-down', 'SVC1', 'edge').source],
        [true, 'default']);
}

// --- the transport, against real servers ---------------------------------------------

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(p));
        });
    });
}

const handler: http.RequestListener = (req, res) => {
    const u = req.url ?? '/';
    if (u === '/ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', checks: { db: { state: 'up' } } })); return; }
    if (u === '/degraded') { res.writeHead(200); res.end(JSON.stringify({ status: 'degraded' })); return; }
    if (u === '/500') { res.writeHead(500); res.end('broken'); return; }
    if (u === '/same') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (u === '/other') { res.writeHead(301, { location: 'http://elsewhere.invalid/ok' }); res.end(); return; }
    if (u === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (u === '/big') {
        res.writeHead(200);
        const chunk = Buffer.alloc(64 * 1024, 120);
        let sent = 0;
        const more = (): void => {
            while (sent < 3 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', more); return; } }
            res.end();
        };
        more();
        return;
    }
    if (u === '/hang') return;   // accept, never answer
    res.writeHead(404); res.end();
};

async function transport(): Promise<void> {
    console.log('\nthe transport, against real servers on the loopback:');
    const hp = await freePort();
    const server = http.createServer(handler);
    const sockets = new Set<net.Socket>();
    let open = 0, peak = 0;
    server.on('connection', (s) => {
        sockets.add(s); open++; peak = Math.max(peak, open);
        s.on('close', () => { sockets.delete(s); open--; });
    });
    await new Promise<void>((r) => server.listen(hp, '127.0.0.1', r));
    const base = `http://127.0.0.1:${hp}`;
    const go = (raw: Record<string, unknown>) => runCheck('svc-http', http1({ timeoutS: 2, ...raw }), '127.0.0.1');

    let r = await go({ url: `${base}/ok` });
    eq('200: ok, with a status, a time, a connect time and the peer',
        [r.outcome, r.httpStatus, r.totalMs !== null, r.connectMs !== null, r.peer, r.dnsMs], ['ok', 200, true, true, '127.0.0.1', null]);
    r = await go({ url: `${base}/ok`, assertion: { type: 'json', path: 'checks.db.state', op: 'equals', values: ['up'] } });
    eq('a JSON assertion that holds: ok, assertion 1', [r.outcome, r.assertion], ['ok', 1]);
    r = await go({ url: `${base}/degraded`, assertion: { type: 'json', path: 'status', op: 'equals', values: ['ok'] } });
    eq('one that does not: wrong-content, assertion 0, and the detail carries no body', [r.outcome, r.assertion, r.detail.includes('degraded')],
        ['wrong-content', 0, false]);
    r = await go({ url: `${base}/500` });
    eq('500 against 200-299: wrong-status 500', [r.outcome, r.httpStatus], ['wrong-status', 500]);
    r = await go({ url: `${base}/500`, expect: '500' });
    eq('500 when 500 is what is expected: ok', r.outcome, 'ok');
    r = await go({ url: `${base}/same` });
    eq('a same-host redirect is followed to its answer', [r.outcome, r.httpStatus], ['ok', 200]);
    r = await go({ url: `${base}/other` });
    eq('another host is NOT followed - the address is judged only for the host the admin named',
        [r.outcome, r.httpStatus, r.detail], ['other-host-redirect', 301, '301 to elsewhere.invalid - not followed; expect 301 to accept the redirect, or check elsewhere.invalid itself']);
    r = await go({ url: `${base}/other`, expect: '301' });
    eq('unless the redirect itself is the expected answer', r.outcome, 'ok');
    r = await go({ url: `${base}/loop` });
    eq('a redirect loop ends after five hops', [r.outcome, r.detail], ['wrong-status', 'more than 5 redirects']);
    r = await go({ url: `${base}/big`, assertion: { type: 'contains', text: 'zzz' } });
    eq('a body past 1 MB stops being read: too-large', r.outcome, 'too-large');
    r = await go({ url: `${base}/big` });
    eq('and with no assertion the body is not read at all', r.outcome, 'ok');
    const t0 = performance.now();
    r = await go({ url: `${base}/hang`, timeoutS: 1 });
    const took = performance.now() - t0;
    eq('a server that never answers: timeout, inside the timeout', [r.outcome, took < 1600], ['timeout', true]);
    const closed = await freePort();
    r = await go({ url: `http://127.0.0.1:${closed}/` });
    eq('a closed port: refused', r.outcome, 'refused');
    r = await go({ url: 'http://no-such-host.invalid/' });
    eq('a name that does not resolve: dns', r.outcome, 'dns');
    r = await runCheck('svc-http', http1({ url: `http://portal.example.test:${hp}/ok`, connect: 'pin' }), '127.0.0.1');
    eq('pinned: the name is sent, the device\'s address is dialled, no lookup', [r.outcome, r.peer, r.dnsMs], ['ok', '127.0.0.1', null]);
    r = await runCheck('svc-http', http1({ url: 'http://portal.example.test/', connect: 'pin' }), '169.254.169.254');
    eq('pinned to a link-local device address: refused before a packet leaves', r.outcome, 'address-refused');

    let t = await runCheck('svc-tcp', { host: null, port: hp, intervalS: 60, timeoutS: 2, outside: 'auto' }, '127.0.0.1');
    eq('tcp to a listener: ok with a connect time', [t.outcome, t.connectMs !== null], ['ok', true]);
    t = await runCheck('svc-tcp', { host: '127.0.0.1', port: closed, intervalS: 60, timeoutS: 2, outside: 'auto' }, '10.0.0.1');
    eq('tcp to a closed port: REFUSED is the service down (rung 2), not the host alive (rung 1)', t.outcome, 'refused');

    console.log('\nthe spacing, measured:');
    const N = 120, spacing = 20, timeoutS = 1;
    peak = 0;
    const done: Promise<unknown>[] = [];
    // The scheduler runs on a fake clock moved a minute on so every check
    // is due; the timers it asks for are relative to that clock's tick.
    let now0 = Date.now();
    const s = new CheckScheduler(spacing, () => now0, (c, at) => {
        done.push(new Promise((res) => setTimeout(() => {
            runCheck('svc-http', c.def as HttpCheckDef, '127.0.0.1').then(res);
        }, Math.max(0, at - now0))));
    });
    s.setChecks(Array.from({ length: N }, (_, i) => ({
        id: String(i), code: `H${i}`, kind: 'svc-http' as const,
        def: http1({ url: `${base}/hang`, intervalS: 60, timeoutS }), deviceHost: '127.0.0.1', deviceName: 'd', name: `h${i}`,
    })));
    now0 += 60_000;
    const tb = performance.now();
    s.tick();
    await Promise.all(done);
    const burst = performance.now() - tb;
    const formula = sweepDurationMs(N, spacing, timeoutS * 1000);
    if (burst < formula * 1.5 && burst < N * timeoutS * 1000 / 4) {
        ok(`${N} checks against a server that never answers took ${Math.round(burst)} ms - the formula's ${formula}, not serial's ${N * timeoutS * 1000}`);
    } else bad('the burst cost far more than the spacing arithmetic allows', { burst, formula });
    const bound = maxOutstanding(N, spacing, timeoutS * 1000);
    if (peak <= bound + 2) ok(`at most ${peak} connections were open at once - the bound is ${bound}, independent of N`);
    else bad('more connections were open at once than spacing allows', { peak, bound });

    for (const so of sockets) so.destroy();
    await new Promise<void>((r2) => server.close(() => r2()));
}

async function tlsTransport(): Promise<void> {
    console.log('\ncertificates, against a real https server:');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-svc-'));
    const f = (n: string): string => path.join(dir, n);
    const run = (args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-subj', '/CN=rscanvas-test-ca']);
    fs.writeFileSync(f('leaf.ext'), 'subjectAltName=DNS:portal.example.test,IP:127.0.0.1\n');
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('leaf.key'), '-out', f('leaf.csr'), '-subj', '/CN=portal.example.test']);
    run(['x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial',
        '-days', '2', '-out', f('leaf.pem'), '-extfile', f('leaf.ext')]);
    const sp = await freePort();
    const server = https.createServer({ key: fs.readFileSync(f('leaf.key')), cert: fs.readFileSync(f('leaf.pem')) },
        (_req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); });
    await new Promise<void>((r) => server.listen(sp, '127.0.0.1', r));
    const go = (raw: Record<string, unknown>) =>
        runCheck('svc-http', http1({ timeoutS: 3, ...raw }), '127.0.0.1');

    let r = await go({ url: `https://127.0.0.1:${sp}/` });
    eq('a certificate from a CA nobody trusts: tls-untrusted, and its days are still read',
        [r.outcome, r.certDays !== null && r.certDays > 1 && r.certDays <= 2], ['tls-untrusted', true]);
    r = await go({ url: `https://127.0.0.1:${sp}/`, verifyTls: false });
    eq('verification off (an internal self-signed site): ok, days still recorded',
        [r.outcome, r.httpStatus, r.certDays !== null && r.certDays > 1], ['ok', 200, true]);

    // The trust the collector uses is the system's plus Node's bundled roots,
    // neither of which holds this CA - so the trusted path is driven by
    // running the same check in a child Node that is told to trust it, the
    // way an internal CA would be configured (NODE_EXTRA_CA_CERTS).
    // ASYNC: a synchronous child would block this process's event loop, and
    // the https server it is checking lives in this process.
    const child = async (url: string, connect: string): Promise<string> => (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        const { runCheck } = await import(${JSON.stringify(new URL('../src/checks/probe.ts', import.meta.url).href)});
        const { parseCheckDef } = await import(${JSON.stringify(new URL('../src/checks/model.ts', import.meta.url).href)});
        const d = parseCheckDef('svc-http', { url: ${JSON.stringify(url)}, connect: ${JSON.stringify(connect)}, timeoutS: 3 });
        const r = await runCheck('svc-http', d.def, '127.0.0.1');
        process.stdout.write(JSON.stringify([r.outcome, r.certDays !== null]));
    `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: f('ca.pem') } })).stdout.toString();
    eq('trusted through the CA, by name, pinned to the address: ok', await child(`https://portal.example.test:${sp}/`, 'pin'), '["ok",true]');
    eq('the same certificate under ANOTHER name: tls-name', await child(`https://other.example.test:${sp}/`, 'pin'), '["tls-name",true]');
    void tls;
    await new Promise<void>((res) => server.close(() => res()));
}

// --- name lookups are rationed (2026-10-06) ---------------------------------------------
// The operator's second real outage: lookups the DNS server never answered
// held libuv's four threads, and the database's own connects to "localhost"
// queued behind them. Checks now hold at most one lookup at a time. A
// lookup here answers only when the test says so - the shape of a blocked
// DNS server, without blocking one.

async function lookups(): Promise<void> {
    console.log('\nname lookups are rationed:');
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const tcp = (host: string, timeoutS = 1) =>
        runCheck('svc-tcp', { host, port, intervalS: 60, timeoutS, outside: 'auto' } as TcpCheckDef, '127.0.0.1');

    let unhandled = 0;
    const onUnhandled = (): void => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);

    const asked: string[] = [];
    const held = new Map<string, { answer: () => void; refuse: () => void }>();
    _setLookupForTests((host) => {
        asked.push(host);
        if (host.startsWith('fast.')) return Promise.resolve({ address: '127.0.0.1' });
        return new Promise((res, rej) => {
            held.set(host, {
                answer: () => res({ address: '127.0.0.1' }),
                refuse: () => rej(Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' })),
            });
        });
    });

    try {
        let r = await tcp('fast.example.test');
        eq('a lookup that answers: the check runs as before', r.outcome, 'ok');
        eq('  and holds nothing afterwards', _lookupsInFlightForTests(), 0);

        // Five names the DNS server never answers, all at once.
        asked.length = 0;
        const t0 = performance.now();
        const five = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => tcp(`${n}.blocked.test`)));
        const took = performance.now() - t0;
        eq('five unanswered names: every check fails as dns', five.map((x) => x.outcome), ['dns', 'dns', 'dns', 'dns', 'dns']);
        eq('  but only one lookup was ever started', asked.length, 1);
        eq('  and it is still held', _lookupsInFlightForTests(), 1);
        eq('  one says the lookup did not finish, four that they were not looked up',
            five.map((x) => (x.detail.includes('not looked up') ? 'waited' : x.detail.includes('did not finish') ? 'late' : x.detail)).sort(),
            ['late', 'waited', 'waited', 'waited', 'waited']);
        if (took < 2500) ok(`  in one timeout, not five (${Math.round(took)} ms)`); else bad('  five checks took', Math.round(took));

        // The next run asks again while the first lookups are still stuck:
        // nothing new is started, for those names or any other.
        asked.length = 0;
        r = await tcp('a.blocked.test');
        eq('a name already being looked up waits on that lookup, not a new one', [r.outcome, asked.length], ['dns', 0]);
        r = await tcp('f.blocked.test');
        eq('a new name with the slot held is not looked up at all', [r.outcome, asked.length], ['dns', 0]);

        // Three checks of one name share one lookup.
        held.get('a.blocked.test')?.refuse();
        await new Promise((res) => setTimeout(res, 20));
        eq('a lookup refused at last frees the slot', _lookupsInFlightForTests(), 0);
        asked.length = 0;
        const same = Promise.all([tcp('g.blocked.test'), tcp('g.blocked.test'), tcp('g.blocked.test')]);
        await new Promise((res) => setTimeout(res, 50));
        eq('three checks of one name: one lookup', asked, ['g.blocked.test']);
        held.get('g.blocked.test')?.answer();
        eq('  and all three connect when it answers', (await same).map((x) => x.outcome), ['ok', 'ok', 'ok']);

        // Checks waiting for the slot get it in turn as it frees.
        asked.length = 0;
        const h = tcp('h.blocked.test', 3);
        const i = tcp('i.blocked.test', 3);
        const j = tcp('fast.after.test', 3);
        await new Promise((res) => setTimeout(res, 100));
        eq('the slot held again, two checks waiting for it', [asked.length, _lookupsInFlightForTests()], [1, 1]);
        held.get('h.blocked.test')?.answer();
        await new Promise((res) => setTimeout(res, 20));
        eq('  each waiting check gets the slot in turn as it frees', asked, ['h.blocked.test', 'i.blocked.test']);
        held.get('i.blocked.test')?.refuse();
        eq('  and the last one connects', (await j).outcome, 'ok');
        eq('  the held ones settle as answered and refused', [(await h).outcome, (await i).outcome], ['ok', 'dns']);
        await new Promise((res) => setTimeout(res, 20));
        eq('no lookups held at the end', _lookupsInFlightForTests(), 0);
        eq('a lookup refused after every asker gave up is not an unhandled rejection', unhandled, 0);
    } finally {
        _setLookupForTests(null);
        process.off('unhandledRejection', onUnhandled);
        server.close();
    }
}

// --- voice (slice 60) ------------------------------------------------------------

/** One one-way call's `-J` output from iperf3 3.16 as the lab produced it
 *  (2026-10-05, lab-5 to lab-3), cut to the fields the parser reads. The
 *  reversed run's has the same shape - sum_received is the receiving end. */
function iperfJson(rcv: Record<string, number> = {}, sent = 250): string {
    return JSON.stringify({
        start: { test_start: { protocol: 'UDP', blksize: 160, tos: 184, target_bitrate: 64000, reverse: 0 } },
        end: {
            sum_sent: { packets: sent, sender: true },
            sum_received: { packets: 250, lost_packets: 0, lost_percent: 0, jitter_ms: 0.0107, sender: false, ...rcv },
        },
    });
}

function voice(): void {
    console.log('\nvoice (slice 60):');
    const d = parseCheckDef('path-voice', {});
    eq('defaults: the device, port 5201, every 5 minutes, 10 s calls marked EF, never outside',
        d.ok ? d.def : d, { host: null, port: 5201, intervalS: 300, durationS: 10, timeoutS: 45, dscp: 46, outside: 'no' });
    const refuse = (l: string, raw: Record<string, unknown>, has: string): void => {
        const r = parseCheckDef('path-voice', raw);
        if (!r.ok && r.detail.includes(has)) ok(l); else bad(l, r);
    };
    refuse('a voice test more often than every minute is refused', { intervalS: 30 }, 'interval');
    refuse('a call longer than 30 s is refused', { durationS: 60 }, '5 to 30');
    refuse('a DSCP past 63 is refused', { dscp: 64 }, 'DSCP');
    eq('its timeout is two calls plus room, not the operator\'s', (parseCheckDef('path-voice', { durationS: 20, timeoutS: 3 }) as { def: VoiceCheckDef }).def.timeoutS, 65);
    eq('and its default name says where', defaultCheckName('path-voice', { host: 'site-a', port: 5201, intervalS: 300, durationS: 10, timeoutS: 30, dscp: 46, outside: 'no' }), 'Voice to site-a');

    eq('MOS: a clean G.711 call is about 4.4', mosEstimate(1, 0.02, 0), 4.4);
    const m = [mosEstimate(20, 2, 1), mosEstimate(20, 2, 5), mosEstimate(150, 30, 0), mosEstimate(20, 2, 50)];
    eq('loss, latency and jitter all pull it down, and it bottoms at 1', [m[0]! < 4.4, m[1]! < m[0]!, m[2]! < 4.2, m[3]], [true, true, true, 1]);

    eq('a one-way call as 3.16 writes it', parseIperfOneWay(iperfJson()), { ok: true, loss: 0, jitter: 0.011 });
    eq('the receiving end\'s loss and jitter, as the reversed run under netem gave them',
        parseIperfOneWay(iperfJson({ lost_packets: 1, lost_percent: 0.3968253968253968, jitter_ms: 5.60882390208387 })),
        { ok: true, loss: 0.397, jitter: 5.609 });
    eq('a call where nothing arrived is 100%, not iperf3\'s 0', (parseIperfOneWay(iperfJson({ packets: 0, lost_percent: 0 })) as { loss: number }).loss, 100);
    const err = (msg: string) => parseIperfOneWay(JSON.stringify({ start: {}, intervals: [], end: {}, error: msg }));
    eq('its errors, in 3.16\'s own words', [
        err('the server is busy running a test. try again later'),
        err('unable to connect to server - server may have stopped running or use a different port, firewall issue, etc.: Connection refused'),
        err('unable to connect to server - server may have stopped running or use a different port, firewall issue, etc.: Connection timed out'),
        err('test authorization failed'),
    ].map((x) => (x.ok ? 'ok' : `${x.outcome}: ${x.detail}`)), [
        'busy: iperf3: the server is busy running a test. try again later',
        'refused: iperf3: Connection refused',
        'timeout: iperf3: Connection timed out',
        'auth: iperf3: test authorization failed',
    ]);
    eq('output that is not JSON is an error, not a crash', (parseIperfOneWay('iperf3: error') as { outcome: string }).outcome, 'error');
    eq('no route and no name', [classifyIperfError('No route to host'), classifyIperfError('Name or service not known')], ['unreachable', 'dns']);
    // 2026-10-07: the lab's "protocol error" at the second of each deploy.
    const cut = parseIperfOneWay(JSON.stringify({ error: 'interrupt - the client has terminated' })) as { outcome: string; detail: string };
    eq('our own client stopped (the service restarting) is ours, not the path\'s', cut.outcome, 'ours');
    eq('  and its words are kept, which is what marks the run as not to be recorded',
        IPERF_CLIENT_INTERRUPTED.test(cut.detail), true);
    eq('the RESPONDER stopping mid-call is still the far end\'s failure',
        classifyIperfError('interrupt - the server has terminated'), 'error');

    const reading = voiceReading({ lossTo: 0, lossFrom: 2, jitterTo: 0.5, jitterFrom: 9.5 }, 30);
    eq('the estimate is the WORSE direction\'s', reading.mos, mosEstimate(15, 9.5, 2));
    eq('and without a round trip there is none', voiceReading({ lossTo: 0, lossFrom: 0, jitterTo: 0, jitterFrom: 0 }, null).mos, null);
    eq('the voice layout: v0/v1 loss, v2/v3 jitter, v4 MOS, v5 outcome; rtt the round trip used', sampleOf({
        outcome: 'ok', httpStatus: null, totalMs: 10400, connectMs: null, dnsMs: null, certDays: null, assertion: null,
        peer: '198.18.50.2', detail: '', voice: reading,
    }), { status: null, rttMs: 30, v: [0, 2, 0.5, 9.5, reading.mos, 0] });
    eq('a call that did not run writes its outcome and nothing else', sampleOf({
        outcome: 'busy', httpStatus: null, totalMs: null, connectMs: null, dnsMs: null, certDays: null, assertion: null,
        peer: null, detail: '', voice: null,
    }).v, [null, null, null, null, null, 16]);

    console.log('\nvoice alerts:');
    const cfg: RulesConfig = DEFAULT_RULES;
    const row = (over: Partial<ServiceRow>): ServiceRow => ({
        code: 'VO1', name: 'Voice to branch', kind: 'path-voice', has_assertion: false, tls: false,
        lv_status: null, lv_v0: 0, lv_v1: 0, lv_v2: 0.4, lv_v3: 0.5, lv_v4: 4.4, lv_v5: OUTCOME.ok,
        fresh: true, device_name: 'branch-iperf', ...over,
    });
    const run = (r: ServiceRow, devices = [{ name: 'branch-iperf', host: '10.9.0.5', status: 'up' }] as Array<Record<string, unknown>>) =>
        new Map(evaluate({ devices, services: [scanServiceOf(r)] }, cfg).filter((c) => c.kind.startsWith('path-')).map((c) => [c.kind, c]));
    const sev = (m: Map<string, Condition>) => Object.fromEntries([...m].map(([k, c]) => [k, c.frozen ? 'frozen' : (c.severity ?? 'normal')]));
    eq('a clean call: four rules, all normal', sev(run(row({}))), { 'path-down': 'normal', 'path-loss': 'normal', 'path-jitter': 'normal', 'path-mos': 'normal' });
    const lossy = run(row({ lv_v1: 2.4, lv_v3: 12, lv_v4: 3.9 }));
    eq('2.4% lost from the site warns, and the label says which way', [lossy.get('path-loss')?.severity, lossy.get('path-loss')?.label, lossy.get('path-loss')?.value],
        ['warn', 'branch-iperf Voice to branch loss from the site', 2.4]);
    eq('60 ms of jitter toward the site is crit', [run(row({ lv_v2: 60 })).get('path-jitter')?.severity, run(row({ lv_v2: 60 })).get('path-jitter')?.label],
        ['crit', 'branch-iperf Voice to branch jitter toward the site']);
    eq('MOS is LOWER_IS_BAD: 3.4 warns, 3.0 is crit', [run(row({ lv_v4: 3.4 })).get('path-mos')?.severity, run(row({ lv_v4: 3.0 })).get('path-mos')?.severity], ['warn', 'crit']);
    eq('no MOS (no round trip yet) freezes only the MOS rule', sev(run(row({ lv_v4: null }))),
        { 'path-down': 'normal', 'path-loss': 'normal', 'path-jitter': 'normal', 'path-mos': 'frozen' });
    eq('a responder that refuses: path-down WARN by default, the readings frozen',
        sev(run(row({ lv_v5: OUTCOME.refused, lv_v0: null, lv_v1: null, lv_v2: null, lv_v3: null, lv_v4: null }))),
        { 'path-down': 'warn', 'path-loss': 'frozen', 'path-jitter': 'frozen', 'path-mos': 'frozen' });
    eq('busy is not down - it answered - so only the readings freeze',
        sev(run(row({ lv_v5: OUTCOME.busy, lv_v0: null, lv_v1: null, lv_v2: null, lv_v3: null, lv_v4: null }))),
        { 'path-down': 'normal', 'path-loss': 'frozen', 'path-jitter': 'frozen', 'path-mos': 'frozen' });
    eq('but busy twelve tests in a row is', run(row({ lv_v5: OUTCOME['busy-always'], lv_v0: null, lv_v1: null, lv_v2: null, lv_v3: null, lv_v4: null })).get('path-down')?.label,
        'branch-iperf Voice to branch: the responder has been busy for 12 tests in a row - something else is using it');
    eq('a down device freezes its voice test', sev(run(row({ lv_v1: 9 }), [{ name: 'branch-iperf', host: '10.9.0.5', status: 'down' }]))['path-loss'], 'frozen');
    eq('iperf3 failing in words nobody classified freezes it - no evidence, not a dead responder',
        sev(run(row({ lv_v5: OUTCOME.error, lv_v0: null, lv_v1: null, lv_v2: null, lv_v3: null, lv_v4: null })))['path-down'], 'frozen');
}

// --- throughput and the gate (slice 61) ----------------------------------------------

async function throughput(): Promise<void> {
    console.log('\nthroughput (slice 61):');
    const bare = parseCheckDef('path-tput', {});
    eq('headroom is the default, and it needs the rate to prove', bare.ok ? 'accepted' : bare.detail.startsWith('a headroom test needs the rate'), true);
    const d = parseCheckDef('path-tput', { capMbps: 200 });
    eq('defaults: hourly, 10 s each way, headroom at the given rate, 01:00-05:00 kept for max, never outside',
        d.ok ? d.def : d, { host: null, port: 5201, intervalS: 3600, durationS: 10, mode: 'headroom', capMbps: 200, windowStart: 1, windowEnd: 5, outside: 'no', timeoutS: 56 });
    const mx = parseCheckDef('path-tput', { mode: 'max', windowStart: 0, windowEnd: 24 }) as { ok: true; def: ThroughputCheckDef };
    eq('max mode carries no cap, and 0 to 24 is all day', [mx.def.capMbps, mx.def.windowStart, mx.def.windowEnd], [null, 0, 24]);
    const refuse = (l: string, raw: Record<string, unknown>, has: string): void => {
        const r = parseCheckDef('path-tput', raw);
        if (!r.ok && r.detail.includes(has)) ok(l); else bad(l, r);
    };
    refuse('more often than every 5 minutes is refused', { capMbps: 100, intervalS: 120 }, 'interval');
    refuse('an empty window is refused', { mode: 'max', windowStart: 5, windowEnd: 5 }, 'empty');
    refuse('a mode that is neither is refused', { mode: 'turbo' }, 'headroom (capped) or max');
    const w = (a: number, b: number) => ({ ...(mx.def), windowStart: a, windowEnd: b });
    eq('the window: start inclusive, end exclusive', [0, 1, 4, 5].map((h) => inWindow(w(1, 5), h)), [false, true, true, false]);
    eq('a window may wrap past midnight', [23, 3, 12].map((h) => inWindow(w(22, 4), h)), [true, true, false]);
    eq('headroom runs at any hour', inWindow({ ...(d as { def: ThroughputCheckDef }).def, windowStart: 1, windowEnd: 5 }, 12), true);
    eq('one test holds the path 36 s at the defaults - 2 x (2 + 10) + 2 s of idle pings + the 10 s gap', throughputCostS({ durationS: 10 }), 36);
    const hourly = (n: number) => Array.from({ length: n }, () => ({ durationS: 10, intervalS: 3600 }));
    eq('90 hourly tests fit in 90% of the hour', throughputFits(hourly(90)).ok, true);
    const no = throughputFits(hourly(91));
    eq('91 do not, and the refusal names the numbers', no.ok ? 'fits' : no.detail.startsWith('throughput tests run one at a time, and these 91 would need 3276 s of every hour'), true);

    eq('the forward call as 3.16 wrote it on the lab (capped at 200M)', parseIperfTcp(JSON.stringify({
        start: { test_start: { protocol: 'TCP', omit: 2, reverse: 0, target_bitrate: 200000000 } },
        end: { sum_sent: { bits_per_second: 199846275.07, retransmits: 0, sender: true }, sum_received: { bits_per_second: 199875455.09, sender: true } },
    })), { ok: true, mbps: 199.88, retransmits: 0 });
    eq('and the reversed one, the rate RSCanvas received', parseIperfTcp(JSON.stringify({
        end: { sum_sent: { bits_per_second: 933275570.68, retransmits: 17, sender: false }, sum_received: { bits_per_second: 933233199.94, sender: false } },
    })), { ok: true, mbps: 933.23, retransmits: 17 });
    eq('its refusals read as for voice', (parseIperfTcp(JSON.stringify({ error: 'the server is busy running a test. try again later' })) as { outcome: string }).outcome, 'busy');
    eq('fping -C, a lost ping left out', parseFpingTimes('198.18.50.2 : 0.124 0.410 - 0.387\n'), [0.124, 0.41, 0.387]);
    eq('the median, not the mean: one late reply is not the queue', [median([0.3, 0.4, 250, 0.35]), median([5, 1, 3]), median([])], [0.4, 3, null]);
    eq('the throughput layout: v0/v1 Mbps, v2 loaded, v3 loaded EF, v4 idle, v5 outcome', sampleOf({
        outcome: 'ok', httpStatus: null, totalMs: 26000, connectMs: null, dnsMs: null, certDays: null, assertion: null, peer: '198.18.50.2', detail: '',
        tput: { mbpsTo: 199.9, mbpsFrom: 933.2, loadedMs: 41.5, loadedEfMs: 0.4, idleMs: 0.3, retransmits: 17 },
    }), { status: null, rttMs: 0.3, v: [199.9, 933.2, 41.5, 0.4, 0.3, 0] });

    console.log('\nthe gate - one throughput at a time, no voice beside it:');
    let now = 0;
    const timers: Array<[number, () => void]> = [];
    const gate = new PathGate(10_000, () => now, (fn, ms) => { timers.push([now + ms, fn]); });
    const advance = (ms: number) => {
        now += ms;
        for (let i = 0; i < timers.length;) {
            if ((timers[i] as [number, () => void])[0] <= now) { const [, fn] = timers.splice(i, 1)[0] as [number, () => void]; fn(); } else i++;
        }
    };
    const flush = () => new Promise((r) => setImmediate(r));
    const log: string[] = [];
    const t1 = await gate.acquireThroughput(); log.push('T1');
    let t2: Release | null = null;
    void gate.acquireThroughput().then((r) => { t2 = r; log.push('T2'); });
    let v1: Release | null = null;
    void gate.acquireVoice().then((r) => { v1 = r; log.push('V1'); });
    await flush();
    eq('while a throughput test runs, neither another nor a voice test starts', log, ['T1']);
    t1(); await flush();
    eq('released, the next throughput test still waits out the gap - and the voice test waits behind it', log, ['T1']);
    advance(10_000); await flush();
    eq('after the gap the waiting throughput test goes first', log, ['T1', 'T2']);
    (t2 as unknown as Release)(); await flush();
    eq('and the voice test once it is done', log, ['T1', 'T2', 'V1']);
    let v2: Release | null = null;
    void gate.acquireVoice().then((r) => { v2 = r; log.push('V2'); });
    await flush();
    eq('voice tests run beside each other', log, ['T1', 'T2', 'V1', 'V2']);
    let t3: Release | null = null;
    void gate.acquireThroughput().then((r) => { t3 = r; log.push('T3'); });
    void gate.acquireVoice().then(() => { log.push('V3'); });
    await flush();
    advance(10_000); await flush();
    eq('a throughput test waits for running voice tests, and no new voice test jumps ahead of it', log, ['T1', 'T2', 'V1', 'V2']);
    (v1 as unknown as Release)(); (v2 as unknown as Release)(); await flush();
    eq('the last voice test out lets it in', log, ['T1', 'T2', 'V1', 'V2', 'T3']);
    (t3 as unknown as Release)(); await flush();
    eq('and the queued voice test follows it', log, ['T1', 'T2', 'V1', 'V2', 'T3', 'V3']);

    console.log('\nthroughput alerts:');
    const row = (over: Partial<ServiceRow>): ServiceRow => ({
        code: 'TP1', name: 'Throughput to branch', kind: 'path-tput', has_assertion: false, tls: false,
        lv_status: null, lv_v0: 480, lv_v1: 210, lv_v2: 35, lv_v3: 0.5, lv_v4: 0.4, lv_v5: OUTCOME.ok,
        fresh: true, device_name: 'branch-iperf', ...over,
    });
    const run = (r: ServiceRow, cfg: RulesConfig) => evaluate({ devices: [{ name: 'branch-iperf', status: 'up' }], services: [scanServiceOf(r)] }, cfg)
        .filter((c) => c.kind.startsWith('path-'));
    eq('with no rate of the operator\'s there is no rate rule - only path-down', run(row({}), DEFAULT_RULES).map((c) => c.kind), ['path-down']);
    const withRate: RulesConfig = { ...DEFAULT_RULES, overrides: [{ scope: 'code', code: 'TP1', kind: 'path-tput', warn: 400, crit: 100, enabled: true }] };
    const c = run(row({}), withRate).find((x) => x.kind === 'path-tput');
    eq('given one, it judges the SLOWER direction and names it (LOWER_IS_BAD)', [c?.severity, c?.label, c?.value], ['warn', 'branch-iperf Throughput to branch throughput from the site', 210]);
    eq('a responder that refuses warns, the rate frozen',
        run(row({ lv_v5: OUTCOME.refused, lv_v0: null, lv_v1: null }), withRate).map((x) => `${x.kind}:${x.frozen ? 'frozen' : x.severity}`),
        ['path-down:warn', 'path-tput:frozen']);
}

async function main(): Promise<void> {
    console.log('service checks\n');
    definitions();
    assertions();
    classification();
    schedule();
    rules();
    voice();
    await throughput();
    await transport();
    await tlsTransport();
    await lookups();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

void main();
