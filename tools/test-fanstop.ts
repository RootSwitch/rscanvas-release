// The stopped-fan alert (src/alerts/fanstop.ts), offline.
//
//   node tools/test-fanstop.ts
//
// Which fans take part - production's own fan names first, a graphics
// card's parked fan above all - the operator's include and exclude at each
// tier, the device's state (muted, down, transient), readings that are no
// evidence, and the words a notification carries. Then production's GPU fan
// replayed: 82% of its polls read 0, and it must raise nothing by default.

import {
    fanStopConditions, fanStopState, parksWhenIdle, fanStopKey, FAN_STOPPED_KIND,
} from '../src/alerts/fanstop.ts';
import {
    buildOverrideIndex, resolveRuleInfo, evaluate, BOOL_RULE_KINDS, FAN_STOPPED_DEFAULT,
    type Override, type RulesConfig, type ScanDevice, type ScanDoc, type ScanMetric,
} from '../src/alerts/rules.ts';
import { DEFAULT_RULES } from '../src/alerts/scan.ts';
import { varsFor } from '../src/alerts/templates.ts';
import { insideClearBand } from '../src/alerts/hysteresis.ts';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

console.log('the stopped-fan alert');

// --- names ---------------------------------------------------------------------------
console.log('\nwhich fans park while idle, by name (production has three: two on a switch, one a graphics card\'s):');
const names: Array<[string, boolean]> = [
    ['Fan 1', false], ['Fan 2', false], ['Fan: GPU1', true],
    ['Fan: gpu0', true], ['Fan: amdgpu', true], ['Fan: Graphics', true], ['Fan: VGA', true],
    ['Fan: Chassis1', false], ['CPU_FAN1', false], ['SYS_FAN2', false], ['Fan: PSU', false],
];
for (const [n, want] of names) eq(`${n}: ${want ? 'parks' : 'judged'}`, parksWhenIdle(n), want);

// --- the rule's place among the others -------------------------------------------------
console.log('\nthe rule ships on, warn, and is a yes/no rule:');
eq('the default', FAN_STOPPED_DEFAULT, { enabled: true, severity: 'warn' });
eq('DEFAULT_RULES carries it', DEFAULT_RULES.fanStopped, FAN_STOPPED_DEFAULT);
eq('a yes/no kind: an override takes no level', BOOL_RULE_KINDS.has(FAN_STOPPED_KIND), true);
eq('resolveRuleInfo knows it', resolveRuleInfo(buildOverrideIndex([]), DEFAULT_RULES, FAN_STOPPED_KIND, 'F2', 'sw'),
    { source: 'default', muted: false, levels: null });
eq('no clear band: a fan turning again is recovered', insideClearBand(FAN_STOPPED_KIND, 120, null), false);

// --- conditions ----------------------------------------------------------------------
const dev = (name: string, over: Partial<ScanDevice> = {}): ScanDevice => ({ name, host: '10.0.0.1', status: 'up', ...over });
const fan = (code: string, host: string, name: string, value: number | null): ScanMetric =>
    ({ code, host, kind: 'fan', value, unit: 'rpm', display: name });
const doc = (devices: ScanDevice[], metrics: ScanMetric[]): ScanDoc => ({ devices, metrics });
const cfgWith = (overrides: Override[], extra: Partial<RulesConfig> = {}): RulesConfig => ({ ...DEFAULT_RULES, ...extra, overrides });
const run = (d: ScanDoc, overrides: Override[] = [], extra: Partial<RulesConfig> = {}) => {
    const cfg = cfgWith(overrides, extra);
    return fanStopConditions(d, cfg, buildOverrideIndex(cfg.overrides));
};
const brief = (cs: ReturnType<typeof run>) => cs.map((c) => [c.key, c.severity, c.frozen, c.value]);

console.log('\na switch with one fan turning and one stopped, and a host whose graphics card is idle:');
const base = doc([dev('sw'), dev('gpuhost')], [
    fan('F1', 'sw', 'Fan 1', 3990), fan('F2', 'sw', 'Fan 2', 0), fan('G1', 'gpuhost', 'Fan: GPU1', 0),
    { code: 'T1', host: 'sw', kind: 'temp', value: 0, unit: 'C', display: 'Temp: Board' },
    { code: null, host: 'sw', kind: 'fan', value: 0, unit: 'rpm', display: 'Fan 9' },
]);
const cs = run(base);
eq('one condition per judged fan: the turning one normal, the stopped one warn; the GPU, the temperature and the codeless row none',
    brief(cs), [['fanstop:F1', null, false, 3990], ['fanstop:F2', 'warn', false, 0]]);
const f2 = cs.find((c) => c.code === 'F2');
eq('its label, kind, unit and key', f2 && [f2.label, f2.kind, f2.unit, f2.threshold, f2.key],
    ['sw Fan 2 stopped', 'fan-stopped', 'rpm', null, fanStopKey('F2')]);
eq('evaluate() is untouched - it still emits nothing for a fan with no levels',
    evaluate(base, DEFAULT_RULES).filter((c) => c.code === 'F2').length, 0);

console.log('\nreadings that are no evidence freeze:');
const blank: Array<[string, number | null]> = [['stale (null)', null], ['not a number', Number.NaN], ['negative', -1]];
for (const [label, v] of blank) {
    eq(label, brief(run(doc([dev('sw')], [fan('F2', 'sw', 'Fan 2', v)]))), [['fanstop:F2', null, true, null]]);
}
eq('a fraction of an rpm is turning, and says so', brief(run(doc([dev('sw')], [fan('F2', 'sw', 'Fan 2', 0.4)]))),
    [['fanstop:F2', null, false, 0.4]]);

