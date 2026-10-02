// Numbers a device reported, made storable before they reach a column
// (2026-10-01, review F7 and F16). Every function here answers null for a
// value the column cannot hold or the rollup cannot aggregate - an absent
// reading, which every reader already handles - rather than letting one bad
// value fail the statement it rides in.
//
// WHY AT THE WRITE AND NOT ONLY AT THE READ. The values come from SNMP agents,
// and a hostile or broken one can say anything: an ifOperStatus of 70000, a
// Counter64 of any length, a sensor reading of "1e200". Each failed a
// statement that carried other rows:
//
//   * samples.status is smallint, and the sample COPY carries EVERY device's
//     rows for about a second - one agent's 70000 lost the whole fleet's
//     batch, by design unrecoverable (F7).
//   * the hourly rollup's avg() overflows on 1e200 ("value out of range:
//     overflow", measured on PostgreSQL 18.6), so one absurd sample stopped
//     the rollup for good, and retention will not drop raw partitions the
//     rollup has not consumed: the disk grows until someone notices (F16).
//   * entities.speed_bps is bigint and the roster's summary columns are real;
//     an overflow there failed the device's own poll write, and the poll was
//     recorded as failed - an answering device read DOWN and paged (F16).

/**
 * The largest magnitude a measurement keeps. Far beyond anything real - 10^15
 * bits a second is a petabit - and far inside what avg()'s sum of squares can
 * hold (it overflows near 10^154).
 */
export const MEASUREMENT_MAX = 1e15;

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** A measurement (a rate, a sensor reading, a duration), or null. */
export function measurement(n: number | null | undefined): number | null {
    return finite(n) && Math.abs(n) <= MEASUREMENT_MAX ? n : null;
}

/** A smallint column's value: a whole number in -32768..32767, or null. */
export function smallint(n: number | null | undefined): number | null {
    return finite(n) && Number.isInteger(n) && n >= -32768 && n <= 32767 ? n : null;
}

/** An int column's value, or null. */
export function int4(n: number | null | undefined): number | null {
    return finite(n) && Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

/**
 * A bigint column's value, or null. Bounded by the largest integer a double
 * holds exactly, not by bigint's own range: past 2^53 a JavaScript number is
 * already an approximation, and past 10^21 it prints as "1e+21", which
 * PostgreSQL refuses as a bigint outright.
 */
export function int8(n: number | null | undefined): number | null {
    return finite(n) && Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
}

/** A value inside an enumerated SNMP domain (ifOperStatus is 1..7), or null. */
export function inDomain(n: number | null | undefined, lo: number, hi: number): number | null {
    return finite(n) && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** JSON whose every number is a storable measurement, others written as null. */
export function boundedJson(value: unknown): string {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' ? measurement(v) : v));
}
