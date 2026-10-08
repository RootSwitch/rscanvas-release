// The glance fields are one vocabulary in THREE places, and this holds them
// together (2026-10-07, SLICE-SERVICE-VIEWS-PLAN step 4, adding mos, bw and
// svc):
//
//   GRID_FIELDS (src/store/ops.ts)   what a board may declare - the board
//                                    editor's checkboxes and the /grid route's
//                                    validation both read it;
//   the projection's VALUES table    what the board query can emit for a key;
//   FIELD_FMT (public/wall.js)       what the wall can draw - a key it lacks
//                                    is filtered out before drawing.
//
// The registry's own comment states the first pairing ("a key here without a
// SQL expression is a checkbox that silently shows nothing") and nothing
// enforced it; the third was not written down at all. A rule stated in one
// place and enforced in another - so this reads the shipped sources.
//
//   node tools/test-glance-fields.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRID_FIELDS, GRID_DEFAULT_FIELDS } from '../src/store/ops.ts';

process.exitCode = 1;
let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The text between two markers, which must each occur once after the first. */
function between(text: string, start: string, end: string): string {
    const a = text.indexOf(start);
    if (a < 0) throw new Error(`marker not found: ${start}`);
    const b = text.indexOf(end, a + start.length);
    if (b < 0) throw new Error(`marker not found: ${end}`);
    return text.slice(a + start.length, b);
}

console.log('glance fields\n');

const registry = GRID_FIELDS.map((f) => f.key).sort();
const sql = between(read('src/store/ops.ts'), '\'fields\', CASE WHEN b.grid_cols IS NOT NULL', ') AS f(k, v)');
const sqlKeys = [...sql.matchAll(/^\s*\('([a-z]+)',/gm)].map((m) => m[1]).sort();
const wall = between(read('public/wall.js'), 'const FIELD_FMT = {', '\n};');
const wallKeys = [...wall.matchAll(/^ {4}([a-z]+): \{/gm)].map((m) => m[1]).sort();

// The control: the extraction must find what it is looking for, or every
// comparison below passes over two empty lists.
if (sqlKeys.length >= 10 && wallKeys.length >= 10) ok(`the extraction finds ${sqlKeys.length} SQL keys and ${wallKeys.length} wall keys`);
else bad('the extraction found too little to compare', { sqlKeys, wallKeys });

eq('every key a board may declare, the board query can emit - and nothing else', sqlKeys, registry);
eq('every key a board may declare, the wall can draw - and nothing else', wallKeys, registry);
eq('the service check fields are among them (step 4)', ['bw', 'mos', 'svc'].every((k) => registry.includes(k)), true);
eq('none of them names a thing: values, not identities',
    GRID_FIELDS.filter((f) => ['mos', 'bw', 'svc'].includes(f.key)).map((f) => f.identity), [false, false, false]);
eq('a board switched on for the first time does not start with them',
    ['mos', 'bw', 'svc'].some((k) => GRID_DEFAULT_FIELDS.includes(k)), false);
eq('every default is a registered key', GRID_DEFAULT_FIELDS.every((k) => registry.includes(k)), true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
