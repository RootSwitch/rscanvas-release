// Traffic reporting arithmetic: pure functions over the hourly rollup's sums,
// so the numbers the Dashboard and the interface report print are pinned by an
// offline test (tools/test-traffic-report.ts) rather than trusted to SQL.
//
// WHAT A TOTAL IS. Every poll stores RATES derived from the interface's own
// SNMP counters (the change since the previous poll over the time between
// them), and the rollup keeps each hour's mean rate per column (a0..a5) plus
// how many samples contributed (n0..n5). So an hour carried
//
//     bytes = mean bits per second x 3,600 s / 8
//
// A missed poll loses no traffic - the next poll's counter delta spans it. What
// cannot be seen is time the device did not answer at all, and a counter reset
// (a reboot): those hours have no row, count as zero, and lower the COVERAGE,
// which is printed beside every total so an estimate never reads as a meter.
//
// Only COMPLETE hours exist in the rollup (roll_up_samples writes up to the
// last whole hour), so every window here ends at the rollup frontier's hour
// and says so - "the 24 hours to 14:00", not "the last 24 hours".

import { csvRow } from '../export/csv.ts';

/** The windows the Dashboard offers, in hours. Anything else is refused. */
export const DASHBOARD_WINDOWS = [6, 24, 168] as const;

export function parseWindowHours(raw: string | null): number | null {
    const n = Number(raw ?? 24);
    return (DASHBOARD_WINDOWS as readonly number[]).includes(n) ? n : null;
}

/** Sum of hourly mean bits/s over hours -> bytes. */
export const bytesFromHourlyBps = (sumOfHourlyMeansBps: number | null): number | null =>
    sumOfHourlyMeansBps === null ? null : (sumOfHourlyMeansBps * 3600) / 8;

/** Sum of hourly mean events/s -> events (errors, discards). */
export const countFromHourlyRate = (sumOfHourlyMeans: number | null): number | null =>
    sumOfHourlyMeans === null ? null : sumOfHourlyMeans * 3600;

/**
 * The share of a window the samples actually cover, 0..1.
 *
 * `coveredHours` is the SQL's sum over the window's hours of
 * min(1, samples x poll interval / 3600) - an hour with every poll counts 1,
 * a half-polled hour 0.5, a missing hour 0. Rounded to a whole percent by the
 * caller; capped at 1 because a device polled faster than its declared
 * interval would otherwise report 103%.
 */
export function coverage(coveredHours: number | null, windowHours: number): number {
    if (coveredHours === null || windowHours <= 0) return 0;
    return Math.min(1, Math.max(0, coveredHours / windowHours));
}

/** Below this share of its hours, a previous window is too thin to compare. */
export const TREND_MIN_COVERAGE = 0.5;

/**
 * Change against the previous window of the same length, as a fraction
 * (+0.35 is 35% more), compared PER COVERED HOUR.
 *
 * Totals alone were wrong, found on the first live run: the lab's rollup
 * began partway through the previous 24 hours, and every interface read
 * about +61% - a full window against part of one, the arithmetic of
 * coverage dressed as a change in traffic. So each side is its sum divided
 * by the hours its samples covered, and a previous window that saw less
 * than half its hours gives no trend at all. Pass covered hours as null for
 * values that are already means (the sensors' percentages).
 *
 * null also when there is nothing to compare with - an interface new to
 * the window, or one that carried nothing before - because "+infinity%" is
 * not a trend and 0 -> 0 is not a change worth an arrow.
 */
export function trend(
    current: number | null, previous: number | null,
    curCoveredH: number | null = null, prevCoveredH: number | null = null, windowHours = 0,
): number | null {
    if (current === null || previous === null) return null;
    if (windowHours > 0 && (prevCoveredH ?? 0) < TREND_MIN_COVERAGE * windowHours) return null;
    let cur = current, prev = previous;
    if (curCoveredH !== null && prevCoveredH !== null) {
        if (curCoveredH <= 0 || prevCoveredH <= 0) return null;
        cur = current / curCoveredH;
        prev = previous / prevCoveredH;
    }
    if (prev <= 0) return null;
    return (cur - prev) / prev;
}

// --- the interface report ----------------------------------------------------

/** One interface-day as the store returns it. */
export interface ReportDayRow {
    day: string;            // YYYY-MM-DD in the report's time zone
    device: string;
    name: string | null;    // ifName / ifDescr
    alias: string | null;   // ifAlias - "Uplink to ISP A"
    code: string;
    sum_in: number | null;  // sum of hourly mean bps over the day's hours
    sum_out: number | null;
    peak_in: number | null; // max of hourly peaks, bps
    peak_out: number | null;
    covered_h: number | null;
    expected_h: number;     // hours of the day inside the report and the rollup
}

