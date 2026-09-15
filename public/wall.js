// The wall render.
//
// This page runs for months on a machine nobody logs into, in a corridor,
// watched by people who will not touch it. Two consequences shape everything
// here and neither is cosmetic:
//
//   1. THERE IS NOBODY TO NOTICE IT IS BROKEN. So the page has to notice, and
//      say so, in a way visible from across the room. The failure mode of
//      every naive dashboard is showing a confident green board from a feed
//      that stopped on Tuesday - a screen that is worse than a blank one,
//      because a blank screen prompts somebody to look.
//   2. THE TOKEN IN THE URL IS THE CREDENTIAL. Nothing here renders it, logs
//      it, or puts it anywhere it was not already.
//
// Rendering is textContent-only, like the app - see check-dom-sinks. Board
// labels come from a document a human typed, which is a lower-trust source
// than it looks: the roster pull (recorded seed) would put DEVICE-REPORTED
// strings into board labels automatically, and then the wall is rendering
// hostile input on a screen nobody is watching.

const $ = (id) => document.getElementById(id);

// The token stays in the address bar, DELIBERATELY, and this is a trade
// rather than an oversight. Stripping it with replaceState would shorten the
// shoulder-surf and screenshot window that ARCHITECTURE names - but an
// unattended display that reboots reloads its URL, and a stripped token means
// it comes back to a permission error nobody is there to fix. A wall that
// cannot survive a power cut is not a wall. The mitigation for the leak stays
// where it was designed to be: narrow scope, and revocation that works.
const TOKEN = new URLSearchParams(location.search).get('token') ?? '';
/**
 * The signed-in way in (slice 45): ?board=<id> and no token, authorised by
 * the session cookie the operator already has.
 *
 * A token is right for a TV and wrong as the only door, because the secret is
 * stored hashed and is therefore unrecoverable - losing the URL means revoke
 * and re-mint, which an admin looking at their own board should never have to
 * do. TOKEN still WINS when both are present: a URL that carries a capability
 * is a kiosk URL, and it must behave the same whether or not the person
 * holding it happens to have a session in that browser.
 */
const BOARD = new URLSearchParams(location.search).get('board') ?? '';

/**
 * URL parameters, BORROWED FROM PingCanvas's kiosk rather than invented.
 *
 * That kiosk has run on real walls for a long time and its parameter set is
 * the list of things people actually reach for: a theme, a rotation, a margin,
 * a refresh interval. Taking the same NAMES matters as much as the features -
 * an operator who knows `?theme=blueprint` from one wall should not have to
 * learn a different spelling here.
 *
 * numParam carries a real bug story from that file, and it is why this is not
 * just `Number(x)`: `?margin=abc` reached its fitToView as NaN and rendered a
 * blank wall, and a junk interval became setInterval(fn, NaN) firing every
 * ~4ms. A wall URL is typed by hand ONCE and then runs for months, so a junk
 * value has to degrade to the default rather than to NaN - and be clamped,
 * because a negative or zero interval is just as fatal as a NaN one.
 */
function numParam(name, def, min, max) {
    const raw = new URLSearchParams(location.search).get(name);
    if (raw === null || raw === '') return def;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return def;
    if (min != null && v < min) return min;
    if (max != null && v > max) return max;
    return v;
}

const REFRESH_MS = numParam('interval', 10, 2, 3600) * 1000;
// After this long with no successful fetch, the board on screen is declared
// untrustworthy. Three missed polls rather than one: a single blip on a
// corridor wifi link should not paint the screen red, and 30 seconds is still
// far inside the time it takes a human to walk past and believe it.
const STALE_AFTER_MS = numParam('staleAfter', 30, 5, 3600) * 1000;

// --- theming, the feature this wall existed without --------------------------
//
// RSCanvas already ships 29 palettes and a picker, but only in the app - the
// wall inherited whatever was last chosen there, which is useless for a screen
// nobody logs into. PingCanvas's kiosk solved this years ago with URL
// parameters, so these are its names: ?theme=, ?themes=, ?themeInterval=.
//
// Rotation is the part that makes a corridor wall pleasant rather than a
// fixture people stop seeing, and it costs a setInterval.
const themeParam = new URLSearchParams(location.search).get('theme');
const themesParam = new URLSearchParams(location.search).get('themes');
const THEME_INTERVAL_MS = numParam('themeInterval', 900, 30) * 1000;

function themeRoster() {
    const all = Object.keys(window.Themes?.THEMES ?? {});
    if (themesParam === null) return [];
    if (themesParam.toLowerCase() === 'all') return all;
    // A csv of names, filtered to ones that exist - a typo in one entry must
    // not empty the rotation and leave the wall on whatever loaded first.
    const want = themesParam.split(',').map((t) => t.trim()).filter(Boolean);
    return want.filter((t) => all.includes(t));
}

function startTheming() {
    if (!window.Themes) return;
    const roster = themeRoster();
    if (themeParam !== null && (window.Themes.THEMES ?? {})[themeParam]) {
        window.Themes.applyTheme(themeParam);
    }
    if (roster.length < 2) return;
    let i = 0;
    window.Themes.applyTheme(roster[0]);
    setInterval(() => {
        i = (i + 1) % roster.length;
        window.Themes.applyTheme(roster[i]);
    }, THEME_INTERVAL_MS);
}

let lastOkAt = 0;
let lastError = '';
let lastBoard = null;
// The auto column count currently ON SCREEN, for chooseCols's hysteresis.
// Per board: switching boards is a new wall, and holding the old board's
// count against the new one's ideal would be hysteresis against nothing.
let lastAutoCols = 0;
/**
 * How many devices the all-clear is an all-clear FOR, or null when the canvas
 * is showing tiles.
 *
 * Kept as state rather than written once into the message, because an empty
 * board is the one render whose honesty DECAYS. Tiles carry their own age
 * cues - a stale wall goes dotted, the counts stay on screen - but "nothing
 * is wrong" is a positive claim with nothing left on the canvas to qualify
 * it, and a dead feed renders identically to a healthy fleet. So the sentence
 * is recomposed every second by updateAge, and it changes TENSE when the data
 * goes stale.
 */
let allClear = null;

