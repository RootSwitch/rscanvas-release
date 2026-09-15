// The sensors slice's pure half: the parent's selection rules and value
// table, held to assertions so the port cannot drift from the choices it
// promised to carry. Same standing as test-machine, test-reach, test-events.
//
// PROVEN ABLE TO FAIL, 2026-08-14 - eight defects planted in the shipped
// module, every one caught, each named for the OPERATIONAL failure it would
// cause rather than the code it changes:
//
//   FS_NOISE loosened (containers flood the tracked set)        -> 9
//   RAM preference flattened (a UMA zone wins on pfSense)       -> 3
//   implausible temps tracked (unconnected headers page at 0C)  -> 3
//   alloc units dropped (bytes become blocks)                   -> 1
//   unknown state reads as ALARM (a UPS with no data pages)     -> 1
//   "Not Available" becomes zero (a BMC gap = a dead fan)       -> 1
//   extend takes the first line (upsc's banner poisons it)      -> 1
//   a >100 core reading stays in the CPU average                -> 1
//
// And the suite's own first failure was the AUTHOR's: 986 tenths-F asserted
// as 36.9C when 98.6F is exactly 37.0C - the one temperature everybody
// knows, miscalculated in the expectation while the ported code had it
// right. Kept in the record because a test that corrects its author is
// doing the same job as one that corrects the code.

import {
    matchVendor, pickRamRow, fsTracked, plausibleC, fanTracked, tempNameValid,
    sensorRaw, sensorSample, VENDORS, decodeExtendName, extendKind,
    type SensorExtra,
} from '../src/collector/sensors.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

const lookup = (m: Record<string, unknown>) => (oid: string): unknown => m[oid];

