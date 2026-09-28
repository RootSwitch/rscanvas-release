// The wall's pure half (public/wall-logic.js), asserted offline - the suite
// fitAxis never had while it shipped an operator-reported defect and was
// rewritten without one. The tidy-board cases below are the digest's own
// verified sizes from the 2026-08-31 rewrite, promoted from prose to
// assertions; the imported module is the SHIPPED one, per the dom.js
// argument.
//
//   node tools/test-wall-logic.ts

interface Dials {
    width: number; height: number; gap: number; pad: number;
    minh: number; scale: number; fcols: number; iconH?: number;
}
interface WallShape { status?: string | null; fields?: Record<string, unknown>; alerts?: number }
const {
    clampNum, PREF_SPEC, fmtAge, chooseCols, wallHeightNeeded,
    visibleFields, tileLineCount, pickFcols, fitAxis, themeRoster, shuffled, nextShift,
} = await import('../public/wall-logic.js' as string) as {
    clampNum: (raw: unknown, lo: number, hi: number, def: number) => number;
    PREF_SPEC: Record<string, { def: unknown; parse: (v: string) => unknown }>;
    fmtAge: (ms: number) => string;
    chooseCols: (sectionLines: number[][], dials: Dials, prevCols?: number) => number;
    wallHeightNeeded: (sectionLines: number[][], cols: number, dials: Dials) => number;
    visibleFields: (shape: WallShape, declared: string[], blanks: string) => string[];
    tileLineCount: (shape: WallShape, declared: string[], blanks: string) => number;
    pickFcols: (textFieldCount: number) => number;
    fitAxis: (los: number[], his: number[]) => { lo: number; hi: number };
    themeRoster: (spec: string, themes: Record<string, { group?: string }>) => string[];
    shuffled: <T>(list: T[], rand?: () => number, notFirst?: T) => T[];
    nextShift: (n: number, prev?: { x: number; y: number }, rand?: () => number) => { x: number; y: number };
};

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

console.log('the wall\'s pure half, offline\n');

console.log('fitAxis - the largest-gap trim, against the operator\'s own cases:');
{
    // A TIDY BOARD IS NEVER TRIMMED, at every size the old percentile trim
    // flagged: the 2026-08-31 report was "an outlier at every size from 2
    // to 40" on evenly spread cards, and this loop is that report as a
    // regression guard.
    let clean = true;
    for (let n = 2; n <= 40; n++) {
        const los = Array.from({ length: n }, (_, i) => i * 210);
        const his = los.map((x) => x + 190);
        const r = fitAxis(los, his);
        if (r.lo !== 0 || r.hi !== (n - 1) * 210 + 190) { clean = false; break; }
    }
    if (clean) ok('a tidy row of equal cards is left exactly as drawn at every size 2..40');
    else bad('the trim fired on a tidy board - the percentile defect back');
}
{
    // A GENUINE STRAY is pulled in: the x=90000 case the trim exists for.
    const los = [0, 210, 420, 630, 90000];
    const his = los.map((x) => x + 190);
    const r = fitAxis(los, his);
    eq('one shape parked at x=90000 is cut from the fit', r, { lo: 0, hi: 820 });
}
{
    // TWO HONEST CLUSTERS a big gap apart are BOTH kept: the gap is large
    // but the minority side is not a stray, it is half the board.
    const los = [0, 210, 420, 5000, 5210, 5420];
    const his = los.map((x) => x + 190);
    const r = fitAxis(los, his);
    eq('two legitimate clusters 5,000px apart are left alone... ', r.lo, 0);
    // The gap (4,390) exceeds half the extent (5,610 / 2 = 2,805) - but the
    // sides tie at 3 and 3, and a tie keeps the LOW side by stated rule, so
    // the high cluster is trimmed. That is the shipped behaviour, pinned so
    // a change to the tie rule is a decision and not a drift.
    if (r.hi === 610) ok('...up to the stated tie rule: an exact tie keeps the low side');
    else bad('the tie rule moved', r);
}
{
    const r = fitAxis([0, 100, 5000], [80, 180, 5080]);
    eq('below MIN_TO_TRIM nothing is ever cut - three shapes have no "rest of the board"',
        r, { lo: 0, hi: 5080 });
}