// --- display settings (slice 31) ---------------------------------------------
//
// WHY THIS IS SAFE, and it is structural rather than promised: BOARD-EXPOSURE
// clause 1 says a display renders what the board DECLARES. The projection
// emits only declared field keys, so everything reachable from this panel is
// already in the payload and already on screen. The panel can therefore only
// ever HIDE - there is no control here that could reveal a field the board
// withheld, because the data for it does not exist on this page. That is why
// a display-side settings panel is not a hole in the exposure model: it
// re-arranges what was granted, and cannot widen the grant.
//
// NOTHING IS SENT BACK. A display token carries board.render and must never
// carry board.write - so these settings are not saved to the board. Instead
// THE URL IS THE STATE: every control rewrites the address bar, which means
// the dialed-in look is a string the operator can copy onto the TV, paste
// into a kiosk config, or mail to themselves. That is the same vocabulary
// PingCanvas's kiosk established and this page already borrowed (?theme=,
// ?margin=, ?interval=), extended rather than replaced - an operator who
// knows one knows the other.
//
// The operator's own framing for why this beats the admin app: dialing a
// wall in is an EYEBALL loop - look, adjust, look - and routing each step
// through a checkbox and a Save in another window makes the loop so slow
// that nobody completes it.

// The pure half lives in wall-logic.js so tools/test-wall-logic.ts can hold
// it without a browser - the dom.js/parse.js posture, adopted here after
// fitAxis shipped an operator-reported defect and was rewritten with still
// zero tests. This file keeps the DOM, the fetch loop, and the state.
import {
    PREF_SPEC, clampNum, fmtAge, chooseCols, tileLineCount, visibleFields,
    pickFcols, fitAxis,
} from './wall-logic.js';

const prefs = {};
function loadPrefs() {
    const q = new URLSearchParams(location.search);
    for (const [k, spec] of Object.entries(PREF_SPEC)) {
        prefs[k] = q.has(k) ? spec.parse(q.get(k)) : spec.def;
    }
}

/** Write one preference into the URL and re-render. replaceState rather than
 *  pushState: a wall is not a browsing history, and forty slider steps should
 *  not need forty presses of Back to undo. */
