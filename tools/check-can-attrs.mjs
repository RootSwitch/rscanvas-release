#!/usr/bin/env node
// Refuse a web-client permission gate that names an action the server does
// not have.
//
//   node tools/check-can-attrs.mjs --self-test
//   node tools/check-can-attrs.mjs --check public
//
// Since 2026-09-25 every write control on the page names the action its route
// enforces - `data-can="device.group"` in the markup, `can('device.track')`
// and `canAny('a b')` in app.js - and the page shows it only to a role whose
// action list (from /api/me, read from src/auth/authorize.ts) contains it.
//
// THE FAILURE THIS CATCHES IS SILENT BY DESIGN. The gate fails closed: an
// action name with a typo is held by no role, so the control never appears
// for anyone - including the admin testing it, who reads the missing button
// as "not built yet" or as some other role's page. No error, no 403, nothing
// in a log. The server's action union is the only list that can say the name
// is wrong, so this reads it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The string literals of `export type Action = ... ;` in authorize.ts. */
export function serverActions(src) {
    const start = src.indexOf('export type Action =');
    if (start === -1) return null;
    // Comments go FIRST, before looking for the end: the union's comments
    // carry quoted words of their own ("device.write" in a sentence) and
    // semicolons, and the first run of this checker stopped at a semicolon
    // in a comment - reading twelve actions of thirty and refusing every
    // gate after them.
    const rest = src.slice(start).replace(/\/\/[^\n]*/g, '');
    const body = rest.slice(0, rest.indexOf(';'));
    return new Set([...body.matchAll(/'([a-z][a-zA-Z]*\.[a-zA-Z]+)'/g)].map((m) => m[1]));
}

/** Every action a client file names in a gate, with its line. */
export function gatedActions(src, isHtml) {
    const out = [];
    const line = (i) => src.slice(0, i).split('\n').length;
    const push = (spec, i) => {
        for (const a of spec.split(/\s+/).filter(Boolean)) out.push({ action: a, line: line(i) });
    };
    if (isHtml) {
        const text = src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
        for (const m of text.matchAll(/\bdata-can\s*=\s*"([^"]*)"/g)) push(m[1], m.index);
    } else {
        for (const m of src.matchAll(/\bcan(?:Any)?\(\s*'([^']*)'\s*\)/g)) push(m[1], m.index);
        for (const m of src.matchAll(/\bdataset\.can\s*=\s*'([^']*)'/g)) push(m[1], m.index);
    }
    return out;
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
    const acts = serverActions(
        "export type Action =\n    | 'health.read'\n    // named apart from \"device.write\"; on purpose\n"
        + "    | 'device.group'\n    | 'alert.suppress';\nconst x = 'not.anAction';");
    t('reads the union members, past a semicolon inside a comment',
        acts.size === 3 && acts.has('device.group') && acts.has('alert.suppress'));
    t('a quoted word in a comment inside the union is not an action', !acts.has('device.write'));
    t('stops at the end of the union', !acts.has('not.anAction'));
    const html = gatedActions('<form data-can="device.group">\n<!-- data-can="old.thing" -->\n'
        + '<button data-can="device.rename device.grup">', true);
    t('reads data-can, including a space-separated list', html.map((g) => g.action).join() === 'device.group,device.rename,device.grup');
    t('a data-can quoted in an HTML comment is not a gate', !html.some((g) => g.action === 'old.thing'));
    const js = gatedActions("if (can('device.track')) x();\nconst y = canAny('a.b c.d');\nel.dataset.can = 'device.mute';\nscan('nope');", false);
    t('reads can(), canAny() and dataset.can in script', js.map((g) => g.action).join() === 'device.track,a.b,c.d,device.mute');
    t('a function merely ending in "can" is not a gate', !js.some((g) => g.action === 'nope'));
    const known = new Set(['device.group', 'device.rename']);
    const bad = html.filter((g) => !known.has(g.action));
    t('the typo is refused and the real names are not', bad.length === 1 && bad[0].action === 'device.grup' && bad[0].line === 3);
    return ok;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const actions = serverActions(readFileSync('src/auth/authorize.ts', 'utf8'));
// A checker that parses nothing passes everything (check-lanes' lesson), so
// an empty union or a client with no gates at all is a refusal, not a pass.
if (actions === null || actions.size < 10) {
    console.error(`REFUSING: read ${actions === null ? 'no' : actions.size} action(s) from src/auth/authorize.ts - was the Action union renamed?`);
    process.exit(1);
}
const bad = [];
let gates = 0;
for (const f of walk(root)) {
    const rel = f.replace(/\\/g, '/');
    for (const g of gatedActions(readFileSync(f, 'utf8'), f.endsWith('.html'))) {
        gates++;
        if (!actions.has(g.action)) bad.push({ rel, ...g });
    }
}
if (gates === 0) {
    console.error(`REFUSING: no data-can, can() or canAny() found under ${root} - the scan is blind, not clean.`);
    process.exit(1);
}
if (bad.length > 0) {
    console.error('\nREFUSING: a permission gate names an action the server does not have.\n');
    console.error('The gate fails closed, so this control would never be shown to anyone.');
    console.error(`Server actions: ${[...actions].sort().join(' ')}\n`);
    for (const b of bad) console.error(`  ${b.rel}:${b.line}  ${b.action}`);
    process.exit(1);
}
console.log(`ok - every permission gate in the web client names a server action (${gates} gates, ${actions.size} actions)`);