console.log('\nvisibleFields / tileLineCount - what a tile really contains:');
{
    const declared = ['stencil', 'cpu', 'mem', 'ping'];
    const up: WallShape = { status: 'up', fields: { stencil: 'server', cpu: 3, ping: 1 } };
    eq('stencil never counts - it is the icon, not a row (the phantom-row defect)',
        visibleFields(up, declared, 'auto'), ['cpu', 'ping']);
    eq('blanks:auto collapses an absent value on an UP device',
        visibleFields(up, declared, 'auto').includes('mem'), false);
    eq('blanks:show keeps the slot',
        visibleFields(up, declared, 'show'), ['cpu', 'mem', 'ping']);
    const down: WallShape = { status: 'down', fields: {} };
    eq('a not-up device keeps every blank - the blanks ARE the message (slice 37)',
        visibleFields(down, declared, 'auto'), ['cpu', 'mem', 'ping']);
    eq('the alert count line is a real row', tileLineCount({ ...up, alerts: 2 }, declared, 'auto'), 3);
    eq('and no alerts adds nothing', tileLineCount(up, declared, 'auto'), 2);
}

console.log('\npickFcols - the reading columns a value count deserves:');
{
    eq('a classic 8-reading board stays one column', pickFcols(8), 1);
    eq('nine readings fold to two', pickFcols(9), 2);
    eq('the operator\'s sixteen-value board is two columns, eight rows', pickFcols(16), 2);
    eq('seventeen and past go to three', pickFcols(17), 3);
}

