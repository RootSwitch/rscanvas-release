// The wall's PURE half: pref parsing, the auto-column arithmetic, the
// drawn-board fit, the age formatter. No DOM, no fetch, no module state -
// wall.js owns those; this module owns the decisions, and
// tools/test-wall-logic.ts asserts them offline.
//
// Extracted 2026-09-01 under parse.js's own rule ("anything pure that wants
// a test has to come out; that is the whole rule"), after the cost of NOT
// having done so was paid twice in one week: fitAxis shipped an
// operator-reported defect (the percentile trim) and was rewritten with
// still zero tests, and the then-autoCols height formula ignored half the
// dials that change real tile height. That formula is gone: chooseCols
// below fits against the wall's real arithmetic (same-day layout
// investigation, operator-reported jumpiness). The functions are imported
// by wall.js, so a test exercises the shipped code - the dom.js argument:
// a copy cannot rot in the same direction as the original.

export function clampNum(raw, lo, hi, def) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, n));
}

/** The display-side pref vocabulary: URL-as-state (slice 31). Parsers only -
 *  reading the query string and writing it back is wall.js's business. */
export const PREF_SPEC = {
    cols: { def: '', parse: (v) => v },              // '' = the board's own choice
    hide: { def: '', parse: (v) => v },              // csv of field keys hidden HERE
    gap: { def: 8, parse: (v) => clampNum(v, 0, 40, 8) },
    pad: { def: 6, parse: (v) => clampNum(v, 2, 24, 6) },
    minh: { def: 0, parse: (v) => clampNum(v, 0, 400, 0) },
    scale: { def: 100, parse: (v) => clampNum(v, 60, 220, 100) },
    align: { def: 'split', parse: (v) => (v === 'center' ? 'center' : 'split') },
    icon: { def: 40, parse: (v) => clampNum(v, 16, 96, 40) },
    // Where the device icon sits. 'side' is slice 32's original mockup - a
    // column beside the readings, one centred title line. 'top' stacks it
    // above the name and pays in HEIGHT instead of width, which is the
    // right trade exactly when the readings need every pixel of width: the
    // operator's all-values board, where the icon and two reading columns
    // were fighting over a 280px tile.
    iconpos: { def: 'side', parse: (v) => (v === 'top' ? 'top' : 'side') },
    // 'auto' picks from the board's own value count (pickFcols below); an
    // explicit 1..3 pins it. Auto is the DEFAULT because the operator's
    // all-values board made the case: sixteen readings in one column is a
    // ribbon, and expecting every wall's owner to discover the dial that
    // fixes it is the dial failing at its job.
    fcols: { def: 'auto', parse: (v) => (v === 'auto' ? 'auto' : clampNum(v, 1, 3, 1)) },
    blanks: { def: 'auto', parse: (v) => (v === 'show' ? 'show' : 'auto') },
    only: { def: 'all', parse: (v) => (v === 'problems' ? 'problems' : 'all') },
};

export function fmtAge(ms) {
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
}

/**
 * The text field keys one tile will actually render, in declared order.
 * ONE source of truth: gridTile draws exactly this list, and the layout
 * arithmetic below counts it - the two can no longer disagree about what a
 * tile contains, which is how the old column chooser planned for tiles the
 * wall never drew.
 *
 * 'stencil' is excluded ALWAYS: it renders as the icon beside the readings,
 * never as a text row, and counting it gave every icon board a phantom row
 * - one full line of height per tile that nothing ever occupied (the
 * 2026-09-01 layout investigation's first finding: on the operator's own
 * board it alone moved the auto choice from 9 columns to 12).
 *
 * blanks: 'show' keeps every declared slot; 'auto' collapses absent values
 * on UP devices only - a not-up device keeps its blanks because the blanks
 * ARE the message (slice 37, both halves of that argument recorded at the
 * render site).
 */
export function visibleFields(shape, declared, blanks) {
    const showEmpty = blanks === 'show' || (shape.status ?? null) !== 'up';
    return declared.filter((k) => {
        if (k === 'stencil') return false;
        if (showEmpty) return true;
        const v = shape.fields ? shape.fields[k] : undefined;
        return v !== undefined && v !== null;
    });
}

