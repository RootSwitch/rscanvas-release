// The login rate limiter's MEMORY BOUND, offline.
//
// The lockout behaviour has always been tested. What had never been tested is
// the thing the restart-dependence audit went looking for: whether the map's
// cap is real. It was not - the sweep skipped entries that were currently
// locked out, so the true bound was "attack rate x the 60s lockout window"
// while the constant said 10,000. Bounded either way, but the code said one
// thing and did another, and the next person reasoning about memory would
// have used the number written down.
//
// This is the cheapest structure in the codebase to attack from outside: it
// is keyed by client IP and reachable by anyone who can reach /api/login.

import {
    loginAllowed, recordLoginFailure, recordLoginSuccess, rateLimitState,
} from '../src/auth/index.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

console.log('login rate limiter: the lockout, and the memory bound\n');

// --- the lockout still works --------------------------------------------------
{
    const ip = '203.0.113.1';
    if (loginAllowed(ip)) ok('an unseen address is allowed');
    else bad('a fresh address was refused');

    for (let i = 0; i < 4; i++) recordLoginFailure(ip);
    if (loginAllowed(ip)) ok('and four failures do not lock it out');
    else bad('locked out one failure early');

    recordLoginFailure(ip);
    if (!loginAllowed(ip)) ok('the fifth does');
    else bad('the lockout never engaged');

    recordLoginSuccess(ip);
    if (loginAllowed(ip)) ok('and a success clears it immediately');
    else bad('a success left the address locked');
}

// --- THE CAP, which is what this file exists for ------------------------------
//
// Every one of these addresses is put into a LIVE lockout, which is exactly
// the state the old sweep could not reclaim. The negative control is the
// first assertion: without pushing them into lockout the old code would have
// passed this too, because expired entries were always collectable.
{
    const before = rateLimitState().tracked;
    const N = 12_000;
    for (let i = 0; i < N; i++) {
        const ip = `198.51.100.${i}`;
        // Five failures each: every address ends LOCKED, not merely counted.
        for (let f = 0; f < 5; f++) recordLoginFailure(ip);
    }
    const after = rateLimitState();

    if (after.tracked <= 10_000) {
        ok(`${N.toLocaleString()} addresses in LIVE lockout leave ${after.tracked.toLocaleString()} `
            + 'tracked - the cap holds for the entries nobody can expire');
    } else {
        bad('the cap did not hold against live lockouts', JSON.stringify(after));
    }

    if (after.lockedOut > 0) {
        ok(`and ${after.lockedOut.toLocaleString()} are still locked out - eviction did not `
            + 'disable the protection, it bounded the bookkeeping');
    } else {
        bad('evicting for the cap disabled the lockout entirely', JSON.stringify(after));
    }

    // The most recent attacker must still be locked: eviction is OLDEST
    // first, so the address that just attacked is the last thing to go.
    if (!loginAllowed(`198.51.100.${N - 1}`)) {
        ok('the most recent offender is still locked - eviction takes the oldest, which is nearest to expiring');
    } else {
        bad('the newest lockout was evicted, which is the wrong end');
    }

    if (before <= 10_000) ok('and the map started within the cap, so the growth above was real');
    else bad('the map was already over the cap before this test ran');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
