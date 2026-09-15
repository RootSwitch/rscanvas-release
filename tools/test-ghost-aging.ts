// The ghost gate: does a stale-stamped interface leave the scan at the
// horizon, and NOTHING else?
//
//   node tools/test-ghost-aging.ts

import { isGhostInterface } from '../src/alerts/ghosts.ts';

// An early exit without a verdict must read as FAILURE, not as a green run
// with no output (the test-walk incident, 2026-09-01).
process.exitCode = 1;

let pass = 0, fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string): void => { fail++; console.log(`  FAIL ${l}`); };
const is = (label: string, got: boolean, want: boolean): void =>
    (got === want ? ok : bad)(label);

const HOUR = 3_600_000;
const now = Date.parse('2026-09-01T12:00:00Z');

console.log('the boundary:');
is('unstamped is never a ghost - the common case costs one null check',
    isGhostInterface(null, now, HOUR), false);
is('stamped five minutes ago is held, not ghosted - an index flap heals first',
    isGhostInterface('2026-09-01T11:55:00Z', now, HOUR), false);
is('stamped exactly at the horizon is still held - the gate is strictly past it',
    isGhostInterface('2026-09-01T11:00:00Z', now, HOUR), false);
is('one millisecond past the horizon is a ghost',
    isGhostInterface(new Date(now - HOUR - 1), now, HOUR), true);
is('a twelve-day corpse is a ghost - the the operator workstation shape',
    isGhostInterface('2026-08-20T08:29:51Z', now, HOUR), true);

console.log('\nthe inputs the store can hand it:');
is('a Date instance ghosts the same as its ISO string',
    isGhostInterface(new Date('2026-08-20T08:29:51Z'), now, HOUR), true);
is('a malformed stamp reads as unstamped - a parse quirk must not silence a live row',
    isGhostInterface('not a timestamp', now, HOUR), false);
is('a stamp from the future is not a ghost - clock skew freezes, never retires',
    isGhostInterface(new Date(now + HOUR), now, HOUR), false);

console.log('\nwhy the horizon is safe:');
// The stamp is only ever written by a SUCCESSFUL poll of the device
// (markInterfacesStale takes the poll's own fresh list), so a device outage
// never starts this clock. That property lives in the store, not here - but
// the horizon's arithmetic must at least respect the configured unit.
is('a 60-minute horizon holds a 59-minute stamp',
    isGhostInterface(new Date(now - 59 * 60_000), now, 60 * 60_000), false);
is('and releases a 61-minute one',
    isGhostInterface(new Date(now - 61 * 60_000), now, 60 * 60_000), true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
