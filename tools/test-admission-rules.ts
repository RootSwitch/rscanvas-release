// The search admission rules, offline and without a database.
//
//   node tools/test-admission-rules.ts
//
// WHY THIS EXISTS, WRITTEN THE DAY IT WAS PAID FOR. On 2026-08-15 the rule
// "free text with no device filter must be refused" was conditioned on trigram
// COVERAGE, and on a young box coverage is complete, so the rule stopped
// firing. What it stopped refusing was a query taking 27-30 seconds, ten times
// a minute, for eleven hours - and the only reason anyone noticed is that a
// soak probe kept reporting it while three separate readings talked themselves
// out of believing it. See SOAK-CRITERIA section 5b.
//
// The lesson that produced this file is narrower than "test your code": the
// admission rules had two tests, and NEITHER could see this. admission-test.ts
// drives the lane queue and needs a database; test-search-semantics.ts diffs
// result sets and needs a database. Both answer "does the query work". Nothing
// answered "is the query allowed to run", which is a decision made from the
// request alone and could always have been tested with no database at all.
//
// So every control here is a pure call to buildWhere with a synthetic coverage
// array, and the ones that matter assert a REFUSAL under conditions where the
// previous version admitted.

import { buildWhere, nearMissFrom, nearMissWork, NEAR_MISS_MS, type SearchFilters, type TrgmCoverageDay } from '../src/store/ops.ts';
import { CONFIG } from '../src/config.ts';

let pass = 0, fail = 0;

/** Coverage where every day the window can touch carries both gin indexes. */
const COVERED: TrgmCoverageDay[] = [];
/** The same days, none of them indexed. */
const UNCOVERED: TrgmCoverageDay[] = [];
{
    const d = new Date(Date.UTC(2026, 6, 1));
    while (d.getTime() < Date.UTC(2026, 11, 31)) {
        const key = d.toISOString().slice(0, 10).replace(/-/g, '');
        COVERED.push({ day: key, covered: true });
        UNCOVERED.push({ day: key, covered: false });
        d.setUTCDate(d.getUTCDate() + 1);
    }
}

