// Device-reported numbers are made storable before they reach a column
// (src/store/bounds.ts, review 2026-09-30 F7 and F16). Offline. The
// PostgreSQL facts these guard against were measured on 18.6 (2026-10-01):
//
//   SELECT 70000::smallint                      -> smallint out of range
//   SELECT 1e39::real                           -> out of range for type real
//   SELECT avg(x) FROM (1e200, 45)              -> value out of range: overflow
//
// The first failed the whole fleet's sample COPY; the third stopped the hourly
// rollup for good, and retention will not drop what the rollup has not read.
//
//   node tools/test-bounds.ts

import { measurement, smallint, int4, int8, inDomain, boundedJson, MEASUREMENT_MAX } from '../src/store/bounds.ts';
import { copyLine } from '../src/store/copy.ts';

process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

console.log('a status is a small whole number or nothing:');
eq('70000 (review F7) is nothing', smallint(70000), null);
eq('32767 is kept', smallint(32767), 32767);
eq('-32768 is kept', smallint(-32768), -32768);
eq('2.5 is nothing', smallint(2.5), null);
eq('NaN is nothing', smallint(NaN), null);
eq('null stays null', smallint(null), null);
eq('ifOperStatus 7 is in its domain', inDomain(7, 1, 7), 7);
eq('ifOperStatus 0 is not', inDomain(0, 1, 7), null);
eq('ifOperStatus 70000 is not', inDomain(70000, 1, 7), null);

console.log('\na measurement is finite and inside what avg() can sum:');
eq('1e200 is nothing', measurement(1e200), null);
eq('-1e200 is nothing', measurement(-1e200), null);
eq('Infinity is nothing', measurement(Infinity), null);
eq('a petabit a second is kept', measurement(MEASUREMENT_MAX), MEASUREMENT_MAX);
eq('400 Gbit/s is kept exactly', measurement(4e11), 4e11);
eq('a fractional rate is kept', measurement(0.25), 0.25);
eq('a negative reading (a temperature) is kept', measurement(-40), -40);
eq('undefined is nothing', measurement(undefined), null);

console.log('\nwhole-number columns:');
eq('an int at its limit is kept', int4(2147483647), 2147483647);
eq('one past it is nothing', int4(2147483648), null);
eq('a bigint past 2^53 is nothing - it is no longer exact', int8(2 ** 53 + 2), null);
eq('1e21, which prints as 1e+21 and PostgreSQL refuses as a bigint, is nothing', int8(1e21), null);
eq('a 100G port speed is kept', int8(100_000_000_000), 100_000_000_000);

console.log('\nthe roster summary JSON:');
{
    const j = JSON.parse(boundedJson({ cpu_pct: 12.5, temp_c: 1e200, top_if: 'xe-0/0/1', top_bps: Infinity, nested: { v: -1e300 } }));
    eq('an absurd reading becomes null, the rest is untouched', j, { cpu_pct: 12.5, temp_c: null, top_if: 'xe-0/0/1', top_bps: null, nested: { v: null } });
}

console.log('\nwhat the sample COPY writes for an absurd row:');
{
    // ops.ts copySamples maps a row through these before copyLine.
    const line = copyLine(['1', '2026-10-01T00:00:00.000Z', smallint(70000), measurement(1e39), ...[1e200, 5, null, 0, Infinity, 1].map(measurement)]);
    eq('the bad values are \\N (NULL), the good ones stand', line, '1\t2026-10-01T00:00:00.000Z\t\\N\t\\N\t\\N\t5\t\\N\t0\t\\N\t1\n');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
