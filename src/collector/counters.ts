// The 32-bit counter rate (slice 28), pure so tools/test-counters.ts holds
// it without a database.
//
// A Counter32 wraps at 2^32 octets - under 4 seconds at 10Gb/s, 34 seconds
// at 1Gb/s - so on a 30-second poll a single wrap is NORMAL operation on a
// busy gigabit port, and the modulo below recovers it exactly. What cannot
// be recovered is a DOUBLE wrap (the counter lapped twice between polls):
// the delta aliases to a small, wrong, confident number. The parent
// (SNMPCanvas poller.js speedTrustAndClamp) carried a clamp for exactly
// this garbage; the fork dropped it when it went HC-only, and the
// operator's iperf drill brought the need back - their Windows Server DCs
// serve no ifHC at all.
//
// Two honest rules, one deliberate limitation:
//
//   1. A decrease is a WRAP, once. now < prev adds 2^32 and the delta is
//      exact - this is the working case, not the edge case.
//   2. THE CLAMP SAYS NULL, NOT A NUMBER. A rate that exceeds what the
//      interface's own speed can carry (past the same 1.5x margin
//      speed-trust uses for jitter) is aliasing or a reset misread as a
//      wrap - and inventing a clamped-to-ceiling reading would be a lie
//      told with confidence. null is "no reading", which the samples
//      schema, the charts and the alert rules already treat honestly.
//   3. LIMITATION, accepted with eyes open: a counter RESET (reboot) reads
//      as a wrap and can produce one plausible-but-false sample if it
//      lands under the clamp. The parent lived with the same; the alert
//      hysteresis (two breaching scans) absorbs a one-poll spike, and a
//      64-bit agent never enters this function at all.
//
// THE GATE THE CODE PRE-NAMED: speedtrust.ts has said since it was ported
// that "only a 64-bit counter may convict" an advertised speed - a 32-bit
// rate can itself be wrap garbage, and a false conviction would let that
// garbage into the graphs forever. The poll enforces it by passing
// speed-trust null rates for any interface on this path.

export const WRAP32 = 1n << 32n;

/**
 * Octets per second from two Counter32 readings, wrap-adjusted and clamped
 * against the interface's own speed claim (override outranks advertised,
 * as everywhere). speedBps null means no claim - the structural bound
 * (a delta can never exceed 2^32 after the modulo) is then the only cap.
 */
export function rate32(
    now: bigint | null, prev: bigint | null, elapsedS: number,
    speedBps: number | null,
): number | null {
    if (now === null || prev === null) return null;
    if (elapsedS <= 0) return null;
    let delta = now - prev;
    if (delta < 0n) delta += WRAP32;
    if (delta < 0n || delta >= WRAP32) return null;   // not Counter32 arithmetic at all
    const octetsPerS = Number(delta) / elapsedS;
    if (speedBps !== null && speedBps > 0 && octetsPerS * 8 > speedBps * 1.5) return null;
    return octetsPerS;
}