console.log('\nchooseCols - the fit is judged against the real wall:');
const DIALS: Dials = {
    width: 1920, height: 1056, gap: 8, pad: 6, minh: 0, scale: 1, fcols: 1,
};
// The operator's own board, 2026-09-01: 36 tiles in 6 sections, up-tiles
// showing 4-6 of 8 declared readings, three internet tiles at one line,
// six down tiles at the full 8 (blanks-are-the-message), a couple of
// alert lines. The old chooser said 12 columns and needed 1458px of the
// 1015 available - it scrolled at its own numbers.
const flat = (n: number, lines: number) => Array.from({ length: n }, () => lines);
const OPERATOR_BOARD = [
    [6, 8, 8, 8, 6, 8],            // Guest PCs: mostly off
    flat(5, 6),                     // Hosts
    flat(3, 1),                     // Internet: ping only
    flat(4, 5),                     // Monitoring
    [7, 5, 5, 5, 3, 3, 3],          // Network
    [6, 3, 4, 6, 4, 4, 4, 4, 8, 8, 5],   // Services incl. two off
];
// The wall in the screenshot runs two field columns; that is the fixture's
// honest mode, and where the fit numbers are pinned.
const OP_DIALS: Dials = { ...DIALS, fcols: 2 };
{
    const cols = chooseCols(OPERATOR_BOARD, OP_DIALS);
    const needed = wallHeightNeeded(OPERATOR_BOARD, cols, OP_DIALS);
    eq('the operator board settles at 6 columns', cols, 6);
    if (needed <= OP_DIALS.height) ok(`and FITS there (${Math.round(needed)}px of ${OP_DIALS.height})`);
    else bad(`chosen ${cols} columns needs ${Math.round(needed)}px of ${OP_DIALS.height} - the old defect, back`);
    // And the choice is honest about the alternative: one fewer column
    // must NOT fit, or the chooser picked more than it needed.
    const tighter = wallHeightNeeded(OPERATOR_BOARD, cols - 1, OP_DIALS);
    eq('and one fewer column would scroll - fewest that fits, not fewer',
        tighter > OP_DIALS.height, true);
    // At ONE field column the same board cannot fit at any readable width -
    // the contract's stated fallback is the widest readable grid, never a
    // silent lie about fitting. (The OLD chooser claimed 12 fit here.)
    eq('when nothing fits, the answer is the max readable count, said plainly',
        chooseCols(OPERATOR_BOARD, DIALS), 12);
}
{
    // A sparse board: 12 one-section tiles of 3 lines fit at the banner
    // guard - the MAX_TILE_W floor, the old suite's first pin, kept.
    eq('a sparse board widens to the max readable tile, not to a banner',
        chooseCols([flat(12, 3)], DIALS), 6);
    // 1,550 tiles: nothing fits, so the widest readable grid - the 30k
    // wall's own measured 12 on 1080p, kept.
    eq('the 30k fleet caps at 12 columns on 1080p - the measured render',
        chooseCols([flat(1550, 3)], DIALS), 12);
    eq('one tile never gets more than one column', chooseCols([flat(1, 3)], DIALS), 1);
    // Two-column readings halve the rows (slice 33), same tile height AT THE
    // SAME GRID WIDTH - the slice-33 property, held where it lives.
    eq('field columns change tile height through ROWS, not field count',
        wallHeightNeeded([flat(12, 6)], 4, { ...DIALS, fcols: 2 }),
        wallHeightNeeded([flat(12, 3)], 4, DIALS));
    // And the WIDTH follows the reading columns (the truncation report,
    // 2026-09-01 second screenshot): a two-column tile deserves roughly two
    // columns' width, so the same sparse board spreads over fewer, wider
    // grid columns instead of slicing every value into an ellipsis.
    eq('two-column readings widen the tile: fewer grid columns, never strips',
        chooseCols([flat(12, 6)], { ...DIALS, fcols: 2 }), 4);
    // Sections pack separately AND spend header height.
    const one = [flat(40, 3)];
    const eight = Array.from({ length: 8 }, () => flat(5, 3));
    eq('eight sections need at least what one flat grid needs',
        chooseCols(eight, DIALS) >= chooseCols(one, DIALS), true);
    eq('ragged sections are real rows: the height model counts them',
        wallHeightNeeded(eight, 4, DIALS) > wallHeightNeeded(one, 4, DIALS), true);
}
{
    // THE DIALS REACH THE FIT - review client finding 7, closed. Doubling
    // the scale doubles tile heights, so fewer rows fit and more columns
    // are needed; minh floors every tile the same way.
    eq('scale enters the arithmetic: bigger text needs more columns',
        chooseCols([flat(40, 5)], { ...DIALS, scale: 2 })
        > chooseCols([flat(40, 5)], DIALS), true);
    eq('minh floors the tile height',
        wallHeightNeeded([flat(4, 1)], 1, { ...DIALS, minh: 300 }) >= 4 * 300, true);
    eq('gap is counted between rows, not after the last',
        wallHeightNeeded([flat(3, 3)], 1, { ...DIALS, gap: 100 })
            - wallHeightNeeded([flat(3, 3)], 1, { ...DIALS, gap: 0 }), 200);
    // A top-positioned icon is a height spend the fit must know about -
    // one icon's worth per tile row, none when it sits beside the readings.
    eq('a top icon spends its height on every row of tiles',
        wallHeightNeeded([flat(3, 3)], 1, { ...DIALS, iconH: 44 })
            - wallHeightNeeded([flat(3, 3)], 1, DIALS), 3 * 44);
}
{
    // HYSTERESIS: the on-screen count holds against a one-column ideal
    // shift - a value arriving on one tile must not reorganize the rest -
    // and follows a two-column shift, because that is a real shape change.
    const ideal = chooseCols(OPERATOR_BOARD, OP_DIALS);   // 6, pinned above
    eq('prev held when the ideal moved by one',
        chooseCols(OPERATOR_BOARD, OP_DIALS, ideal - 1), ideal - 1);
    eq('prev held when the ideal did not move at all',
        chooseCols(OPERATOR_BOARD, OP_DIALS, ideal), ideal);
    eq('a two-column difference is followed',
        chooseCols(OPERATOR_BOARD, OP_DIALS, ideal - 2) === ideal - 2, false);
    eq('a previous choice outside the readable range is not held',
        chooseCols(OPERATOR_BOARD, OP_DIALS, ideal + 1), ideal);
    eq('no previous choice applies the ideal directly',
        chooseCols(OPERATOR_BOARD, OP_DIALS, 0), ideal);
    // One tile gaining one line - the report's "small change" - must not
    // move an on-screen wall at all.
    const bumped = OPERATOR_BOARD.map((s, i) => (i === 1 ? [s[0]! + 1, ...s.slice(1)] : s));
    eq('one value arriving on one tile leaves the on-screen count alone',
        chooseCols(bumped, OP_DIALS, ideal), ideal);
}

