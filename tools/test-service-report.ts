// The services report's arithmetic (2026-10-07, SLICE-SERVICE-VIEWS-PLAN step
// 3), against the readings themselves: raw readings are rolled into hours the
// way roll_up_samples does, the hours summed into days the way
// OPS.serviceReport does, and every figure the report prints is compared with
// the same figure computed straight from the readings. The point is the
// pooling: a fortnight's standard deviation must be the fortnight's.
//
//   node tools/test-service-report.ts

import {
    mean, parseReportKind, SERVICE_COLUMNS, serviceCsv, serviceLines, stdDev, type ServiceDayRow,
} from '../src/reports/services.ts';

// An early exit without a verdict must read as FAILURE (the test-walk incident).
process.exitCode = 1;

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};
const close = (l: string, got: number | null | undefined, want: number, dp: number): void => {
    if (got !== null && got !== undefined && Math.abs(got - want) <= 0.5 * 10 ** -dp + 1e-9) ok(`${l} (${got})`);
    else bad(l, `got ${got}, wanted ${want.toFixed(dp + 2)}`);
};

type Run = { v: Array<number | null>; ok: boolean };   // v0..v4 and the outcome

/** An hour's rollup row from its runs, as roll_up_samples writes it. */
function hourOf(runs: Run[], voice: boolean, withSpread = true) {
    const col = (i: number) => runs.map((r) => r.v[i]).filter((x): x is number => x !== null);
    const h: Record<string, number | null> = { n: runs.length, nok: runs.filter((r) => r.ok).length };
    for (let i = 0; i < 5; i++) {
        const xs = col(i);
        h[`a${i}`] = xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
        h[`n${i}`] = xs.length;
        h[`lo${i}`] = xs.length ? Math.min(...xs) : null;
        h[`m${i}`] = xs.length ? Math.max(...xs) : null;
        h[`q${i}`] = withSpread && xs.length ? xs.reduce((s, x) => s + x * x, 0) : null;
    }
    h.mos36 = voice ? col(4).filter((x) => x < 3.6).length : null;
    h.mos31 = voice ? col(4).filter((x) => x < 3.1).length : null;
    if (!withSpread) { h.nok = null; h.mos36 = null; h.mos31 = null; }
    return h;
}

/** A day's row from its hours, as OPS.serviceReport sums them. */
function dayOf(day: string, code: string, kind: string, hours: Array<Record<string, number | null>>): ServiceDayRow {
    const sum = (f: (h: Record<string, number | null>) => number | null) => {
        const xs = hours.map(f).filter((x): x is number => x !== null);
        return xs.length ? xs.reduce((s, x) => s + x, 0) : null;
    };
    const ext = (k: string, pickMax: boolean) => {
        const xs = hours.map((h) => h[k]).filter((x): x is number => x !== null);
        return xs.length ? (pickMax ? Math.max(...xs) : Math.min(...xs)) : null;
    };
    const r: Record<string, unknown> = {
        day, device: 'Branch 12', name: 'Voice to Branch 12', code, kind, hours: hours.length,
        runs: sum((h) => h.n), ok_n: sum((h) => (h.nok === null ? null : h.n)), ok_runs: sum((h) => h.nok),
        band_n: sum((h) => (h.mos36 === null ? null : h.n4)), mos36: sum((h) => h.mos36), mos31: sum((h) => h.mos31),
    };
    for (let i = 0; i < 5; i++) {
        r[`s${i}`] = sum((h) => (h[`a${i}`] === null ? null : (h[`a${i}`] as number) * (h[`n${i}`] as number)));
        r[`c${i}`] = sum((h) => h[`n${i}`]);
        r[`qs${i}`] = sum((h) => (h[`q${i}`] === null || h[`a${i}`] === null ? null : (h[`a${i}`] as number) * (h[`n${i}`] as number)));
        r[`qc${i}`] = sum((h) => (h[`q${i}`] === null ? null : h[`n${i}`]));
        r[`q${i}`] = sum((h) => h[`q${i}`]);
        r[`lo${i}`] = ext(`lo${i}`, false);
        r[`m${i}`] = ext(`m${i}`, true);
    }
    return r as unknown as ServiceDayRow;
}

