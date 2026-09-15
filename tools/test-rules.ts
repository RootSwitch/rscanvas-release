// The alerting engine, and a differential against the parent it came from.
//
//   node tools/test-rules.ts
//
// TWO SECTIONS, and the second is the one that makes the port trustworthy.
//
// Named cases first, for the behaviours a reader should be able to find: the
// three places `frozen` is used, LOWER_IS_BAD inversion, override precedence,
// and reboot detection.
//
// Then a GENERATED DIFFERENTIAL. `evaluate` has too many branches to enumerate
// by hand - device roster versus embedded device blocks, four interface
// aspects, thirteen metric kinds, two override scopes, muted rules, unknown
// statuses, null rates - so instead a deterministic pseudo-random generator
// builds documents and configs, and the parent's own JavaScript is run against
// this TypeScript over every one. Any behavioural difference shows up as a
// mismatch with the document that produced it.
//
// That is the parent-diff rule as a test rather than a review note, and it is
// here because `filter.js` proved reading a ported file is not enough: its port
// silently dropped the parent's LIKE escaping and read fine on its own merits.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
    evaluate, detectReboots, LOWER_IS_BAD, METRIC_KINDS,
    type ScanDoc, type RulesConfig, type ScanMetric,
} from '../src/alerts/rules.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const CONFIG: RulesConfig = {
    thresholds: {
        cpu: { warn: 80, crit: 90 },
        temp: { warn: 55, crit: 65 },
        battery: { warn: 50, crit: 20 },
        uptime: { warn: null, crit: null },
    },
    ifRules: {
        down: { enabled: true, severity: 'crit' },
        errors: { warn: 1, crit: 10 },
        discards: { warn: 1, crit: 10 },
        util: { warn: 70, crit: 90 },
    },
    deviceDown: { enabled: true, severity: 'crit' },
    overrides: [],
};

console.log('alerting engine\n');

// --- FROZEN, in all three of its uses -----------------------------------------
//
// The property AlertCanvas got right: frozen is a THIRD state, distinct from
// normal, meaning no evidence either way. An alarm true when its input was last
// good must not silently become "resolved" because the input went away.

{
    const doc: ScanDoc = {
        devices: [{ name: 'sw1', host: '10.0.0.1', status: 'down' }],
        interfaces: [{ id: 'sw1:1', code: 'abc', name: 'Gi0/1', device: { name: 'sw1' },
            adminStatus: 'up', operStatus: 'up', speedBps: 1e9, inBps: 1e8 }],
        metrics: [{ code: 'm1', host: 'sw1', kind: 'cpu', value: 5 }],
    };
    const cs = evaluate(doc, CONFIG);
    const ifConds = cs.filter((c) => c.code === 'abc');
    const metric = cs.find((c) => c.key === 'metric:m1');

    if (ifConds.length === 4 && ifConds.every((c) => c.frozen && c.severity === null)) {
        ok('a DOWN device freezes all four interface aspects rather than reporting normal');
    } else {
        bad('interfaces under a down device were not frozen', JSON.stringify(ifConds.map((c) => [c.kind, c.frozen])));
    }
    if (metric?.frozen === true && metric.severity === null) {
        ok('and freezes that device\'s metrics too - a healthy CPU reading is not evidence it recovered');
    } else {
        bad('a metric under a down device was not frozen', JSON.stringify(metric));
    }
}

// --- transient (slice 25, quiet 2) --------------------------------------------
//
// For a DECLARED transient device, down emits severity null - the watchdog's
// healthy pattern - so an open device-down alert clears through the ordinary
// counters. Since 2026-09-01 (ruling 4) the quiet extends UNIFORMLY to the
// device's interfaces and metrics while it is down; a non-flagged device
// stays bit-for-bit identical - which the generated differential below keeps
// proving, because the parent's generator never emits the flag.

