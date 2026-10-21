// How fast the database grows, and where it levels off (2026-10-19).
//
// The operator, comparing the Retention panel with SNMPCanvas's: "History on
// disk: 1.71 GiB spanning 65 days (about 26.9 MiB/day). At 90 days it levels
// off near 2.37 GiB." RSCanvas showed a partition count and a total. One
// store is one division there; here the parts keep for different spans and
// one keeps for good, so each is judged on its own and then added up:
//
//   raw samples       daily partitions, kept RAW_RETENTION_DAYS
//   syslog and traps  daily partitions, kept MESSAGE_RETENTION_DAYS
//   ping detail       one table, rows deleted past PING_HISTORY_DAYS
//   hourly history    monthly partitions and ping_hourly, kept for good
//   everything else   devices, alerts, the audit trail - read as it stands
//
// A RATE IS THE LAST SEVEN COMPLETE DAYS, not size over age. Measured on
// production before this was written: its first syslog days were light (1 to
// 4 MB against 12 now), and the last few days of syslog carry a free-text
// index (TRGM_RECENT_DAYS) that roughly doubles them until it is dropped -
// size over age would have read both as the rate. So the index is taken out
// of each day and added back once, at the size it has now, since that window
// rolls along rather than filling.
//
// Pure: the reads are in OPS (uiPartitions, growthFacts). tools/test-growth.ts
// holds it, with production's own numbers of 2026-10-19 among its cases.

export interface GrowthPartition {
    parent: string;
    partition_name: string;
    bytes: string | number;
    /** The free-text indexes on a messages partition; absent or 0 elsewhere. */
    trgm_bytes?: string | number | null;
}

export interface GrowthFacts {
    dbBytes: number;
    pingBytes: number;
    /** Epoch seconds of the oldest ping probe kept, null when there is none. */
    pingOldestS: number | null;
    pingHourlyBytes: number;
    pingHourlyOldestS: number | null;
    nowS: number;
}

export interface GrowthWindows { rawDays: number; messageDays: number; pingDays: number }

export interface GrowthPart {
    key: 'raw' | 'messages' | 'ping' | 'hourly' | 'other';
    bytes: number;
    /** Bytes a day now; null when there is too little history to say. */
    perDay: number | null;
    /** How long it is kept; null = for good (hourly) or not a window (other). */
    keptDays: number | null;
    /** Whole days of it held; null where that is not the measure. */
    heldDays: number | null;
    /** Where it levels off at today's rate; null when kept for good or unknown. */
    steadyBytes: number | null;
    full: boolean;
    /** The free-text index's share, counted once (messages only). */
    indexBytes?: number;
}

export interface Growth {
    totalBytes: number;
    parts: GrowthPart[];
    /** Every windowed part at its level plus what is kept for good and the rest, as of now; null when a window's rate is unknown. */
    steadyBytes: number | null;
    /** What the kept-for-good history adds a year at today's rate; null when unknown. */
    perYearBytes: number | null;
}

/** A partition with less than this holds no day worth measuring: an empty
 *  messages partition with its four indexes is 72 kB, a samples one 8 kB. */
export const EMPTY_PARTITION_BYTES = 128 * 1024;
/** Days the rate is averaged over. */
export const RATE_DAYS = 7;
/** A month's rate needs this many days of it before it is trusted. */
export const MIN_MONTH_DAYS = 3;

const DAY = 86_400;
const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
};
const utcDayKey = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10).replace(/-/g, '');

/** A daily-partitioned table: rate from its last complete days, the index counted once. */
function dailyPart(
    key: 'raw' | 'messages', rows: GrowthPartition[], parent: string, keptDays: number, nowS: number,
): GrowthPart {
    const today = utcDayKey(nowS);
    const mine = rows.filter((r) => r.parent === parent);
    const bytes = mine.reduce((a, r) => a + num(r.bytes), 0);
    const indexBytes = mine.reduce((a, r) => a + num(r.trgm_bytes), 0);
    const complete = mine
        .map((r) => ({ day: /_(\d{8})$/.exec(r.partition_name)?.[1] ?? '', base: num(r.bytes) - num(r.trgm_bytes) }))
        .filter((r) => r.day !== '' && r.day < today && r.base >= EMPTY_PARTITION_BYTES)
        .sort((a, b) => a.day.localeCompare(b.day));
    const last = complete.slice(-RATE_DAYS);
    const perDay = last.length > 0 ? last.reduce((a, r) => a + r.base, 0) / last.length : null;
    // Held: whole days from the oldest day with anything in it to yesterday -
    // a quiet day inside that span is still a day of the window.
    const oldest = complete[0]?.day;
    const dayS = (k: string): number => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8))) / 1000;
    const heldDays = oldest === undefined ? 0 : Math.round((dayS(today) - dayS(oldest)) / DAY);
    return {
        key, bytes, perDay, keptDays, heldDays,
        steadyBytes: perDay === null ? null : perDay * keptDays + indexBytes,
        full: heldDays >= keptDays,
        ...(key === 'messages' ? { indexBytes } : {}),
    };
}

