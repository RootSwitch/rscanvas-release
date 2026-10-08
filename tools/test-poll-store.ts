// A poll that fails on OUR database is not the device's failure (2026-10-06).
//
// The lab's second real outage: database connects starved behind unanswered
// name lookups, 93 of them timed out, and every poll that met one was written
// against its device - about a hundred device-down alerts for devices that
// answered the whole time. The fix has two halves this file holds:
//
//   * the store TAGS what it throws with the lane it came out of, keeping the
//     error's class and code - so a caller tells "our database failed" from
//     its own failure without matching message strings;
//   * the poll reads the tag: SNMP's own kind for the device's failures,
//     'store' for the database's, 'other' for anything else - and the
//     collector writes nothing against the device for 'store'.
//
// Offline: the lane is pointed at a port nothing listens on, so the connect
// is refused - the same throw site (pool.connect) as the outage's timeout.
//
//   node tools/test-poll-store.ts

process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

const { internalUnsafeLane, storeFailureLane, storeRefusal, closeAll } = await import('../src/store/index.ts');
const { pollErrorKind } = await import('../src/collector/poll.ts');
const { SnmpError } = await import('../src/collector/snmp.ts');

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

console.log('poll store failures\n');

console.log('the store names what it throws:');
let thrown: unknown = null;
try {
    await internalUnsafeLane('collector', async () => ({ rows: [], rowCount: 0 }));
    bad('a lane pointed at a closed port connected - the control did not arrive');
} catch (err) {
    thrown = err;
}
if (thrown !== null) {
    const e = thrown as NodeJS.ErrnoException;
    ok(`the connect failed, as the control intends (${e.code ?? e.message})`);
    eq('  and the error says which lane it came out of', storeFailureLane(thrown), 'collector');
    eq('  keeping its own code for the callers that branch on one', e.code, 'ECONNREFUSED');
    if (thrown instanceof Error) ok('  and its class'); else bad('  the error lost its class');
    if (!Object.keys(thrown as object).includes('rscanvasStoreLane') && !JSON.stringify(thrown).includes('rscanvasStoreLane')) {
        ok('  the tag is not enumerable - it never reaches a log line or a JSON body');
    } else bad('  the tag leaks into enumeration');
}

const refused = storeRefusal('entitiesForDevice', {
    ok: false, reason: 'busy', lane: 'collector', inFlight: 4, capacity: 4, policy: 'skip', waitMs: 2000,
} as Parameters<typeof storeRefusal>[1]);
eq('a structured refusal the caller cannot go on without becomes a tagged error',
    [refused.message, storeFailureLane(refused)], ['entitiesForDevice refused (busy)', 'collector']);

eq('an error that never passed through the store is not the store\'s', storeFailureLane(new Error('Connection terminated due to connection timeout')), null);
eq('  whatever its message says', storeFailureLane(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), null);
eq('  nor is a thrown string, null or undefined',
    [storeFailureLane('boom'), storeFailureLane(null), storeFailureLane(undefined)], [null, null, null]);

console.log('\nthe poll says whose failure it was:');
eq('an SNMP timeout is the device\'s', pollErrorKind(new SnmpError('Request timed out', 'timeout')), 'timeout');
eq('an SNMP auth failure is the device\'s (or its credential\'s)', pollErrorKind(new SnmpError('Authentication failure', 'auth')), 'auth');
eq('the refused connect above is the store\'s', pollErrorKind(thrown), 'store');
eq('so is the refusal', pollErrorKind(refused), 'store');
eq('anything else is other, as before', pollErrorKind(new TypeError('cannot read properties of undefined')), 'other');

await closeAll();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