/** Text lines one tile renders: its visible fields plus the alert count
 *  line, which is a row of the body grid like any other (slice 40b). */
export function tileLineCount(shape, declared, blanks) {
    return visibleFields(shape, declared, blanks).length
        + (Number(shape.alerts) > 0 ? 1 : 0);
}

// The glance tile's vertical anatomy, mirroring wall.css: the label is 16px
// at line-height 1.25, a field line is 12.5px at 1.35, both multiplied by
// --gw-scale; the tile carries --gw-pad top and bottom plus a hair of
// border. Constants of the STYLESHEET, not of this module - a change there
// changes these, and test-wall-logic pins the pairing.
const LABEL_H = 20;      // 16 * 1.25
const LINE_H = 16.9;     // 12.5 * 1.35
const TILE_SLACK = 4;    // borders and rounding
const HEADER_H = 36;     // section head incl. its margins
const SECTION_MARGIN = 14;
const CANVAS_PAD = 24;   // 12px each side
// The width guards are PER READING COLUMN, not per tile. 150..340 was tuned
// for single-column tiles; holding it while fcols multiplied the columns
// sliced a two-column tile into 75px strips and every value ellipsized -
// the operator's second screenshot (2026-09-01, the all-values board). Each
// extra reading column brings most of a first column's width with it:
// slightly less at the floor (the label row amortizes) and at the ceiling
// (two wide columns of readings is already generous before banner-hood).
const MIN_TILE_W = 150;        // narrower is unreadable
const MAX_TILE_W = 340;        // wider is a banner, not a tile
const EXTRA_FCOL_MIN_W = 130;
const EXTRA_FCOL_MAX_W = 170;

/**
 * The reading-column count for a board that asked for 'auto': one column
 * until the stack gets ribbon-shaped, two through the operator's sixteen-
 * value board (eight rows), three beyond. Decided from the DECLARED text
 * fields, not per tile - every tile on a wall lays out the same way, and
 * a count that flapped with blanks:auto would re-shape the wall each time
 * a reading arrived.
 */
export function pickFcols(textFieldCount) {
    if (textFieldCount <= 8) return 1;
    if (textFieldCount <= 16) return 2;
    return 3;
}

function tileHeight(lines, dials) {
    const rows = Math.ceil(Math.max(0, lines) / Math.max(1, dials.fcols));
    // iconH is the top-positioned icon's spend (0 when the icon sits beside
    // the readings, where it costs width the guards already price in). It
    // is charged to every tile: an icon-less tile on an icon-top wall reads
    // slightly taller than it is, which only ever errs toward fitting.
    const h = LABEL_H * dials.scale + rows * LINE_H * dials.scale
        + 2 * dials.pad + TILE_SLACK + (dials.iconH ?? 0);
    return Math.max(dials.minh, h);
}

/**
 * The height the wall really needs at a column count. Exported so the test
 * can hold chooseCols to its own arithmetic: "the chosen count fits" is an
 * assertable sentence, not a hope.
 *
 * Sections pack SEPARATELY - a ragged last row is a real row - and a grid
 * row is as tall as its tallest tile, which is what lets one full-height
 * down-tile coexist with a row of collapsed up-tiles without the whole
 * wall being planned around the worst case. This is the arithmetic the
 * old chooser lacked on both counts: it assumed tiles pack perfectly
 * across section boundaries and that every tile is the declared maximum,
 * so its "fewest columns with no scroll" answer scrolled at its own
 * numbers on the operator's board (36 tiles, 6 sections: 1458px claimed
 * fit into 1015).
 */
export function wallHeightNeeded(sectionLines, cols, dials) {
    let h = CANVAS_PAD;
    const multi = sectionLines.length > 1;
    for (const tiles of sectionLines) {
        if (multi) h += HEADER_H + SECTION_MARGIN;
        for (let i = 0; i < tiles.length; i += cols) {
            const row = tiles.slice(i, i + cols);
            h += Math.max(...row.map((l) => tileHeight(l, dials)));
            if (i + cols < tiles.length) h += dials.gap;
        }
    }
    return h;
}

