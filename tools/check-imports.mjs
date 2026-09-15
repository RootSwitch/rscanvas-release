// What does a module ACTUALLY import? The cheapest re-sizing there is.
//
//   node tools/check-imports.mjs --self-test
//   node tools/check-imports.mjs <dir> [more dirs...]
//
// WHY THIS EXISTS. The slice 6 triage classified modules by ASSOCIATION rather
// than by imports, and got three in a row wrong in the same direction - always
// too expensive. `rules.js` was filed under "JSON transport" because
// AlertCanvas's alerting reads a feed. That dependency lives in `scanner.js`,
// which BUILDS the document; the engine only ever receives a plain object. The
// assumption belonged to the caller and was attributed to the callee.
//
// A module with no imports cannot depend on the database, the JSON feed or the
// file layout, whatever its neighbours do. So the split is mechanical:
//
//   ZERO imports          handed its data. PORTABLE, and a differential test
//                         away from correct.
//   BUILTINS only         nearly portable - crypto, path, no I/O of consequence.
//   LOCAL imports         depends on siblings; inherits whatever they touch.
//   PACKAGE imports       the real rewrite surface: a driver, a framework, a
//                         transport.
//
// WHAT IMPORTS CANNOT ANSWER, found 2026-07-27 on the fourth triage miss and
// the first in the opposite direction. Zero imports means a module can be
// PORTED without the store. It says nothing about whether it can be LANDED
// without a consumer. filter.js has zero imports and is not a free move: its
// only consumer is the search API, so landing it means changing that contract.
// Portability is a property of the module's imports; landability is a property
// of the TARGET tree, which no scan of the parent can see.
//
// So the report now prints each module's CONSUMERS (reverse edges within the
// scanned tree) beside its imports. The scan still cannot decide landability -
// but it puts the question in front of the person who can, instead of letting
// "zero imports" quietly stand in for "free".
//
// This is a SCANNER, so per SESSION-NOTES it opens with a known positive rather
// than a fault injection: "found nothing" and "cannot see anything" are the
// same output. --self-test asserts it finds the imports in a fixture that has
// them, and reports zero for one that does not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUILTINS = new Set([
    'fs', 'path', 'crypto', 'http', 'https', 'net', 'dgram', 'os', 'url', 'util',
    'events', 'stream', 'zlib', 'child_process', 'worker_threads', 'assert',
    'timers', 'buffer', 'string_decoder', 'querystring', 'tls', 'dns', 'module',
]);

const norm = (s) => s.replace(/^node:/, '');

/** Every import specifier in a file, classified. */
export function classify(src) {
    const specs = [];
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of src.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);

    const local = [];
    const builtin = [];
    const pkg = [];
    for (const s of specs) {
        if (s.startsWith('.')) local.push(s);
        else if (BUILTINS.has(norm(s))) builtin.push(norm(s));
        else pkg.push(s);
    }
    return {
        local: [...new Set(local)],
        builtin: [...new Set(builtin)],
        pkg: [...new Set(pkg)],
    };
}

function verdict(c) {
    if (c.pkg.length > 0) return 'REWRITE';
    if (c.local.length > 0) return 'depends';
    if (c.builtin.length > 0) return 'near-free';
    return 'FREE';
}

function scan(dir) {
    const out = [];
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(js|mjs|ts)$/.test(e.name)) out.push(p);
        }
    };
    walk(dir);
    return out;
}

/**
 * Reverse edges within one scanned tree: for each module, which SIBLINGS import
 * it. Resolved by joining the specifier onto the importer's directory, which is
 * exactly how `require('./x')` resolves in these flat server/ trees.
 */
export function consumersOf(rows) {
    const stripExt = (f) => f.replace(/\.(js|mjs|ts)$/, '');
    const byFile = new Map(rows.map((r) => [r.file, []]));
    for (const r of rows) {
        for (const spec of r.local) {
            const target = path.posix.normalize(
                path.posix.join(path.posix.dirname(r.file), stripExt(spec)));
            for (const other of rows) {
                if (other === r) continue;
                if (stripExt(other.file) === target) byFile.get(other.file).push(r.file);
            }
        }
    }
    return byFile;
}