{
    const doc: ScanDoc = {
        devices: [
            { name: 'parlor1', host: '10.0.0.9', status: 'down', transient: true },
            { name: 'parlor2', host: '10.0.0.10', status: 'up', transient: true },
            { name: 'srv1', host: '10.0.0.11', status: 'down' },
        ],
        interfaces: [{ id: 'parlor1:1', code: 'p1if', name: 'eth0', device: { name: 'parlor1' },
            adminStatus: 'up', operStatus: 'up', speedBps: 1e9, inBps: 1e8 }],
        metrics: [{ code: 'pm1', host: 'parlor1', kind: 'cpu', value: 5 }],
    };
    const cs = evaluate(doc, CONFIG);
    const off = cs.find((c) => c.key === 'device:parlor1');
    const up = cs.find((c) => c.key === 'device:parlor2');
    const real = cs.find((c) => c.key === 'device:srv1');
    if (off !== undefined && off.severity === null && !off.frozen) {
        ok('transient down emits severity null - an open device-down clears normally');
    } else bad('transient down did not emit the healthy condition', JSON.stringify(off));
    if (up !== undefined && up.severity === null) ok('transient up is null like any healthy device');
    else bad('transient up mis-evaluated', JSON.stringify(up));
    if (real !== undefined && real.severity === 'crit') ok('a NON-flagged down device still raises crit');
    else bad('non-flagged down device no longer raises', JSON.stringify(real));
    // RULING REVERSED 2026-09-01 (DECISIONS-2026-09-01 ruling 4). This test
    // used to pin the opposite: "a transient down device still FREEZES its
    // interface and metric rules - evidence, not classification". The
    // operator's fleet showed what that costs - four of six transient
    // devices carrying if-down crits, one open since 08-28, frozen across
    // every declared-expected absence. The declaration means "this
    // device's absence is not a fault", and the claim now extends
    // UNIFORMLY: while a transient device is down, its interfaces and
    // metrics are severity-null and NOT frozen, so open alerts clear
    // through the ordinary counters and re-raise honestly on return.
    const ifc = cs.find((c) => c.code === 'p1if' && c.kind === 'if-down');
    const met = cs.find((c) => c.key === 'metric:pm1');
    if (ifc?.frozen === false && ifc.severity === null && met?.frozen === false && met.severity === null) {
        ok('a transient DOWN device quiets its interfaces and metrics - null, not frozen (ruling 4)');
    } else bad('transient down did not quiet downstream rules', JSON.stringify({ ifc, met }));
    // The non-transient half is UNCHANGED and stays pinned: a dead switch
    // must never auto-clear its interface alerts.
    const srvIf = cs.find((c) => c.key === 'device:srv1');
    if (srvIf?.severity === 'crit') {
        ok('the reversal touched only declared-transient devices');
    } else bad('the reversal leaked past transient devices', JSON.stringify(srvIf));
}

{
    // The half the ruling deliberately kept: a NIC that drops while its
    // transient device is PRESENT is information, and still alerts.
    const doc: ScanDoc = {
        devices: [{ name: 'parlor1', host: '10.0.0.9', status: 'up', transient: true }],
        interfaces: [{ id: 'parlor1:1', code: 'p1if', name: 'eth0', device: { name: 'parlor1' },
            adminStatus: 'up', operStatus: 'down' }],
    };
    const cs = evaluate(doc, CONFIG);
    const ifc = cs.find((c) => c.code === 'p1if' && c.kind === 'if-down');
    if (ifc !== undefined && ifc.severity !== null && !ifc.frozen) {
        ok('a NIC down on a PRESENT transient device still alerts - presence makes it information');
    } else bad('if-down on a present transient device was quieted', JSON.stringify(ifc));
}

{
    const doc: ScanDoc = {
        interfaces: [{ id: 'sw2:1', code: 'q', name: 'Gi0/1', device: { name: 'sw2', status: 'up' },
            adminStatus: 'unknown', operStatus: 'unknown',
            inErrorsPerSec: null, outErrorsPerSec: null }],
    };
    const cs = evaluate(doc, CONFIG);
    const down = cs.find((c) => c.kind === 'if-down');
    const errs = cs.find((c) => c.kind === 'if-errors');
    if (down?.frozen === true) ok('an interface with unknown admin/oper status is frozen, not "up"');
    else bad('unknown status did not freeze', JSON.stringify(down));
    if (errs?.frozen === true) ok('and null counter rates freeze - settling counters are not a normal reading');
    else bad('null rates did not freeze', JSON.stringify(errs));
}

