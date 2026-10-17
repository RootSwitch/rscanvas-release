// The availability report's arithmetic (src/reports/availability.ts), offline.
//
//   node tools/test-availability-report.ts
//
// What a reader trusts the page for: probes inside maintenance left out of
// the share and counted; groups POOLED (probes over probes), never an average
// of shares; a device with nothing outside maintenance has no availability
// rather than 100%; the unassigned group said, not dropped; worst first; and
// the CSV carrying the same figures.

import {
    availabilityCsv, availabilityLines, leftOutTransient, parseAvailabilityGroup, UNASSIGNED, type AvailabilityRow,
} from '../src/reports/availability.ts';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

const row = (over: Partial<AvailabilityRow>): AvailabilityRow => ({
    device: 'd', location: 'Closet', application: null, address: '192.0.2.1',
    probes: 1440, misses: 0, planned_probes: 0, planned_misses: 0,
    hours_measured: 24, hours_total: 24, outages: 0, blips: 0,
    longest_s: 0, down_s: 0, planned_down_s: 0, ...over,
});

console.log('availability report arithmetic');

console.log('\none device:');
const [clean] = availabilityLines([row({ device: 'sw1' })], 'device');
eq('every probe answered is 100%, all of it measured', [clean?.pct, clean?.measuredPct], [100, 100]);
const [down] = availabilityLines([row({ device: 'fw', misses: '36', outages: 1, longest_s: 2100, down_s: 2160 })], 'device');
eq('36 of 1,440 missed is 97.5% - the store hands counts as text and they are read as numbers',
    down?.pct, 97.5);
const [planned] = availabilityLines([row({ device: 'dc3', misses: 10, planned_probes: 10, planned_misses: 10, planned_down_s: 600 })], 'device');
eq('ten probes missed inside a maintenance window leave the share at 100%, and are counted',
    [planned?.pct, planned?.plannedProbes, planned?.plannedDownS], [100, 10, 600]);
const [allPlanned] = availabilityLines([row({ device: 'x', probes: 60, misses: 60, planned_probes: 60, planned_misses: 60 })], 'device');
eq('a device probed only inside maintenance has no availability - not 100%, and not 0%', allPlanned?.pct, null);
const [half] = availabilityLines([row({ device: 'y', hours_measured: 12, hours_total: 24 })], 'device');
eq('looked at for twelve of twenty-four hours is 50% measured', half?.measuredPct, 50);
eq('a device line carries its address and groups', [clean?.address, clean?.location, clean?.devices], ['192.0.2.1', 'Closet', 1]);

console.log('\ngroups pool, never average:');
const rows = [
    row({ device: 'a', location: 'Closet', probes: 1440, misses: 144, outages: 2, longest_s: 900, down_s: 1500 }),
    row({ device: 'b', location: 'Closet', probes: 60, misses: 0, hours_measured: 1, hours_total: 1, longest_s: 30, down_s: 30, blips: 1 }),
    row({ device: 'c', location: null }),
    row({ device: 'e', location: '  ', misses: 1 }),
];
const byLoc = availabilityLines(rows, 'location');
const closet = byLoc.find((l) => l.name === 'Closet');
eq('Closet is (1,500 - 144) / 1,500 = 90.4% - the mean of 90% and 100% would say 95%',
    closet && Math.round(closet.pct! * 10) / 10, 90.4);
eq('its counts add, its longest is the longest, its measured pools the hours',
    closet && [closet.devices, closet.outages, closet.blips, closet.longestS, closet.downS, closet.measuredPct],
    [2, 2, 1, 900, 1530, 100]);
const none = byLoc.find((l) => l.name === UNASSIGNED);
eq('no location, and a blank one, are one group called (unassigned)', none && [none.devices, none.probes, none.misses], [2, 2880, 1]);
eq('a group line names no device address', closet?.address, null);

console.log('\nworst first:');
const order = availabilityLines([
    row({ device: 'fine' }),
    row({ device: 'bad', misses: 100 }),
    row({ device: 'empty', probes: 0, misses: 0 }),
    row({ device: 'tied-more-down', misses: 1, down_s: 600 }),
    row({ device: 'tied-less-down', misses: 1, down_s: 60 }),
], 'device').map((l) => l.name);
eq('lowest share first, then more time down, a line with no share last', order,
    ['bad', 'tied-more-down', 'tied-less-down', 'fine', 'empty']);

console.log('\nthe CSV:');
const csv = availabilityCsv(availabilityLines([row({ device: 'sw1', misses: 3, outages: 1, longest_s: 125.4, down_s: 190.6 })], 'device'), 'device').split('\n');
// The house CSV (export/csv.ts) quotes every cell, which also guards formulas.
eq('a device header', csv[0], '"device","address","location","application","availability_pct","probes","missed","probes_in_maintenance",'
    + '"measured_pct","outages","blips","longest_outage_s","down_s","down_in_maintenance_s"');
eq('and its line: the share to three places, seconds whole', csv[1], '"sw1","192.0.2.1","Closet","","99.792","1440","3","0","100.0","1","0","125","191","0"');
const gcsv = availabilityCsv(availabilityLines(rows, 'application'), 'application').split('\n');
eq('a group CSV names the group and counts devices', [gcsv[0]?.startsWith('"application","devices","availability_pct"'), gcsv[1]?.startsWith('"(unassigned)","4",')],
    [true, true]);

console.log('\ntransient devices:');
const withLaptop = [row({ device: 'sw1' }), row({ device: 'laptop-1', transient: true, misses: 1390 })];
eq('a transient device is left out of the list - off is its state, and 3% would top it for nothing',
    availabilityLines(withLaptop, 'device').map((l) => l.name), ['sw1']);
eq('and out of its group\'s pool', availabilityLines(withLaptop, 'location')[0]?.pct, 100);
eq('and named, so the page can say who', leftOutTransient(withLaptop), ['laptop-1']);

console.log('\nthe group parameter:');
eq('absent and "device" are by device; location and application are groups; anything else is refused',
    [parseAvailabilityGroup(null), parseAvailabilityGroup('device'), parseAvailabilityGroup('location'),
        parseAvailabilityGroup('application'), parseAvailabilityGroup('rack')],
    ['device', 'device', 'location', 'application', null]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