console.log('\nthe device\'s state:');
eq('muted: nothing at all', run(doc([dev('sw', { muted: true })], [fan('F2', 'sw', 'Fan 2', 0)])).length, 0);
eq('down: frozen - device-down speaks', brief(run(doc([dev('sw', { status: 'down' })], [fan('F2', 'sw', 'Fan 2', 0)]))),
    [['fanstop:F2', null, true, null]]);
eq('down and transient: quiet, not frozen (ruling 4)',
    brief(run(doc([dev('sw', { status: 'down', transient: true })], [fan('F2', 'sw', 'Fan 2', 0)]))),
    [['fanstop:F2', null, false, null]]);
eq('a device missing from the roster still judges its fans', brief(run(doc([], [fan('F2', 'sw', 'Fan 2', 0)]))),
    [['fanstop:F2', 'warn', false, 0]]);

console.log('\nthe operator\'s rows:');
const row = (o: Partial<Override>): Override => ({ scope: 'code', kind: FAN_STOPPED_KIND, enabled: true, ...o } as Override);
eq('this fan off: gone', run(base, [row({ code: 'F2', enabled: false })]).map((c) => c.code), ['F1']);
eq('the GPU fan included: judged, and stopped', brief(run(base, [row({ code: 'G1' })])).find((c) => c[0] === 'fanstop:G1'),
    ['fanstop:G1', 'warn', false, 0]);
eq('this fan on at crit', brief(run(base, [row({ code: 'F2', severity: 'crit' })])).find((c) => c[0] === 'fanstop:F2'),
    ['fanstop:F2', 'crit', false, 0]);
eq('the switch turned off: neither of its fans', run(base, [row({ scope: 'host-kind', host: 'sw', enabled: false })]).length, 0);
eq('the GPU host turned ON adds nothing a name did not: still no GPU fan',
    run(base, [row({ scope: 'host-kind', host: 'gpuhost', enabled: true })]).map((c) => c.code), ['F1', 'F2']);
eq('a fan included under a device turned off: its own row wins',
    run(base, [row({ scope: 'host-kind', host: 'sw', enabled: false }), row({ code: 'F2' })]).map((c) => c.code), ['F2']);
eq('off for every device: none', run(base, [row({ scope: 'kind', enabled: false })]).length, 0);
eq('off for every device, one fan included: that one',
    run(base, [row({ scope: 'kind', enabled: false }), row({ code: 'F1' })]).map((c) => c.code), ['F1']);
eq('the config at crit', brief(run(base, [], { fanStopped: { enabled: true, severity: 'crit' } })).find((c) => c[0] === 'fanstop:F2'),
    ['fanstop:F2', 'crit', false, 0]);
eq('the config off: none', run(base, [], { fanStopped: { enabled: false } }).length, 0);

console.log('\nwhat the card is told, from the same function the scan uses:');
const st = (code: string, host: string, name: string, overrides: Override[] = [], extra: Partial<RulesConfig> = {}) => {
    const cfg = cfgWith(overrides, extra);
    const s = fanStopState(buildOverrideIndex(cfg.overrides), cfg, code, host, name);
    return [s.on, s.why];
};
eq('a switch fan', st('F1', 'sw', 'Fan 1'), [true, 'default']);
eq('a graphics card\'s', st('G1', 'gpuhost', 'Fan: GPU1'), [false, 'parks']);
eq('its own row on', st('G1', 'gpuhost', 'Fan: GPU1', [row({ code: 'G1' })]), [true, 'this sensor']);
eq('its own row off', st('F1', 'sw', 'Fan 1', [row({ code: 'F1', enabled: false })]), [false, 'this sensor']);
eq('its device off', st('F1', 'sw', 'Fan 1', [row({ scope: 'host-kind', host: 'sw', enabled: false })]), [false, 'this device']);
eq('every device off', st('F1', 'sw', 'Fan 1', [row({ scope: 'kind', enabled: false })]), [false, 'every device']);
eq('the config off', st('F1', 'sw', 'Fan 1', [], { fanStopped: { enabled: false } }), [false, 'every device']);

console.log('\nthe words a notification carries:');
const a = { kind: FAN_STOPPED_KIND, severity: 'warn', value: 0, unit: 'rpm', label: 'sw Fan 2 stopped', host: 'sw' } as never;
eq('the detail says stopped, and that the sensor may be what died', varsFor(a, 'raise').detail,
    'reading 0 - the fan has stopped turning, or its speed sensor has stopped reporting it');
eq('the clear carries the reading it recovered to',
    varsFor({ ...(a as object), value: 3990 } as never, 'clear').reading, ' (now 3990rpm)');

// --- production's graphics-card fan, replayed --------------------------------------------
// 34,344 of 41,982 polls read 0 from 10-03 to 10-18: the card idles with its
// fan parked. By default it is not judged at all, so not one of them raises.
console.log('\nproduction\'s graphics-card fan, 82% of its polls at 0:');
let raised = 0;
for (let i = 0; i < 1000; i++) {
    const v = i % 100 < 82 ? 0 : 1200 + i;
    raised += run(doc([dev('host')], [fan('G1', 'host', 'Fan: GPU1', v)])).filter((c) => c.severity !== null).length;
}
eq('not one of a thousand raises', raised, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
