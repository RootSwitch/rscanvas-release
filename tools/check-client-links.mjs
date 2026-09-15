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
// Scope: absolute same-origin paths written as string or template literals in
// public/*.js. Relative links, full URLs to other hosts, and anything built
// at runtime are out of scope - this catches the constant that was wrong, not
// every reachable string.

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
 * Absolute same-origin paths the client actually NAVIGATES to, minus query
 * and hash.
 *
 * Only navigations - `.href =`, `window.open(`, `location.assign/replace` -
 * rather than every string that starts with a slash. The first version took
 * all of them and flagged `'/s'`, a units label in a chart formatter, and the
 * word `/index.html` inside the comment explaining this very bug. A check
 * that cries wolf gets an exception added and then gets ignored, so it
 * matches the thing that can actually produce a 404 in front of an operator.
 */
const NAV = /(?:\.href\s*=\s*|window\.open\(\s*|location\.href\s*=\s*|location\.(?:assign|replace)\(\s*)['"`](\/[^'"`]*)['"`]/g;

export function linkedPaths(src) {
    const out = [];
    for (const m of src.matchAll(NAV)) {
        out.push({ path: m[1].split(/[#?]/)[0] || '/', line: src.slice(0, m.index).split('\n').length });
    }
    return out;
}

function* walk(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (p.endsWith('.js')) yield p;
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
        "a.href = `/#device=${x}`;\n"
        + "b.href = '/index.html#device=y';\n"
        + "window.open('/wall.html?board=3');\n"
        + "const unit = '/s';\n"
        + "// the bug was a link to /index.html and this comment must not count\n");
    const paths = links.map((l) => l.path);
    t('strips the hash from a template literal', paths.includes('/'));
    t('finds the path the operator hit', paths.includes('/index.html'));
    t('strips the query from window.open', paths.includes('/wall.html'));
    t('a units label that starts with a slash is not a link', !paths.includes('/s'));
    t('a path named in a comment is not a link', paths.filter((p) => p === '/index.html').length === 1);
    const bad = links.filter((l) => !served.has(l.path));
    t('the real defect is refused and the fixed form is not',
        bad.length === 1 && bad[0].path === '/index.html');
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
for (const f of walk(root)) {
    const rel = f.replace(/\\/g, '/');
    for (const l of linkedPaths(readFileSync(f, 'utf8'))) {
        if (!served.has(l.path) && !l.path.startsWith('/api/')) bad.push({ rel, ...l });
    }
}

if (bad.length > 0) {
    console.error('\nREFUSING: the client links to a path the server does not serve.\n');
    console.error('STATIC_FILES is an exact-path allowlist. A path outside it falls through');
    console.error('to the API and answers JSON in the browser, with nothing to say why.');
    console.error(`Served: ${[...served].sort().join(' ')}\n`);
    for (const b of bad) console.error(`  ${b.rel}:${b.line}  ${b.path}`);
    process.exit(1);
}
console.log(`ok - every client link resolves to a served path (${served.size} served)`);
