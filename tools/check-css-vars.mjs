#!/usr/bin/env node
// Refuse a CSS custom property that is used and never defined.
//
// AN UNDEFINED CUSTOM PROPERTY IS NOT AN ERROR, and that is the whole reason
// this check exists. `color: var(--se-crit)` where nothing defines --se-crit
// is not a parse failure and not a console warning: the declaration is simply
// dropped, the property falls back to its inherited or initial value, and the
// page renders. Something plausible appears. Nobody looks twice.
//
// WHAT IT COST. The wall styled down devices with var(--se-crit) and up
// devices with var(--se-ok), while the palette has always called those
// --se-down and --se-up. Both declarations were dead, so border-color fell
// back to currentColor and a DOWN device rendered IDENTICALLY to a healthy
// one - on the page whose entire job is showing what is broken, for months.
// Only `warn` survived, by the accident of being spelled the same in both
// vocabularies. The staleness banner's red background was dead the same way,
// so "NOT UPDATING" drew as plain text. Found 2026-08-30 by rendering 1,550
// real devices and asking why none of them were red.
//
// A FALLBACK IS THE OPT-OUT, and it needs no keyword: `var(--se-hover,
// rgba(127,127,127,0.12))` says the author knew the variable might be absent
// and chose what happens then. That is a deliberate default, not a silent
// one, so it passes. Only a bare var(--x) with no definition anywhere is
// refused - the form that fails invisibly.
//
// Definitions are collected from the CSS and HTML, and ALSO from
// setProperty() calls in the scripts, because the wall's live dials
// (--gw-gap, --gw-scale, --gw-banner) are legitimately defined at runtime and
// exist nowhere in a stylesheet.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STYLE_EXT = /\.(css|html)$/;
const SCRIPT_EXT = /\.(js|mjs)$/;
const DEFINE = /--([a-zA-Z0-9_-]+)\s*:/g;
const SET_PROPERTY = /setProperty\(\s*['"`]--([a-zA-Z0-9_-]+)/g;
/** A bare reference: var(--x) with no comma, so no fallback. */
const BARE_USE = /var\(\s*--([a-zA-Z0-9_-]+)\s*\)/g;

function* walk(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) yield* walk(p);
        else yield p;
    }
}

export function analyse(files) {
    const defined = new Set();
    for (const { name, text } of files) {
        if (STYLE_EXT.test(name)) for (const m of text.matchAll(DEFINE)) defined.add(m[1]);
        if (SCRIPT_EXT.test(name)) for (const m of text.matchAll(SET_PROPERTY)) defined.add(m[1]);
    }
    const missing = [];
    for (const { name, text } of files) {
        if (!STYLE_EXT.test(name)) continue;
        for (const m of text.matchAll(BARE_USE)) {
            if (defined.has(m[1])) continue;
            missing.push({ rel: name, line: text.slice(0, m.index).split('\n').length, name: m[1] });
        }
    }
    return { defined, missing };
}

function selfTest() {
    let ok = true;
    const check = (label, files, want) => {
        const got = analyse(files).missing.map((m) => m.name).sort().join(',');
        if (got === want) console.log(`  ok   ${label}`);
        else { ok = false; console.log(`  FAIL ${label}: got [${got}] want [${want}]`); }
    };
    check('a defined variable passes',
        [{ name: 'a.css', text: ':root{--x:red} .a{color:var(--x)}' }], '');
    check('an undefined bare reference is caught',
        [{ name: 'a.css', text: '.a{color:var(--nope)}' }], 'nope');
    check('a fallback is a deliberate default and passes',
        [{ name: 'a.css', text: '.a{color:var(--nope, #999)}' }], '');
    check('defined in one file, used in another',
        [{ name: 'a.css', text: ':root{--x:red}' }, { name: 'b.html', text: '<style>.a{color:var(--x)}</style>' }], '');
    check('set at runtime by a script counts as defined',
        [{ name: 'w.js', text: "el.style.setProperty('--gw-gap', '8px')" },
            { name: 'a.css', text: '.a{gap:var(--gw-gap)}' }], '');
    check('the real defect: a second vocabulary for an existing colour',
        [{ name: 'p.css', text: ':root{--se-down:#d64545;--se-up:#2e9b57}' },
            { name: 'w.html', text: '<style>.n.down{border-color:var(--se-crit)}.n.up{border-color:var(--se-ok)}</style>' }],
        'se-crit,se-ok');
    return ok;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const files = [];
for (const f of walk(root)) {
    if (STYLE_EXT.test(f) || SCRIPT_EXT.test(f)) {
        files.push({ name: f.replace(/\\/g, '/'), text: readFileSync(f, 'utf8') });
    }
}
const { defined, missing } = analyse(files);

if (missing.length > 0) {
    console.error('\nREFUSING: a CSS custom property is used and never defined.\n');
    console.error('This does not fail at runtime - the declaration is dropped and the');
    console.error('property falls back to its inherited value, so the page renders');
    console.error('something plausible. That is how a DOWN device came to render exactly');
    console.error('like a healthy one on the wall for months.\n');
    console.error('Use a name the palette actually defines, or give the reference an');
    console.error('explicit fallback - var(--x, <value>) - which says you meant it.\n');
    for (const m of missing) console.error(`  ${m.rel}:${m.line}  --${m.name}`);
    process.exit(1);
}
console.log(`ok - every CSS variable used is defined (${defined.size} known)`);