export interface ReportLine {
    day: string;
    device: string;
    iface: string;
    description: string;
    inGB: number | null;
    outGB: number | null;
    totalGB: number | null;
    peakInMbps: number | null;
    peakOutMbps: number | null;
    coveragePct: number;
}

const GB = 1e9;
const round = (v: number | null, dp: number): number | null =>
    v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * The report's lines: one per interface-day, then one TOTAL line per
 * interface over the whole range - the number a month's ISP report is
 * actually for. Decimal gigabytes (1e9), as carriers and billing use.
 */
export function reportLines(rows: ReportDayRow[]): ReportLine[] {
    const lines: ReportLine[] = [];
    type Total = { base: ReportDayRow; inB: number; outB: number; pkIn: number | null;
        pkOut: number | null; cov: number; exp: number; any: boolean; first: string; last: string };
    // Each interface's total follows its own days, so a block of the CSV
    // reads on its own: the days, then what they add up to.
    const pushTotal = (t: Total): void => {
        lines.push({
            day: `total ${t.first} to ${t.last}`,
            device: t.base.device,
            iface: t.base.name ?? t.base.code,
            description: t.base.alias ?? '',
            inGB: t.any ? round(t.inB / GB, 3) : null,
            outGB: t.any ? round(t.outB / GB, 3) : null,
            totalGB: t.any ? round((t.inB + t.outB) / GB, 3) : null,
            peakInMbps: round(t.pkIn === null ? null : t.pkIn / 1e6, 2),
            peakOutMbps: round(t.pkOut === null ? null : t.pkOut / 1e6, 2),
            coveragePct: Math.round(100 * coverage(t.cov, t.exp)),
        });
    };
    let t: Total | null = null;
    const sorted = [...rows].sort((a, b) =>
        a.device.localeCompare(b.device) || (a.name ?? '').localeCompare(b.name ?? '')
        || a.code.localeCompare(b.code) || a.day.localeCompare(b.day));
    for (const r of sorted) {
        if (t !== null && t.base.code !== r.code) { pushTotal(t); t = null; }
        const inB = bytesFromHourlyBps(r.sum_in);
        const outB = bytesFromHourlyBps(r.sum_out);
        lines.push({
            day: r.day,
            device: r.device,
            iface: r.name ?? r.code,
            description: r.alias ?? '',
            inGB: round(inB === null ? null : inB / GB, 3),
            outGB: round(outB === null ? null : outB / GB, 3),
            totalGB: inB === null && outB === null ? null : round(((inB ?? 0) + (outB ?? 0)) / GB, 3),
            peakInMbps: round(r.peak_in === null ? null : r.peak_in / 1e6, 2),
            peakOutMbps: round(r.peak_out === null ? null : r.peak_out / 1e6, 2),
            coveragePct: Math.round(100 * coverage(r.covered_h, r.expected_h)),
        });
        t ??= { base: r, inB: 0, outB: 0, pkIn: null, pkOut: null, cov: 0, exp: 0,
            any: false, first: r.day, last: r.day };
        t.inB += inB ?? 0;
        t.outB += outB ?? 0;
        t.any ||= inB !== null || outB !== null;
        if (r.peak_in !== null) t.pkIn = Math.max(t.pkIn ?? 0, r.peak_in);
        if (r.peak_out !== null) t.pkOut = Math.max(t.pkOut ?? 0, r.peak_out);
        t.cov += r.covered_h ?? 0;
        t.exp += r.expected_h;
        t.last = r.day;
    }
    if (t !== null) pushTotal(t);
    return lines;
}

export const REPORT_COLUMNS = [
    'date', 'device', 'interface', 'description', 'in_GB', 'out_GB', 'total_GB',
    'peak_in_Mbps', 'peak_out_Mbps', 'coverage_pct',
];

/** The CSV, every cell through the formula guard (device text is hostile). */
export function reportCsv(lines: ReportLine[]): string {
    let out = csvRow(REPORT_COLUMNS);
    for (const l of lines) {
        out += csvRow([l.day, l.device, l.iface, l.description, l.inGB, l.outGB, l.totalGB,
            l.peakInMbps, l.peakOutMbps, l.coveragePct]);
    }
    return out;
}

/** YYYY-MM-DD, and a real calendar date. */
export function isDay(s: string | null): s is string {
    if (s === null || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * An IANA zone the runtime knows, e.g. America/Chicago.
 *
 * A NAME, NOT AN OFFSET (2026-10-03, review L17). Intl accepts bare offsets
 * - "+05", "+05:00", "-0500" all passed here - and PostgreSQL reads a bare
 * offset as a POSIX zone, whose sign is the opposite of ISO's: "+05" there is
 * five hours WEST of UTC. A report asked for at +05 summed its days ten hours
 * off. Every IANA name begins with a letter (Etc/GMT+5 and
 * America/Port-au-Prince included), so that is the rule.
 */
export function isTimeZone(tz: string | null): tz is string {
    if (tz === null || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}