/**
 * Choose the glance grid's column count: the fewest readable columns whose
 * REAL height fits the canvas, judged by wallHeightNeeded above with every
 * dial (scale, pad, gap, minh, fcols) fed through - the 2026-09-01 review's
 * client finding 7, closed rather than recorded.
 *
 * sectionLines: per section, the per-tile text line counts IN RENDER ORDER
 * (from tileLineCount, so blanks:auto and the alert line are already in).
 * A flat board is one section; only a multi-section board pays for heads.
 *
 * HYSTERESIS, because a wall is glanced at: prevCols is the count currently
 * on screen, and when the fresh ideal differs by only one column the screen
 * keeps what it has - a value arriving on one tile must not reorganize
 * thirty-five others. A two-column difference means the shape genuinely
 * changed, and the wall follows it. prevCols 0 means nothing is on screen
 * yet and the ideal is applied directly.
 */
export function chooseCols(sectionLines, dials, prevCols = 0) {
    const n = sectionLines.reduce((s, t) => s + t.length, 0);
    if (n === 0) return 1;
    const W = Math.max(1, dials.width - CANVAS_PAD);
    const H = Math.max(1, dials.height);
    const minW = MIN_TILE_W + (Math.max(1, dials.fcols) - 1) * EXTRA_FCOL_MIN_W;
    const maxW = MAX_TILE_W + (Math.max(1, dials.fcols) - 1) * EXTRA_FCOL_MAX_W;
    const maxCols = Math.max(1, Math.min(Math.floor(W / minW), n));
    const minCols = Math.max(1, Math.min(Math.ceil(W / maxW), maxCols));
    let ideal = maxCols;   // nothing fits: widest readable grid, least scroll
    for (let c = minCols; c <= maxCols; c++) {
        if (wallHeightNeeded(sectionLines, c, dials) <= H) { ideal = c; break; }
    }
    if (prevCols >= minCols && prevCols <= maxCols && Math.abs(prevCols - ideal) <= 1) {
        return prevCols;
    }
    return ideal;
}

// FITTING THE LAYOUT, AND WHY THIS IS NOT A PERCENTILE (rewritten
// 2026-08-31, reported by the operator).
//
// It was: trim to the 5th-95th percentile of positions, clamp what falls
// outside, and count those as outliers. A PERCENTILE ALWAYS HAS A TAIL,
// so on any evenly-spread board the top 5% fell outside BY
// CONSTRUCTION. A tidy row of equal cards reported an outlier at every
// size tried from 2 to 40, and the rightmost card was clamped back onto
// its neighbour. Both halves of the report - a banner on a board with
// room to spare, and "most of the cards equidistant, but some pushed
// together" - were that one defect. At three shapes it is unavoidable:
// the 95th percentile of three values IS the middle one.
//
// The trim protects a real case and is kept: one shape parked at x=90000
// would otherwise squash every other shape into a corner, silently, on a
// wall nobody is watching. But "far away" is a statement about a GAP, not
// about a rank - so that is what is measured. Sort the positions, find the
// largest gap between neighbours, and cut there only when that single gap
// dominates the whole extent. A board laid out at any regular spacing has
// no dominating gap and is left exactly as drawn.
export const GAP_SHARE = 0.5;      // one gap must exceed half the extent to count
export const MIN_TO_TRIM = 4;      // below this there is no "rest of the board"

export function fitAxis(los, his) {
    const lo = Math.min(...los), hi = Math.max(...his);
    if (los.length < MIN_TO_TRIM || hi - lo <= 0) return { lo, hi };
    const sorted = [...los].sort((a, b) => a - b);
    let gap = 0, at = -1;
    for (let i = 1; i < sorted.length; i++) {
        const g = sorted[i] - sorted[i - 1];
        if (g > gap) { gap = g; at = i; }
    }
    if (gap <= GAP_SHARE * (hi - lo)) return { lo, hi };
    // Keep the side holding MORE shapes; the minority beyond the gap is
    // what gets pulled in. A tie keeps the low side, which is arbitrary
    // and stated rather than accidental.
    const below = at, above = sorted.length - at;
    return above > below
        ? { lo: sorted[at], hi }
        : { lo, hi: Math.max(...his.filter((v, i) => los[i] < sorted[at])) };
}
