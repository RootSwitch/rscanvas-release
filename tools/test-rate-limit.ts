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
    beginLoginAttempt, endLoginAttempt, lockoutMs, addressKey, accountKey, type LoginAttempt,
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

// --- the three holes of review F8 (2026-10-01) --------------------------------
console.log('\nthe race, the reset and the account (review F8):');
{
    // THE RACE: twenty concurrent attempts from one address, none finished
    // yet. Before, all twenty passed the check and reached scrypt.
    const held: Array<LoginAttempt | null> = [];
    for (let i = 0; i < 20; i++) held.push(beginLoginAttempt('192.0.2.10', `spray-${i}`));
    const admitted = held.filter((a) => a !== null).length;
    if (admitted === 5) ok('twenty concurrent attempts from one address: five admitted, fifteen refused before scrypt');
    else bad('concurrent attempts were not bounded', admitted);
    for (const a of held) if (a) endLoginAttempt(a, false);
    if (beginLoginAttempt('192.0.2.10', 'someone') === null) ok('and their five failures lock the address');
    else bad('five failed attempts did not lock the address');
}
{
    // THE RESET: four guesses at one account, a valid sign-in to another
    // from the same address, then more guesses. The success used to clear
    // the address's count.
    const ip = '192.0.2.20';
    for (let i = 0; i < 4; i++) endLoginAttempt(beginLoginAttempt(ip, 'victim') as LoginAttempt, false);
    endLoginAttempt(beginLoginAttempt(ip, 'my-own-account') as LoginAttempt, true);
    // It used to clear the count, leaving four more guesses; now one remains.
    const fifth = beginLoginAttempt(ip, 'victim-2');
    if (fifth) endLoginAttempt(fifth, false);
    if (fifth !== null && beginLoginAttempt(ip, 'victim-3') === null) {
        ok('a valid sign-in does not reset its address: one guess was left, and after it the address is locked');
    } else bad('a successful sign-in reset the address count');
}
{
    // THE ACCOUNT: five guesses at one name, each from a different address.
    for (let i = 0; i < 5; i++) endLoginAttempt(beginLoginAttempt(`198.18.0.${i}`, 'Admin') as LoginAttempt, false);
    if (beginLoginAttempt('198.18.0.99', 'admin') === null) ok('five failures from five addresses lock the account (case folded)');
    else bad('the account was not locked');
    const other = beginLoginAttempt('198.18.0.99', 'operator');
    if (other !== null) ok('another account from a clean address is untouched');
    else bad('locking one account locked another');
    if (other) endLoginAttempt(other, true);
    if (loginAllowed(accountKey('nobody-has-this-name'))) ok('an unknown name starts unlocked, like a real one');
    else bad('an unknown name started locked');
}
{
    if (lockoutMs(1) === 60_000 && lockoutMs(2) === 120_000 && lockoutMs(4) === 480_000 && lockoutMs(10) === 900_000) {
        ok('repeated lockouts double, 1 minute to a 15 minute ceiling');
    } else bad('lockout lengths', [1, 2, 4, 10].map(lockoutMs));
    const a = addressKey('2001:db8:1:2:3:4:5:6');
    const b = addressKey('2001:db8:1:2::9');
    if (a === b && a === 'ip6:2001:db8:1:2::/64') ok('IPv6 addresses count by their /64');
    else bad('IPv6 keys differ within one /64', `${a} vs ${b}`);
    if (addressKey('2001:db8:1:3::1') !== a) ok('and another /64 is another key');
    else bad('two /64s shared a key');
    if (addressKey('::ffff:203.0.113.5') === addressKey('203.0.113.5')) ok('an IPv4-mapped address is its IPv4 address');
    else bad('a mapped address was keyed apart from its IPv4 form');
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
