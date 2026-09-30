// JIT per lane (src/store/lanes.ts), pinned: off where queries are short and
// frequent, the server's default where they aggregate millions of rows. The
// measurement behind each choice is in lanes.ts; this keeps a later edit from
// quietly turning compile time back on for the Alerts page.
//
//   node tools/test-lane-jit.ts

import { LANES, ALL_LANES } from '../src/store/lanes.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

console.log('JIT is off on the lanes whose queries are short and frequent:');
for (const lane of ['collector', 'ingest', 'alerts', 'jobs', 'interactive'] as const) {
    eq(`${lane}: off`, LANES[lane].jit, false);
}
console.log('\nand left to the server where aggregation measured faster with it:');
for (const lane of ['heavy', 'export', 'maintenance'] as const) {
    eq(`${lane}: server default`, LANES[lane].jit, null);
}
eq('\nevery lane is decided, none by omission', ALL_LANES.every((l) => LANES[l].jit === false || LANES[l].jit === null), true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
