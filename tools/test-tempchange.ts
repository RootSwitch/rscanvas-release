// Change from normal (src/alerts/tempchange.ts), offline.
//
//   node tools/test-tempchange.ts
//
// The classifier over every temperature name production had on 2026-10-16
// (the replay's 72), the operator's include and exclude, and the two rules
// at their edges: one sensor at its floor and its spread, a room at
// min(3, n), a room short of witnesses, a down device, a muted one. Then the
// words a notification carries.

import {
    classifyTempSensor, participation, takingPart, changeConditions, minReadings, gateOf, roomKey, parseRoomKey,
    BASELINE_MIN_HOURS, SINGLE_FLOOR_C, ROOM_FLOOR_C, type ChangeSensor,
} from '../src/alerts/tempchange.ts';
import { buildOverrideIndex, resolveRuleInfo, BOOL_RULE_KINDS, type Override, type RulesConfig } from '../src/alerts/rules.ts';
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

console.log('change from normal');

// --- the classifier, on production's own names -----------------------------------
console.log('\nproduction names that follow the ROOM, one of each kind the minute replay judged:');
const room: Array<[string, string | null, string]> = [
    ['Temp: da1', 'nas', 'disk'], ['Temp: da6', 'nas', 'disk'],
    ['Temp: temp1', 'server', 'board'], ['Temp: SYSTIN', 'server', 'board'],
    ['Temp: AUXTIN1', 'server', 'board'], ['Temp: AUXTIN3', 'server', 'board'],
    ['Temp: sensor0', 'server', 'nic'], ['Temp: mlx5-pci-0101:sensor0', 'server', 'nic'],
    ['Temp: Module0', 'server', 'dimm'], ['Temp: Module1', 'server', 'dimm'],
    ['Temp: CPU temperature', 'switch', 'switch'],
];
for (const [n, st, want] of room) eq(`${n} on a ${st}: ${want}`, classifyTempSensor(n, st), want);

console.log('\nproduction names that follow WORK (left out - the replay was quiet only without them):');
const work: Array<[string, string | null]> = [
    ['Temp: Package id 0', 'server'], ['Temp: Tctl', 'server'], ['Temp: CPUTIN', 'server'],
    ['Temp: GPU0', 'server'], ['Temp: GPU1-Edge', 'server'], ['Temp: GPU1-Mem', 'server'], ['Temp: GPU', 'server'],
    ['Temp: edge', 'server'], ['Temp: Composite', 'server'], ['Temp: nvme-pci-0800:Composite', 'server'],
    ['Temp: Sensor 1', 'server'], ['Temp: Sensor 2', 'server'], ['Temp: nvme-pci-0800:Sensor 2', 'server'],
    ['Temp: nvd0', 'nas'], ['Temp: pch_cometlake-virtual-0:temp1', 'server'],
];
for (const [n, st] of work) eq(`${n}: none`, classifyTempSensor(n, st), null);

console.log('\nthe stencil decides a CPU-named sensor, and other vendors\' names:');
eq('"CPU temperature" on a router is its work', classifyTempSensor('Temp: CPU temperature', 'router'), null);
eq('"CPU temperature" with no stencil is its work', classifyTempSensor('Temp: CPU temperature', null), null);
eq('a switch\'s PSU follows its PoE load', classifyTempSensor('PSU1 temperature', 'switch'), null);
eq('a switch\'s SFP is left out', classifyTempSensor('SFP+ 1 temperature', 'switch'), null);
eq('an inlet sensor is air', classifyTempSensor('Inlet Temp', 'server'), 'ambient');
eq('an ambient sensor is air', classifyTempSensor('Ambient', 'server'), 'ambient');
eq('a UPS probe is air, whatever the operator named it', classifyTempSensor('Temp: Rack 4 rear', 'ups'), 'ambient');
eq('a UPS battery warms with charging: out', classifyTempSensor('Temp: Battery', 'ups'), null);
eq('acpitz is the board', classifyTempSensor('Temp: acpitz-acpi-0:temp1', 'server'), 'board');
eq('a SATA disk by drivetemp', classifyTempSensor('Temp: drivetemp-scsi-0-0:temp1', 'server'), 'disk');
eq('an unknown name takes no part by itself', classifyTempSensor('Temp: iwlwifi_1-virtual-0:temp1', 'server'), null);
eq('an empty name', classifyTempSensor('', 'server'), null);