// --- LOWER_IS_BAD inversion ---------------------------------------------------
{
    const low = evaluate({ metrics: [{ code: 'b', host: 'ups1', kind: 'battery', value: 15 }] }, CONFIG);
    const high = evaluate({ metrics: [{ code: 'c', host: 'sw1', kind: 'cpu', value: 95 }] }, CONFIG);
    if (low[0]?.severity === 'crit') ok('battery 15 against crit 20 is CRIT - low is bad for battery/runtime/uptime');
    else bad('the LOWER_IS_BAD inversion did not fire', JSON.stringify(low[0]));
    if (high[0]?.severity === 'crit') ok('and cpu 95 against crit 90 is crit the ordinary way round');
    else bad('a normal high-is-bad threshold did not fire', JSON.stringify(high[0]));
    if (LOWER_IS_BAD.has('uptime')) ok('uptime is in LOWER_IS_BAD, which is how a reboot reads as a collapse');
    else bad('uptime is missing from LOWER_IS_BAD');
}

// --- override precedence ------------------------------------------------------
{
    const cfg: RulesConfig = { ...CONFIG, overrides: [
        { scope: 'code', code: 'c1', kind: 'cpu', warn: 10, crit: 20, enabled: true },
        { scope: 'host-kind', host: 'sw9', kind: 'cpu', enabled: false },
    ] };
    const byCode = evaluate({ metrics: [{ code: 'c1', host: 'sw1', kind: 'cpu', value: 25 }] }, cfg);
    if (byCode[0]?.severity === 'crit' && byCode[0]?.threshold === 20) {
        ok('a code-scoped override replaces the default thresholds');
    } else {
        bad('the code override did not apply', JSON.stringify(byCode[0]));
    }
    const muted = evaluate({ metrics: [{ code: 'zz', host: 'sw9', kind: 'cpu', value: 99 }] }, cfg);
    if (muted.length === 0) ok('a disabled host-kind override MUTES the rule entirely - no condition at all');
    else bad('a muted rule still produced a condition', JSON.stringify(muted));
}


