// Speed trust, offline. The rule is small and every branch has cost somebody
// something, so every branch has a control.
//
//   node tools/test-speedtrust.ts

import { speedTrust, speedChangeLiftsConviction, SPEED_TRUST_MARGIN } from '../src/collector/speedtrust.ts';

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
};
const G = 1_000_000_000;
const base = { advertisedBps: G, overrideBps: null, untrusted: false, inBps: null, outBps: null };

console.log('the conviction:');
eq('idle traffic on a 1G link is trusted at 1G',
    speedTrust({ ...base, inBps: 10e6, outBps: 5e6 }).trustedBps, G);
eq('exactly at the margin is NOT convicted - 10% is jitter',
    speedTrust({ ...base, inBps: G * SPEED_TRUST_MARGIN }).convictNow, false);
eq('one bit past the margin convicts',
    speedTrust({ ...base, inBps: G * SPEED_TRUST_MARGIN + 1 }).convictNow, true);
eq('and the convicting poll already reports utilization SUSPENDED, not computed',
    speedTrust({ ...base, inBps: 1.4 * G }).trustedBps, null);
eq('the worst direction is what convicts - out alone at 218% (the TrueNAS vtnet case)',
    speedTrust({ ...base, inBps: 100e6, outBps: 2.18 * G }).convictNow, true);
eq('worstBps names the rate that did it, for the log line',
    speedTrust({ ...base, inBps: 100e6, outBps: 2.18 * G }).worstBps, 2.18 * G);

console.log('\nprecedence:');
eq('an override outranks the advertised speed',
    speedTrust({ ...base, overrideBps: 10 * G }).trustedBps, 10 * G);
eq('an override is NEVER second-guessed - traffic far past it does not convict',
    speedTrust({ ...base, overrideBps: 100e6, inBps: 5 * G }).convictNow, false);
eq('and utilization still uses the override under that traffic',
    speedTrust({ ...base, overrideBps: 100e6, inBps: 5 * G }).trustedBps, 100e6);
eq('an already-untrusted speed stays suspended and does not re-convict',
    speedTrust({ ...base, untrusted: true, inBps: 5 * G }),
    { trustedBps: null, convictNow: false, worstBps: 5 * G });
eq('an override lifts a standing conviction for utilization purposes',
    speedTrust({ ...base, untrusted: true, overrideBps: 2 * G, inBps: 5 * G }).trustedBps, 2 * G);

console.log('\nno claim at all:');
eq('no advertised speed means nothing to trust and nothing to convict',
    speedTrust({ ...base, advertisedBps: null, inBps: 5 * G }),
    { trustedBps: null, convictNow: false, worstBps: 5 * G });
eq('a zero advertised speed is the same as none',
    speedTrust({ ...base, advertisedBps: 0, inBps: 5 * G }).convictNow, false);
eq('null rates convict nothing - counters settling are not evidence',
    speedTrust({ ...base, inBps: null, outBps: null }).convictNow, false);

console.log('\nlifting the conviction:');
eq('a changed advertised speed lifts it - the link re-negotiated',
    speedChangeLiftsConviction(true, G, 10 * G), true);
eq('an unchanged speed does not',
    speedChangeLiftsConviction(true, G, G), false);
eq('nothing to lift when not convicted',
    speedChangeLiftsConviction(false, G, 10 * G), false);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
