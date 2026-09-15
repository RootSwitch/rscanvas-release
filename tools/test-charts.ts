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

const { fmtValue } = await import('../public/charts.js' as string) as {
    fmtValue: (v: number | null | undefined, unit: string) => string;
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
eq('bps scales SI decimal', fmtValue(1_500_000, 'bps'), '1.50 Mbps');
eq('bytes scale SI binary', fmtValue(1536, 'bytes'), '1.50 KiB');
eq('a day-scale duration reads d+h', fmtValue(90_000, 'dur'), '1d 1h');
eq('an hour-scale duration reads h+m', fmtValue(5400, 'dur'), '1h 30m');
eq('absence is a dash, not a zero', fmtValue(null, 'bps'), '-');
eq('NaN is absence too', fmtValue(Number.NaN, 'pct'), '-');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
