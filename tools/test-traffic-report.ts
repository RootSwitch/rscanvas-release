// The reporting arithmetic, offline: bytes from hourly means, coverage, trend,
// the report's lines and totals, and its CSV.
//
//   node tools/test-traffic-report.ts
//
// src/reports/traffic.ts says what a total is (hourly mean bps x 3,600 / 8)
// and why coverage rides beside it. These are the numbers the Dashboard and a
// month's ISP report print, so they are pinned here against hand arithmetic
// rather than trusted to read right.

import {
    bytesFromHourlyBps, countFromHourlyRate, coverage, trend, parseWindowHours,
    reportLines, reportCsv, isDay, isTimeZone, REPORT_COLUMNS, type ReportDayRow,
} from '../src/reports/traffic.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// --- totals ------------------------------------------------------------------------
// A link at a steady 8 Mbit/s for 24 hours carried 8e6 x 86,400 / 8 bytes.
ok('24 hours at 8 Mbit/s is 86.4 GB', near(bytesFromHourlyBps(24 * 8e6), 86.4e9));
ok('one hour at 1 Gbit/s is 450 GB', near(bytesFromHourlyBps(1e9), 450e9));
ok('no hours is no number, not zero', bytesFromHourlyBps(null) === null);
ok('0.5 errors/s for 2 hours is 3,600 errors', near(countFromHourlyRate(2 * 0.5), 3600));

// --- coverage ------------------------------------------------------------------------
ok('a fully polled window is 1', coverage(24, 24) === 1);
ok('18 of 24 hours covered is 0.75', coverage(18, 24) === 0.75);
ok('over-polling cannot read above 100%', coverage(25, 24) === 1);
ok('nothing covered, or no window, is 0', coverage(null, 24) === 0 && coverage(5, 0) === 0);

// --- trend ---------------------------------------------------------------------------
ok('135 against 100 is +35%', near(trend(135, 100), 0.35));
ok('50 against 100 is -50%', near(trend(50, 100), -0.5));
ok('no previous window is no trend, not +infinity', trend(10, null) === null && trend(10, 0) === null);
// The first live run's false +61%: the same rate, a full window against a
// window the rollup only partly covered. Per covered hour, it is no change.
ok('a steady rate over a full window against a 15-hour one is 0%, not +60%',
    trend(24 * 100, 15 * 100, 24, 15, 24) === 0, String(trend(24 * 100, 15 * 100, 24, 15, 24)));
ok('a real doubling still reads +100% per covered hour', near(trend(24 * 200, 18 * 100, 24, 18, 24), 1));
ok('a previous window under half covered gives no trend', trend(2400, 1100, 24, 11, 24) === null);
ok('already-mean values (sensors) are compared as they are, with the same coverage rule',
    near(trend(30, 20, null, 20, 24), 0.5) && trend(30, 20, null, 6, 24) === null);

// --- windows -------------------------------------------------------------------------
ok('the window defaults to 24 hours', parseWindowHours(null) === 24);
ok('6, 24 and 168 hours are offered', parseWindowHours('6') === 6 && parseWindowHours('168') === 168);
ok('anything else is refused', parseWindowHours('12') === null && parseWindowHours('24h') === null);

// --- the report ----------------------------------------------------------------------
const day = (code: string, device: string, name: string, d: string, sumIn: number | null, cov: number, pk = 5e7): ReportDayRow => ({
    day: d, device, name, alias: code === 'isp1' ? '=HYPERLINK("http://x")' : 'Uplink, "ISP B"', code,
    sum_in: sumIn, sum_out: sumIn === null ? null : sumIn / 2,
    peak_in: sumIn === null ? null : pk, peak_out: sumIn === null ? null : pk / 2,
    covered_h: cov, expected_h: 24,
});
// isp2 is given first and out of order, to prove the sort; isp1 has a dead day.
const rows = [
    day('isp2', 'edge-1', 'Gi0/2', '2026-09-02', 24 * 8e6, 24),
    day('isp1', 'edge-1', 'Gi0/1', '2026-09-02', null, 0),
    day('isp2', 'edge-1', 'Gi0/2', '2026-09-01', 24 * 8e6, 24, 9e7),
    day('isp1', 'edge-1', 'Gi0/1', '2026-09-01', 24 * 16e6, 12),
];
const lines = reportLines(rows);
ok('six lines: two days and a total for each of two interfaces', lines.length === 6);
ok('sorted by interface then day, each total after its own days',
    lines.map((l) => `${l.iface} ${l.day.slice(0, 5)}`).join('|')
    === 'Gi0/1 2026-|Gi0/1 2026-|Gi0/1 total|Gi0/2 2026-|Gi0/2 2026-|Gi0/2 total',
    lines.map((l) => `${l.iface} ${l.day}`).join('|'));
const dead = lines[1]!;
ok('a day with no samples is a line with no GB and 0% coverage, not a missing date',
    dead.day === '2026-09-02' && dead.inGB === null && dead.totalGB === null && dead.coveragePct === 0);
const t1 = lines[2]!;
ok('total: 172.8 GB in over the range', t1.inGB === 172.8, String(t1.inGB));
ok('total: in plus out', t1.totalGB === 259.2, String(t1.totalGB));
ok('total coverage is covered hours over expected hours (12 of 48 = 25%)', t1.coveragePct === 25, String(t1.coveragePct));
ok('total names the range', t1.day === 'total 2026-09-01 to 2026-09-02');
const t2 = lines[5]!;
ok('the total peak is the highest daily peak (90 Mbps)', t2.peakInMbps === 90 && t2.peakOutMbps === 45, `${t2.peakInMbps}/${t2.peakOutMbps}`);
ok('a half-covered day reads 50%', lines[0]!.coveragePct === 50);

const csv = reportCsv(lines);
const csvLines = csv.trim().split('\n');
ok('CSV: a header and one row per line', csvLines.length === 7 && csvLines[0] === REPORT_COLUMNS.map((c) => `"${c}"`).join(','));
ok('CSV: a description starting with = is formula-guarded', csv.includes('"\'=HYPERLINK(""http://x"")"'));
ok('CSV: embedded quotes and commas stay inside their cell', csv.includes('"Uplink, ""ISP B"""'));
ok('CSV: an empty measurement is an empty cell, not "null"', !csv.includes('null'));

// --- inputs ----------------------------------------------------------------------------
ok('a real date is a date', isDay('2026-09-25') && isDay('2024-02-29'));
ok('an impossible date is not', !isDay('2026-02-30') && !isDay('2026-9-25') && !isDay(null));
ok('IANA zones are accepted', isTimeZone('America/Chicago') && isTimeZone('UTC') && isTimeZone('Etc/GMT+6'));
ok('anything else is refused before it reaches SQL',
    !isTimeZone('Mars/Olympus') && !isTimeZone("UTC'; DROP TABLE x;--") && !isTimeZone(null));
// Review L17: Intl takes bare offsets, PostgreSQL reads them as POSIX with
// the sign reversed - a +05 report summed its days ten hours off.
ok('a bare offset is refused, in every spelling Intl accepts',
    !isTimeZone('+05') && !isTimeZone('+05:00') && !isTimeZone('-0500'));
ok('names with + and - in them still pass', isTimeZone('America/Port-au-Prince') && isTimeZone('Etc/GMT-14'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
