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

import { buildWhere, type SearchFilters, type TrgmCoverageDay } from '../src/store/ops.ts';
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