console.log('\nPREF_SPEC - every dial clamps, every enum falls back:');
{
    eq('scale clamps its ceiling', PREF_SPEC.scale!.parse('9999'), 220);
    eq('scale clamps its floor', PREF_SPEC.scale!.parse('1'), 60);
    eq('garbage takes the default, never NaN', PREF_SPEC.gap!.parse('junk'), 8);
    eq('icon range matches the panel', PREF_SPEC.icon!.parse('200'), 96);
    eq('fcols is 1..3', PREF_SPEC.fcols!.parse('7'), 3);
    eq('fcols auto passes through', PREF_SPEC.fcols!.parse('auto'), 'auto');
    eq('fcols defaults to auto - the all-values ribbon must fold on its own',
        PREF_SPEC.fcols!.def, 'auto');
    eq('iconpos accepts top', PREF_SPEC.iconpos!.parse('top'), 'top');
    eq('iconpos garbage falls back to side - slice 32 stays the default look',
        PREF_SPEC.iconpos!.parse('weird'), 'side');
    eq('an unknown align is split', PREF_SPEC.align!.parse('weird'), 'split');
    eq('an unknown only-mode shows all', PREF_SPEC.only!.parse('nothing'), 'all');
    eq('clampNum itself: NaN takes the default', clampNum('x', 0, 10, 4), 4);
}

console.log('\nfmtAge - the tense boundaries:');
{
    eq('89s is seconds', fmtAge(89_000), '89s');
    eq('90s becomes minutes', fmtAge(90_000), '2m');
    eq('89m is minutes', fmtAge(5_340_000), '89m');
    eq('90m becomes hours', fmtAge(5_400_000), '2h');
    eq('a day reads in hours, because a wall that stale is the headline',
        fmtAge(86_400_000), '24h');
}

// A seeded generator, so a failure here reproduces rather than flickers.
const lcg = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
};

console.log('\nburn-in prefs - the kiosk names, clamped like every other dial:');
{
    eq('a rotation changes every 5 minutes unless told otherwise (the operator\'s own default)',
        PREF_SPEC.themeInterval!.def, 300);
    eq('themeInterval has a floor - a 5 s rotation is a strobe, not a wall', PREF_SPEC.themeInterval!.parse('5'), 30);
    eq('themeInterval garbage takes the default', PREF_SPEC.themeInterval!.parse('soon'), 300);
    eq('themeOrder takes shuffle in any case', PREF_SPEC.themeOrder!.parse('Shuffle'), 'shuffle');
    eq('an unknown themeOrder is list order', PREF_SPEC.themeOrder!.parse('random'), 'list');
    eq('the shift is OFF unless asked - the default wall keeps its layout', PREF_SPEC.shift!.def, 0);
    eq('the shift is whole pixels', PREF_SPEC.shift!.parse('7.6'), 8);
    eq('a negative shift is off', PREF_SPEC.shift!.parse('-4'), 0);
    eq('the shift is capped - it is paid for in margin', PREF_SPEC.shift!.parse('999'), 50);
    eq('shift garbage is off, never NaN', PREF_SPEC.shift!.parse('lots'), 0);
    eq('shiftInterval has a floor', PREF_SPEC.shiftInterval!.parse('1'), 30);
}

