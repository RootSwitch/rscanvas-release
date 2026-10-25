// The sensor re-pin planner: does a renumbered agent get its instructions
// refreshed, and does NOTHING else move?
//
//   node tools/test-sensor-repin.ts

import {
    planSensorRepin, type RepinExisting, type RepinDiscovered, type SensorExtra,
} from '../src/collector/sensors.ts';

// An early exit without a verdict must read as FAILURE, not as a green run
// with no output (the test-walk incident, 2026-09-01).
process.exitCode = 1;

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n         wanted ${w}\n         got    ${g}`); }
};

const HR = '1.3.6.1.2.1.25.3.3.1.2';
const ST = '1.3.6.1.2.1.25.2.3.1';
const cpuX = (...idx: number[]): SensorExtra =>
    ({ style: 'gauge-avg', oids: idx.map((i) => `${HR}.${i}`) });
const fsX = (idx: number): SensorExtra =>
    ({ style: 'hr-storage', allocUnits: 4096, usedOid: `${ST}.6.${idx}`, sizeOid: `${ST}.5.${idx}` });
const row = (id: string, kind: string, idx: string | null, name: string, extra: SensorExtra): RepinExisting =>
    ({ id, kind, snmp_index: idx, name, extra });
const find = (kind: string, idx: string, name: string, extra: SensorExtra): RepinDiscovered =>
    ({ kind, snmpIndex: idx, name, extra });

console.log('the DC shape - the reason this module exists:');
{
    // DC-3, literally: cpu pinned at hrProcessorLoad .4/.5, the reboot
    // re-dealt the cores to .3/.4. Same kind, same symbolic index 'cpu' -
    // the instruction refreshes in place.
    const plan = planSensorRepin(
        [find('cpu', 'cpu', 'CPU', cpuX(3, 4))],
        [row('e1', 'cpu', 'cpu', 'CPU', cpuX(4, 5))]);
    eq('a renumbered CPU re-pins by its symbolic index',
        plan, [{ id: 'e1', snmpIndex: 'cpu', name: 'CPU', extra: cpuX(3, 4) }]);
}
{
    // The fs case: the INDEX is the volatile part. "C:\" moved from
    // hrStorage 1 to 2; the row follows by name, index and OIDs together.
    const plan = planSensorRepin(
        [find('fs', '2', 'C:\\ Label:System', fsX(2))],
        [row('e1', 'fs', '1', 'C:\\ Label:System', fsX(1))]);
    eq('a renumbered filesystem follows its name to the new index',
        plan, [{ id: 'e1', snmpIndex: '2', name: 'C:\\ Label:System', extra: fsX(2) }]);
}

console.log('\nwhat must NOT move:');
{
    const same = planSensorRepin(
        [find('cpu', 'cpu', 'CPU', cpuX(3, 4)), find('fs', '1', 'C:\\', fsX(1))],
        [row('e1', 'cpu', 'cpu', 'CPU', cpuX(3, 4)), row('e2', 'fs', '1', 'C:\\', fsX(1))]);
    eq('an agent that did not renumber plans nothing - the midnight steady state writes no rows',
        same, []);
}
{
    // jsonb normalizes key order; identical instructions in a different
    // order must not read as drift or every midnight rewrites every row.
    const reordered: SensorExtra = JSON.parse(
        '{"sizeOid":"' + ST + '.5.1","usedOid":"' + ST + '.6.1","allocUnits":4096,"style":"hr-storage"}');
    eq('jsonb key order is not drift',
        planSensorRepin([find('fs', '1', 'C:\\', fsX(1))], [row('e1', 'fs', '1', 'C:\\', reordered)]),
        []);
}
{
    // The discover-if-NONE rule's other half: a sensor the operator deleted
    // appears in the discovery and matches no row - the plan may not invent
    // an insert for it.
    eq('a deleted sensor stays deleted - the plan never inserts',
        planSensorRepin([find('fs', '3', 'D:\\ junk', fsX(3))], []), []);
}
{
    // Two disks wearing one label: matching either is a guess, and a wrong
    // guess splices two histories. Refused.
    const plan = planSensorRepin(
        [find('fs', '5', 'Backup', fsX(5))],
        [row('e1', 'fs', '1', 'Backup', fsX(1)), row('e2', 'fs', '2', 'Backup', fsX(2))]);
    eq('an ambiguous name is refused, not guessed', plan, []);
}
{
    // The target index is still held by another row whose own match failed:
    // moving there would trip the unique key, so the planner refuses rather
    // than queueing a write the store must reject every midnight.
    const plan = planSensorRepin(
        [find('fs', '2', 'C:\\', fsX(2))],
        [row('e1', 'fs', '1', 'C:\\', fsX(1)), row('e2', 'fs', '2', 'old and gone', fsX(2))]);
    eq('a target index another row still holds is refused', plan, []);
}
{
    // Kinds never cross: a mem row cannot claim an fs discovery even with
    // a matching name.
    eq('kinds never cross-match',
        planSensorRepin([find('fs', '2', 'Physical memory', fsX(2))],
            [row('e1', 'mem', '5', 'Physical memory', fsX(5))]),
        []);
}

console.log('\nclaims are exclusive:');
{
    // A row matched by index (rule 1) is not up for grabs by name (rule 2),
    // and each discovery claims at most one row.
    const plan = planSensorRepin(
        [find('fs', '1', 'C:\\', fsX(1)), find('fs', '2', 'C:\\', fsX(2))],
        [row('e1', 'fs', '1', 'C:\\', fsX(1))]);
    eq('an index-matched row is not re-claimed by name, and duplicates fall away',
        plan, []);
}

console.log('\ndisks that trade indexes (2026-10-22):');
{
    // A production GPU server, literally: a kernel update's reboot mounted /boot/efi before
    // /mnt/models, and net-snmp numbers mounts in mount order. Rule 1 kept
    // each row on its old index - now the other disk's - so the models disk
    // filling up was raised as "/boot/efi".
    const rows = [row('r37', 'fs', '37', '/', fsX(37)), row('r51', 'fs', '51', '/boot', fsX(51)),
        row('models', 'fs', '52', '/mnt/models', fsX(52)), row('efi', 'fs', '53', '/boot/efi', fsX(53))];
    const plan = planSensorRepin([find('fs', '37', '/', fsX(37)), find('fs', '51', '/boot', fsX(51)),
        find('fs', '52', '/boot/efi', fsX(52)), find('fs', '53', '/mnt/models', fsX(53))], rows);
    eq('production\'s swap: both rows follow their names, together; the unmoved two plan nothing',
        plan.map((u) => [u.id, u.snmpIndex, u.extra.usedOid]).sort(),
        [['efi', '52', `${ST}.6.52`], ['models', '53', `${ST}.6.53`]]);
}
{
    const plan = planSensorRepin(
        [find('fs', '2', '/a', fsX(2)), find('fs', '3', '/b', fsX(3)), find('fs', '1', '/c', fsX(1))],
        [row('a', 'fs', '1', '/a', fsX(1)), row('b', 'fs', '2', '/b', fsX(2)), row('c', 'fs', '3', '/c', fsX(3))]);
    eq('three rotating: all three move', plan.map((u) => [u.id, u.snmpIndex]).sort(), [['a', '2'], ['b', '3'], ['c', '1']]);
}
{
    // /a wants 2, /b wants 3 - but 3 is held by /gone, whose disk is not
    // there to follow. /gone stays put, so /b cannot move, so /a cannot.
    const plan = planSensorRepin(
        [find('fs', '2', '/a', fsX(2)), find('fs', '3', '/b', fsX(3))],
        [row('a', 'fs', '1', '/a', fsX(1)), row('b', 'fs', '2', '/b', fsX(2)), row('gone', 'fs', '3', '/gone', fsX(3))]);
    eq('a move blocked by a row staying put blocks the move that needed its index - settled, not half-written',
        plan, []);
}
{
    const plan = planSensorRepin(
        [find('mem', '6', 'Memory: Physical memory', fsX(6))],
        [row('m', 'mem', '6', 'Memory: Swap space', fsX(6))]);
    eq('an hrStorage index that now holds another name is not the same row by index', plan, []);
    const sym = planSensorRepin(
        [find('cpu', 'cpu', 'CPU (8 cores)', cpuX(1, 2))],
        [row('c', 'cpu', 'cpu', 'CPU (4 cores)', cpuX(1))]);
    eq('...while a symbolic index still is, whatever its name says', sym.map((u) => u.id), ['c']);
}

console.log('\na CPU whose count changed (2026-10-25):');
{
    // Production's GPU server, 4 vCPUs to 10: the processor list and the counted
    // name move together.
    const plan = planSensorRepin(
        [find('cpu', 'cpu', 'CPU (10 cores)', cpuX(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))],
        [row('c', 'cpu', 'cpu', 'CPU (4 cores)', cpuX(1, 2, 3, 4))]);
    eq('more vCPUs: the new processor list and the name with it, from and to',
        plan.map((u) => [u.id, u.extra.oids?.length, u.rename]),
        [['c', 10, { from: 'CPU (4 cores)', to: 'CPU (10 cores)' }]]);
    // What production actually holds: a restart already re-pinned the ten
    // processors, and the name was left behind. The plan was empty there.
    const stale = planSensorRepin(
        [find('cpu', 'cpu', 'CPU (10 cores)', cpuX(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))],
        [row('c', 'cpu', 'cpu', 'CPU (4 cores)', cpuX(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))]);
    eq('a current processor list under a stale count is renamed alone',
        stale.map((u) => u.rename), [{ from: 'CPU (4 cores)', to: 'CPU (10 cores)' }]);
    eq('one core is "core", and back to many',
        planSensorRepin([find('cpu', 'cpu', 'CPU (2 cores)', cpuX(1, 2))],
            [row('c', 'cpu', 'cpu', 'CPU (1 core)', cpuX(1))]).map((u) => u.rename?.to), ['CPU (2 cores)']);
    eq('a steady CPU plans nothing',
        planSensorRepin([find('cpu', 'cpu', 'CPU (10 cores)', cpuX(1, 2))],
            [row('c', 'cpu', 'cpu', 'CPU (10 cores)', cpuX(1, 2))]), []);
    eq('a vendor CPU ("CPU", no count) keeps its name',
        planSensorRepin([find('cpu', 'cpu', 'CPU', cpuX(3, 4))],
            [row('c', 'cpu', 'cpu', 'CPU', cpuX(4, 5))]).map((u) => u.rename), [undefined]);
    eq('nor is a counted name traded for a vendor one',
        planSensorRepin([find('cpu', 'cpu', 'CPU', cpuX(1))],
            [row('c', 'cpu', 'cpu', 'CPU (4 cores)', cpuX(1, 2, 3, 4))]).map((u) => u.rename), [undefined]);
    // Every other kind's name is identity: a temperature whose label moved
    // at the same index re-pins its instruction and keeps its name.
    eq('another kind\'s name never follows',
        planSensorRepin([find('temp', 'lm-3', 'Temp: Package id 1', cpuX(9))],
            [row('t', 'temp', 'lm-3', 'Temp: Package id 0', cpuX(8))]).map((u) => u.rename), [undefined]);
    eq('...and a name change alone moves nothing there',
        planSensorRepin([find('temp', 'lm-3', 'Temp: Package id 1', cpuX(8))],
            [row('t', 'temp', 'lm-3', 'Temp: Package id 0', cpuX(8))]), []);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