function setPref(key, value) {
    prefs[key] = value;
    const url = new URL(location.href);
    if (value === PREF_SPEC[key].def || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
    history.replaceState(null, '', url);
    applyPrefs();
    if (lastBoard !== null) render(lastBoard);
}

function applyPrefs() {
    const w = document.getElementById('wall');
    w.style.setProperty('--gw-gap', `${prefs.gap}px`);
    w.style.setProperty('--gw-pad', `${prefs.pad}px`);
    w.style.setProperty('--gw-minh', `${prefs.minh}px`);
    w.style.setProperty('--gw-scale', String(prefs.scale / 100));
    w.style.setProperty('--gw-icon', `${prefs.icon}px`);
    // 'auto' resolves against the BOARD (its declared value count), so the
    // glance renderer owns this var - renderGrid sets the resolved number.
    // An explicit pin is board-independent and applies here like any dial.
    if (prefs.fcols !== 'auto') w.style.setProperty('--gw-fcols', String(prefs.fcols));
    document.getElementById('wall-canvas').classList.toggle('gwall-center', prefs.align === 'center');
}

const hiddenFields = () => new Set(prefs.hide === '' ? [] : prefs.hide.split(','));

function message(text) {
    const el = $('wall-msg');
    el.textContent = text;
    el.classList.remove('hidden');
    $('wall-canvas').replaceChildren();
    // Any other message outranks the all-clear and stops it recomposing: a
    // revoked token or an empty board is not "nothing is wrong".
    allClear = null;
}

/**
 * The empty canvas, said out loud and kept CURRENT.
 *
 * The two states differ by TENSE, and that is the whole design:
 *
 *   fresh - "all 970 devices healthy - updated 4s ago". A present-tense
 *           claim, which is what an operator walking past should be able to
 *           believe without stopping.
 *   stale - "970 devices were healthy 21m ago - nothing checked since". The
 *           same fact, dated rather than retracted.
 *
 * A frozen sentence would keep asserting the first one over a feed that died,
 * and an empty board has no tiles left to carry the usual age cues - no
 * dotted borders, no greying. Tense is the cheapest honest signal there is,
 * and the staleness bar above still does the shouting.
 */
function renderAllClear() {
    if (allClear === null) return;
    const n = allClear.total;
    const devices = `${n} device${n === 1 ? '' : 's'}`;
    const age = lastOkAt === 0 ? null : Date.now() - lastOkAt;
    const el = $('wall-msg');
    el.textContent = age !== null && age > STALE_AFTER_MS
        ? `${devices} were healthy ${fmtAge(age)} ago - nothing checked since`
        : `all ${devices} healthy${age === null ? '' : ` - updated ${fmtAge(age)} ago`}`;
    el.classList.remove('hidden');
    $('wall-canvas').replaceChildren();
}

// --- glance grid (slice 26) --------------------------------------------------
//
// The grid is RENDERING, not layout: tiles in label order, wrapped at the
// board's declared column count by CSS grid, coordinates never consulted.
// Fields arrive pre-filtered by the projection (clause 1 - only declared
// keys exist in the payload), so everything here is presentation: order,
// formatting, and the uniform-slot rule. Every tile renders every declared
// field line - a missing value is a BLANK slot, never a collapsed one, so
// the grid stays a grid and a blank reads as "no reading", the roster's own
// vocabulary.

const FIELD_FMT = {
    // Slice 32: not a text line - gridTile draws it as artwork and skips it
    // in the line loop. Present here so the settings panel can list it by a
    // human name like every other field.
    stencil: { label: 'type icon', fmt: (v) => String(v) },
    address: { label: 'addr', fmt: (v) => String(v) },
    hardware: { label: 'hw', fmt: (v) => String(v) },
    cpu: { label: 'CPU', fmt: (v) => `${v}%` },
    mem: { label: 'mem', fmt: (v) => `${v}%` },
    top: { label: 'top', fmt: (v) => fmtBps(v) },
    topif: { label: 'if', fmt: (v) => String(v) },
    fs: { label: 'fs', fmt: (v) => `${v}%` },
    fsname: { label: 'vol', fmt: (v) => String(v) },
    temp: { label: 'temp', fmt: (v) => `${v}C` },
    errs: { label: 'errs', fmt: (v) => `${v}/s` },
    uptime: { label: 'up', fmt: (v) => fmtDur(v) },
    ping: { label: 'ping', fmt: (v) => `${v < 1 ? '<1' : v} ms` },
    snmp: { label: 'snmp', fmt: (v) => `${v} ms` },
    batt: { label: 'batt', fmt: (v) => `${v}%` },
    runtime: { label: 'runtime', fmt: (v) => fmtDur(v) },
};

function fmtBps(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '';
    const n = Number(v);
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Gb/s`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb/s`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kb/s`;
    return `${Math.round(n)} b/s`;
}

function fmtDur(s) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n >= 172800) return `${(n / 86400).toFixed(1)}d`;
    if (n >= 7200) return `${(n / 3600).toFixed(1)}h`;
    return `${Math.round(n / 60)}m`;
}

/** One state class per tile - the SAME vocabulary as the drawn wall, decided
 *  by the same rules, so red means red on both. */
function stateClasses(el, s) {
    const status = s.status ?? null;
    if (status === null) el.classList.add('unknown');
    // A forced device awaiting first contact must not wear green: 'pending'
    // is "no verdict yet", which is the unknown rendering, not the up one.
    else if (status === 'pending') el.classList.add('unknown');
    else if (status === 'down') el.classList.add(s.transient ? 'off' : 'down');
    else if (Number(s.alerts) > 0) el.classList.add('warn');
    else el.classList.add('up');
    if (s.stale) el.classList.add('stale');
    if (s.maintenance) el.classList.add('maint');
}

/**
 * The `only=problems` filter's ONE question, and it is deliberately the
 * narrow one: is this device DEFINITELY fine?
 *
 * NOT "is this a problem". Deciding what counts as a problem would be a
 * second classification standing beside stateClasses, and the two would
 * drift the first time a state was added to one of them - the same drift
 * ALERT_IN_MAINTENANCE and deviceStatusSql exist to prevent on the server.
 * So this asks for the `up` branch of that same ladder and nothing else.
 *
 * Everything the ladder is unsure or unhappy about therefore SURVIVES the
 * filter: unknown, down, off, warn, and also stale and maintenance, which
 * are modifiers rather than states and are kept because an operator who
 * hides the healthy is asking to see what is not. Hiding errs toward
 * showing, which is the only safe direction on a screen nobody is watching.
 */
function plainlyUp(s) {
    const status = s.status ?? null;
    return status !== null
        && status !== 'down'
        && !(Number(s.alerts) > 0)
        && !s.stale
        && !s.maintenance;
}

/** The counts footer - the all-green line that lets somebody close the tab.
 *  Rendered for BOTH modes; zero categories stay silent except up. */
function renderCounts(shapes) {
    const c = { up: 0, warn: 0, down: 0, off: 0, unknown: 0, maint: 0, stale: 0, pending: 0 };
    for (const s of shapes) {
        const status = s.status ?? null;
        if (status === null) c.unknown++;
        // Counted apart from unknown: "2 pending" says two devices are
        // awaiting first contact, which is a to-do, not a mystery.
        else if (status === 'pending') c.pending++;
        else if (status === 'down') { if (s.transient) c.off++; else c.down++; }
        else if (Number(s.alerts) > 0) c.warn++;
        else c.up++;
        if (s.maintenance) c.maint++;
        if (s.stale) c.stale++;
    }
    const parts = [`${c.up} up`];
    if (c.warn) parts.push(`${c.warn} warn`);
    if (c.down) parts.push(`${c.down} down`);
    if (c.off) parts.push(`${c.off} off`);
    if (c.pending) parts.push(`${c.pending} pending`);
    if (c.unknown) parts.push(`${c.unknown} unknown`);
    if (c.maint) parts.push(`${c.maint} maint`);
    if (c.stale) parts.push(`${c.stale} stale`);
    $('wall-counts').textContent = parts.join(' · ');
}

/**
 * AUTO COLUMNS (cols = 0), computed at render from the one screen that
 * matters: this one. The operator's CrossCanvas story is the spec - a static
 * 4-per-zone default gave an 80-device zone twenty rows while its neighbours
 * sat tiny, and "fit a normal widescreen" was the unsolved part. Here it is
 * arithmetic, because the per-board field set FIXES the tile height before
 * anything renders: rows that fit the height are known, so the fewest
 * columns that avoid scrolling are known, clamped so a tile never gets
 * narrower than readable (scroll instead) nor wider than a banner. Nothing
 * is stored, nothing is laid out - a resize just recomputes.
 */
/**
 * A tile, which is a LINK only when the server said so (slice 45).
 *
 * Two conditions, and both come from the payload rather than from this page:
 * `interactive` is true only for a session principal, and `device` - the
 * binding identity - is only projected for that same principal. So a kiosk
 * has neither the permission nor the name, and cannot manufacture either by
 * editing its own URL. That is the point: a display token is a capability for
 * ONE BOARD, and a tile that navigated into the app would quietly widen it.
 *
 * A real anchor rather than a div with a click handler, so middle-click and
 * ctrl-click open a tab the way they do everywhere else, and so the thing is
 * reachable from a keyboard without inventing a tabindex.
 */
function tileElement(s) {
    const device = typeof s.device === 'string' ? s.device : '';
    if (lastBoard?.interactive !== true || device === '') return document.createElement('div');
    const a = document.createElement('a');
    // `/` and NOT `/index.html`. STATIC_FILES is an allowlist keyed by exact
    // path and it has no `/index.html` entry, so that URL falls through to
    // the API's JSON 404 - which is what a real operator got when they
    // clicked a tile. It passed here because the off-box harness served
    // public/ by filename with no allowlist, so it answered a path the
    // product refuses. A test rig more permissive than the thing it stands in
    // for tests nothing about the thing it stands in for.
    a.href = `/#device=${encodeURIComponent(device)}`;
    a.title = `Open ${device} in RSCanvas`;
    return a;
}

function gridTile(s, declared) {
    const el = tileElement(s);
    el.className = 'node gtile';
    stateClasses(el, s);
    const label = document.createElement('span');
    label.className = 'glabel';
    label.textContent = s.label ?? '';
    el.appendChild(label);

    // THE ICON (slice 32), left of the readings - the operator's own mockup,
    // which put it beside the numbers rather than above the name so the tile
    // keeps one centred title line and gains a column instead of a row.
    //
    // Only when the board DECLARED the stencil field and the device has one:
    // guessStencil returns nothing when the evidence is ambiguous, and a
    // blank space is the honest rendering of "we do not know what this is".
    //
    // innerHTML is used HERE and nowhere else on this page, deliberately and
    // narrowly: the markup is a GENERATED CONSTANT from stencils.js, keyed by
    // a value the server validated against the same vocabulary, and it never
    // contains anything a device reported. check-dom-sinks knows this file;
    // if that provenance ever changes, this line has to change with it.
    const wantIcon = declared.includes('stencil') && s.fields && s.fields.stencil;
    const body = document.createElement('div');
    body.className = 'gbody';
    if (wantIcon) {
        // Object.hasOwn, not a bare index: a stencil value of 'constructor'
        // or 'toString' would otherwise find an inherited function, pass the
        // truthiness check, and stringify it into the sink below. The server
        // validates the vocabulary; this makes the provenance claim true by
        // construction on this side too.
        const lib = window.Stencils ?? {};
        const art = Object.hasOwn(lib, s.fields.stencil) ? lib[s.fields.stencil] : undefined;
        if (art) {
            const icon = document.createElement('div');
            icon.className = 'gicon';
            // DOM-SINK-OK: the markup is a build-time constant from
            // stencils.js (generated by tools/build-stencils.mjs), selected
            // by a key the server validated against the same nine-name
            // vocabulary. No device-reported string reaches this line - the
            // device only influences WHICH constant, never its contents.
            icon.innerHTML = art;
            // Position by pref: beside the readings (slice 32's mockup, a
            // WIDTH spend) or above the name (a HEIGHT spend - the right
            // trade when multi-column readings need every pixel of width).
            // Above goes on the TILE, before the label, so the flex column
            // stacks icon / name / readings; beside stays a body column.
            if (prefs.iconpos === 'top') {
                icon.classList.add('gicon-top');
                el.insertBefore(icon, label);
            } else {
                body.appendChild(icon);
            }
        }
    }
    const lines = document.createElement('div');
    lines.className = 'glines';
    body.appendChild(lines);
    el.appendChild(body);

    // A BLANK MEANS TWO DIFFERENT THINGS, and that is what decides whether
    // to keep the slot (slice 37). The operator saw both and said they could
    // argue it either way - because both arguments are right, about
    // different blanks:
    //
    //   device UP, value absent    this device DOES NOT REPORT IT. A UniFi
    //                              AP serves no memory; the row is a
    //                              permanent hole that will never fill, and
    //                              printing "mem" beside nothing forever is
    //                              the tile lying about what it knows.
    //   device NOT UP, all absent  WE CANNOT SEE ANY OF IT RIGHT NOW. Here
    //                              the blanks ARE the message, and
    //                              collapsing them would make a dead device
    //                              look like a device with nothing to say.
    //
    // The projection blanks every value when a device is not up, so the two
    // cases are distinguishable from the payload alone - no new field, no
    // guess. Strict uniformity stays available for walls that want every
    // tile identical whatever the fleet.
    //
    // The decision itself lives in wall-logic's visibleFields, because the
    // column chooser COUNTS these lines to size the wall - drawing from the
    // same list is what stops the layout planning for tiles this loop never
    // draws (the phantom-stencil-row and declared-maximum defects of the
    // 2026-09-01 layout investigation, both of which were this loop and the
    // old chooser disagreeing about tile contents).
    for (const k of visibleFields(s, declared, prefs.blanks)) {
        const raw = s.fields ? s.fields[k] : undefined;
        const line = document.createElement('span');
        line.className = 'gfield';
        const v = raw;
        const name = document.createElement('span');
        name.className = 'gfname';
        name.textContent = FIELD_FMT[k].label;
        line.appendChild(name);
        const val = document.createElement('span');
        val.className = 'gfval';
        val.textContent = v === undefined || v === null ? '' : FIELD_FMT[k].fmt(v);
        line.appendChild(val);
        lines.appendChild(line);
    }
    if (Number(s.alerts) > 0) {
        const a = document.createElement('span');
        a.className = 'count';
        a.textContent = `${s.alerts} alert${Number(s.alerts) === 1 ? '' : 's'}`;
        // Slice 40b: into the BODY, not the tile. Appended to the tile it sat
        // below gbody and ate height from the bottom, so an alert tile's icon
        // centred 7px higher than every other tile's - measured, and the
        // residual slice 40 deliberately left. Inside the body it is a row of
        // the body's own grid, spanning both columns, so it keeps the tile's
        // centre line while the icon spans both rows and centres on the lot.
        body.appendChild(a);
    }
    return el;
}

/**
 * Sections (slice 27): one per declared group, IN DECLARED ORDER - the team
 * that owns the board decided what leads its own dashboard. The all-fleet
 * board has no declared order, so its sections sort alphabetically (the one
 * case where alphabetical is honest). Hand-bound strays from undeclared
 * groups land in a trailing unlabelled section rather than vanishing - a
 * tile that disappears is a device nobody is watching.
 *
 * ONE column count across every section, computed once - per-section column
 * counts were CrossCanvas's tower trap. A big section takes more rows; a
 * small one stays small; the grid stays one grid.
 */
function renderGrid(board) {
    const declaredShapes = [...(board.shapes || [])]
        .sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? ''), undefined, { numeric: true }));

    // Slice 44: `only=problems`. Measured against 1,550 devices, where 970 of
    // them were plain `up` and the wall ran to 12.8 screens at 1080p with the
    // first down device three screens in. Hiding the healthy takes that to
    // about half a screen, which is the difference between a wall somebody
    // reads and a wall somebody scrolls.
    //
    // SUBTRACTIVE, so it is free under BOARD-EXPOSURE clause 1 - it shows
    // strictly less than the board declared and can never surface a device
    // the board withheld. The counts footer is deliberately computed BEFORE
    // this, in render(), so the header keeps telling the truth about the
    // whole board while the canvas shows a slice of it.
    const shapes = prefs.only === 'problems'
        ? declaredShapes.filter((s) => !plainlyUp(s))
        : declaredShapes;
    const hiddenHealthy = declaredShapes.length - shapes.length;

    // SAY THAT YOU BOUND IT - the same posture as the drawn mode's outlier
    // banner. A filtered wall that looks unfiltered is the truncated list
    // that looks complete, which is the one failure this file keeps refusing.
    // THE ALL-CLEAR NEEDS WORDS, NOT AN EMPTY SCREEN. A blank wall is what a
    // broken wall looks like, so the one outcome everybody actually wants -
    // nothing is wrong - must not render as the one everybody fears.
    //
    // Handled BEFORE the banner, and the banner is then skipped: with no
    // tiles left, "970 healthy devices hidden" and "all 970 healthy" are the
    // same sentence twice, and they would also collide, since the outliers
    // bar and the staleness bar occupy the same strip.
    if (shapes.length === 0 && hiddenHealthy > 0) {
        allClear = { total: hiddenHealthy };
        renderAllClear();
        return;
    }

    if (hiddenHealthy > 0) {
        const bar = $('wall-outliers');
        bar.textContent =
            `showing problems only - ${hiddenHealthy} healthy `
            + `device${hiddenHealthy === 1 ? '' : 's'} hidden on this screen`;
        bar.classList.remove('hidden');
        // MEASURED, not assumed: the bar wraps to two lines on a narrow panel
        // and a fixed offset would then sit on top of the first section
        // header. Read after unhiding, which is when it has a height.
        $('wall').style.setProperty('--gw-banner', `${bar.offsetHeight}px`);
    }
    // DECLARED, then filtered by this display's own hide list (slice 31). The
    // order matters and is the safety argument: the board decides what may be
    // shown, the screen decides what it wants of that.
    const hidden = hiddenFields();
    const declared = (board.grid.fields || [])
        // hasOwn: a field key of 'constructor' would find an inherited
        // function here, survive this filter, and throw at .fmt inside
        // gridTile - where poll's catch would mislabel the render error
        // "cannot reach the server".
        .filter((k) => Object.hasOwn(FIELD_FMT, k) && !hidden.has(k));
    const canvas = $('wall-canvas');
    canvas.replaceChildren();

    // Group by section when the board is sourced; a flat grid otherwise.
    const bySection = new Map();
    for (const s of shapes) {
        const key = board.grid.sectioned ? (s.section ?? '') : '';
        if (!bySection.has(key)) bySection.set(key, []);
        bySection.get(key).push(s);
    }
    const order = board.grid.sections !== null && Array.isArray(board.grid.sections)
        ? board.grid.sections.filter((v) => bySection.has(v))
        : [...bySection.keys()].filter((k) => k !== '').sort((a, b) => a.localeCompare(b));
    if (bySection.has('') && !order.includes('')) order.push('');
    const multi = order.length > 1;

    // This display's column choice outranks the board's, and 'auto' is a
    // choice too - a 4K panel and a lobby 1080p screen showing ONE board
    // want different answers, which is the whole reason these live per
    // display rather than on the board.
    const override = prefs.cols === '' ? null : prefs.cols === 'auto' ? 0 : Number(prefs.cols);
    const wanted = override !== null ? override : Number(board.grid.cols);
    // Clamped at the one point of use, covering the URL and the board doc
    // both: the URL is the API (numParam's own lesson), and ?cols=9999999
    // must not become nine million grid tracks on an unattended screen. 48
    // is past any panel the glance grid can render legibly.
    // Reading columns: 'auto' follows the board's own value count, so an
    // all-values board folds into two columns without anyone finding the
    // dial (the operator's ribbon report). Resolved HERE because it needs
    // the board, and written to the CSS var so the tiles lay out with the
    // same number the fit arithmetic used.
    const fcols = prefs.fcols === 'auto'
        ? pickFcols(declared.filter((k) => k !== 'stencil').length)
        : prefs.fcols;
    $('wall').style.setProperty('--gw-fcols', String(fcols));

    let cols;
    if (wanted >= 1) {
        cols = Math.min(Math.floor(wanted), 48);
        lastAutoCols = 0;   // pinned: hysteresis restarts when auto returns
    } else {
        // The REAL wall, handed to the chooser: per section, each tile's
        // rendered line count - blanks:auto collapsed, the alert line in -
        // so the fit is judged against what gridTile below will draw, with
        // every dial fed through and the on-screen count held unless the
        // ideal moves by two (a value arriving on one tile must not
        // reorganize the other thirty-five).
        const sectionLines = order.length > 0
            ? order.map((key) => bySection.get(key).map((s) => tileLineCount(s, declared, prefs.blanks)))
            : [shapes.map((s) => tileLineCount(s, declared, prefs.blanks))];
        cols = chooseCols(sectionLines, {
            width: canvas.clientWidth, height: canvas.clientHeight,
            gap: prefs.gap, pad: prefs.pad, minh: prefs.minh,
            scale: prefs.scale / 100, fcols,
            // A top-positioned icon spends height on every tile that has
            // one; 4px is its stacking margin. Beside the readings it
            // spends width instead, which the per-column guards price in.
            iconH: prefs.iconpos === 'top' && declared.includes('stencil')
                ? prefs.icon + 4 : 0,
        }, lastAutoCols);
        lastAutoCols = cols;
    }

    if (!multi) {
        canvas.classList.add('gwall');
        canvas.classList.remove('gwall-outer');
        canvas.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        for (const s of shapes) canvas.appendChild(gridTile(s, declared));
        return;
    }

    canvas.classList.remove('gwall');
    canvas.classList.add('gwall-outer');
    canvas.style.gridTemplateColumns = '';
    for (const key of order) {
        const head = document.createElement('div');
        head.className = 'gsection-head';
        head.textContent = key === '' ? 'ungrouped' : key;
        canvas.appendChild(head);
        const sec = document.createElement('div');
        sec.className = 'gwall gwall-sec';
        sec.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        for (const s of bySection.get(key)) sec.appendChild(gridTile(s, declared));
        canvas.appendChild(sec);
    }
}

