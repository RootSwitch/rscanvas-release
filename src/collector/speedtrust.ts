// Speed trust: can the advertised interface speed be believed?
//
// PORTED FROM SNMPCANVAS server/poller.js speedTrustAndClamp, rule and margin
// verbatim. Pure, so tools/test-speedtrust.ts holds it without a database.
//
// The advertised speed is a CLAIM. virtio, netvsc and most paravirtual NICs
// advertise a number the hypervisor invented, and then move whatever the host
// can push. Utilization against that number is a percentage of fiction - the
// parent's measured case was "133% at replication time", RSCanvas's first real
// estate produced 218% on a TrueNAS vtnet - and a clamp against it silently
// discards the FASTEST real samples, which are exactly the ones an operator
// wants to see.
//
// Three rules, in precedence order:
//
//   1. An operator override outranks everything and is never second-guessed.
//      It is their honest number for a link the agent cannot describe.
//   2. A measured rate more than 10% over the advertised speed CONVICTS it.
//      10% is timing jitter between two polls, not fiction; anything past it
//      cannot be explained by clock skew.
//   3. Once convicted, utilization is SUSPENDED - reported as unrated - not
//      computed against nothing. The conviction lifts only if the advertised
//      speed itself changes (a re-negotiated link gets a fresh trial) or an
//      override is set.
//
// Only a 64-bit counter may convict. A 32-bit rate can itself be wrap
// garbage, and a false conviction would let that garbage into the graphs from
// then on. RSCanvas polls ifHCInOctets/ifHCOutOctets exclusively, so that
// precondition is structural here rather than checked per call - but it is
// stated because a future 32-bit fallback would have to gate this.

/** The parent's margin. Exported so the test asserts the boundary. */
export const SPEED_TRUST_MARGIN = 1.1;

export interface SpeedTrustInput {
    /** ifHighSpeed*1e6 or ifSpeed, as discovered. null when the agent gave none. */
    advertisedBps: number | null;
    /** The operator's number, or null. */
    overrideBps: number | null;
    /** Already convicted before this poll. */
    untrusted: boolean;
    /** This poll's in and out bps, null when no rate is computable. */
    inBps: number | null;
    outBps: number | null;
}

export interface SpeedTrustVerdict {
    /** The speed utilization may be computed against; null means SUSPENDED. */
    trustedBps: number | null;
    /** True on the poll that CONVICTS - the caller persists it and logs once. */
    convictNow: boolean;
    /** The measured rate that did the convicting, for the log line. */
    worstBps: number;
}

export function speedTrust(i: SpeedTrustInput): SpeedTrustVerdict {
    const override = i.overrideBps !== null && i.overrideBps > 0 ? i.overrideBps : 0;
    const advertised = i.advertisedBps !== null && i.advertisedBps > 0 ? i.advertisedBps : 0;
    const worst = Math.max(i.inBps ?? 0, i.outBps ?? 0);

    let untrusted = i.untrusted;
    let convictNow = false;
    if (override === 0 && advertised > 0 && !untrusted && worst > advertised * SPEED_TRUST_MARGIN) {
        untrusted = true;
        convictNow = true;
    }

    const trustedBps = override > 0 ? override
        : untrusted ? null
        : advertised > 0 ? advertised
        : null;
    return { trustedBps, convictNow, worstBps: worst };
}

/**
 * Does a change in the advertised speed lift a standing conviction?
 *
 * The parent (poller.js:391): "if (e.speed_untrusted && update.speed_bps !==
 * e.speed_bps) update.speed_untrusted = 0". A link that re-negotiated has a
 * new claim, and the new claim has not been disproven yet.
 */
export function speedChangeLiftsConviction(
    untrusted: boolean, previousBps: number | null, currentBps: number | null,
): boolean {
    return untrusted && previousBps !== currentBps;
}
