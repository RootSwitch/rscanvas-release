// Every statement that deletes entities queues their hourly history for the
// purge, in the same statement.
//
// The class this guards (slice 60, 2026-10-09, found on the demo box):
// samples_hourly carries no foreign key to entities, and the rollup is kept
// forever, so an entity deleted without its rollup rows leaves them for good -
// unreadable, since every reader joins entities, and counted by nobody. Three
// statements deleted entities (a device delete, a service check's removal, the
// interface-corpse prune) and none of them knew. The fourth would not either,
// unless something said so the day it was written.
//
// The rule: a SQL template literal that says `DELETE FROM entities` must also
// say `INSERT INTO rollup_purge` - a data-modifying CTE over the deleted ids,
// so the delete and its purge commit together (sql/slice60.sql). The jobs
// worker does the purging; the statement only queues.
//
// Not a SQL parser: the template-literal tokeniser from
// check-entity-source.mjs, and SQL comments removed before matching, so prose
// about the rule never trips it.
//
//   node tools/check-entity-deletes.mjs --self-test
//   node tools/check-entity-deletes.mjs --check src

import fs from 'node:fs';
import path from 'node:path';
import { templateLiterals, stripSqlComments } from './check-entity-source.mjs';

function walkDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p, out);
        else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
}

const DELETES = /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?entities\b/gi;
const QUEUES = /\bINSERT\s+INTO\s+(?:public\.)?rollup_purge\b/i;

/** Findings for one file's text: [{ line }]. */
export function scanDeletes(src) {
    const { ok, literals } = templateLiterals(src);
    if (!ok) return { ok: false, findings: [], deletes: 0 };
    const findings = [];
    let deletes = 0;
    for (const lit of literals) {
        const sql = stripSqlComments(lit.text);
        for (const m of sql.matchAll(DELETES)) {
            deletes++;
            if (!QUEUES.test(sql)) {
                findings.push({ line: lit.line + sql.slice(0, m.index).split('\n').length - 1 });
            }
        }
    }
    return { ok: true, findings, deletes };
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };
    const expect = (label, src, count) => {
        const r = scanDeletes(src);
        if (r.ok && r.findings.length === count) ok(label);
        else bad(label, JSON.stringify(r));
    };

    expect('a bare entity delete is REFUSED',
        "q(`DELETE FROM entities WHERE device_id = $1 RETURNING name`)", 1);
    expect('the same delete queueing its ids passes',
        "q(`WITH gone AS (DELETE FROM entities WHERE device_id = $1 RETURNING id),\n"
        + " purge AS (INSERT INTO rollup_purge (entity_id) SELECT id FROM gone ON CONFLICT (entity_id) DO NOTHING)\n"
        + " SELECT count(*) FROM gone`)", 0);
    expect('an aliased delete is the same delete',
        "q(`WITH gone AS (DELETE FROM entities e WHERE e.kind = 'if' RETURNING 1) SELECT count(*) FROM gone`)", 1);
    expect('ONLY and a schema prefix do not hide it',
        "q(`DELETE FROM ONLY public.entities WHERE id = $1`)", 1);
    expect('other tables are not this rule\'s business',
        "q(`DELETE FROM devices WHERE id = $1`); q(`DELETE FROM entities_archive WHERE id = $1`)", 0);
    expect('a queue named only in a SQL comment does not satisfy it',
        "q(`DELETE FROM entities WHERE id = $1 -- INSERT INTO rollup_purge later`)", 1);
    expect('a delete in a SQL comment does not trip it',
        "q(`SELECT 1 FROM entities -- not DELETE FROM entities\n WHERE id = $1`)", 0);
    expect('prose in TypeScript comments never trips it',
        "// a DELETE FROM entities must queue\nconst x = 1;", 0);
    expect('the queue in ANOTHER statement does not count',
        "a(`DELETE FROM entities WHERE id = $1`);\nb(`INSERT INTO rollup_purge (entity_id) VALUES ($1)`)", 1);

    const blind = scanDeletes("q(`DELETE FROM entities WHERE id = $1");
    if (!blind.ok) ok('an unterminated literal is reported as BLIND, not passed');
    else bad('an unterminated literal passed', JSON.stringify(blind));

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

function check(dir) {
    const files = walkDir(dir);
    let deletes = 0;
    let bad = 0;
    for (const f of files) {
        const r = scanDeletes(fs.readFileSync(f, 'utf8'));
        if (!r.ok) {
            console.error(`  ${f}: the scan lost its place (an unterminated literal, string or comment) - the checker is blind here, which is a failure`);
            bad++;
            continue;
        }
        deletes += r.deletes;
        for (const x of r.findings) {
            console.error(`  ${f}:${x.line}: DELETE FROM entities without INSERT INTO rollup_purge in the same statement`);
            bad++;
        }
    }
    if (bad > 0) {
        console.error(`\nREFUSING: ${bad} entity delete(s) would leave their hourly history forever.\n`);
        console.error('samples_hourly has no foreign key to entities and the rollup is never aged out. Return the');
        console.error('deleted ids and queue them in the same statement:');
        console.error('  WITH gone AS (DELETE FROM entities ... RETURNING id),');
        console.error('       purge AS (INSERT INTO rollup_purge (entity_id) SELECT id FROM gone ON CONFLICT (entity_id) DO NOTHING)');
        console.error('See sql/slice60.sql.');
        return 1;
    }
    console.log(`ok - every entity delete queues its hourly history (${deletes} delete(s) in ${files.length} files)`);
    return 0;
}

const arg = process.argv[2];
if (arg === '--self-test') process.exit(selfTest());
else if (arg === '--check') process.exit(check(process.argv[3] ?? 'src'));
else {
    console.error('usage: check-entity-deletes.mjs --self-test | --check <srcdir>');
    process.exit(2);
}
