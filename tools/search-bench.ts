// Measure one search case, cold or warm, with cache residency attached.
//
// Driven by tools/search-bench.sh, which handles the root-only part of making a
// read genuinely cold. This half runs one case and prints JSON.
//
// It goes through OPS.searchMessages, the real product path, rather than a
// parallel query written for the benchmark. A benchmark that measures a
// hand-rolled lookalike proves the lookalike is fast.
//
// THE ENVELOPE THIS IS CHECKED AGAINST (spike/RESULTS.md, all cold, 50M rows):
//
//   host + 24h + fragment, 500 matches     262 to 277ms
//   host + 24h + fragment, no match         62ms
//   browse: host + 24h, no text match      109ms
//   free-text, all devices, 24h            109ms  (with trigram on recent 3d)
//
// Two things make a search look far faster than the envelope, and both are easy
// to do by accident:
//
//   1. A SMALL LIMIT. ORDER BY ts DESC with LIMIT 5 stops as soon as five rows
//      match, so a common fragment returns in a millisecond or two having read
//      almost nothing. The measured figures return 500 rows. A first pass at
//      this reported 1.3ms for a 109ms case for exactly that reason.
//   2. A REUSED FRAGMENT. Keeping one literal keeps its trigram pages hot and
//      measures the cache rather than the index. That flaw made the spike's
//      first no-match figure roughly six times too good.
//
// So limits match the measurement, and absent fragments vary per invocation.

import { OPS, closeAll, type SearchFilters } from '../src/store/index.ts';
import { measureResidency } from '../src/residency.ts';
import { CONFIG } from '../src/config.ts';

const CASE = process.argv[2] ?? 'filtered_match_500';
const HOST = process.env.BENCH_HOST || 'sw-0001';
const WARM_RUNS = Number(process.env.WARM_RUNS || 3);

// Plausible but absent. The seeder's deviceIp() lays 600 devices across
// 10.20.0.x, 10.20.1.x and 10.20.2.x, so 10.20.7.x is the right shape, shares
// its trigrams with real data, and cannot match. Varied per invocation so a
// repeat run does not read its predecessor's hot pages.
function absentAddress(): string {
    return `10.20.7.${1 + Math.floor(Math.random() * 250)}`;
}

// Present in the corpus: template 0 emits it on every LINK-3-UPDOWN line, so a
// single host over 24 hours has comfortably more than 500 of them.
const PRESENT_FRAGMENT = 'changed state to down';

function filtersFor(name: string): { filters: SearchFilters; expectMs: [number, number]; note: string } {
    const now = Date.now();
    const day = (h: number): Date => new Date(now - h * 3_600_000);

    switch (name) {
        case 'filtered_match_500':
            return {
                filters: { from: day(24), to: new Date(now), host: HOST, fragment: PRESENT_FRAGMENT, limit: 500 },
                expectMs: [150, 500],
                note: 'host + 24h + fragment, 500 matches. Envelope 262 to 277ms cold.',
            };
        case 'filtered_nomatch':
            return {
                filters: { from: day(24), to: new Date(now), host: HOST, fragment: absentAddress(), limit: 500 },
                expectMs: [10, 200],
                note: 'host + 24h + absent fragment. Envelope 62ms cold.',
            };
        case 'filtered_14d':
            return {
                filters: { from: day(24 * 14), to: new Date(now), host: HOST, fragment: absentAddress(), limit: 500 },
                expectMs: [10, 250],
                note: 'host + 14d + absent fragment. Envelope 85ms cold. Nearly flat vs 24h is the finding.',
            };
        // Locates the cliff at the edge of the trigram window. BENCH_HOURS
        // sweeps the window while everything else is held constant, which is
        // the only way to separate "wider window" from "crossed the index
        // boundary" - two explanations that look identical from one data point.
        case 'filtered_window': {
            const hours = Number(process.env.BENCH_HOURS || 24);
            return {
                filters: { from: day(hours), to: new Date(now), host: HOST, fragment: absentAddress(), limit: 500 },
                expectMs: [0, 30_000],
                note: `host + ${hours}h + absent fragment. Trigram covers the most recent ${CONFIG.trgmRecentDays} days.`,
            };
        }
        case 'browse_500':
            return {
                filters: { from: day(24), to: new Date(now), host: HOST, limit: 500 },
                expectMs: [20, 300],
                note: 'browse: host + 24h, no text match, 500 rows. Envelope 109ms cold.',
            };
        case 'freetext_24h':
            return {
                filters: { from: day(24), to: new Date(now), fragment: absentAddress(), limit: 500 },
                expectMs: [20, 400],
                note: 'free-text, all devices, 24h, absent fragment. Envelope 109ms cold with trigram on recent partitions.',
            };
        default:
            throw new Error(`unknown case ${JSON.stringify(name)}`);
    }
}

async function runOnce(filters: SearchFilters): Promise<{ ms: number; rows: number; waitMs: number }> {
    const res = await OPS.searchMessages(filters);
    if (!('ok' in res) || !res.ok) {
        const why = 'reason' in res ? res.reason : 'unknown';
        throw new Error(`search refused: ${why}`);
    }
    return { ms: res.timing.execMs, rows: res.rowCount, waitMs: res.timing.waitMs };
}

async function main(): Promise<void> {
    const { filters, expectMs, note } = filtersFor(CASE);

    // Cold: the first execution after the cache was dropped. Residency is
    // captured around it, because a "cold" figure whose residency says
    // "fully resident" is not a cold figure and must not be reported as one.
    const { result: cold, residency } = await measureResidency(() => runOnce(filters));

    // The warm runs reuse the SAME filters, fragment included.
    //
    // An earlier version generated a fresh absent fragment for each warm run,
    // reasoning that a reused literal keeps its trigram pages hot. That rule is
    // right when measuring an index in isolation and wrong here: a cold/warm
    // ratio compares one query against itself, so changing the fragment between
    // the two makes them different queries and the ratio meaningless rather
    // than merely noisy. It showed up as the free-text case reporting warm
    // SLOWER than cold, which is not an anomaly, it is an invalid comparison.
    //
    // The anti-hot-page property is preserved where it actually matters:
    // absentAddress() is called once per PROCESS, so a repeated invocation of
    // this tool still gets a fragment its predecessor never touched.
    const warms: number[] = [];
    for (let i = 0; i < WARM_RUNS; i++) {
        warms.push((await runOnce(filters)).ms);
    }
    const warm = warms.length ? warms.reduce((a, b) => a + b, 0) / warms.length : 0;

    await closeAll();

    const withinEnvelope = cold.ms >= expectMs[0] && cold.ms <= expectMs[1];
    console.log(JSON.stringify({
        case: CASE,
        note,
        host: HOST,
        trgmRecentDays: CONFIG.trgmRecentDays,
        coldMs: Number(cold.ms.toFixed(1)),
        warmMs: Number(warm.toFixed(1)),
        ratio: warm > 0 ? Number((cold.ms / warm).toFixed(1)) : null,
        rowsReturned: cold.rows,
        waitMs: cold.waitMs,
        envelopeMs: expectMs,
        withinEnvelope,
        residency,
    }));
}

main().catch((err) => {
    console.error(JSON.stringify({ case: CASE, error: (err as Error).message }));
    void closeAll();
    process.exit(1);
});