// --- participation -----------------------------------------------------------------
console.log('\nwho takes part:');
const ov = (o: Partial<Override> & { scope: Override['scope']; kind: string }): Override => ({ enabled: true, ...o });
const none = buildOverrideIndex([]);
eq('a room name, no rows: on by name', participation(none, 'c1', 'srv', 'nic'), { on: true, why: 'name' });
eq('a work name, no rows: off', participation(none, 'c1', 'srv', null), { on: false, why: 'not by name' });
const inc = buildOverrideIndex([ov({ scope: 'code', code: 'c1', kind: 'temp-change' })]);
eq('a work name INCLUDED on its card: on', participation(inc, 'c1', 'srv', null), { on: true, why: 'this sensor' });
const exc = buildOverrideIndex([ov({ scope: 'code', code: 'c1', kind: 'temp-change', enabled: false })]);
eq('a room name EXCLUDED on its card: off', participation(exc, 'c1', 'srv', 'nic'), { on: false, why: 'this sensor' });
const devOff = buildOverrideIndex([ov({ scope: 'host-kind', host: 'srv', kind: 'temp-change', enabled: false })]);
eq('the device turned off: its room names are off', participation(devOff, 'c1', 'srv', 'board'), { on: false, why: 'this device' });
const devOffInc = buildOverrideIndex([ov({ scope: 'host-kind', host: 'srv', kind: 'temp-change', enabled: false }),
    ov({ scope: 'code', code: 'c1', kind: 'temp-change' })]);
eq('...but a sensor included on its card still is', participation(devOffInc, 'c1', 'srv', null), { on: true, why: 'this sensor' });
const devOn = buildOverrideIndex([ov({ scope: 'host-kind', host: 'srv', kind: 'temp-change' })]);
eq('a device turned ON does not sweep its CPU in', participation(devOn, 'c1', 'srv', null), { on: false, why: 'not by name' });
const fleetOff = buildOverrideIndex([ov({ scope: 'kind', kind: 'temp-change', enabled: false })]);
eq('the fleet\'s single-sensor switch off leaves participation (rooms) to the name', participation(fleetOff, 'c1', 'srv', 'nic'), { on: true, why: 'name' });

// --- the rules -----------------------------------------------------------------------
const cfg: RulesConfig = DEFAULT_RULES;
let n = 0;
const S = (o: Partial<ChangeSensor>): ChangeSensor => ({
    code: `c${++n}`, name: 'Temp: SYSTIN', host: 'srv', location: 'Closet A', stencil: 'server',
    status: 'up', transient: false, muted: false, pollS: 30, hours: 168, med: 40, q1: 39.5, q3: 40.5,
    r10: 40, n10: 20, r20: 40, n20: 40, ...o,
});
const conds = (ss: ChangeSensor[], idx = none, c = cfg) => changeConditions(takingPart(ss, idx), c, idx);

console.log('\nthe arithmetic:');
eq('half a window of 30 s readings: 20 in 20 minutes', minReadings(1200, 30), 20);
eq('a 300 s poller needs two in 10 minutes', minReadings(600, 300), 2);
eq('a quiet sensor\'s gate is the floor', gateOf({ q1: 39.5, q3: 40.5 }, SINGLE_FLOOR_C), 8);
eq('a noisy one\'s is three spreads', gateOf({ q1: 36, q3: 40 }, SINGLE_FLOOR_C), 12);