/**
 * Lay the shapes out to fill the screen.
 *
 * The document's coordinates come from an editor canvas of unknown size, and
 * the display is whatever was mounted on the wall. So the shapes' own bounding
 * box is measured and scaled to fit - uniformly, preserving aspect, because a
 * stretched topology stops matching the room it describes.
 */
function render(board) {
    const sameBoard = (lastBoard?.id ?? lastBoard?.name) === (board.id ?? board.name);
    if (!sameBoard) lastAutoCols = 0;
    // A refresh must not steal the reader's place: replaceChildren resets
    // the scroller to the top, so a wall taller than its screen snapped
    // back every ten seconds - unreadable below the fold by construction.
    // The position is saved before the rebuild and restored after, on the
    // SAME board only; a board switch starts at the top like any new page.
    const keepScroll = sameBoard ? $('wall-canvas').scrollTop : 0;
    lastBoard = board;
    allClear = null;   // re-established below only if the canvas ends up empty
    const shapes = board.shapes || [];
    $('wall-msg').classList.add('hidden');
    $('wall-name').textContent = board.name || 'board';
    // Cleared up front so an empty board cannot keep a previous render's
    // banner on screen - the stalest thing a wall can show is a note about a
    // board it is no longer displaying.
    $('wall-outliers').classList.add('hidden');
    $('wall').style.removeProperty('--gw-banner');
    renderCounts(shapes);

    const canvas = $('wall-canvas');
    canvas.replaceChildren();
    canvas.classList.remove('gwall');
    canvas.style.gridTemplateColumns = '';
    if (shapes.length === 0) {
        message('this board has no shapes yet');
        return;
    }
    // Slice 26: a board that declares a grid renders as one (cols 0 = auto) -
    // and everything below this line is the drawn mode, untouched.
    if (board.grid) {
        renderGrid(board);
        canvas.scrollTop = keepScroll;
        return;
    }

    // ONE STRAY SHAPE MUST NOT COLLAPSE THE BOARD.
    //
    // Scaling to the outright bounding box means a single shape parked far
    // off-canvas - a forgotten export artefact, something dragged into the
    // void - shrinks every real device to a few unreadable pixels, silently.
    // The wall is watched by nobody, so "silently" is the whole problem.
    //
    // So the layout is fitted to the 5th-95th percentile of positions and the
    // outliers are CLAMPED to that box rather than dropped. Clamped, because a
    // shape that vanishes is a device nobody is looking at any more, and the
    // banner below says how many were pulled in - the same posture as every
    // other cap on these pages: bound the render, say that you did.
    // The largest-gap trim and its whole 2026-08-31 story live with fitAxis
    // in wall-logic.js now, where the tidy-board sizes the operator's report
    // named (2..40, no trim; a genuine stray; two honest clusters) are
    // pinned by test instead of by the prose that once described a
    // percentile the code no longer had.
    const rawX = shapes.map((s) => Number(s.x) || 0);
    const rawY = shapes.map((s) => Number(s.y) || 0);
    const farX = shapes.map((s) => (Number(s.x) || 0) + (Number(s.w) || 80));
    const farY = shapes.map((s) => (Number(s.y) || 0) + (Number(s.h) || 40));
    const fx = fitAxis(rawX, farX);
    const fy = fitAxis(rawY, farY);
    const loX = fx.lo, hiX = fx.hi, loY = fy.lo, hiY = fy.hi;
    const minX = loX;
    const minY = loY;
    const spanX = Math.max(1, hiX - loX);
    const spanY = Math.max(1, hiY - loY);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    // COUNTED FROM WHAT THE CLAMP ACTUALLY DID, so the banner cannot claim a
    // shape was moved when it was not - these used to be separate tests and
    // could disagree. "Far" means further than the shape's own size: landing
    // a few pixels inside the edge is a fit, not a rescue.
    const outliers = shapes.filter((s) => {
        const x = Number(s.x) || 0, y = Number(s.y) || 0;
        const dx = Math.abs(clamp(x, loX, hiX) - x);
        const dy = Math.abs(clamp(y, loY, hiY) - y);
        return dx > Math.max(40, Number(s.w) || 80) || dy > Math.max(40, Number(s.h) || 40);
    }).length;
    // Said out loud rather than left to be noticed: a board with shapes pulled
    // in from far outside the layout is one somebody should tidy, and the
    // alternative is a wall that looks fine and is subtly not the drawing.
    if (outliers > 0) {
        $('wall-outliers').textContent =
            `${outliers} shape(s) sit far outside the layout and were pulled to its edge`;
        $('wall-outliers').classList.remove('hidden');
    }

    // ?margin=, borrowed name and all. A wall mounted behind a bezel wants
    // more; a small screen wants less.
    const pad = numParam('margin', 24, 0, 400);
    const w = canvas.clientWidth - pad * 2;
    const h = canvas.clientHeight - pad * 2;
    // Never scale UP past 1.5: a three-shape board blown to fill a 4K panel
    // looks like an error, and the empty space is honest about how much of the
    // wall is actually in use.
    const scale = Math.min(1.5, spanX > 0 ? w / spanX : 1, spanY > 0 ? h / spanY : 1);

    for (const s of shapes) {
        const el = tileElement(s);
        el.className = 'node';
        // The classes are decided here, in one place, so "what does red mean"
        // has one answer. Order matters: stale is applied ON TOP of status
        // rather than instead of it, because "it was up when we last heard"
        // is a different claim from "it is up".
        const status = s.status ?? null;
        // Slice 25: down + transient renders OFF - dim, deliberate, counted
        // apart. A parlor of powered-down stations at 02:00 is a quiet grid,
        // and one RED machine on it still means exactly what red means
        // everywhere else. The projection sends the flag only when true.
        if (status === null) el.classList.add('unknown');
        else if (status === 'down') el.classList.add(s.transient ? 'off' : 'down');
        else if (Number(s.alerts) > 0) el.classList.add('warn');
        else el.classList.add('up');
        if (s.stale) el.classList.add('stale');
        // Slice 22: a window is RENDERED, never hidden. The dashed border
        // and the corner tag make a wall in maintenance distinguishable
        // from a quiet wall at a glance - which is the whole design: the
        // page is withheld, the truth is not.
        if (s.maintenance) el.classList.add('maint');

        el.style.left = `${pad + (clamp(Number(s.x) || 0, loX, hiX) - minX) * scale}px`;
        el.style.top = `${pad + (clamp(Number(s.y) || 0, loY, hiY) - minY) * scale}px`;
        el.style.width = `${(Number(s.w) || 80) * scale}px`;
        el.style.height = `${(Number(s.h) || 40) * scale}px`;

        const label = document.createElement('span');
        label.textContent = s.label ?? '';
        el.appendChild(label);

        // Present only when the board declared show_addresses - the projection
        // omits the key entirely otherwise, so there is nothing to decide here.
        if (s.address) {
            const a = document.createElement('span');
            a.className = 'addr';
            a.textContent = s.address;
            label.appendChild(a);
        }
        if (Number(s.alerts) > 0) {
            const c = document.createElement('span');
            c.className = 'count';
            c.textContent = `${s.alerts} alert${Number(s.alerts) === 1 ? '' : 's'}`;
            label.appendChild(c);
        }
        canvas.appendChild(el);
    }
}