/**
 * The hourly history's rate: this UTC month's partition over the days it has
 * covered - from the month's start, or from when the database began if that
 * was later (the oldest ping kept stands for it: pings are kept a month,
 * raw samples two weeks). Under MIN_MONTH_DAYS into a month, last month's
 * partition over its covered days instead. Plus ping_hourly over its own
 * span (it has an index on its hour, so its oldest row is cheap; the samples
 * rollup has none, which is why it is judged by month).
 */
function hourlyPart(rows: GrowthPartition[], f: GrowthFacts): GrowthPart {
    const mine = rows.filter((r) => r.parent === 'samples_hourly');
    const sampleBytes = mine.reduce((a, r) => a + num(r.bytes), 0);
    const bytes = sampleBytes + f.pingHourlyBytes;
    const now = new Date(f.nowS * 1000);
    const monthStartS = (y: number, m: number): number => Date.UTC(y, m, 1) / 1000;
    const cur = { start: monthStartS(now.getUTCFullYear(), now.getUTCMonth()), end: f.nowS };
    const prev = { start: monthStartS(now.getUTCFullYear(), now.getUTCMonth() - 1), end: cur.start };
    const firstS = f.pingOldestS ?? f.pingHourlyOldestS;
    const sizeOf = (startS: number): number => {
        const d = new Date(startS * 1000);
        const name = `samples_hourly_${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        return num(mine.find((r) => r.partition_name === name)?.bytes);
    };
    const covered = (m: { start: number; end: number }): number =>
        Math.max(0, m.end - Math.max(m.start, firstS ?? m.start)) / DAY;
    // A month answers only when it covers MIN_MONTH_DAYS and holds something:
    // a database with no hourly history has no rate, not a rate of zero.
    let samplesPerDay: number | null = null;
    if (covered(cur) >= MIN_MONTH_DAYS && sizeOf(cur.start) >= EMPTY_PARTITION_BYTES) samplesPerDay = sizeOf(cur.start) / covered(cur);
    else if (covered(prev) >= MIN_MONTH_DAYS && sizeOf(prev.start) >= EMPTY_PARTITION_BYTES) samplesPerDay = sizeOf(prev.start) / covered(prev);
    const pingSpan = f.pingHourlyOldestS === null ? 0 : (f.nowS - f.pingHourlyOldestS) / DAY;
    const pingPerDay = pingSpan >= 1 ? f.pingHourlyBytes / pingSpan : 0;
    return {
        key: 'hourly', bytes, perDay: samplesPerDay === null ? null : samplesPerDay + pingPerDay,
        keptDays: null, heldDays: null, steadyBytes: null, full: false,
    };
}

export function estimateGrowth(rows: GrowthPartition[], f: GrowthFacts, w: GrowthWindows): Growth {
    const raw = dailyPart('raw', rows, 'samples', w.rawDays, f.nowS);
    const messages = dailyPart('messages', rows, 'messages', w.messageDays, f.nowS);
    const pingHeld = f.pingOldestS === null ? 0 : Math.min((f.nowS - f.pingOldestS) / DAY, w.pingDays);
    const pingPerDay = pingHeld >= 1 ? f.pingBytes / pingHeld : null;
    const ping: GrowthPart = {
        key: 'ping', bytes: f.pingBytes, perDay: pingPerDay, keptDays: w.pingDays, heldDays: Math.floor(pingHeld),
        steadyBytes: pingPerDay === null ? null : pingPerDay * w.pingDays, full: pingHeld >= w.pingDays - 0.5,
    };
    const hourly = hourlyPart(rows, f);
    const counted = raw.bytes + messages.bytes + ping.bytes + hourly.bytes;
    const other: GrowthPart = {
        key: 'other', bytes: Math.max(0, f.dbBytes - counted), perDay: null, keptDays: null, heldDays: null,
        steadyBytes: null, full: false,
    };
    const windows = [raw, messages, ping];
    const steadyBytes = windows.some((p) => p.steadyBytes === null) ? null
        : windows.reduce((a, p) => a + (p.steadyBytes as number), 0) + hourly.bytes + other.bytes;
    return {
        totalBytes: f.dbBytes,
        parts: [raw, messages, ping, hourly, other],
        steadyBytes,
        perYearBytes: hourly.perDay === null ? null : hourly.perDay * 365,
    };
}