// --- the kind tier (2026-08-19): a default expressed as data ------------------
//
// "Temperature alerts off" is a row, not a code change, so an operator can see
// it and delete it. Precedence code > host-kind > kind > DEFAULT_RULES, and
// every tier can mute.
{
    const cfg: RulesConfig = { ...CONFIG, overrides: [
        { scope: 'kind', kind: 'temp', warn: 70, crit: 85, enabled: true },
    ] };
    // CONFIG's temp default is warn 55 / crit 65. At 60C the DEFAULT says warn;
    // the kind override says nothing. The override must win.
    const r = evaluate({ metrics: [{ code: 't1', host: 'anyhost', kind: 'temp', value: 60 }] }, cfg);
    // A leveled metric always yields a condition (the machine needs normals to
    // clear on); what the override changes is WHICH threshold and whether it
    // breaches. Under the default 60C is a warn; under the kind override it is
    // normal against 70.
    if (r[0]?.severity === null && r[0]?.threshold === 70) ok('a kind-scoped override replaces the default for EVERY device of that kind');
    else bad('the kind override did not apply', JSON.stringify(r[0]));
    const hot = evaluate({ metrics: [{ code: 't1', host: 'anyhost', kind: 'temp', value: 90 }] }, cfg);
    if (hot[0]?.severity === 'crit' && hot[0]?.threshold === 85) ok('and its own levels are what fire');
    else bad('kind override levels wrong', JSON.stringify(hot[0]));
}
{
    // Muting at the kind tier is how temperatures ship OFF from this slice on.
    const cfg: RulesConfig = { ...CONFIG, overrides: [{ scope: 'kind', kind: 'temp', enabled: false }] };
    const r = evaluate({ metrics: [{ code: 't1', host: 'h', kind: 'temp', value: 200 }] }, cfg);
    if (r.length === 0) ok('a disabled kind override mutes every entity of that kind - temperatures off by data');
    else bad('kind mute did not mute', JSON.stringify(r));
    const other = evaluate({ metrics: [{ code: 'c1', host: 'h', kind: 'cpu', value: 95 }] }, cfg);
    if (other.length === 1) ok('and does NOT touch another kind');
    else bad('kind mute leaked across kinds', JSON.stringify(other));
}
{
    // Precedence, all three tiers present for one target.
    const cfg: RulesConfig = { ...CONFIG, overrides: [
        { scope: 'kind', kind: 'temp', enabled: false },                              // everyone: off
        { scope: 'host-kind', host: 'hot-box', kind: 'temp', warn: 80, crit: 95, enabled: true },  // this box: on, high
        { scope: 'code', code: 'nvme0', kind: 'temp', warn: 60, crit: 70, enabled: true },         // this sensor: tighter
    ] };
    const elsewhere = evaluate({ metrics: [{ code: 'x', host: 'other', kind: 'temp', value: 90 }] }, cfg);
    if (elsewhere.length === 0) ok('precedence: a device with no narrower rule gets the kind tier (muted)');
    else bad('kind tier did not apply where no narrower rule exists', JSON.stringify(elsewhere));
    const box = evaluate({ metrics: [{ code: 'y', host: 'hot-box', kind: 'temp', value: 90 }] }, cfg);
    if (box[0]?.severity === 'warn' && box[0]?.threshold === 80) ok('precedence: host-kind beats kind');
    else bad('host-kind did not beat kind', JSON.stringify(box[0]));
    const sensor = evaluate({ metrics: [{ code: 'nvme0', host: 'hot-box', kind: 'temp', value: 75 }] }, cfg);
    if (sensor[0]?.severity === 'crit' && sensor[0]?.threshold === 70) ok('precedence: code beats host-kind beats kind');
    else bad('code did not beat host-kind', JSON.stringify(sensor[0]));
}
// --- reboot detection ---------------------------------------------------------
{
    const prev = new Map([['u1', 100_000], ['u2', 50]]);
    const metrics: ScanMetric[] = [
        { code: 'u1', host: 'a', kind: 'uptime', value: 40 },
        { code: 'u2', host: 'b', kind: 'uptime', value: 45 },
        { code: 'u3', host: 'c', kind: 'uptime', value: null },
    ];
    const r = detectReboots(prev, metrics);
    if (r.length === 1 && r[0]?.code === 'u1') {
        ok('uptime going backwards past the 30s jitter guard is a reboot');
    } else {
        bad('reboot detection is wrong', JSON.stringify(r));
    }
    if (!r.some((x) => x.code === 'u2')) ok('and a 5s dip inside the guard is not - that is sampling jitter');
    else bad('jitter was reported as a reboot');
    if (!r.some((x) => x.code === 'u3')) ok('a null uptime is not a reboot - Number(null) is 0 and would look like one');
    else bad('a null uptime was read as a reboot');
}