// --- the control panel -------------------------------------------------------
//
// Built fresh on each open rather than kept in sync: it is opened by a human
// standing at a screen, so the cost is irrelevant and the alternative (a
// long-lived panel drifting from the board it describes) is a bug waiting.

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}

function heading(panel, text) { panel.appendChild(el('h4', null, text)); }

function selectRow(panel, label, options, current, onPick) {
    const wrap = el('label', 'stack');
    wrap.appendChild(el('span', null, label));
    const sel = el('select');
    for (const [value, text] of options) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        if (String(value) === String(current)) o.selected = true;
        sel.appendChild(o);
    }
    sel.addEventListener('change', () => onPick(sel.value));
    wrap.appendChild(sel);
    panel.appendChild(wrap);
}

function sliderRow(panel, label, key, lo, hi, step, unit) {
    const wrap = el('label', 'stack');
    const cap = el('span', null, `${label}: ${prefs[key]}${unit}`);
    wrap.appendChild(cap);
    const s = document.createElement('input');
    s.type = 'range';
    s.min = String(lo); s.max = String(hi); s.step = String(step);
    s.value = String(prefs[key]);
    // `input` rather than `change`: the point of doing this at the wall is
    // watching the wall move as you drag it.
    s.addEventListener('input', () => {
        cap.textContent = `${label}: ${s.value}${unit}`;
        setPref(key, Number(s.value));
    });
    wrap.appendChild(s);
    panel.appendChild(wrap);
}

