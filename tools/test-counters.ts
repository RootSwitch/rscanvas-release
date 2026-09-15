// The 32-bit counter rate (slice 28) - wrap arithmetic and the clamp.
//
//   node tools/test-counters.ts
//
// Pure-function cases, including the one that documents the accepted
// limitation rather than hiding it: a reboot's counter reset reads as a
// wrap and can slip one plausible-but-false sample under the clamp. The
// test asserts that behavior ON PURPOSE, so if someone later fixes it
// with uptime correlation, this file makes them say so.

import { rate32, WRAP32 } from '../src/collector/counters.ts';
import { rate } from '../src/collector/poll.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

console.log('counter rates\n');

// --- the ordinary case --------------------------------------------------------
{
    const r = rate32(2_000_000n, 1_000_000n, 30, 1e9);
    if (r !== null && Math.abs(r - 1_000_000 / 30) < 1e-9) ok('a plain delta divides by elapsed');
    else bad('plain delta wrong', r);
}

// --- the wrap is the WORKING case, not the edge -------------------------------
{
    // 1Gb/s wraps Counter32 in ~34s: prev near the top, now past zero.
    const prev = WRAP32 - 1_000n;
    const now = 5_000n;
    const r = rate32(now, prev, 30, 10e9);
    if (r !== null && Math.abs(r - 6_000 / 30) < 1e-9) ok('a single wrap is recovered exactly (now < prev adds 2^32)');
    else bad('single wrap not recovered', r);
}

// --- the clamp: null, never an invented number --------------------------------
{
    // A delta that claims 1.06 Gb/s on a 100 Mb/s interface: aliasing or a
    // reset misread as a wrap. The honest answer is "no reading".
    const r = rate32(4_000_000_000n, 0n, 30, 100e6);
    if (r === null) ok('a rate past speed x1.5 on a 32-bit source is NULL - aliasing, not measurement');
    else bad('over-speed 32-bit rate was served', r);
}
{
    // The same delta with NO speed claim: the structural bound is the only
    // cap, and the number is served - an unrated interface still deserves
    // its reading.
    const r = rate32(4_000_000_000n, 0n, 30, null);
    if (r !== null && r > 0) ok('with no speed claim the structural bound is the only cap');
    else bad('speedless 32-bit rate wrongly suppressed', r);
}

// --- the documented limitation ------------------------------------------------
{
    // Reboot: counter resets to a small value. Wrap math reads it as a lap.
    // prev=3e9, now=1000 -> delta ~1.29e9 octets ~344 Mb/s over 30s - UNDER
    // the 1.5x clamp on a gigabit port, so one false sample slips through.
    // Asserted as-is: the parent lived with the same, hysteresis absorbs a
    // one-poll spike, and fixing it properly means uptime correlation -
    // whoever adds that gets to flip this case.
    const r = rate32(1_000n, 3_000_000_000n, 30, 1e9);
    if (r !== null) ok('LIMITATION (asserted on purpose): a reboot reset can pass one false sample under the clamp');
    else bad('the reboot case changed behavior - update this test AND counters.ts together', r);
}

// --- inputs that cannot rate --------------------------------------------------
{
    if (rate32(null, 5n, 30, null) === null && rate32(5n, null, 30, null) === null) {
        ok('null counters rate null');
    } else bad('null counters produced a rate');
    if (rate32(5n, 1n, 0, null) === null && rate32(5n, 1n, -3, null) === null) {
        ok('zero or negative elapsed rates null');
    } else bad('bad elapsed produced a rate');
}

// --- the 64-bit path is UNCHANGED ---------------------------------------------
{
    if (rate(1_000n, 2_000n, 30) === null) {
        ok('64-bit decrease stays a RESET (null) - HC never wrap-adjusts');
    } else bad('rate() behavior changed');
    const r = rate(2_000n, 1_000n, 30);
    if (r !== null && Math.abs(r - 1_000 / 30) < 1e-9) ok('64-bit plain delta unchanged');
    else bad('rate() plain delta wrong', r);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
