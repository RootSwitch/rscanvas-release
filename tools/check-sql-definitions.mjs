// Every function and view is defined in exactly ONE applied sql file -
// verified against sql/, deliberately not a SQL parser.
//
// The class this guards, found 2026-09-06 on lab-stresstest and fixed by
// hand five days earlier without a guard (34dbe46): sync_recent_trgm_indexes
// was CREATE OR REPLACEd in slice19.sql (the report-only body the
// maintenance lane depends on) AND in slice5-retention.sql (an older body
// that built and dropped indexes inline). apply-schema applies slice files
// first and retention files second, so every --with-retention run quietly
// reinstalled the older body over the newer one. Same signature, so
// checkForOverloads saw one function and refused nothing; the installed
// behaviour flapped with a command-line flag. The 30k box took its schema
// that way on 08-30 and ran the old body for a week. The only symptom was
// a count in the soak log climbing one a day, and the repo's own copy of
// the function said that could not happen - which is the worst kind of
// defect, the kind the source code denies.
//
// The rule is the smallest one that makes the class impossible: a name may
// be CREATEd in one applied file. A body evolves by CREATE OR REPLACE in
// the file that owns the name, never in a second file whose position in
// the apply order decides which body wins. DROP FUNCTION in a second file
// is fine - it is a removal, not a competing definition.
//
//   node tools/check-sql-definitions.mjs --self-test
//   node tools/check-sql-definitions.mjs --check sql

import fs from 'node:fs';
import path from 'node:path';

/** The files apply-schema actually runs, and nothing else: a stray .sql
 *  under sql/ that is never applied cannot compete for a name. Mirrors the
 *  two globs in src/db/apply-schema.ts. */
export const APPLIED = /^(?:bootstrap|slice\d+)(?:-retention)?\.sql$/;

/** Comments and dollar-quoted bodies removed. A body may legitimately hold
 *  the words CREATE FUNCTION inside a string or an EXECUTE format(), and a
 *  commented-out definition defines nothing. */
export function bare(sql) {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$/g, ' ');
}

const DEF = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW|MATERIALIZED\s+VIEW)\s+((?:[A-Za-z_][A-Za-z_0-9]*\.)?[A-Za-z_][A-Za-z_0-9]*)/gi;

/** "<kind> <name>" -> the set of files that CREATE it. */
export function definitions(files) {
    const by = new Map();
    for (const { name: file, text } of files) {
        for (const m of bare(text).matchAll(DEF)) {
            const kind = m[1].toLowerCase().replace(/\s+/g, ' ');
            const name = m[2].toLowerCase().replace(/^public\./, '');
            const key = `${kind} ${name}`;
            const owners = by.get(key) ?? new Set();
            owners.add(file);
            by.set(key, owners);
        }
    }
    return by;
}

/**
 * The verdict. A definition set with NOTHING in it is a failure, not a
 * pass: a checker that reads an empty directory and reports "no duplicates"
 * has verified nothing, and the house rule is that a checker fails on zero
 * input rather than blessing it.
 */
export function judge(by) {
    const dups = [...by.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([key, owners]) => ({ key, files: [...owners].sort() }));
    if (by.size === 0) return { ok: false, blind: true, dups, count: 0 };
    return { ok: dups.length === 0, blind: false, dups, count: by.size };
}

