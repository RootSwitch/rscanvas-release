// How long an export will take, and how big it will be.
//
// This exists because the queue's admission policy bounds the projected START
// time of a job (BUILD-PLAN, "settle the export queue's admission policy"), and
// you cannot bound a start time without knowing how long the jobs ahead will
// run. A depth cap needs no estimator; a wait cap needs one.
//
// THE THING THAT MAKES THIS NON-TRIVIAL. Measured throughput, slice 1:
//
//   one host, 14 days      78,107 rows in 9.0s      8,681 rows/s
//   all hosts, 14 days  46,592,833 rows in 456.9s   101,980 rows/s
//
// Twelve times apart, and in the direction nobody guesses: the NARROW export is
// the slow one, per row. That is the time-major layout property
// (ARCHITECTURE.md 5a) - one device's rows are scattered one per page by the
// write order, so a per-device read is a random page read per row while a
// fleet-wide read is a sequential scan.
//
// A single rows-per-second constant would therefore under-predict a narrow
// export by 12x, and an ETA that is confidently wrong is worse than no ETA.

import type { SearchFilters } from '../store/index.ts';

// Measured on the lab, 2026-07-26. See RESULTS-SLICE-1.md 4b and
// RESULTS-SLICE-3.md.
//
// THESE ARE COLD FIGURES AND THEY OVER-PREDICT A WARM EXPORT. Measured error
// once slice 3 could compare prediction against reality:
//
//   narrow, warm   predicted 9.4s, actual 0.8s     0.08x
//   wide,   warm   predicted 4.1s, actual 2.9s     0.69x
//   wide,   warm   predicted 15.9s, actual 11.6s   0.73x
//
// The narrow miss is the interesting one and it is not a bad constant. The 12x
// narrow-versus-wide gap is a COLD-CACHE property: one device's rows are
// scattered one per page, so reading them cold is a random page read per row,
// and warm it is not - warm, narrow ran at 89,000 to 98,000 rows/s, which is
// indistinguishable from wide. The estimator cannot know the cache state.
//
// So the constants stay COLD deliberately, because the two errors are not
// symmetric. Over-predicting makes the queue ceiling refuse a little too
// early, which costs throughput. Under-predicting makes it admit work it
// cannot deliver on time, which is the failure the ceiling exists to prevent -
// a job id that resolves in three hours. Conservative is the correct
// direction, and 12x conservative on the narrow case is recorded here rather
// than quietly rounded away.
export const NARROW_ROWS_PER_S = 8_681;
export const WIDE_ROWS_PER_S = 101_980;

/** Connection acquisition, cursor declaration, first fetch. */
const FIXED_OVERHEAD_MS = 400;

/** Measured: 10.9GB for 46,592,833 rows, plus the raw column this export adds. */
const BYTES_PER_ROW = 320;

/**
 * A query is NARROW when it is confined to one device.
 *
 * That is the property that decides the access pattern: a host or source
 * address filter turns the read into one-page-per-row, everything else does
 * not. A time window narrows the row COUNT without changing the pattern, which
 * is why it does not appear here.
 */
export function isNarrow(f: SearchFilters): boolean {
    return f.host !== undefined || f.sourceIp !== undefined;
}

export interface Estimate {
    rows: number;
    narrow: boolean;
    rowsPerSecond: number;
    durationMs: number;
    bytes: number;
}

export function estimate(f: SearchFilters, rows: number): Estimate {
    const narrow = isNarrow(f);
    const rowsPerSecond = narrow ? NARROW_ROWS_PER_S : WIDE_ROWS_PER_S;
    return {
        rows,
        narrow,
        rowsPerSecond,
        durationMs: Math.round(FIXED_OVERHEAD_MS + (rows / rowsPerSecond) * 1000),
        bytes: rows * BYTES_PER_ROW,
    };
}

export function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

export function humanDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m${secs.toString().padStart(2, '0')}s`;
}
