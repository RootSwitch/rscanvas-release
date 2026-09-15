// Hysteresis: an alert clears when the value has moved MEANINGFULLY back,
// not merely back across the line.
//
// The machine's raiseScans / clearScans debounce TIME - two consecutive
// scans on the right side of the threshold. They do not debounce MAGNITUDE. A
// value oscillating half a degree either side of a threshold crosses cleanly
// for two scans, clears, crosses back for two scans, raises again, and every
// one of those is an email. Measured on a real estate 2026-08-18: one sensor
// at 45.85C against warn 45 - MPC4 Temp: Composite - CLEARED FIVE TIMES IN 73
// MINUTES, with its sibling sensor doing the same beside it.
//
// The rule is a BAND below the threshold that the value must fall through
// before a normal reading counts toward clearing:
//
//     raise    at value >= threshold            (unchanged)
//     clear    at value <  threshold - band     (was: value < threshold)
//     between  HELD - neither breaching nor clearing, the incident simply
//              continues; the machine already has this outcome and calls it
//              frozen, so no new state is invented
//
// Per KIND, because the right band is a property of what is being measured
// and not of the alert machine: 2C on a temperature is jitter, 2% on a disk
// is a log rotation. Kinds not listed get zero band and behave exactly as
// before, so this is opt-in per kind and cannot change a rule nobody meant to
// change.
//
// LOWER_IS_BAD kinds (battery, runtime, uptime) breach going DOWN, so their
// band sits ABOVE the threshold: a battery at 49% against warn 50 must climb
// past 50 + band to clear, not merely to 50.
//
// Pure. tools/test-hysteresis.ts holds it, and the mock fleet's SENSOR_MODE=
// flap (43C/47C across warn 45) is the fleet-scale fixture: with a 2C band a
// flapping sensor raises once and holds, without it the same sensor churns.

import { LOWER_IS_BAD } from './rules.ts';

/**
 * The band per kind, in the kind's own unit. Zero (or absent) means no
 * hysteresis - the pre-existing behaviour.
 */
export const CLEAR_BAND: Readonly<Record<string, number>> = {
    temp: 2,        // C - half a degree of sensor jitter is the measured case
    cpu: 5,         // %
    mem: 3,         // %
    disk: 3,        // % - a log rotation, not a trend
    util: 5,        // % - GAUGE SENSORS (alertScanSensors maps 'gauge' here)
    'if-util': 5,   // % - LINK utilization, the kind rules.ts actually emits
                    // for interfaces. For this table's first three months the
                    // 'util' entry above carried a comment claiming to cover
                    // link utilization while the interface kind - the one
                    // most likely to flap at 80% - had no band at all
                    // (2026-09-01 review). The comment was the tell: the two
                    // kinds are different rows in this table because they are
                    // different populations, and each names its own band.
    fan: 200,       // rpm
    battery: 5,     // % - LOWER_IS_BAD: must climb 5 above warn to clear

    // 'if-errors' and 'if-discards' have NO band, and as of 2026-09-01 that
    // is recorded as UNDECIDED rather than decided: their rates are spiky by
    // nature and a band in /s is a claim about what error-rate jitter looks
    // like that nobody has measured yet. If their alerts churn in practice,
    // the flap report over cleared-alert history is the measurement to bring
    // here first.
};

/**
 * Should a NORMAL reading (severity null) on an OPEN alert count toward
 * clearing, or be held inside the band?
 *
 * Only called when the rule engine has already said "normal": the band never
 * suppresses a raise, and never applies to a pending alert (nothing has been
 * sent, so there is nothing to protect from churn).
 */
export function insideClearBand(
    kind: string, value: number | null, threshold: number | null,
): boolean {
    const band = CLEAR_BAND[kind] ?? 0;
    if (band <= 0 || value === null || threshold === null) return false;
    return LOWER_IS_BAD.has(kind)
        ? value <= threshold + band    // has not climbed PAST it - the edge belongs to the band
        : value >= threshold - band;   // has not fallen PAST it - the edge belongs to the band
}
