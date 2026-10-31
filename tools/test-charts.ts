// charts.js's value formatter, as a table - the suite that would have
// caught the 2026-09-01 review's client finding 5 before it shipped: the
// errors/discards chart formatted fractional rates through fmtSI's two
// decimals, so one CRC per five minutes (0.0033/s) labelled its axis and
// tooltip "0.00 /s" - a failing port reading as clean, the exact bug the
// one-way-door rule was written about, enforced in the roster's fmtRate and
// not in the chart until that review. The shipped module is imported, never
// re-implemented.
//
//   node tools/test-charts.ts

const { fmtValue, lineRuns, chartStep } = await import('../public/charts.js' as string) as {
    fmtValue: (v: number | null | undefined, unit: string) => string;
    lineRuns: (data: Array<[number, number | null]>, stepSec: number) => Array<Array<[number, number]>>;
    chartStep: (bucketSec: number, stepSec: number | null | undefined) => number;
};

let pass = 0;
let fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    if (got === want) { pass++; console.log(`  ok   ${l}`); }
    else { fail++; console.log(`  FAIL ${l} - got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
};

console.log('charts.js fmtValue, as a table\n');

console.log('the one-way door: fractional rates stay fractional');
eq('one CRC per five minutes is NOT "0.00 /s"', fmtValue(0.0033, 'pps'), '0.0033 /s');
// Three decimals, not four: 0.0167 sits above the 0.01 line, and the
// roster's fmtRate renders it identically - the two formatters agreeing is
// the property, and this suite's own first run mistook four-decimals-
// everywhere for it.
eq('one CRC per minute survives, at fmtRate\'s own precision', fmtValue(0.0167, 'pps'), '0.017 /s');
eq('sub-one rates keep three decimals', fmtValue(0.5, 'pps'), '0.500 /s');
eq('zero is honestly zero', fmtValue(0, 'pps'), '0.00 /s');
eq('whole rates go back to SI', fmtValue(1500, 'pps'), '1.50 k/s');

console.log('\nthe other units, pinned');
eq('percent gets one decimal', fmtValue(85.7333333, 'pct'), '85.7%');
eq('temperature gets one decimal', fmtValue(45.85, 'degc'), '45.9 C');
eq('rpm is whole', fmtValue(1234.6, 'rpm'), '1235 rpm');
eq('bps scales SI decimal, written as the Top 10 writes it', fmtValue(1_500_000, 'bps'), '1.50 Mb/s');
eq('bytes scale SI binary', fmtValue(1536, 'bytes'), '1.50 KiB');
eq('a day-scale duration reads d+h', fmtValue(90_000, 'dur'), '1d 1h');
eq('an hour-scale duration reads h+m', fmtValue(5400, 'dur'), '1h 30m');
eq('absence is a dash, not a zero', fmtValue(null, 'bps'), '-');
eq('NaN is absence too', fmtValue(Number.NaN, 'pct'), '-');

// --- where a line breaks (2026-10-21) -------------------------------------------------
// Production's hourly bandwidth test drew no line at 3 days and under: the
// raw view's bucket is 1/300 of the range (60 s at 6 h, 300 s at 24 h, 840 s
// at 3 days), each hourly reading sat more than 2.5 buckets from the next,
// and a run of one point drew nothing. The step is now the slower of the
// bucket and the entity's own cadence.
console.log('\nwhere a line breaks');
const hourly: Array<[number, number | null]> = Array.from({ length: 72 }, (_, i) => [1_000_000 + i * 3600 + 7, 940]);
const lens = (runs: Array<Array<unknown>>): string => JSON.stringify(runs.map((r) => r.length));
eq('an hourly test at 3 days, judged by the 840 s bucket alone: 72 runs of one (the bug)',
    lens(lineRuns(hourly, chartStep(840, null))), JSON.stringify(Array(72).fill(1)));
eq('...with its hourly cadence: one line', lens(lineRuns(hourly, chartStep(840, 3600))), '[72]');
eq('...the same at 6 hours (60 s buckets)', lens(lineRuns(hourly.slice(0, 6), chartStep(60, 3600))), '[6]');
const holed = hourly.filter(([t]) => t < 1_000_000 + 20 * 3600 || t > 1_000_000 + 24 * 3600);
eq('four hours with no test still break it - the cadence does not paper over an outage',
    lens(lineRuns(holed, chartStep(840, 3600))), '[20,48]');
const failed = hourly.map(([t, v], i) => [t, i === 30 ? null : v] as [number, number | null]);
eq('a failed run (null) breaks it too', lens(lineRuns(failed, chartStep(840, 3600))), '[30,41]');
const thirty: Array<[number, number | null]> = Array.from({ length: 10 }, (_, i) => [2_000_000 + i * 60, 5]);
eq('a 30 s poller in 60 s buckets: the bucket is the slower, as before', chartStep(60, 30), 60);
eq('  and joins', lens(lineRuns(thirty, chartStep(60, 30))), '[10]');
eq('no cadence known: the bucket alone, as before', chartStep(300, null), 300);
eq('a lone reading between gaps is its own run, which the chart draws as a dot',
    lens(lineRuns([[0, 1], [60, 1], [5000, 2], [9000, 3], [9060, 3]], 60)), '[2,1,2]');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