console.log('\none sensor (20 minutes, max(3 x spread, 8 C)):');
const one = (o: Partial<ChangeSensor>) => conds([S({ location: null, ...o })])[0];
eq('at its week: normal, rise 0, gate 8', ((c) => [c?.severity, c?.value, c?.threshold, c?.frozen])(one({})), [null, 0, 8, false]);
eq('+8 exactly: not past the gate', one({ r20: 48 })?.severity, null);
eq('+8.1: warn', one({ r20: 48.1 })?.severity, 'warn');
eq('THE DEAD NIC FAN: +20 C, warn, value the rise',
    ((c) => [c?.severity, c?.value, c?.kind, c?.key.startsWith('change:')])(one({ name: 'Temp: mlx5-pci-0100:sensor0', r20: 60 })),
    ['warn', 20, 'temp-change', true]);
eq('a noisy sensor +10 is inside its three spreads', one({ q1: 36, q3: 40, r20: 50 })?.severity, null);
eq('a drop of 20 C is not this rule\'s', one({ r20: 20 })?.severity, null);
eq('short of readings: frozen', ((c) => [c?.severity, c?.frozen, c?.value])(one({ r20: 60, n20: 5 })), [null, true, null]);
eq('no readings at all: frozen', one({ r20: null, n20: 0 })?.frozen, true);
eq('its device down: frozen, whatever the last minutes said', one({ r20: 60, status: 'down' })?.frozen, true);
eq('a muted device: nothing', conds([S({ location: null, muted: true, r20: 60 })]).length, 0);
eq('a transient device: nothing', conds([S({ location: null, transient: true, r20: 60 })]).length, 0);
eq(`still learning (${BASELINE_MIN_HOURS - 1} h): nothing`, conds([S({ location: null, hours: BASELINE_MIN_HOURS - 1, r20: 60 })]).length, 0);
eq('a work-driven name +30 C: nothing', conds([S({ location: null, name: 'Temp: Package id 0', r20: 70 })]).length, 0);
eq('...included on its card: warn', conds([S({ code: 'cpu1', location: null, name: 'Temp: Package id 0', r20: 70 })],
    buildOverrideIndex([ov({ scope: 'code', code: 'cpu1', kind: 'temp-change' })]))[0]?.severity, 'warn');
eq('the fleet\'s switch off: no single condition', conds([S({ location: null, r20: 60 })], fleetOff).length, 0);

console.log('\na room (10 minutes, max(3 x spread, 3 C), min(3, n) of n >= 2 devices):');
const roomOf = (devs: Array<Partial<ChangeSensor>>, idx = none, c = cfg) =>
    conds(devs.map((o, i) => S({ host: `d${i}`, ...o })), idx, c).filter((x) => x.kind === 'temp-room');
eq('one device is not a room', roomOf([{ r10: 50 }]).length, 0);
eq('seven at their week: one normal room condition', ((r) => [r.length, r[0]?.severity, r[0]?.frozen, r[0]?.key])(roomOf(Array(7).fill({}))),
    [1, null, false, 'temp-room:location:Closet A']);
const ac = Array(7).fill(0).map((_, i) => (i < 3 ? { r10: 43.5 + i } : {}));
eq('THE CLOSET AC: three of seven past 3 C, warn', ((r) => [r[0]?.severity, r[0]?.value])(roomOf(ac)), ['warn', 3.5]);
eq('...its label names them, warmest first', roomOf(ac)[0]?.label, 'Closet A (location): 3 of 7 devices warmer than their week - d2, d1, d0');
eq('two of seven: normal', roomOf(Array(7).fill(0).map((_, i) => (i < 2 ? { r10: 45 } : {})))[0]?.severity, null);
eq('+3 exactly on three: normal', roomOf(Array(7).fill(0).map((_, i) => (i < 3 ? { r10: 43 } : {})))[0]?.severity, null);
eq('a two-device room raises on both', roomOf([{ r10: 44 }, { r10: 44 }])[0]?.severity, 'warn');
eq('...and not on one', roomOf([{ r10: 44 }, {}])[0]?.severity, null);
eq('two sensors on one device count once', roomOf([{ host: 'a', r10: 44 }, { host: 'a', r10: 44 }, { host: 'b', r10: 44 }, { host: 'c' }])[0]?.label,
    'Closet A (location): 2 of 3 devices warmer than their week - a, b');
