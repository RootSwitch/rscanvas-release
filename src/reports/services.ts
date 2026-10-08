// The services report's arithmetic (2026-10-07, SLICE-SERVICE-VIEWS-PLAN step
// 3): pure functions over the hourly rollup's sums, pinned by an offline test
// (tools/test-service-report.ts) rather than trusted to SQL - traffic.ts's
// rule for the interface report.
//
// WHAT THE STORE HANDS OVER is sums, never figures: per check per local day,
// for each value column, the weighted sum (an hour's mean x its count), the
// count, the minimum and the maximum; the sums the spread needs, over the
// hours that carry a sum of squares; ok runs and the MOS bands over the hours
// that carry them. A figure for a day, or for the whole period, is computed
// from POOLED sums - so a fortnight's standard deviation is the fortnight's,
// not an average of fourteen daily ones, and a quiet day does not weigh as
// much as a busy one.
//
// One kind of check per report, because each kind's columns are its own: a
// voice test's MOS, loss and jitter; a throughput test's rates both ways and
// its latency under load; a web or TCP check's response time. The standard
// deviation is the operator's reason for the report - "oversubscribed or
// intermittently problematic WAN links" - and beside it the minimum says how
// bad, and the runs under the G.109 bands say how often.

import { csvRow } from '../export/csv.ts';

export const REPORT_KINDS = {
    voice: ['path-voice'],
    bandwidth: ['path-tput'],
    web: ['svc-http', 'svc-tcp'],
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;

export function parseReportKind(raw: string | null): ReportKind | null {
    return raw === 'voice' || raw === 'bandwidth' || raw === 'web' ? raw : null;
}

/** One check-day as the store returns it (OPS.serviceReport). */
export interface ServiceDayRow {
    day: string; device: string; name: string; code: string; kind: string;
    hours: number; runs: number | null; ok_n: number | null; ok_runs: number | null;
    s0: number | null; s1: number | null; s2: number | null; s3: number | null; s4: number | null;
    c0: number | null; c1: number | null; c2: number | null; c3: number | null; c4: number | null;
    qs0: number | null; qs1: number | null; qs2: number | null; qs3: number | null; qs4: number | null;
    qc0: number | null; qc1: number | null; qc2: number | null; qc3: number | null; qc4: number | null;
    q0: number | null; q1: number | null; q2: number | null; q3: number | null; q4: number | null;
    lo0: number | null; lo1: number | null; lo2: number | null; lo3: number | null; lo4: number | null;
    m0: number | null; m1: number | null; m2: number | null; m3: number | null; m4: number | null;
    band_n: number | null; mos36: number | null; mos31: number | null;
}

/** A report column: its CSV name, its heading on the page, its decimals. */
export interface ServiceColumn { id: string; label: string; dp: number }

export const SERVICE_COLUMNS: Record<ReportKind, ServiceColumn[]> = {
    voice: [
        { id: 'runs', label: 'runs', dp: 0 }, { id: 'ok_pct', label: 'ok %', dp: 1 },
        { id: 'mos_avg', label: 'MOS avg', dp: 2 }, { id: 'mos_min', label: 'MOS min', dp: 2 },
        { id: 'mos_sd', label: 'MOS sd', dp: 2 },
        { id: 'runs_under_3_6', label: 'under 3.6', dp: 0 }, { id: 'runs_under_3_1', label: 'under 3.1', dp: 0 },
        { id: 'loss_avg_pct', label: 'loss avg %', dp: 2 }, { id: 'loss_worst_pct', label: 'loss worst %', dp: 2 },
        { id: 'jitter_avg_ms', label: 'jitter avg ms', dp: 2 }, { id: 'jitter_worst_ms', label: 'jitter worst ms', dp: 2 },
    ],
    bandwidth: [
        { id: 'runs', label: 'runs', dp: 0 }, { id: 'ok_pct', label: 'ok %', dp: 1 },
        { id: 'to_avg_mbps', label: 'to avg', dp: 1 }, { id: 'to_min_mbps', label: 'to min', dp: 1 },
        { id: 'to_sd_mbps', label: 'to sd', dp: 1 },
        { id: 'from_avg_mbps', label: 'from avg', dp: 1 }, { id: 'from_min_mbps', label: 'from min', dp: 1 },
        { id: 'from_sd_mbps', label: 'from sd', dp: 1 },
        { id: 'loaded_avg_ms', label: 'loaded ms avg', dp: 1 }, { id: 'loaded_worst_ms', label: 'loaded ms worst', dp: 1 },
    ],
    web: [
        { id: 'runs', label: 'runs', dp: 0 }, { id: 'ok_pct', label: 'ok %', dp: 1 },
        { id: 'ms_avg', label: 'ms avg', dp: 1 }, { id: 'ms_worst', label: 'ms worst', dp: 1 },
        { id: 'ms_sd', label: 'ms sd', dp: 1 },
    ],
};

export interface ServiceLine {
    day: string;            // YYYY-MM-DD, or "total <from> to <to>"
    device: string;
    check: string;
    code: string;
    kind: string;
    values: Record<string, number | null>;
}

type Five = [number, number, number, number, number];
interface Sums {
    runs: number; okN: number; okRuns: number; bandN: number; mos36: number; mos31: number;
    s: Five; c: Five; qs: Five; qc: Five; q: Five; lo: Array<number | null>; m: Array<number | null>;
}

const zero = (): Five => [0, 0, 0, 0, 0];
const empty = (): Sums => ({
    runs: 0, okN: 0, okRuns: 0, bandN: 0, mos36: 0, mos31: 0,
    s: zero(), c: zero(), qs: zero(), qc: zero(), q: zero(), lo: [null, null, null, null, null], m: [null, null, null, null, null],
});
const n = (v: number | null | undefined): number => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 0 : Number(v));
const pick = <K extends string>(r: ServiceDayRow, prefix: K, i: number): number | null =>
    (r as unknown as Record<string, number | null>)[`${prefix}${i}`] ?? null;