const NOW = new Date('2026-08-15T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

function filters(hours: number, extra: Partial<SearchFilters> = {}): SearchFilters {
    return { from: hoursAgo(hours), to: NOW, ...extra };
}

function refusal(f: SearchFilters, coverage: TrgmCoverageDay[]): string | null {
    const r = buildWhere(f, coverage);
    return 'ok' in r ? r.reason : null;
}

function check(label: string, got: string | null, want: string | null): void {
    if (got === want) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label} - wanted ${want ?? 'ADMIT'}, got ${got ?? 'ADMIT'}`); }
}

console.log('the free-text cost ceiling (2026-08-15):');

// THE LOAD-BEARING CONTROL. Full coverage, no device filter, wide window: the
// version this file was written against ADMITTED this, and it is the thirty
// second query. If this control ever goes green on an ADMIT, read
// CONFIG.freeTextMaxHours and SOAK-CRITERIA 5b before changing it.
check('wide free text with COMPLETE coverage is refused - coverage is not permission',
    refusal(filters(240, { fragment: 'timeout' }), COVERED), 'free-text-window');

check('the 240h probe is refused on cost BEFORE the index rule can be consulted',
    refusal(filters(240, { fragment: 'timeout' }), UNCOVERED), 'free-text-window');

check('at the ceiling exactly, still admitted - the cap is a maximum, not a fence',
    refusal(filters(CONFIG.freeTextMaxHours, { fragment: 'timeout' }), COVERED), null);

check('one hour past the ceiling is refused',
    refusal(filters(CONFIG.freeTextMaxHours + 1, { fragment: 'timeout' }), COVERED), 'free-text-window');

check('a NAMED DEVICE lifts the cap, because it bounds the scan itself',
    refusal(filters(240, { fragment: 'timeout', host: 'sw-core-1' }), COVERED), null);

check('an address lifts it too',
    refusal(filters(240, { fragment: 'timeout', sourceIp: '10.4.0.9' }), COVERED), null);

check('no fragment at all is not free text, so the cap does not apply',
    refusal(filters(240), COVERED), null);

console.log('\nthe index rule still applies inside the cost ceiling:');

check('narrow free text over UNCOVERED days is still refused for the index',
    refusal(filters(12, { fragment: 'timeout' }), UNCOVERED), 'unindexed-free-text');

check('narrow free text over covered days is admitted',
    refusal(filters(12, { fragment: 'timeout' }), COVERED), null);

console.log('\nthe rules that were already there, unchanged:');

check('past the absolute ceiling is window-too-wide, not the free-text cap',
    refusal(filters(CONFIG.maxSearchWindowHours + 24, { fragment: 'timeout' }), COVERED),
    'window-too-wide');

check('an inverted window is caught before anything else',
    refusal({ from: NOW, to: hoursAgo(1) }, COVERED), 'window-inverted');

// THE NEAR-MISS HINT'S REACH (2026-10-30, the beta list's S4): a zero-result
// exact host:/app: search's "did you mean" looks only as far back as the
// search index reaches, and under its own statement timeout.
console.log('\nthe near-miss hint looks only where the search index reaches:');
{
    const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
    const days = (...ds: string[]): TrgmCoverageDay[] => ds.map((d) => ({ day: d, covered: true }));
    // Three covered days ending today (2026-08-15, NOW's UTC day), one
    // uncovered day before them, then older covered ones that must not count,
    // and tomorrow's empty partition, not yet indexed, that must not matter.
    const cov: TrgmCoverageDay[] = [
        ...days('20260805', '20260806'), { day: '20260812', covered: false },
        ...days('20260813', '20260814', '20260815'), { day: '20260816', covered: false },
    ];
    check('a month-wide search: the hint starts at the newest covered run, midnight UTC',
        iso(nearMissFrom(cov, hoursAgo(30 * 24), NOW, NOW)), '2026-08-13T00:00:00.000Z');
    check('a window inside the run keeps its own start',
        iso(nearMissFrom(cov, hoursAgo(6), NOW, NOW)), hoursAgo(6).toISOString());
    check('a window ending before the run gives no hint',
        iso(nearMissFrom(cov, hoursAgo(10 * 24), hoursAgo(5 * 24), NOW)), null);
    check('today not covered (a fresh box before its first sync): no hint',
        iso(nearMissFrom(days('20260813', '20260814'), hoursAgo(24), NOW, NOW)), null);
    check('nothing covered: no hint',
        iso(nearMissFrom(UNCOVERED, hoursAgo(24), NOW, NOW)), null);
    check('the statement timeout is short - garnish, not a search', String(NEAR_MISS_MS <= 1000), 'true');

    // The work against a fake client: the probe runs from the clamped start
    // under SET LOCAL, and a timeout (57014) is an empty answer, not a throw.
    const fake = (fail57014: boolean) => {
        const seen: Array<{ text: string; values?: unknown[] }> = [];
        return {
            seen,
            query: async (text: string, values?: unknown[]) => {
                seen.push({ text, values });
                if (/pg_inherits/.test(text)) return { rows: cov, rowCount: cov.length };
                if (/FROM messages/.test(text)) {
                    if (fail57014) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
                    return { rows: [{ kind: 'host', value: 'core-sw-1' }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            },
        };
    };
    const okc = fake(false);
    const got = await nearMissWork(okc, hoursAgo(30 * 24), NOW, 'core', null, NOW);
    const probe = okc.seen.find((q) => /FROM messages/.test(q.text));
    check('the probe searches from the clamped start',
        iso((probe?.values?.[0] as Date) ?? null), '2026-08-13T00:00:00.000Z');
    check('under its own timeout, inside a transaction',
        okc.seen.map((q) => q.text.trim().split(/\s+/).slice(0, 3).join(' ')).filter((t) => /^(BEGIN|SET LOCAL|COMMIT)/.test(t)).join(' | '),
        `BEGIN | SET LOCAL statement_timeout | COMMIT`);
    check('and each hit says how far back it looked',
        got.rows.map((r) => `${r.value}@${r.since.toISOString()}`).join(','), 'core-sw-1@2026-08-13T00:00:00.000Z');
    const slow = fake(true);
    let threw = false;
    let empty: { rows: unknown[] } = { rows: ['x'] };
    try { empty = await nearMissWork(slow, hoursAgo(30 * 24), NOW, 'core', null, NOW); } catch { threw = true; }
    check('a probe past its timeout is no hint, not a lane failure',
        `${threw ? 'threw' : 'answered'} ${empty.rows.length} ${slow.seen.some((q) => q.text === 'ROLLBACK') ? 'rolled back' : 'left open'}`,
        'answered 0 rolled back');
    const none = fake(false);
    await nearMissWork(none, hoursAgo(10 * 24), hoursAgo(5 * 24), 'core', null, NOW);
    check('a window the index cannot reach never touches messages',
        String(none.seen.some((q) => /FROM messages/.test(q.text))), 'false');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
