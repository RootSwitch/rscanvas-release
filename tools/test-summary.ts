// The poll-time roster summary (src/collector/summary.ts).
//
//   node tools/test-summary.ts
//
// Every rule the roster's columns depend on, pinned: untracked interfaces do
// not count, admin-down is not down, fullest and busiest are picks, a
// convicted speed yields no share, nothing reads as zero when nothing was
// measured, and state sensors count alarms by status.

import { summarizeReadings, type IfReading, type SensorReading } from '../src/collector/summary.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? (pass++, console.log(`  ok   ${l}`))
        : (fail++, console.log(`  FAIL ${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
};
const IF = (p: Partial<IfReading>): IfReading => ({
    name: 'x', tracked: true, operStatus: 1, adminStatus: 1,
    inBps: null, outBps: null, inErrs: null, outErrs: null, trustedSpeedBps: 1e9, ...p,
});
const S = (p: Partial<SensorReading>): SensorReading => ({ kind: 'cpu', name: 's', v0: null, v1: null, status: null, ...p });

console.log('nothing measured:');
const empty = summarizeReadings([], []);
eq('every reading is null, never zero', [empty.cpu_pct, empty.mem_pct, empty.fs_pct, empty.temp_c, empty.if_errs, empty.top_bps, empty.batt_pct], [null, null, null, null, null, null, null]);
eq('counts are zero', [empty.if_count, empty.down_ports, empty.alarms, empty.state_sensors], [0, 0, 0, 0]);

console.log('\ninterfaces:');
const ifs = summarizeReadings([
    IF({ name: 'Gi0/1', inBps: 5e6, outBps: 9e8, inErrs: 0, outErrs: 2.5 }),
    IF({ name: 'Gi0/2', operStatus: 2, inBps: 0, outBps: 0 }),
    IF({ name: 'Gi0/3', operStatus: 2, adminStatus: 2 }),
    IF({ name: 'Nu0', tracked: false, operStatus: 2, inBps: 5e9, outBps: 5e9, inErrs: 99, outErrs: 99 }),
], []);
eq('tracked interfaces counted, untracked not', ifs.if_count, 3);
eq('down = oper down while admin up; the admin-down port is not counted', ifs.down_ports, 1);
eq('the busiest TRACKED interface wins, by the larger direction', [ifs.top_if, ifs.top_bps], ['Gi0/1', 9e8]);
eq('its trusted speed rides along', ifs.top_speed, 1e9);
eq('worst errors/s across tracked interfaces, larger direction', ifs.if_errs, 2.5);
const convicted = summarizeReadings([IF({ name: 'eth0', inBps: 1e6, outBps: 2e6, trustedSpeedBps: null })], []);
eq('a convicted (untrusted) speed yields no share denominator', [convicted.top_if, convicted.top_speed], ['eth0', null]);

console.log('\nsensors:');
const sen = summarizeReadings([], [
    S({ kind: 'cpu', v0: 12 }), S({ kind: 'cpu', v0: 37.26 }),
    S({ kind: 'mem', name: 'Physical memory', v0: 3e9, v1: 4e9 }),
    S({ kind: 'fs', name: '/', v0: 50, v1: 100 }), S({ kind: 'fs', name: '/var', v0: 91, v1: 100 }), S({ kind: 'fs', name: '/empty', v0: 0, v1: 0 }),
    S({ kind: 'temp', v0: 41 }), S({ kind: 'temp', v0: 55.55 }),
    S({ kind: 'state', status: 1 }), S({ kind: 'state', status: 2 }), S({ kind: 'state', status: 2 }),
    S({ kind: 'battery', v0: 88 }), S({ kind: 'runtime', v0: 1234 }),
    S({ kind: 'gauge', v0: 999 }),
]);
eq('CPU is the highest reading, rounded to a tenth', sen.cpu_pct, 37.3);
eq('memory is used/size as a percentage', sen.mem_pct, 75);
eq('fullest filesystem is a PICK with its name; a zero-size row is ignored', [sen.fs_pct, sen.fs_name], [91, '/var']);
eq('temperature is the hottest sensor', sen.temp_c, 55.6);
eq('state sensors: counted, alarms by status 2', [sen.state_sensors, sen.alarms], [3, 2]);
eq('UPS charge and runtime', [sen.batt_pct, sen.runtime_s], [88, 1234]);
eq('a kind the roster does not show changes nothing', sen.if_count, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