// --- THE GENERATED DIFFERENTIAL -----------------------------------------------
console.log('');
{
    const PARENT = 'C:/Workspace/alertcanvas/server/rules.js';
    if (!fs.existsSync(PARENT)) {
        console.log(`  skip differential: ${PARENT} not present on this machine`);
    } else {
        const req = createRequire(import.meta.url);
        const parent = req(PARENT) as {
            evaluate: (d: unknown, c: unknown) => unknown[];
            detectReboots: (p: Map<string, number>, m: unknown[]) => unknown[];
        };

        // Deterministic, so a mismatch is reproducible from the seed alone.
        let seed = 20260727;
        const rnd = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
        const maybe = <T,>(v: T, p = 0.25): T | null => (rnd() < p ? null : v);

        const STATUSES = ['up', 'down', 'unknown', null];
        const genDoc = (): ScanDoc => {
            const devs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, n) => ({
                name: `dev${n}`, host: `10.0.0.${n}`, status: pick(STATUSES),
            }));
            return {
                devices: rnd() < 0.8 ? devs : undefined,
                interfaces: Array.from({ length: Math.floor(rnd() * 4) }, (_, n) => ({
                    id: `dev${Math.floor(rnd() * devs.length)}:${n}`,
                    code: rnd() < 0.9 ? `if${n}` : null,
                    name: `Gi0/${n}`,
                    alias: maybe('uplink', 0.5),
                    device: rnd() < 0.8 ? pick(devs) : null,
                    adminStatus: pick(STATUSES),
                    operStatus: pick(STATUSES),
                    speedBps: pick([0, 1e6, 1e9, null]),
                    inBps: maybe(rnd() * 2e9),
                    outBps: maybe(rnd() * 2e9),
                    inErrorsPerSec: maybe(rnd() * 20),
                    outErrorsPerSec: maybe(rnd() * 20),
                    inDiscardsPerSec: maybe(rnd() * 20),
                    outDiscardsPerSec: maybe(rnd() * 20),
                })),
                metrics: Array.from({ length: Math.floor(rnd() * 5) }, (_, n) => ({
                    code: rnd() < 0.9 ? `m${n}` : null,
                    host: pick(devs).name,
                    kind: pick([...METRIC_KINDS, 'gpu']),   // 'gpu' is an unconfigured kind
                    value: rnd() < 0.15 ? null : rnd() * 120,
                    unit: pick(['%', 'C', '', null]),
                    display: maybe(`Sensor ${n} 42%`, 0.5),
                })),
            } as ScanDoc;
        };
        const genConfig = (): RulesConfig => ({
            ...CONFIG,
            deviceDown: { enabled: rnd() < 0.8, severity: pick(['crit', 'warn'] as const) },
            ifRules: {
                ...CONFIG.ifRules,
                down: { enabled: rnd() < 0.8, severity: pick(['crit', 'warn'] as const) },
                util: rnd() < 0.8 ? { warn: 70, crit: 90 } : null,
            },
            overrides: rnd() < 0.5 ? [{
                scope: pick(['code', 'host-kind'] as const),
                code: 'if1', host: 'dev0', kind: pick(['cpu', 'if-errors', 'device-down']),
                warn: 5, crit: 15, severity: 'warn', enabled: rnd() < 0.7,
            }] : [],
        });

        let mismatches = 0;
        const N = 400;
        for (let i = 0; i < N && mismatches < 3; i++) {
            const doc = genDoc();
            const cfg = genConfig();
            const mine = JSON.stringify(evaluate(doc, cfg));
            const theirs = JSON.stringify(parent.evaluate(doc, cfg));
            if (mine !== theirs) {
                mismatches++;
                bad(`differential mismatch on generated document ${i}`,
                    `\n         fork:   ${mine.slice(0, 220)}\n         parent: ${theirs.slice(0, 220)}`
                    + `\n         doc:    ${JSON.stringify(doc).slice(0, 300)}`);
            }
        }
        if (mismatches === 0) {
            ok(`${N} generated documents evaluate IDENTICALLY to the parent's JavaScript`);
        }

        let rebootMismatch = 0;
        for (let i = 0; i < 100; i++) {
            const prev = new Map([['u1', rnd() * 200_000], ['u2', rnd() * 100]]);
            const ms: ScanMetric[] = [
                { code: 'u1', host: 'a', kind: 'uptime', value: rnd() < 0.2 ? null : rnd() * 200_000 },
                { code: 'u2', host: 'b', kind: 'uptime', value: rnd() * 100 },
                { code: 'u3', host: 'c', kind: 'cpu', value: 5 },
            ];
            if (JSON.stringify(detectReboots(prev, ms)) !== JSON.stringify(parent.detectReboots(prev, ms))) {
                rebootMismatch++;
            }
        }
        if (rebootMismatch === 0) ok('and 100 reboot-detection cases match, including the null and jitter paths');
        else bad(`${rebootMismatch} reboot-detection mismatches`);
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