function buildPanel() {
    const panel = $('wall-panel');
    panel.replaceChildren();

    // THEME. The engine has been here since the wall shipped (?theme= and the
    // ?themes= rotation, borrowed from PingCanvas's kiosk); what was missing
    // was a way to pick one without editing a URL by hand.
    const names = Object.keys(window.Themes?.THEMES ?? {});
    if (names.length > 0) {
        heading(panel, 'theme');
        const cur = new URLSearchParams(location.search).get('theme') ?? '';
        selectRow(panel, '', [['', 'default'], ...names.map((n) => [n, n])], cur, (v) => {
            const url = new URL(location.href);
            if (v === '') url.searchParams.delete('theme'); else url.searchParams.set('theme', v);
            history.replaceState(null, '', url);
            if (v !== '') window.Themes.applyTheme(v);
            else location.reload();   // back to the app's own default
        });
    }

    // WHAT TO SHOW. Offered ONLY on a grid board, for the same reason the
    // stencil control is: a drawn board's geometry IS its information, so
    // hiding the healthy would punch holes in a topology rather than shorten
    // a list, and a control that would mislead is worse than one that is
    // merely absent. No dead controls on this panel.
    if (lastBoard?.grid) {
        heading(panel, 'what to show');
        selectRow(panel, '', [['all', 'every device'], ['problems', 'problems only']],
            prefs.only, (v) => setPref('only', v));
        panel.appendChild(el('div', 'note',
            'Hides devices that are up with no alerts. Anything unknown, down, '
            + 'stale or in maintenance stays. The count above always describes the '
            + 'whole board, and the banner says how many are hidden here.'));
    }

    // FIELDS - only what the board declared, which is the exposure argument
    // made visible: this list IS the grant, and the ticks only subtract.
    // Slice 39: the stencil comes OUT of this list. It is not a value on a
    // tile, it is artwork beside them, and FIELD_FMT has said exactly that in
    // a comment since slice 32. Leaving it here split ONE concept across two
    // panel sections - the on/off tick in this list, the size slider under
    // "text" - and the cost was measured the only way this kind of cost ever
    // is: the operator asked for a size control to be BUILT, because they had
    // seen the "text" heading above the existing one and skipped past it. An
    // icon is not text. One concept, one place, immediately below.
    const declaredAll = (lastBoard?.grid?.fields || []).filter((k) => FIELD_FMT[k]);
    const declared = declaredAll.filter((k) => k !== 'stencil');
    if (declared.length > 0) {
        heading(panel, 'values on each tile');
        const hidden = hiddenFields();
        const box = el('div', 'fields');
        for (const k of declared) {
            const lab = el('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !hidden.has(k);
            cb.addEventListener('change', () => {
                const next = hiddenFields();
                if (cb.checked) next.delete(k); else next.add(k);
                setPref('hide', [...next].join(','));
            });
            lab.appendChild(cb);
            lab.appendChild(el('span', null, FIELD_FMT[k].label));
            box.appendChild(lab);
        }
        panel.appendChild(box);
        panel.appendChild(el('div', 'note',
            'Only what this board publishes can appear here - unticking hides it on this screen alone.'));
    }

    // Both halves of the icon, together, because they are one decision.
    // Offered ONLY when the board declared the stencil: the panel may hide
    // what a board grants and can never reveal what it withheld, so an
    // undeclared icon gets no control here at all rather than a dead one.
    if (declaredAll.includes('stencil')) {
        heading(panel, 'device icon');
        selectRow(panel, 'icon', [['show', 'show'], ['hide', 'hide']],
            hiddenFields().has('stencil') ? 'hide' : 'show', (v) => {
                const next = hiddenFields();
                if (v === 'hide') next.add('stencil'); else next.delete('stencil');
                setPref('hide', [...next].join(','));
            });
        // The operator measured these against their own mockup: 40 reasonably
        // legible, 60 very visible, 80 starting to push it at a normal width.
        sliderRow(panel, 'size', 'icon', 16, 96, 2, 'px');
        selectRow(panel, 'position', [
            ['side', 'beside the readings'],
            ['top', 'above the name'],
        ], prefs.iconpos, (v) => setPref('iconpos', v));
    }

    heading(panel, 'layout');
    const colOpts = [['', 'board default'], ['auto', 'auto (fit this screen)']];
    for (let i = 1; i <= 12; i++) colOpts.push([String(i), `${i} column${i === 1 ? '' : 's'}`]);
    selectRow(panel, 'columns', colOpts, prefs.cols, (v) => setPref('cols', v));
    sliderRow(panel, 'space between tiles', 'gap', 0, 40, 1, 'px');
    sliderRow(panel, 'padding inside tiles', 'pad', 2, 24, 1, 'px');
    sliderRow(panel, 'minimum tile height', 'minh', 0, 320, 4, 'px');
    panel.appendChild(el('div', 'note',
        'Raise the minimum height to push tiles toward squares; 0 lets them shrink to their text.'));

    heading(panel, 'text');
    sliderRow(panel, 'size', 'scale', 60, 220, 5, '%');
    // Slice 33: the operator watched a tile grow into a tall ribbon as they
    // ticked fields on, with the icon stranded beside it. Two columns of
    // readings keeps the tile squarer and the icon proportionate - their
    // three screenshots are the argument, in order.
    selectRow(panel, 'readings in', [
        ['auto', 'auto (by value count)'],
        ['1', 'one column'],
        ['2', 'two columns'],
        ['3', 'three columns'],
    ], String(prefs.fcols), (v) => setPref('fcols', v === 'auto' ? 'auto' : Number(v)));
    selectRow(panel, 'readings a device lacks', [
        ['auto', 'hide the line'],
        ['show', 'keep the empty line'],
    ], prefs.blanks, (v) => setPref('blanks', v));
    selectRow(panel, 'reading layout', [
        ['split', 'name left, value right'],
        ['center', 'name and value together'],
    ], prefs.align, (v) => setPref('align', v));

    heading(panel, 'refresh');
    const iv = new URLSearchParams(location.search).get('interval') ?? '10';
    selectRow(panel, 'poll every', [['5', '5 seconds'], ['10', '10 seconds'], ['30', '30 seconds'], ['60', '60 seconds']],
        iv, (v) => {
            // Guarded: a value that is not one of the four offered can only
            // arrive from a script driving the page, and writing `interval=`
            // then RELOADING on it would cost a wall its refresh rate for no
            // reason. Found by a drill doing exactly that.
            if (!['5', '10', '30', '60'].includes(v)) return;
            const url = new URL(location.href);
            url.searchParams.set('interval', v);
            // The poll timer is set once at load, so this one genuinely needs
            // a reload - said plainly rather than silently doing nothing.
            // DOM-SINK-OK: a URL object built from location.href, with only a
            // searchParam changed - the scheme and origin are the page's own
            // and cannot be rewritten by setting a query value.
            location.href = url.toString();
        });

    const row = el('div', 'row2');
    const copy = el('button', null, 'Copy this display URL');
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            $('wall-copied').textContent = 'copied - paste this into the kiosk config for this screen to keep the look';
        } catch {
            // Clipboard needs a secure context; on plain http it refuses. Say
            // so rather than appearing to work.
            $('wall-copied').textContent = 'clipboard blocked here - the address bar holds the same settings';
        }
    });
    const reset = el('button', null, 'Reset');
    reset.addEventListener('click', () => {
        const url = new URL(location.href);
        for (const k of Object.keys(PREF_SPEC)) url.searchParams.delete(k);
        // DOM-SINK-OK: same URL object as above with params REMOVED, which
        // cannot introduce a scheme.
        location.href = url.toString();
    });
    row.appendChild(copy);
    row.appendChild(reset);
    panel.appendChild(row);
    const copied = el('div', null, '');
    copied.id = 'wall-copied';
    panel.appendChild(copied);
    panel.appendChild(el('div', 'note',
        'These settings live in the address bar of this page only. Nothing is written back to the board, '
        + 'and other displays of the same board are untouched.'));
}

