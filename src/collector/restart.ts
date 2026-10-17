// Did the device restart since its last good poll? Pure, so
// tools/test-restart.ts holds it without an agent or a database.
//
// THE QUESTION IS ASKED OF THE GAP, NOT OF TWO NUMBERS. The parent's
// detector (detectReboots in alerts/rules.ts, ported and never wired)
// compared consecutive readings: lower than last time is a reboot. That
// misses the case a monitor most needs - a device that drops off for an
// hour and comes back having restarted 20 minutes ago, whose new uptime is
// HIGHER than a short one it had before. The honest test is against what the
// uptime SHOULD read now: the last reading plus the time since. A device
// that kept running reads at least that; one that restarted reads less, by
// at least how long it had been up.
//
// ONE CLOCK. The elapsed time is the database's own age of the last good
// poll (computed in SQL when the poll was dispatched) plus how long this
// poll has run on the collector's monotonic clock - never the app's wall
// clock against a Postgres timestamp, which is the mistake the scan made
// with poll ages and paid for (alerts/scan.ts, "ONE CLOCK"). The age runs
// from the END of the last poll, and the reading was taken near its start,
// so the expected uptime is UNDER-stated by up to one poll's length: the
// error only ever runs toward "kept running", never toward a false restart.
//
// THREE ALLOWANCES, each for a real way a running device's uptime misses
// the line:
//   * TOLERANCE_S: the reading is whole seconds, the age is taken at
//     dispatch, and agents stamp TimeTicks at their own moment.
//   * drift: the agent's clock is not the database's. 1,000 ppm of the gap
//     (3.6 s an hour, 86 s a day) is ten times a poor crystal, and matters
//     only after long outages, when the restart signal is days anyway.
//   * the wrap: TimeTicks are 32-bit hundredths, so sysUpTime returns to
//     zero after 497.1 days of honest running. A reading that lands where
//     the expected value lands modulo 2^32 ticks is a wrap.
//
// WHAT IT CANNOT SEE: a device that had been up for less than the tolerance
// when it restarted again (a boot loop) reads as one restart, not several.
// And sysUpTime is the AGENT's: an agent restart is indistinguishable from
// a power cycle here, which is why every sentence a person reads says "the
// device or its SNMP agent".

/** sysUpTime's ceiling: 2^32 TimeTicks of 1/100 s, about 497.1 days. */
export const UPTIME_WRAP_S = 2 ** 32 / 100;

/** The smallest shortfall that counts as a restart. */
export const TOLERANCE_S = 120;

/** Allowance for the agent's clock against the database's, per second of gap. */
export const DRIFT = 0.001;

export type RestartVerdict =
    /** Nothing to compare: no earlier reading, no age, or no reading now. */
    | { kind: 'unknown' }
    /** Still running - including a reading AHEAD of the line. */
    | { kind: 'running' }
    /** sysUpTime wrapped at 497 days; the device kept running. */
    | { kind: 'wrapped' }
    /** It came back from zero. upBeforeS is the uptime the last good poll
     *  read - the least it had been up; bootAgoS is the uptime now. */
    | { kind: 'restarted'; upBeforeS: number; bootAgoS: number };

export function judgeRestart(
    prevUptimeS: number | null | undefined,
    sinceLastS: number | null | undefined,
    uptimeS: number | null | undefined,
): RestartVerdict {
    const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!finite(prevUptimeS) || !finite(sinceLastS) || !finite(uptimeS)) return { kind: 'unknown' };
    const expected = prevUptimeS + sinceLastS;
    const allow = Math.max(TOLERANCE_S, sinceLastS * DRIFT);
    if (uptimeS + allow >= expected) return { kind: 'running' };
    if (expected + allow >= UPTIME_WRAP_S && Math.abs(uptimeS - (expected - UPTIME_WRAP_S)) <= allow) {
        return { kind: 'wrapped' };
    }
    return { kind: 'restarted', upBeforeS: prevUptimeS, bootAgoS: uptimeS };
}