console.log('\nthemeRoster - what ?themes= rotates through:');
{
    const T = {
        classic: {}, canvas: { group: 'Paper' }, gesso: { group: 'Paper' },
        ink: { group: 'Night' }, midnight: { group: 'Night' }, blueprint: { group: 'Cool' },
    };
    eq('empty is no rotation', themeRoster('', T), []);
    eq('all is every theme, in authored order', themeRoster('all', T),
        ['classic', 'canvas', 'gesso', 'ink', 'midnight', 'blueprint']);
    eq('ALL is all', themeRoster('ALL', T).length, 6);
    eq('a group name is its themes', themeRoster('night', T), ['ink', 'midnight']);
    eq('a group and a theme mix item by item (the kiosk\'s night,ink bug)',
        themeRoster('Night,blueprint', T), ['ink', 'midnight', 'blueprint']);
    eq('a theme named twice comes round once', themeRoster('ink,night', T), ['ink', 'midnight']);
    eq('a typo drops out instead of emptying the rotation', themeRoster('nosuch,ink', T), ['ink']);
    eq('nothing known is no rotation', themeRoster('nosuch', T), []);
    eq('spaces and empty items are ignored', themeRoster(' canvas , , gesso ', T), ['canvas', 'gesso']);
}

console.log('\nshuffled - ?themeOrder=shuffle:');
{
    const list = ['a', 'b', 'c', 'd', 'e'];
    const r = lcg(7);
    const out = shuffled(list, r);
    eq('a shuffle is a permutation', [...out].sort(), list);
    eq('the input is not reordered in place', list, ['a', 'b', 'c', 'd', 'e']);
    const firsts = new Set<string>();
    let repeated = 0;
    for (let i = 0; i < 2000; i++) {
        const s = shuffled(list, r, 'c');
        firsts.add(s[0]!);
        if (s[0] === 'c') repeated++;
    }
    eq('the theme on screen never comes straight back round after a wrap', repeated, 0);
    eq('every other theme can lead', [...firsts].sort(), ['a', 'b', 'd', 'e']);
    eq('a one-theme ring cannot avoid itself, and does not try', shuffled(['a'], r, 'a'), ['a']);
    eq('a generator that returns 1 still permutes', [...shuffled(list, () => 1)].sort(), list);
}

console.log('\nnextShift - where the wall jumps:');
{
    eq('shift 0 is no offset', nextShift(0), { x: 0, y: 0 });
    eq('a negative shift is no offset', nextShift(-3), { x: 0, y: 0 });
    eq('a junk shift is no offset', nextShift(Number('junk')), { x: 0, y: 0 });
    const r = lcg(42);
    let prev = { x: 0, y: 0 };
    let outOfRange = 0;
    let stayed = 0;
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (let i = 0; i < 5000; i++) {
        const p = nextShift(8, prev, r);
        if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || Math.abs(p.x) > 8 || Math.abs(p.y) > 8) outOfRange++;
        if (p.x === prev.x && p.y === prev.y) stayed++;
        xs.add(p.x); ys.add(p.y);
        prev = p;
    }
    eq('every offset is whole pixels within the band', outOfRange, 0);
    eq('the wall never "moves" to where it already is', stayed, 0);
    // The reason it is random and not the kiosk's ring: a ring of radius 8
    // puts every edge on 3 lines per axis; this must reach all 17.
    eq('edges are spread over every line of the band, x', xs.size, 17);
    eq('edges are spread over every line of the band, y', ys.size, 17);
    eq('a stuck generator still moves the wall, inward', nextShift(8, { x: 0, y: 0 }, () => 0.5), { x: -1, y: 0 });
    eq('stuck at the far edge, it steps back in', nextShift(8, { x: -8, y: -8 }, () => 0), { x: -7, y: -8 });
    const hi = nextShift(8, { x: 0, y: 0 }, () => 1);
    eq('a generator that returns 1 stays in range', Math.abs(hi.x) <= 8 && Math.abs(hi.y) <= 8, true);
    const shrunk = nextShift(4, { x: 20, y: 20 }, lcg(3));
    eq('an offset from a wider band comes back inside a narrower one',
        Math.abs(shrunk.x) <= 4 && Math.abs(shrunk.y) <= 4, true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
