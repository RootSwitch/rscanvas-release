// The growth estimate (src/store/growth.ts), offline.
//
//   node tools/test-growth.ts
//
// First on production's own numbers of 2026-10-19 (the sizes the operator's
// question was asked against, read read-only that evening): raw samples full
// at about 1.5 GB, syslog whose recent days are doubled by the free-text
// index, ping detail two days short of its window, an hourly history in its
// second month. Then the edges: an empty database, a young one, today's
// partial day and the pre-made future days, and the start of a month.

import { estimateGrowth, EMPTY_PARTITION_BYTES, type GrowthFacts, type GrowthPartition } from '../src/store/growth.ts';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const near = (label: string, got: number | null | undefined, want: number, tol: number): void =>
    eq(`${label} (${got === null || got === undefined ? got : Math.round(got)} ~ ${want})`, got !== null && got !== undefined && Math.abs(got - want) <= tol, true);
const MB = 1e6;
const S = (iso: string): number => Date.parse(iso) / 1000;
const day = (d: string): string => d.replace(/-/g, '');
const W = { rawDays: 14, messageDays: 30, pingDays: 30 };

console.log('the growth estimate');

// --- production, 2026-10-19 23:50Z ------------------------------------------------
const NOW = S('2026-10-19T23:50:00Z');
const rawKnown: Record<string, number> = {
    '2026-10-11': 103833600, '2026-10-12': 104079360, '2026-10-13': 103538688, '2026-10-14': 104218624,
    '2026-10-15': 103768064, '2026-10-16': 107585536, '2026-10-17': 105701376, '2026-10-18': 106577920,
    '2026-10-19': 107462656,
};
const rows: GrowthPartition[] = [];
for (let d = S('2026-10-05T00:00:00Z'); d <= S('2026-10-26T00:00:00Z'); d += 86_400) {
    const iso = new Date(d * 1000).toISOString().slice(0, 10);
    const bytes = rawKnown[iso] ?? (iso < '2026-10-11' ? 99_000_000 : 8192);
    rows.push({ parent: 'samples', partition_name: `samples_${day(iso)}`, bytes });
}
// Syslog: the measured partitions, the four newest with their free-text index.
const msg: Array<[string, number, number]> = [
    ['2026-10-11', 1343488, 0], ['2026-10-12', 4390912, 0], ['2026-10-13', 12935168, 0], ['2026-10-14', 12361728, 0],
    ['2026-10-15', 13156352, 0], ['2026-10-16', 24829952, 12_200_000], ['2026-10-17', 22011904, 10_500_000],
    ['2026-10-18', 22568960, 11_000_000], ['2026-10-19', 26107904, 12_800_000],
];
for (let d = S('2026-09-22T00:00:00Z'); d < S('2026-10-11T00:00:00Z'); d += 86_400) {
    rows.push({ parent: 'messages', partition_name: `messages_${day(new Date(d * 1000).toISOString().slice(0, 10))}`, bytes: 900_000 });
}
for (const [d, b, t] of msg) rows.push({ parent: 'messages', partition_name: `messages_${day(d)}`, bytes: b, trgm_bytes: t });
for (const d of ['2026-10-20', '2026-10-21', '2026-10-22']) rows.push({ parent: 'messages', partition_name: `messages_${day(d)}`, bytes: 73728 });
rows.push({ parent: 'samples_hourly', partition_name: 'samples_hourly_202609', bytes: 18 * 1024 * 1024 });
rows.push({ parent: 'samples_hourly', partition_name: 'samples_hourly_202610', bytes: 23 * 1024 * 1024 });
rows.push({ parent: 'samples_hourly', partition_name: 'samples_hourly_202611', bytes: 8192 });
const facts: GrowthFacts = {
    dbBytes: 1863 * 1024 * 1024, pingBytes: 152 * 1024 * 1024, pingOldestS: S('2026-09-22T02:07:00Z'),
    pingHourlyBytes: 2656 * 1024, pingHourlyOldestS: S('2026-09-22T02:00:00Z'), nowS: NOW,
};
const g = estimateGrowth(rows, facts, W);
const part = (k: string) => g.parts.find((p) => p.key === k)!;
console.log('\nproduction on 2026-10-19:');
near('raw samples: the last seven complete days, today and the made-ahead days left out', part('raw').perDay, 105.1 * MB, 0.3 * MB);
eq('raw samples: fourteen days held of fourteen - full', [part('raw').heldDays, part('raw').full], [14, true]);
near('raw samples level at fourteen days of it', part('raw').steadyBytes, 14 * 105.1 * MB, 5 * MB);
near('syslog: a day without its index is about 12 MB, not the 23 the newest days read', part('messages').perDay, 11.6 * MB, 0.6 * MB);
eq('syslog: 28 of 30 days held', [part('messages').heldDays, part('messages').full], [27, false]);
near('the index counted once, at its size now', part('messages').indexBytes, 46.5 * MB, 0.1 * MB);
near('syslog levels off near 30 days of it plus the index', part('messages').steadyBytes, 30 * 11.6 * MB + 46.5 * MB, 20 * MB);
near('ping: its size over the days it holds', part('ping').perDay, (152 * 1024 * 1024) / 27.9, 0.2 * MB);
near('ping levels off near thirty days of it', part('ping').steadyBytes, 171 * MB, 3 * MB);
near('hourly history: this month over the days it has covered, plus the ping summary', part('hourly').perDay, 1.30 * MB, 0.08 * MB);
eq('hourly history is kept for good: no level', [part('hourly').keptDays, part('hourly').steadyBytes], [null, null]);
near('everything else is the rest of the database', part('other').bytes, facts.dbBytes - part('raw').bytes - part('messages').bytes
    - part('ping').bytes - part('hourly').bytes, 1);