function main(): void {
    console.log('sensors offline: the ported choices\n');

    console.log('vendor matching');
    eq('longest prefix wins (Smart-UPS beats a bare APC arc would-be)',
        matchVendor('1.3.6.1.4.1.318.1.3.27.3', null)?.key, 'apc-smartups');
    eq('the Rack PDU branch is its own device type',
        matchVendor('1.3.6.1.4.1.318.1.3.4.6', null)?.key, 'apc-rpdu');
    eq('a bare enterprise root still matches its own prefix (trailing-dot compare)',
        matchVendor('1.3.6.1.4.1.14988', null)?.key, 'mikrotik');
    eq('no vendor is null, not a guess', matchVendor('1.3.6.1.4.1.99999.1', null), null);
    eq('sysObjectID absent falls through to nothing without a descr',
        matchVendor(null, null), null);

    console.log('\nfilesystem noise (discovered untracked, never hidden)');
    for (const noisy of ['/run', '/run/lock', '/dev/shm', '/proc', '/sys/fs/cgroup',
        '/snap/core/1', '/tmp', '/var/db/system/cores', '/pool/.zfs/snapshot/x']) {
        eq(`${noisy} is noise`, fsTracked(noisy), false);
    }
    for (const real of ['/', '/boot', '/boot/efi', '/var', '/var/lib/postgresql',
        '/home', '/mnt/tank', '/rundeck']) {
        eq(`${real} is tracked by default`, fsTracked(real), true);
    }

    console.log('\nthe RAM row (bsnmpd lists every UMA zone as hrStorageRam)');
    {
        const rows = [
            { idx: '1', descr: 'UMA zone: mbuf', alloc: 1, bytes: 5e9 },
            { idx: '2', descr: 'Physical memory', alloc: 4096, bytes: 8e9 },
            { idx: '3', descr: 'Real memory', alloc: 4096, bytes: 8e9 },
        ];
        eq('"Physical memory" wins whatever its size', pickRamRow(rows)?.idx, '2');
        eq('"Real memory" is second preference', pickRamRow(rows.filter((r) => r.idx !== '2'))?.idx, '3');
        eq('otherwise the LARGEST row - the zone rows are subsets of it',
            pickRamRow([
                { idx: '1', descr: 'UMA zone: mbuf', alloc: 1, bytes: 5e9 },
                { idx: '4', descr: 'Memory buffers', alloc: 1, bytes: 16e9 },
            ])?.idx, '4');
        eq('no rows is null, not a throw', pickRamRow([]), null);
    }

    console.log('\nplausibility gates');
    eq('0C is an unconnected header, untracked', plausibleC(0), false);
    eq('a wrapped negative is untracked', plausibleC(-273), false);
    eq('110C and past is a decode artifact', plausibleC(110), false);
    eq('a real reading tracks', plausibleC(48), true);
    eq('null never tracks', plausibleC(null), false);
    eq('a stopped fan (0 rpm) is untracked at discovery', fanTracked(0), false);
    eq('a spinning fan tracks', fanTracked(3990), true);
    eq('60000 rpm is a decode artifact', fanTracked(60000), false);
    eq('the FS/Ruijie padding row "dev:invalid" is no sensor', tempNameValid('dev:invalid'), false);
    eq('an empty name is no sensor', tempNameValid('  '), false);
    eq('SYSTIN is a sensor', tempNameValid('SYSTIN'), true);

    console.log('\nsensorRaw (string-flavoured agents)');
    eq('extend output takes the FIRST NUMERIC LINE - upsc prints a banner first',
        sensorRaw({ style: 'extend' }, 'SSL connect prohibited\n27.4\n'), 27.4);
    eq('extend with no numeric line is null', sensorRaw({ style: 'extend' }, 'error: no UPS'), null);
    eq('BMC "600.00rpm" parses leniently', sensorRaw({ style: 'asrock-str' }, '600.00rpm'), 600);
    eq('BMC "Not Available" is null, NEVER zero', sensorRaw({ style: 'asrock-str' }, 'Not Available'), null);
    eq('numeric styles pass through', sensorRaw({ style: 'div' }, '42'), 42);

    console.log('\nsensorSample: the value table, branch by branch');
    {
        const extra: SensorExtra = { style: 'gauge-avg', oids: ['a', 'b', 'c'] };
        eq('cpu is ONE entity, cores averaged',
            sensorSample('cpu', extra, lookup({ a: 10, b: 20, c: 30 })).v0, 20);
        eq('a core past 100 is a decode artifact and drops from the average',
            sensorSample('cpu', extra, lookup({ a: 10, b: 20, c: 400 })).v0, 15);
        eq('no cores answering is null, not zero',
            sensorSample('cpu', extra, lookup({})).v0, null);
    }
    {
        const extra: SensorExtra = { style: 'hr-storage', allocUnits: 4096, usedOid: 'u', sizeOid: 's' };
        const s = sensorSample('fs', extra, lookup({ u: 1000, s: 5000 }));
        eq('hr-storage multiplies allocation units into BYTES', [s.v0, s.v1], [4096000, 20480000]);
        eq('used answering without size keeps used',
            sensorSample('fs', extra, lookup({ u: 1000 })).v1, null);
    }
    {
        const extra: SensorExtra = { style: 'used-free', usedOid: 'u', freeOid: 'f' };
        const s = sensorSample('mem', extra, lookup({ u: 3e9, f: 1e9 }));
        eq('used-free computes total as used+free', [s.v0, s.v1], [3e9, 4e9]);
        eq('free missing means total unknown, used still real',
            sensorSample('mem', extra, lookup({ u: 3e9 })).v1, null);
    }
    {
        const extra: SensorExtra = { style: 'div', valueOid: 'v', div: 10 };
        eq('MikroTik tenths divide to degrees',
            sensorSample('temp', extra, lookup({ v: 385 })).v0, 38.5);
    }
    {
        const extra: SensorExtra = { style: 'tenthF', valueOid: 'v' };
        eq('the budget-PDU tenthF style converts to celsius (986 tenths-F = 98.6F = 37.0C)',
            sensorSample('temp', extra, lookup({ v: 986 })).v0, 37);
    }
    {
        const extra: SensorExtra = { style: 'div', valueOid: 'v', div: 100 };
        eq('runtime is TimeTicks/100 in seconds',
            sensorSample('runtime', extra, lookup({ v: 360000 })).v0, 3600);
        eq('a runtime past 1e7 seconds is a decode artifact, null',
            sensorSample('runtime', extra, lookup({ v: 1e12 })).v0, null);
    }
    {
        const extra: SensorExtra = {
            style: 'state', valueOid: 'v', okValues: [2], unknownValues: [1],
        };
        eq('online is 0/ok with the up badge',
            sensorSample('state', extra, lookup({ v: 2 })), { v0: 0, v1: null, status: 1 });
        eq('on battery is 1/alarm with the down badge',
            sensorSample('state', extra, lookup({ v: 3 })), { v0: 1, v1: null, status: 2 });
        eq('unknown (1) is null - no data, not ok, not alarm',
            sensorSample('state', extra, lookup({ v: 1 })), { v0: null, v1: null, status: null });
        eq('boost/trim/bypass (any non-ok enum) also read as the alarm state',
            sensorSample('state', extra, lookup({ v: 7 })).v0, 1);
    }

    console.log('\nNET-SNMP-EXTEND: the length-prefixed index and the naming convention');
    {
        // "temp-GPU" = 8 chars, then its ASCII codes. Off by one here and the
        // sensor never appears, with no error anywhere - which is why the
        // decode is a named function with its own assertions.
        const enc = (s: string): string =>
            [s.length, ...[...s].map((c) => c.charCodeAt(0))].join('.');
        eq('a name round-trips through the length-prefixed index',
            decodeExtendName(enc('temp-GPU')), 'temp-GPU');
        eq('names with dashes and digits survive',
            decodeExtendName(enc('runtime-UPS1')), 'runtime-UPS1');
        eq('a truncated index (length longer than the chars) is refused, not half-read',
            decodeExtendName('9.116.101.109.112'), null);
        eq('a zero length is refused', decodeExtendName('0'), null);
        eq('non-printable codes are refused rather than becoming control chars',
            decodeExtendName('2.7.9'), null);

        eq('batt- becomes a battery card called Batt:',
            extendKind('batt-UPS1'), { kind: 'battery', name: 'Batt: UPS1' });
        eq('util- becomes a GAUGE (percent), not a unit-less number',
            extendKind('util-UPS1-Load'), { kind: 'gauge', name: 'Util: UPS1-Load' });
        eq('runtime- keeps its seconds semantics',
            extendKind('runtime-UPS1'), { kind: 'runtime', name: 'Runtime: UPS1' });
        eq('temp- is a temperature', extendKind('temp-GPU'), { kind: 'temp', name: 'Temp: GPU' });
        eq('the prefix match is case-insensitive', extendKind('TEMP-GPU')?.kind, 'temp');
        eq('an unprefixed extend is NOT a sensor - the convention is the interface',
            extendKind('myscript'), null);
        eq('a prefix with no name is not a sensor', extendKind('temp-'), null);
    }

    console.log('\nthe vendor data itself');
    {
        const mikrotik = VENDORS.find((v) => v.key === 'mikrotik');
        if (mikrotik !== undefined && mikrotik.metrics?.every((m) => m.kind === 'fan')) {
            ok('mikrotik maps fans and temps ONLY - the PSU states with unknown polarity stay unmapped');
        } else bad('mikrotik vendor entry drifted from the recorded decision');
        const apc = VENDORS.find((v) => v.key === 'apc-smartups');
        const runtime = apc?.metrics?.find((m) => m.kind === 'runtime');
        eq('the APC runtime divisor is 100 (TimeTicks to seconds)', runtime?.div, 100);
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