function check(dir) {
    const names = fs.readdirSync(dir).filter((f) => APPLIED.test(f)).sort();
    const files = names.map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
    const v = judge(definitions(files));
    if (v.blind) {
        console.error(`FAIL - no function or view definitions found under ${dir} (${names.length} applied file(s)); `
            + 'a checker with nothing to check has checked nothing');
        process.exit(1);
    }
    for (const d of v.dups) {
        console.error(`  ${d.key} is defined in ${d.files.length} files: ${d.files.join(', ')}\n`
            + '    apply order decides which body wins; keep ONE and evolve it there');
    }
    if (!v.ok) { console.error(`FAIL - ${v.dups.length} name(s) defined in more than one applied file`); process.exit(1); }
    console.log(`ok - ${v.count} function/view definition(s) across ${names.length} applied files, each owned by one file`);
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };

    const reporter = 'DROP FUNCTION IF EXISTS sync_x(text, int);\n'
        + 'CREATE OR REPLACE FUNCTION sync_x(tbl text, keep_days int)\nRETURNS TABLE(action text) LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN;\nEND $$;\n';
    const older = '-- the 2026-08 shape\nCREATE OR REPLACE FUNCTION sync_x(tbl text, keep_days int)\nRETURNS TABLE(action text) LANGUAGE plpgsql AS $$\nBEGIN\n  EXECUTE \'CREATE INDEX i ON t (c)\';\nEND $$;\n';

    // THE PLANTED DEFECT is the 34dbe46 shape: the same name in two files.
    {
        const v = judge(definitions([{ name: 'slice19.sql', text: reporter }, { name: 'slice5-retention.sql', text: older }]));
        if (!v.ok && v.dups.length === 1 && v.dups[0].files.join(',') === 'slice19.sql,slice5-retention.sql') {
            ok('a function defined in two applied files is caught, and both files are named');
        } else bad('missed the two-file definition', v);
    }
    {
        // One file, two CREATE OR REPLACE of the same name: one owner, and
        // that owner evolving its body. Not the class.
        const v = judge(definitions([{ name: 'slice5.sql', text: reporter + '\n' + reporter }]));
        if (v.ok && v.count === 1) ok('the same name twice in ONE file is one owner, not a duplicate');
        else bad('a single owner was accused', v);
    }
    {
        // A DROP in a second file is a removal, not a competing definition.
        const v = judge(definitions([{ name: 'slice19.sql', text: reporter },
            { name: 'slice30.sql', text: 'DROP FUNCTION IF EXISTS sync_x(text, int);\n' }]));
        if (v.ok) ok('DROP FUNCTION in another file is not a definition');
        else bad('a DROP was counted as a definition', v);
    }
    {
        // The words inside a body or a comment define nothing.
        const noisy = 'CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$\n'
            + 'BEGIN\n  EXECUTE format(\'CREATE OR REPLACE FUNCTION g() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql\');\nEND $body$;\n'
            + '-- CREATE FUNCTION h() was removed in slice 9\n/* CREATE VIEW v AS SELECT 1 */\n';
        const by = definitions([{ name: 'a.sql', text: noisy }, { name: 'b.sql', text: 'CREATE FUNCTION g() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;' }]);
        const v = judge(by);
        if (v.ok && v.count === 2 && by.has('function f') && by.has('function g')) {
            ok('a definition quoted inside a body or a comment is not a definition');
        } else bad('body or comment text was counted', [...by.keys()]);
    }
    {
        // Views are the same class, and public. is the same name.
        const v = judge(definitions([{ name: 'a.sql', text: 'CREATE VIEW public.roster AS SELECT 1;' },
            { name: 'b.sql', text: 'CREATE OR REPLACE VIEW roster AS SELECT 2;' }]));
        if (!v.ok && v.dups[0]?.key === 'view roster') ok('a view defined in two files is caught, schema prefix or not');
        else bad('missed the two-file view', v);
    }
    {
        // BLIND: nothing to check is a failure, never a pass.
        const v = judge(definitions([{ name: 'empty.sql', text: '-- nothing here\n' }]));
        if (!v.ok && v.blind) ok('zero definitions is a FAILED check, not a clean one');
        else bad('an empty input passed', v);
    }
    {
        if (APPLIED.test('slice19.sql') && APPLIED.test('slice5-retention.sql') && APPLIED.test('bootstrap.sql')
            && !APPLIED.test('scratch.sql') && !APPLIED.test('slice19.sql.bak')) {
            ok('the applied-file glob matches apply-schema: bootstrap, sliceN, sliceN-retention, nothing else');
        } else bad('the applied glob drifted');
    }

    console.log(`${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--check') check(process.argv[3] ?? 'sql');
else { console.error('usage: check-sql-definitions.mjs --self-test | --check <dir>'); process.exit(2); }