function report(roots) {
    const rows = [];
    for (const root of roots) {
        for (const f of scan(root)) {
            const c = classify(fs.readFileSync(f, 'utf8'));
            rows.push({
                file: path.relative(path.dirname(root), f).replace(/\\/g, '/'),
                lines: fs.readFileSync(f, 'utf8').split('\n').length,
                v: verdict(c), ...c,
            });
        }
    }
    const consumers = consumersOf(rows);
    const order = { FREE: 0, 'near-free': 1, depends: 2, REWRITE: 3 };
    rows.sort((a, b) => order[a.v] - order[b.v] || b.lines - a.lines);

    let last = null;
    for (const r of rows) {
        if (r.v !== last) { console.log(`\n--- ${r.v} ---`); last = r.v; }
        const used = consumers.get(r.file) ?? [];
        const detail = [
            r.pkg.length > 0 ? `pkg: ${r.pkg.join(', ')}` : '',
            r.local.length > 0 ? `local: ${r.local.join(', ')}` : '',
            r.builtin.length > 0 ? `node: ${r.builtin.join(', ')}` : '',
            used.length > 0
                ? `used by: ${used.map((u) => path.posix.basename(u)).join(', ')}`
                : 'used by: NOTHING HERE',
        ].filter(Boolean).join('  |  ');
        console.log(`  ${String(r.lines).padStart(5)}  ${r.file.padEnd(46)} ${detail}`);
    }
    const free = rows.filter((r) => r.v === 'FREE' || r.v === 'near-free');
    console.log(`\n${rows.length} modules: ${free.length} PORTABLE or nearly `
        + `(${free.reduce((n, r) => n + r.lines, 0)} lines), `
        + `${rows.length - free.length} depending on something.`);
    console.log('portable is not landable: "used by" is who consumes it in THIS tree - '
        + 'whether the fork has that consumer is a question this scan cannot answer.');
    return 0;
}

function selfTest() {
    console.log('import scanner self-test: known positives must be FOUND\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-imp-'));
    let pass = 0;
    let fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };
    try {
        fs.writeFileSync(path.join(dir, 'pure.js'), 'function f(){return 1}\nmodule.exports={f};\n');
        fs.writeFileSync(path.join(dir, 'mixed.js'),
            "const fs=require('fs');\nconst db=require('./db');\nconst pg=require('pg');\n");
        fs.writeFileSync(path.join(dir, 'esm.ts'),
            "import { a } from './a.ts';\nimport pg from 'pg';\nimport fs from 'node:fs';\n");

        const pure = classify(fs.readFileSync(path.join(dir, 'pure.js'), 'utf8'));
        if (verdict(pure) === 'FREE') ok('a module with no imports classifies FREE');
        else bad('a pure module was not FREE', JSON.stringify(pure));

        const mixed = classify(fs.readFileSync(path.join(dir, 'mixed.js'), 'utf8'));
        if (mixed.builtin.includes('fs') && mixed.local.includes('./db') && mixed.pkg.includes('pg')) {
            ok('require() of a builtin, a sibling and a package are told apart');
        } else {
            bad('CommonJS requires were misclassified', JSON.stringify(mixed));
        }
        if (verdict(mixed) === 'REWRITE') ok('and a package import makes it REWRITE');
        else bad('a package import did not force REWRITE');

        const esm = classify(fs.readFileSync(path.join(dir, 'esm.ts'), 'utf8'));
        if (esm.local.includes('./a.ts') && esm.pkg.includes('pg') && esm.builtin.includes('fs')) {
            ok('ESM import syntax and node: prefixes are handled too');
        } else {
            bad('ESM imports were misclassified', JSON.stringify(esm));
        }

        // Reverse edges, against a known positive AND a known negative:
        // mixed.js imports ./db, so a db.js placed beside it must show mixed.js
        // as its consumer - and pure.js, which nothing imports, must show none.
        fs.writeFileSync(path.join(dir, 'db.js'), 'module.exports = {};' + '\n');
        const rows = [];
        for (const f of ['pure.js', 'mixed.js', 'db.js']) {
            const c = classify(fs.readFileSync(path.join(dir, f), 'utf8'));
            rows.push({ file: f, v: verdict(c), ...c });
        }
        const rev = consumersOf(rows);
        if ((rev.get('db.js') ?? []).includes('mixed.js')) {
            ok('reverse edges: db.js is shown as consumed by mixed.js');
        } else {
            bad('reverse edges MISSED a known consumer', JSON.stringify([...rev]));
        }
        if ((rev.get('pure.js') ?? []).length === 0) {
            ok('and a module nothing imports shows no consumers');
        } else {
            bad('reverse edges invented a consumer', JSON.stringify(rev.get('pure.js')));
        }

        // The negative control: the scanner must not invent imports, or
        // "everything depends on something" would pass for the wrong reason.
        if (pure.local.length + pure.builtin.length + pure.pkg.length === 0) {
            ok('and it reports NOTHING for a file that imports nothing');
        } else {
            bad('the scanner invented imports for a pure file', JSON.stringify(pure));
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv[0] === '--self-test') process.exit(selfTest());
else if (argv.length > 0) process.exit(report(argv));
else { console.error('usage: check-imports.mjs --self-test | <dir> [...]'); process.exit(2); }
