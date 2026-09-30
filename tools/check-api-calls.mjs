#!/usr/bin/env node
// Refuse an api() call in the web client whose second argument carries data
// but no method.
//
//   node tools/check-api-calls.mjs --self-test
//   node tools/check-api-calls.mjs --check public
//
// WHAT IT COST. The page's api(path, opts) hands opts straight to fetch(), so
// its second argument is fetch OPTIONS - method, headers, body. The boards
// list's reconcile verbs called api(url, { action }) as if it took the
// request body: fetch ignored the unknown key and sent a bodiless GET, the
// POST-only route never matched, and the router's catch-all answered "not
// found". Add, drop and rebuild had never worked from the page; the server
// route and its judgements were tested, the button was not. Found by the
// operator on 2026-09-28, pressing "add 3" for three new ping-only devices.
//
// The rule: an object literal passed as api()'s second argument must name a
// method. A GET needs no options at all, so a literal without one is always
// a body in the wrong place. SCOPE: syntactic, over object literals written
// at the call; an options object built elsewhere and passed by name is not
// seen, and neither is a call through another helper.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Line numbers of api(x, { ... }) calls whose literal names no method. */
export function scanApiCalls(src) {
    const hits = [];
    const re = /\bapi\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        // Walk to the call's first top-level comma, then see whether an object
        // literal follows it.
        let i = re.lastIndex;
        let depth = 0;
        let quote = null;
        for (; i < src.length; i++) {
            const c = src[i];
            if (quote !== null) {
                if (c === '\\') { i++; continue; }
                if (c === quote) quote = null;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
            else if (c === ',' && depth === 0) break;
        }
        if (src[i] !== ',') continue;
        let j = i + 1;
        while (/\s/.test(src[j] ?? '')) j++;
        if (src[j] !== '{') continue;
        // The literal, braces balanced, strings skipped.
        let k = j;
        let d = 0;
        quote = null;
        for (; k < src.length; k++) {
            const c = src[k];
            if (quote !== null) {
                if (c === '\\') { k++; continue; }
                if (c === quote) quote = null;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
            if (c === '{') d++;
            else if (c === '}') { d--; if (d === 0) break; }
        }
        const literal = src.slice(j, k + 1);
        if (!/\bmethod\s*:/.test(literal)) hits.push(src.slice(0, m.index).split('\n').length);
    }
    return hits;
}

function* walk(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (/\.js$/.test(p)) yield p;
    }
}

function selfTest() {
    let ok = true;
    const t = (label, cond) => { if (cond) console.log(`  ok   ${label}`); else { ok = false; console.log(`  FAIL ${label}`); } };
    t('THE ACTUAL DEFECT: a request body passed as fetch options',
        scanApiCalls('const r = await api(`/api/boards/${id}/reconcile`,\n    { action, ...(extra || {}) });').length === 1);
    t('the fixed call, with method, headers and a JSON body, is fine',
        scanApiCalls("api(`/api/boards/${id}/reconcile`, { method: 'POST', headers: {}, body: JSON.stringify({ action }) });").length === 0);
    t('a plain GET with no options is fine', scanApiCalls("api('/api/devices');").length === 0);
    t('a DELETE with only a method is fine', scanApiCalls("api(`/api/boards/${x}`, { method: 'DELETE' });").length === 0);
    t('a comma inside the path expression is not the argument break',
        scanApiCalls('api(`/api/x?a=${f(1, 2)}`, { method: "POST" });').length === 0);
    t('and the defect is still found after one',
        scanApiCalls('api(`/api/x?a=${f(1, 2)}`, { action: 1 });').length === 1);
    t('the line reported is the call\'s', scanApiCalls('a();\nb();\napi(u, { action });')[0] === 3);
    return ok;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const bad = [];
let files = 0;
for (const f of walk(root)) {
    files++;
    for (const line of scanApiCalls(readFileSync(f, 'utf8'))) bad.push(`${f.replace(/\\/g, '/')}:${line}`);
}
if (files === 0) { console.error(`REFUSING: no .js files under ${root} - a check of nothing is not a pass`); process.exit(1); }
if (bad.length > 0) {
    console.error('\nREFUSING: an api() call passes data as its second argument without a method.\n');
    console.error("api(path, opts) hands opts to fetch(): a { action } there is dropped, the");
    console.error('request goes out as a bodiless GET, and a POST route answers "not found".');
    console.error("Write { method: 'POST', headers: { 'content-type': 'application/json' },");
    console.error('body: JSON.stringify({ ... }) }.\n');
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
}
console.log('ok - every api() call with options names its method');