const sd = (xs: number[]) => {
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

console.log('services report\n');

console.log('the pieces:');
eq('kinds: voice, bandwidth, web - nothing else', ['voice', 'bandwidth', 'web', 'tcp', null].map(parseReportKind), ['voice', 'bandwidth', 'web', null, null]);
close('mean from a weighted sum', mean(30, 4), 7.5, 6);
eq('no count, no mean', mean(0, 0), null);
close('the standard deviation from pooled sums is the textbook one', stdDev(1 + 4 + 9 + 16, 10, 4), sd([1, 2, 3, 4]), 9);
eq('under two readings there is none', stdDev(4, 2, 1), null);
eq('identical readings: zero, never a NaN from rounding', stdDev(3 * 0.1 * 0.1, 0.3, 3), 0);

// A voice test over two days: a steady day and a day that sags now and then
// - the operator's site whose MOS drops below 3 on occasional runs.
const steady = [4.38, 4.40, 4.39, 4.41, 4.40, 4.39];
const sagging = [4.40, 4.38, 2.90, 4.39, 3.40, 4.40, 4.37, 4.41];
const run = (mos: number, loss: number, jit: number): Run => ({ v: [loss, loss / 2, jit, jit * 2, mos], ok: true });
const failed: Run = { v: [null, null, null, null, null], ok: false };
const d1h1 = steady.slice(0, 3).map((m) => run(m, 0, 1)), d1h2 = steady.slice(3).map((m) => run(m, 0.1, 1.5));
const d2h1 = sagging.slice(0, 4).map((m, i) => run(m, i === 2 ? 4 : 0.2, i === 2 ? 30 : 2));
const d2h2 = [...sagging.slice(4).map((m, i) => run(m, i === 0 ? 2 : 0.1, i === 0 ? 20 : 1.8)), failed];
const rows = [
    dayOf('2026-10-05', 'V1', 'path-voice', [hourOf(d1h1, true), hourOf(d1h2, true)]),
    dayOf('2026-10-06', 'V1', 'path-voice', [hourOf(d2h1, true), hourOf(d2h2, true)]),
];
const lines = serviceLines('voice', rows);

console.log('\na voice test, a steady day and a sagging one:');
eq('two days and a total', lines.map((l) => l.day), ['2026-10-05', '2026-10-06', 'total 2026-10-05 to 2026-10-06']);
const [day1, day2, tot] = lines;
close('day 1 MOS average', day1.values.mos_avg, avg(steady), 2);
close('day 2 MOS sd, from its two hours pooled', day2.values.mos_sd, sd(sagging), 2);
close('the TOTAL\'s sd is the whole period\'s, not an average of the days\'', tot.values.mos_sd, sd([...steady, ...sagging]), 2);
eq('  (which the average of the two daily figures is not)',
    Math.abs(((day1.values.mos_sd ?? 0) + (day2.values.mos_sd ?? 0)) / 2 - sd([...steady, ...sagging])) > 0.1, true);
close('the minimum is the sag', tot.values.mos_min, 2.9, 2);
eq('how often: runs under 3.6 and under 3.1', [tot.values.runs_under_3_6, tot.values.runs_under_3_1], [2, 1]);
eq('runs count the failed one; ok % does not', [tot.values.runs, tot.values.ok_pct], [15, Math.round(14 / 15 * 1000) / 10]);
close('loss avg is the worse direction\'s (toward, here)', tot.values.loss_avg_pct,
    avg([...d1h1, ...d1h2, ...d2h1, ...d2h2.slice(0, 4)].map((r) => r.v[0] as number)), 2);
eq('loss and jitter worst are the worst of either direction', [tot.values.loss_worst_pct, tot.values.jitter_worst_ms], [4, 60]);

console.log('\nhours rolled before the upgrade carry no spread:');
{
    // Day 1's hours from before the upgrade: averages, no sums of squares,
    // no ok count, no bands. The spread must come from day 2 alone, not be
    // biased by day 1's means counted against a sum of squares without them.
    const mixed = serviceLines('voice', [
        dayOf('2026-10-05', 'V1', 'path-voice', [hourOf(d1h1, true, false), hourOf(d1h2, true, false)]),
        dayOf('2026-10-06', 'V1', 'path-voice', [hourOf(d2h1, true), hourOf(d2h2, true)]),
    ]);
    const t = mixed[2];
    close('the total\'s sd is over the hours that have one', t.values.mos_sd, sd(sagging), 2);
    close('its average still uses every hour', t.values.mos_avg, avg([...steady, ...sagging]), 2);
    eq('ok % over the hours that count ok runs only', t.values.ok_pct, Math.round(8 / 9 * 1000) / 10);
    eq('a day with nothing to count shows nothing, not zero', [mixed[0].values.mos_sd, mixed[0].values.ok_pct, mixed[0].values.runs_under_3_6], [null, null, null]);
}

console.log('\nbandwidth and web:');
{
    const tp = [[200, 150], [199, 120], [200, 162]].map(([a, b]) => ({ v: [a, b, 40, 3, 1], ok: true } as Run));
    const [l1] = serviceLines('bandwidth', [dayOf('2026-10-06', 'T1', 'path-tput', [hourOf(tp, false)])]);
    close('to: average and sd', l1.values.to_sd_mbps, sd([200, 199, 200]), 1);
    eq('from: the slowest run', l1.values.from_min_mbps, 120);
    eq('no band counts on anything but voice', 'runs_under_3_6' in l1.values, false);
    const web = [{ v: [120, 30, 41, 1, 2], ok: true }, { v: [480, 31, 41, 1, 3], ok: true }, failed] as Run[];
    const [w1] = serviceLines('web', [dayOf('2026-10-06', 'H1', 'svc-http', [hourOf(web, false)])]);
    eq('web: average, worst, two of three ok', [w1.values.ms_avg, w1.values.ms_worst, w1.values.ok_pct], [300, 480, 66.7]);
}

console.log('\nthe CSV:');
{
    const csv = serviceCsv('voice', lines);
    // Every cell is quoted by the shared helper (src/export/csv.ts); read them bare.
    const cells = (line: string) => line.split(',').map((c) => c.replace(/^"|"$/g, ''));
    const [head, firstRow] = csv.split('\n');
    eq('a header from the kind\'s columns', cells(head), ['date', 'device', 'check', ...SERVICE_COLUMNS.voice.map((c) => c.id)]);
    eq('one row a line, the header first', csv.trim().split('\n').length, lines.length + 1);
    eq('values rounded to the column\'s decimals', cells(firstRow).slice(5, 8), [String(day1.values.mos_avg), String(day1.values.mos_min), String(day1.values.mos_sd)]);
    const hostile = serviceCsv('web', serviceLines('web', [{ ...dayOf('2026-10-06', 'H1', 'svc-http', []), name: '=HYPERLINK("x")' }]));
    eq('a check named like a formula is defused', hostile.split('\n')[1].includes('"=HYPERLINK'), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