function addRow(t: Sums, r: ServiceDayRow): void {
    t.runs += n(r.runs); t.okN += n(r.ok_n); t.okRuns += n(r.ok_runs);
    t.bandN += n(r.band_n); t.mos36 += n(r.mos36); t.mos31 += n(r.mos31);
    for (let i = 0; i < 5; i++) {
        t.s[i] += n(pick(r, 's', i)); t.c[i] += n(pick(r, 'c', i));
        t.qs[i] += n(pick(r, 'qs', i)); t.qc[i] += n(pick(r, 'qc', i)); t.q[i] += n(pick(r, 'q', i));
        const lo = pick(r, 'lo', i), m = pick(r, 'm', i);
        if (lo !== null) t.lo[i] = t.lo[i] === null ? lo : Math.min(t.lo[i] as number, lo);
        if (m !== null) t.m[i] = t.m[i] === null ? m : Math.max(t.m[i] as number, m);
    }
}

/** The mean from a weighted sum and its count; null with nothing counted. */
export function mean(s: number, c: number): number | null {
    return c > 0 ? s / c : null;
}

/**
 * The sample standard deviation from pooled sums: sum of squares q, sum s,
 * count c - sqrt((q - s^2/c) / (c - 1)). Null under two readings. Every
 * reading the same is zero, exactly: the formula subtracts two nearly equal
 * numbers there, and what is left - a hair either side of zero - is rounding,
 * not spread (a hair under would be a NaN).
 */
export function stdDev(q: number, s: number, c: number): number | null {
    if (c < 2) return null;
    const v = (q - (s * s) / c) / (c - 1);
    const m = s / c;
    return v <= m * m * 1e-12 ? 0 : Math.sqrt(v);
}

const worse = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);

function values(kind: ReportKind, t: Sums): Record<string, number | null> {
    const okPct = t.okN > 0 ? t.okRuns / t.okN * 100 : null;
    const base = { runs: t.runs, ok_pct: okPct };
    const avg = (i: number) => mean(t.s[i], t.c[i]);
    const sd = (i: number) => stdDev(t.q[i], t.qs[i], t.qc[i]);
    if (kind === 'voice') {
        return {
            ...base,
            mos_avg: avg(4), mos_min: t.lo[4], mos_sd: sd(4),
            // Counted only over hours that carry the bands; null when none do.
            runs_under_3_6: t.bandN > 0 ? t.mos36 : null, runs_under_3_1: t.bandN > 0 ? t.mos31 : null,
            // The worse direction's: loss and jitter toward the site and from it.
            loss_avg_pct: worse(avg(0), avg(1)), loss_worst_pct: worse(t.m[0], t.m[1]),
            jitter_avg_ms: worse(avg(2), avg(3)), jitter_worst_ms: worse(t.m[2], t.m[3]),
        };
    }
    if (kind === 'bandwidth') {
        return {
            ...base,
            to_avg_mbps: avg(0), to_min_mbps: t.lo[0], to_sd_mbps: sd(0),
            from_avg_mbps: avg(1), from_min_mbps: t.lo[1], from_sd_mbps: sd(1),
            loaded_avg_ms: avg(2), loaded_worst_ms: t.m[2],
        };
    }
    return { ...base, ms_avg: avg(0), ms_worst: t.m[0], ms_sd: sd(0) };
}

function rounded(kind: ReportKind, v: Record<string, number | null>): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const col of SERVICE_COLUMNS[kind]) {
        const x = v[col.id] ?? null;
        out[col.id] = x === null ? null : Math.round(x * 10 ** col.dp) / 10 ** col.dp;
    }
    return out;
}

/**
 * The report's lines: one per check-day, then each check's TOTAL over the
 * whole range from the pooled sums of its days, so a block of the CSV reads
 * on its own - the days, then what they come to.
 */
export function serviceLines(kind: ReportKind, rows: ServiceDayRow[]): ServiceLine[] {
    const lines: ServiceLine[] = [];
    const sorted = [...rows].sort((a, b) => a.device.localeCompare(b.device)
        || a.name.localeCompare(b.name) || a.code.localeCompare(b.code) || a.day.localeCompare(b.day));
    let total: { base: ServiceDayRow; sums: Sums; first: string; last: string } | null = null;
    const flush = (): void => {
        if (total === null) return;
        lines.push({
            day: `total ${total.first} to ${total.last}`, device: total.base.device, check: total.base.name,
            code: total.base.code, kind: total.base.kind, values: rounded(kind, values(kind, total.sums)),
        });
        total = null;
    };
    for (const r of sorted) {
        if (total !== null && total.base.code !== r.code) flush();
        const day = empty();
        addRow(day, r);
        lines.push({ day: r.day, device: r.device, check: r.name, code: r.code, kind: r.kind, values: rounded(kind, values(kind, day)) });
        total ??= { base: r, sums: empty(), first: r.day, last: r.day };
        addRow(total.sums, r);
        total.last = r.day;
    }
    flush();
    return lines;
}

/** The CSV, every cell through the formula guard (check names are typed text). */
export function serviceCsv(kind: ReportKind, lines: ServiceLine[]): string {
    const cols = SERVICE_COLUMNS[kind];
    let out = csvRow(['date', 'device', 'check', ...cols.map((c) => c.id)]);
    for (const l of lines) out += csvRow([l.day, l.device, l.check, ...cols.map((c) => l.values[c.id] ?? '')]);
    return out;
}