eq('THE WITNESSES GONE: an open room alert whose servers shut down freezes, not clears',
    ((r) => [r[0]?.severity, r[0]?.frozen])(roomOf([{ r10: 50 }, { status: 'down' }, { status: 'down' }, { status: 'down' }])), [null, true]);
eq('three judged and quiet with one down: normal', ((r) => [r[0]?.severity, r[0]?.frozen])(roomOf([{}, {}, {}, { status: 'down' }])), [null, false]);
eq('rooms are per location', roomOf([{ r10: 44 }, { r10: 44, location: 'Lab' }, { r10: 44 }, { location: 'Lab' }]).map((r) => [r.key, r.severity]),
    [['temp-room:location:Closet A', 'warn'], ['temp-room:location:Lab', null]]);
eq('no location, no room', roomOf([{ r10: 50, location: null }, { r10: 50, location: '' }]).length, 0);
const roomOff = buildOverrideIndex([ov({ scope: 'kind', kind: 'temp-room', enabled: false })]);
eq('the fleet\'s room switch off: no room conditions', roomOf(ac, roomOff).length, 0);
eq('...one-sensor conditions stay', conds([S({ r20: 60 })], roomOff).map((c) => c.kind), ['temp-change']);
eq('a device turned off leaves its room', roomOf([{ host: 'a', r10: 44 }, { host: 'b', r10: 44 }, { host: 'c', r10: 44 }],
    buildOverrideIndex([ov({ scope: 'host-kind', host: 'c', kind: 'temp-change', enabled: false })]))[0]?.label,
    'Closet A (location): 2 of 2 devices warmer than their week - a, b');
eq('the room floor is lower than one sensor\'s', ROOM_FLOOR_C < SINGLE_FLOOR_C, true);

console.log('\nkeys and provenance:');
eq('a room key round-trips a location with a colon', parseRoomKey(roomKey('Rack 4: top')), 'Rack 4: top');
eq('a group key is not a room key', parseRoomKey('group:location:Lab'), null);
eq('both kinds are on-or-off', [BOOL_RULE_KINDS.has('temp-change'), BOOL_RULE_KINDS.has('temp-room')], [true, true]);
eq('provenance: on by default', resolveRuleInfo(none, cfg, 'temp-change', 'c1', 'srv'), { source: 'default', muted: false, levels: null });
eq('provenance: the fleet row off', resolveRuleInfo(roomOff, cfg, 'temp-room', null, null), { source: 'kind override', muted: true, levels: null });

console.log('\nwhat a notification says:');
const v = varsFor({ kind: 'temp-change', severity: 'warn', label: 'srv Temp: mlx5 above its week', host: 'srv', value: 20.4, threshold: 8, unit: 'C' }, 'raise');
eq('the detail says a rise, not a reading', v.detail,
    '20.4 C warmer than its median over the last week (it raises past +8 C - three times its usual spread, or 8 C)');
eq('a clear says where it stands on its week', varsFor({ kind: 'temp-change', severity: 'warn', value: 0.4, threshold: 8, unit: 'C' }, 'clear').reading,
    ' (now +0.4 C on its week)');
eq('a room says it is a room', varsFor({ kind: 'temp-room', severity: 'warn', value: 3.5, unit: 'C' }, 'raise').detail,
    'several devices in one location warmer than their own last week at once, at least 3.5 C each - the room, not one device: check its cooling');
eq('a room\'s clear carries no reading', varsFor({ kind: 'temp-room', severity: 'warn', value: 0.2, unit: 'C' }, 'clear').reading, '');
eq('a sensor clears a degree under its gate, not at it', [insideClearBand('temp-change', 7.5, 8), insideClearBand('temp-change', 6.9, 8)], [true, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