near('altogether it levels off near 2.1 GB', g.steadyBytes, 2.1e9, 0.12e9);
near('and then grows about 0.47 GB a year', g.perYearBytes, 0.475e9, 0.03e9);

// --- the edges --------------------------------------------------------------------
console.log('\nthe edges:');
const empty = estimateGrowth([], { dbBytes: 9e6, pingBytes: 0, pingOldestS: null, pingHourlyBytes: 0, pingHourlyOldestS: null, nowS: NOW }, W);
eq('an empty database: every rate unknown, nothing projected, no throw',
    [empty.parts.map((p) => p.perDay), empty.steadyBytes, empty.perYearBytes, empty.parts.find((p) => p.key === 'other')?.bytes],
    [[null, null, null, null, null], null, null, 9e6]);
const young: GrowthPartition[] = [
    { parent: 'samples', partition_name: 'samples_20261018', bytes: 40 * MB },
    { parent: 'samples', partition_name: 'samples_20261019', bytes: 30 * MB },
    { parent: 'samples', partition_name: 'samples_20261020', bytes: 8192 },
    { parent: 'messages', partition_name: 'messages_20261018', bytes: 2 * MB },
    { parent: 'messages', partition_name: 'messages_20261019', bytes: 1 * MB },
    { parent: 'samples_hourly', partition_name: 'samples_hourly_202610', bytes: 1 * MB },
];
const y = estimateGrowth(young, { dbBytes: 90 * MB, pingBytes: 4 * MB, pingOldestS: S('2026-10-18T06:00:00Z'),
    pingHourlyBytes: 100_000, pingHourlyOldestS: S('2026-10-18T06:00:00Z'), nowS: NOW }, W);
const yp = (k: string) => y.parts.find((p) => p.key === k)!;
eq('a day-old install: one complete day is the rate, today is not', [yp('raw').perDay, yp('raw').heldDays, yp('raw').full], [40 * MB, 1, false]);
near('...and it projects from it', yp('raw').steadyBytes, 14 * 40 * MB, 1);
eq('under three days of hourly history: too early, not a guess', [yp('hourly').perDay, y.perYearBytes], [null, null]);
const lateStart = estimateGrowth([{ parent: 'samples_hourly', partition_name: 'samples_hourly_202610', bytes: 6 * MB }],
    { dbBytes: 40 * MB, pingBytes: 0, pingOldestS: S('2026-10-13T23:50:00Z'), pingHourlyBytes: 0, pingHourlyOldestS: null, nowS: NOW }, W);
near('a database begun mid-month: its six days, not the nineteen since the 1st', lateStart.parts.find((p) => p.key === 'hourly')!.perDay,
    1 * MB, 1);
eq('ping under a day old: too early', estimateGrowth(young, { dbBytes: 90 * MB, pingBytes: 4 * MB, pingOldestS: S('2026-10-19T12:00:00Z'),
    pingHourlyBytes: 0, pingHourlyOldestS: null, nowS: NOW }, W).parts.find((p) => p.key === 'ping')!.perDay, null);
const early = estimateGrowth([
    { parent: 'samples_hourly', partition_name: 'samples_hourly_202610', bytes: 31 * MB },
    { parent: 'samples_hourly', partition_name: 'samples_hourly_202611', bytes: 1.5 * MB },
], { dbBytes: 40 * MB, pingBytes: 0, pingOldestS: S('2026-09-01T00:00:00Z'), pingHourlyBytes: 0, pingHourlyOldestS: null,
    nowS: S('2026-11-02T00:00:00Z') }, W);
near('a day into a month: last month\'s rate, not one day of this one', early.parts.find((p) => p.key === 'hourly')!.perDay, 1 * MB, 1);
eq('a messages partition below the empty mark is not a day', EMPTY_PARTITION_BYTES > 73728, true);
eq('everything else never reads negative', estimateGrowth(rows, { ...facts, dbBytes: 1 }, W).parts.find((p) => p.key === 'other')!.bytes, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