$('wall-gear').addEventListener('click', () => {
    const panel = $('wall-panel');
    const opening = panel.classList.contains('hidden');
    if (opening) buildPanel();
    panel.classList.toggle('hidden', !opening);
});

// THE CURSOR AUTO-HIDES, which is PingCanvas's kiosk behaviour kept for the
// unattended case - but it RETURNS on movement, because this page has
// controls worth reaching. A wall nobody touches shows no arrow; a wall
// somebody walks up to does.
let idleTimer = null;
function wake() {
    document.getElementById('wall').classList.remove('idle');
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        // Never while the panel is open: hiding the cursor mid-adjustment
        // would be the page fighting the person using it.
        if ($('wall-panel').classList.contains('hidden')) {
            document.getElementById('wall').classList.add('idle');
        }
    }, 5000);
}
window.addEventListener('mousemove', wake);
window.addEventListener('keydown', wake);
wake();

/**
 * The staleness bar. Runs on its own timer rather than only after a fetch,
 * because the case it exists for is the one where fetches have STOPPED
 * HAPPENING - a check that only runs on success can never fire.
 */
function updateAge() {
    const el = $('wall-stale');
    if (lastOkAt === 0) {
        // BEFORE THE FIRST SUCCESS there is no age to report, but a bare
        // return here was this page's own forbidden failure: a wall booted
        // against a down API showed the static "connecting..." forever,
        // retrying invisibly, while lastError held a composed sentence
        // nobody displayed (2026-09-01 review). The terminal states (401,
        // 403, no board named) write their own message and clear lastError,
        // so this branch fires only for the retrying kind - server errors
        // and network failures - which are exactly the ones a person walking
        // past a blank wall needs a sentence about.
        if (lastError !== '') {
            el.textContent = `NOT CONNECTED - nothing has arrived yet (${lastError}) - retrying`;
            el.classList.remove('hidden');
        }
        return;
    }
    const age = Date.now() - lastOkAt;
    $('wall-age').textContent = `updated ${fmtAge(age)} ago`;
    if (age > STALE_AFTER_MS) {
        el.textContent = `NOT UPDATING - this board is ${fmtAge(age)} old`
            + (lastError === '' ? '' : ` (${lastError})`);
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
    // The all-clear is the one render with nothing on the canvas to age
    // visibly, so it is recomposed on this tick rather than at render time.
    renderAllClear();
}

async function poll() {
    if (TOKEN === '' && BOARD === '') {
        message('this URL names no board - a display needs ?token=... from the board it shows, '
            + 'or ?board=<id> if you are signed in');
        return;
    }
    try {
        // The token goes in the Authorization header even though it arrived in
        // the query string: it keeps the credential out of the app's own
        // access logs for every poll after the first page load. The signed-in
        // path has no secret to keep out of a log, so the board id rides the
        // query string and the session cookie does the work.
        const res = await fetch(
            TOKEN !== '' ? '/api/display/board'
                : `/api/display/board?board=${encodeURIComponent(BOARD)}`,
            {
                headers: TOKEN !== '' ? { authorization: `Bearer ${TOKEN}` } : {},
                credentials: 'same-origin',
                cache: 'no-store',
            });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401 && TOKEN === '') {
            // The session went away under a signed-in wall. Terminal in the
            // same manner as a revoked token, and said as its own sentence
            // rather than as an HTTP code, because the fix is different: this
            // one is solved by signing in again, not by a new URL.
            message('signed out - sign in to RSCanvas again to keep watching this board');
            $('wall-stale').classList.add('hidden');
            lastOkAt = 0;
            // Cleared so the never-connected branch of updateAge cannot
            // resurface an older network error over this terminal message.
            lastError = '';
            return;
        }
        if (res.status === 403) {
            // Terminal, and said plainly. A revoked token is the expected end
            // of a display's life - somebody decommissioned the screen - so
            // this is not an error to retry silently forever behind a board
            // that still looks live. The signed-in case is a different
            // sentence for the same reason as the 401 above: nothing is wrong
            // with the URL, the account simply may not render this board.
            message(TOKEN !== ''
                ? 'this display token is no longer valid - it was revoked, or never existed'
                : 'this account is not allowed to view this board');
            $('wall-stale').classList.add('hidden');
            lastOkAt = 0;
            lastError = '';
            return;
        }
        if (!res.ok || body.ok !== true) {
            lastError = body.detail || `HTTP ${res.status}`;
            updateAge();
            return;
        }
        render(body);
        lastOkAt = Date.now();
        lastError = '';
        updateAge();
    } catch (err) {
        // A network failure must NOT clear the board. The last known state is
        // still the best information available, and it is now labelled with
        // its age - which is strictly more useful than a blank screen and
        // strictly more honest than a fresh-looking one.
        lastError = 'cannot reach the server';
        updateAge();
    }
}

loadPrefs();
applyPrefs();
startTheming();
poll();
setInterval(poll, REFRESH_MS);
setInterval(updateAge, 1000);
// A wall gets resized once, when somebody rotates the panel. Re-laying out on
// resize costs nothing and saves a site visit.
window.addEventListener('resize', () => { if (lastOkAt !== 0) poll(); });
