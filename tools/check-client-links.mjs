#!/usr/bin/env node
// Refuse a same-origin link in the web client that the server will not serve.
//
// STATIC_FILES in src/main.ts is an ALLOWLIST keyed by exact path. Anything
// not in it falls through to the API, which answers `{"ok":false,"detail":
// "not found"}` - JSON, in the browser, where a page was expected. There is
// no redirect and no index resolution: `/` is served and `/index.html` is
// not, and nothing about the failure says so.
//
// WHAT IT COST. The wall's click-through shipped pointing at
// `/index.html#device=<name>`. Every tile an operator clicked produced a
// screenful of JSON. It passed every check I ran because the off-box harness
// served public/ BY FILENAME with no allowlist, so it answered a path the
// product refuses - a rig more permissive than the thing it stands in for
// proves nothing about the thing it stands in for. Found 2026-08-31 by the
// operator, on the first real click.
//
// Scope: same-origin navigations written as string or template literals in
// public/*.js, and href/src attributes in public/*.html, relative or absolute
// (relative ones resolved against the page). Full URLs to other hosts and
// anything built at runtime are out of scope - this catches the constant that
// was wrong, not every reachable string. Since 2026-10-08 it also refuses an
// absolute link to anything but the API (see resolveLink).
//
// THE HTML HALF (2026-09-24). The pages' own <link> and <script> tags were
// never read, and they are where a missing allowlist entry does its quietest
// damage: a favicon link to an unserved path answers JSON with a 404, no page
// shows an error, and Firefox then records "this origin has no icon" in
// places.sqlite, where a hard reload does not reach it. Adding favicon.ico,
// favicon-32.png and apple-touch-icon.png to the head is what made that worth
// checking before it happens rather than after.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Keys of the STATIC_FILES object literal in main.ts. */
export function servedPaths(mainSrc) {
    const start = mainSrc.indexOf('const STATIC_FILES');
    if (start === -1) return null;
    // `= {`, not the first `{`. The declaration is typed
    // `Record<string, { file: string; type: string }>`, so the first brace
    // belongs to the TYPE and matching it yielded an empty allowlist - which
    // made this checker fail everything on its first run rather than nothing.
    const eq = mainSrc.indexOf('= {', start);
    if (eq === -1) return null;
    const open = mainSrc.indexOf('{', eq);
    let depth = 0;
    let end = open;
    for (let i = open; i < mainSrc.length; i++) {
        if (mainSrc[i] === '{') depth++;
        else if (mainSrc[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = mainSrc.slice(open, end);
    return new Set([...body.matchAll(/'(\/[^']*)'\s*:/g)].map((m) => m[1]));
}

/**
 * One link as written: null when it is not ours to check (a fragment alone,
 * another origin, a scheme, or a template that opens with a variable),
 * otherwise the path it reaches - resolved against `base`, the page's own
 * URL, minus query and hash - and whether it was written absolute.
 *
 * RELATIVE PAGE LINKS (2026-10-08). The pages and their files moved to
 * relative paths so the static demo can serve them under a path on GitHub
 * Pages, where `/app.js` would mean the domain's root, not the demo's. In the
 * product both pages are served at the root, so a relative link reaches the
 * same path it always did - and it is checked against the allowlist the same
 * way. An ABSOLUTE link to anything but the API is now refused: it works in
 * the product and breaks only in the demo, where nobody runs this check. The
 * API stays absolute; it lives at the server's root, and the demo answers it
 * in the page.
 */
function resolveLink(raw, base) {
    if (raw === '' || raw.startsWith('#') || raw.startsWith('//') || raw.startsWith('${')) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
    const absolute = raw.startsWith('/');
    const path = new URL(raw.split(/[#?]/)[0] || './', `http://x${base}`).pathname;
    return { path, absolute };
}

/**
 * Same-origin paths the client actually NAVIGATES to.
 *
 * Only navigations - `.href =`, `window.open(`, `location.assign/replace` -
 * rather than every string that starts with a slash. The first version took
 * all of them and flagged `'/s'`, a units label in a chart formatter, and the
 * word `/index.html` inside the comment explaining this very bug. A check
 * that cries wolf gets an exception added and then gets ignored, so it
 * matches the thing that can actually produce a 404 in front of an operator.
 * Both pages are served at the root, so a relative navigation resolves
 * against `/`.
 */
const NAV = /(?:\.href\s*=\s*|window\.open\(\s*|location\.href\s*=\s*|location\.(?:assign|replace)\(\s*)['"`]([^'"`]*)['"`]/g;

export function linkedPaths(src) {
    const out = [];
    for (const m of src.matchAll(NAV)) {
        const r = resolveLink(m[1], '/');
        if (r) out.push({ ...r, line: src.slice(0, m.index).split('\n').length });
    }
    return out;
}

/**
 * Same-origin paths in href= and src= attributes of an HTML page, resolved
 * against the URL the page is served at (`/` for index.html, `/<name>` for
 * the rest).
 *
 * Comments are blanked first, keeping their newlines so line numbers still
 * point at the right place: index.html explains its own markup at length, and
 * a tag quoted in a comment is not a request the browser makes. `//host`
 * (protocol-relative) is another origin and is not ours to check.
 */
const ATTR = /\b(?:href|src)\s*=\s*["']([^"']*)["']/g;

export function htmlLinkedPaths(src, pageUrl = '/') {
    const text = src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
    const out = [];
    for (const m of text.matchAll(ATTR)) {
        const r = resolveLink(m[1], pageUrl);
        if (r) out.push({ ...r, line: text.slice(0, m.index).split('\n').length });
    }
    return out;
}

/** Why a link is refused, or null. */
export function refusal(link, served) {
    if (link.absolute && !link.path.startsWith('/api/')) return 'absolute';
    if (!served.has(link.path) && !link.path.startsWith('/api/')) return 'unserved';
    return null;
}

function* walk(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (p.endsWith('.js') || p.endsWith('.html')) yield p;
    }
}

function selfTest() {
    let ok = true;
    const t = (label, cond) => { if (cond) console.log(`  ok   ${label}`); else { ok = false; console.log(`  FAIL ${label}`); } };
    const served = servedPaths(
        'const STATIC_FILES: Record<string, { file: string; type: string }> = {\n'
        + " '/': {a:1},\n '/app.js': {b:2},\n '/wall.html': {c:3},\n};\nconst other = { '/nope': 1 };");
    t('reads the allowlist keys past the TYPE annotation, which has its own brace',
        served.size === 3 && served.has('/') && served.has('/app.js'));
    t('stops at the closing brace, so a later object is not swept in', !served.has('/nope'));
    const links = linkedPaths(
        "a.href = `./#device=${x}`;\n"
        + "b.href = 'index.html#device=y';\n"
        + "window.open(`wall.html?board=${id}`);\n"
        + "c.href = '/wall.html';\n"
        + "d.href = `/api/report/traffic?${q}`;\n"
        + "e.href = '#';\n"
        + "f.href = 'https://github.com/RootSwitch';\n"
        + "const unit = '/s';\n"
        + "// the bug was a link to /index.html and this comment must not count\n");
    const paths = links.map((l) => l.path);
    t('a relative link resolves against the root, hash stripped', paths.includes('/'));
    t('finds the path the operator hit, written relative', paths.includes('/index.html'));
    t('strips the query from window.open', paths.includes('/wall.html'));
    t('a units label that starts with a slash is not a link', !paths.includes('/s'));
    t('a path named in a comment is not a link', paths.filter((p) => p === '/index.html').length === 1);
    t('a bare fragment and another origin are not ours to check', links.length === 5);
    const bad = links.map((l) => ({ ...l, why: refusal(l, served) })).filter((l) => l.why);
    t('the real defect is refused as unserved',
        bad.some((l) => l.path === '/index.html' && l.why === 'unserved'));
    t('an absolute page link is refused even though the path is served',
        bad.some((l) => l.path === '/wall.html' && l.why === 'absolute'));
    t('the API stays absolute, and the fixed forms pass', bad.length === 2);
    const head = htmlLinkedPaths(
        '<head>\n'
        + '<link rel="icon" href="favicon.ico" sizes="32x32">\n'
        + '<!-- was <link rel="icon" href="old.ico"> before\n the port -->\n'
        + '<script src="app.js?v=2"></script>\n'
        + '<link rel="preconnect" href="//cdn.example">\n'
        + '<a href="#top">top</a>\n'
        + '<link rel="stylesheet" href="/style.css">\n', '/wall.html');
    const hp = head.map((l) => l.path);
    t('reads a head <link> href, resolved against the page', hp.includes('/favicon.ico'));
    t('reads a <script> src and strips its query', hp.includes('/app.js'));
    t('a tag quoted inside a comment is not a request', !hp.includes('/old.ico'));
    t('line numbers survive a blanked multi-line comment',
        head.find((l) => l.path === '/app.js')?.line === 5);
    t('a protocol-relative URL is another origin, and a fragment is not a path', hp.length === 3);
    const hbad = head.map((l) => ({ ...l, why: refusal(l, served) })).filter((l) => l.why);
    t('the unserved icon is refused',
        hbad.some((l) => l.path === '/favicon.ico' && l.why === 'unserved'));
    t('an absolute stylesheet is refused: it breaks under a path',
        hbad.some((l) => l.path === '/style.css' && l.why === 'absolute'));
    t('nothing else is refused', hbad.length === 2);
    return ok;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const served = servedPaths(readFileSync('src/main.ts', 'utf8'));
if (served === null) {
    console.error('REFUSING: could not find STATIC_FILES in src/main.ts - was it renamed?');
    process.exit(1);
}
const bad = [];
let checked = 0;
for (const f of walk(root)) {
    const rel = f.replace(/\\/g, '/');
    const name = rel.split('/').pop();
    const links = f.endsWith('.html')
        ? htmlLinkedPaths(readFileSync(f, 'utf8'), name === 'index.html' ? '/' : `/${name}`)
        : linkedPaths(readFileSync(f, 'utf8'));
    for (const l of links) {
        checked++;
        const why = refusal(l, served);
        if (why) bad.push({ rel, why, ...l });
    }
}

const unserved = bad.filter((b) => b.why === 'unserved');
const absolute = bad.filter((b) => b.why === 'absolute');
if (unserved.length > 0) {
    console.error('\nREFUSING: the client links to a path the server does not serve.\n');
    console.error('STATIC_FILES is an exact-path allowlist. A path outside it falls through');
    console.error('to the API and answers JSON in the browser, with nothing to say why.');
    console.error(`Served: ${[...served].sort().join(' ')}\n`);
    for (const b of unserved) console.error(`  ${b.rel}:${b.line}  ${b.path}`);
}
if (absolute.length > 0) {
    console.error('\nREFUSING: a page link written as an absolute path.\n');
    console.error('Pages and their files are linked RELATIVE, so the pages also work served');
    console.error('under a path (the static demo on GitHub Pages). Only /api/ stays absolute.\n');
    for (const b of absolute) console.error(`  ${b.rel}:${b.line}  ${b.path}`);
}
if (bad.length > 0) process.exit(1);
console.log(`ok - ${checked} client links resolve to served paths, pages linked relative (${served.size} served)`);
