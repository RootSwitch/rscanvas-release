#!/usr/bin/env node
// Refuse a `style` ATTRIBUTE anywhere in the web client, because the
// Content-Security-Policy depends on there not being one.
//
//   node tools/check-inline-style.mjs --self-test
//   node tools/check-inline-style.mjs --check public
//
// WHAT IT COST, and it is the reason this is a checker rather than a comment.
// The CSP shipped as `style-src 'self'` on the strength of a measurement:
// zero `style=` attributes in either HTML file, zero inline handlers, one
// `<style>` block that was moved to wall.css. That measurement was correct
// and the conclusion was wrong, because it only looked at the HTML. The
// stencil icons are SVG MARKUP STRINGS in stencils.js, assigned through the
// one sanctioned `innerHTML` in wall.js, and every one of them carried
// `style="fill:currentColor"` on its paths and
// `style="fill-rule:evenodd;..."` on its root - 480 and 120 of them at 1,550
// tiles. Chrome parses those as inline styles and refuses them.
//
// The visible result was the EXACT failure the wall already has a scar from:
// **every icon rendered black instead of taking its tile's state colour**, so
// a down device's icon stopped being red. That is the `--se-crit` bug again,
// arriving by a different route, and no test in the repo would have said so -
// it is invisible to a DOM-sink scan, invisible to typecheck, and invisible
// to any check that reads the HTML rather than the markup the JS builds.
// Found 2026-08-31 by loading the page against the real headers and reading
// the computed fill, not by reasoning about the policy.
//
// The fix was presentation attributes (`fill="currentColor"`), which SVG
// honours and CSP does not govern. This refuses the regression.
//
// SCOPE, stated because a checker whose limits are unwritten gets trusted for
// things it never did: this is syntactic. It catches `style="..."` and
// `style=\"...\"` in .html and .js under public/. It does NOT see a style
// attribute assembled at runtime from pieces, and it deliberately allows
// `el.style.x = ...` and `setProperty`, which are CSSOM and which CSP permits
// - verified in a browser under the shipped policy rather than assumed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** `style="..."` or the escaped `style=\"...\"` form inside a JS string. */
const STYLE_ATTR = /\bstyle\s*=\s*\\?"/;

export function scanInlineStyle(src) {
    const hits = [];
    src.split(/\r?\n/).forEach((line, i) => {
        // A whole-line comment is prose, not markup - the same rule the
        // sibling checkers use, and the reason this file can describe the
        // defect it exists to catch without tripping on itself.
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        if (STYLE_ATTR.test(line)) hits.push(i + 1);
    });
    return hits;
}

function* walk(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (/\.(js|html)$/.test(p)) yield p;
    }
}

function selfTest() {
    let ok = true;
    const t = (label, cond) => { if (cond) console.log(`  ok   ${label}`); else { ok = false; console.log(`  FAIL ${label}`); } };
    t('plain HTML style attribute is refused',
        scanInlineStyle('<div style="color:red">x</div>').length === 1);
    t('THE ACTUAL DEFECT: an escaped style attribute inside a JS markup string',
        scanInlineStyle('const s = "<path d=\\"M0\\" style=\\"fill:currentColor;\\"/>";').length === 1);
    t('the presentation-attribute form that replaced it is fine',
        scanInlineStyle('const s = "<path d=\\"M0\\" fill=\\"currentColor\\"/>";').length === 0);
    t('CSSOM is allowed - CSP does not govern it, checked in a browser',
        scanInlineStyle('el.style.width = "3px"; el.style.setProperty("--a","b");').length === 0);
    t('a prose line describing style="x" does not trip it',
        scanInlineStyle('// it used to carry style="fill:currentColor"').length === 0);
    return ok;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const bad = [];
for (const f of walk(root)) {
    for (const line of scanInlineStyle(readFileSync(f, 'utf8'))) {
        bad.push(`${f.replace(/\\/g, '/')}:${line}`);
    }
}
if (bad.length > 0) {
    console.error('\nREFUSING: a `style` attribute in the web client.\n');
    console.error("The pages ship `style-src 'self'`, so the browser will DROP this");
    console.error('declaration. On an SVG stencil that means the icon loses its state');
    console.error('colour and renders black - silently, on the wall, which is the one');
    console.error('surface where a wrong colour is the whole failure.\n');
    console.error('Use a presentation attribute (fill="currentColor") or a rule in a');
    console.error('stylesheet. CSSOM (el.style.x = ...) is fine and is not this.\n');
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
}
console.log('ok - no inline style attributes in the web client (the CSP depends on it)');
