// Full-series apply CONVERGENCE, against a disposable database: apply
// bootstrap through every slice, then the retention files, and assert the
// INSTALLED function bodies are the newest definition of each - read back
// with pg_get_functiondef, never inferred from the files.
//
// The defect this mechanises (2026-09-01 review finding 11, store F1):
// slice5-retention.sql carried the PRE-slice-19 body of
// sync_recent_trgm_indexes, apply-schema applies slice files FIRST and
// retention files SECOND, so every `--with-retention` run reinstalled the
// old index-building body over slice 19's reporter - same signature, so
// checkForOverloads saw one function and refused nothing, and the installed
// behaviour flapped with a command-line flag. npm test's dry-run lists the
// files; only an APPLY followed by a read-back can see what a full series
// actually converges to.
//
// PROVISIONAL - NEVER RUN. Written on a box with no Postgres (2026-09-01);
// the first run belongs on lab-test against a scratch database, the same
// posture test-page-budgets shipped with and recorded in its own header.
// The apply order is DUPLICATED from apply-schema.ts's globs because that
// file executes its main() at import - the duplication is a recorded
// hazard, and the assertions below are the hedge: if the orders ever
// diverge, the convergence check is exactly what notices.
//
// DESTRUCTIVE-ADJACENT: applies DDL. Point DATABASE_URL at a DISPOSABLE
// database only (make-test-db.sh mints one); the retention functions carry
// their own fixture interlocks but this tool does not need to test them.
//
//   DATABASE_URL=postgres://...scratch... node tools/test-apply-convergence.ts

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? '';
if (url === '') {
    console.error('FAIL - DATABASE_URL is required, and must name a DISPOSABLE database');
    process.exit(2);
}

const SQL_DIR = path.join(import.meta.dirname, '..', 'sql');
const bySliceNumber = (a: string, b: string): number =>
    Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
const schemaFiles = fs.readdirSync(SQL_DIR)
    .filter((f) => /^(bootstrap|slice\d+)\.sql$/.test(f))
    .sort(bySliceNumber);
const retentionFiles = fs.readdirSync(SQL_DIR)
    .filter((f) => /^slice\d+-retention\.sql$/.test(f))
    .sort();

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d).slice(0, 300));
};

const client = new pg.Client({ connectionString: url });
await client.connect();
console.log(`apply convergence against ${url.replace(/:[^:@/]+@/, ':***@')}\n`);

for (const f of [...schemaFiles, ...retentionFiles]) {
    await client.query(fs.readFileSync(path.join(SQL_DIR, f), 'utf8'));
}
ok(`applied ${schemaFiles.length} schema + ${retentionFiles.length} retention file(s), in order`);

/** The installed definition, from the catalogue - the value at its point of
 *  use, never the file. */
async function def(fn: string): Promise<string> {
    const r = await client.query(
        `SELECT pg_get_functiondef(p.oid) AS d
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`, [fn]);
    if (r.rows.length !== 1) throw new Error(`${fn}: ${r.rows.length} definitions installed`);
    return String(r.rows[0].d);
}

{
    // THE TRGM SYNC IS THE REPORTER, whatever order the files applied in.
    const d = await def('sync_recent_trgm_indexes');
    if (d.includes("'needs-index'") && d.includes("'needs-drop'")) {
        ok('sync_recent_trgm_indexes reports needs-index/needs-drop (slice 19 body)');
    } else bad('the reporter body is not installed', d);
    if (!/EXECUTE format\(\s*'CREATE INDEX/.test(d) && !/EXECUTE format\('DROP INDEX/.test(d)) {
        ok('and it creates and drops NOTHING - the pre-slice-19 body cannot have won the apply');
    } else bad('an index-building body is installed - the with-retention flap is back', d);
}
{
    // FINDING-10'S GUARD ACTUALLY GUARDS: the cutoff is computed AFTER the
    // zone pin, in both functions that pin one. plpgsql evaluates DECLARE
    // initializers before the body, so the order of these two substrings in
    // the installed text is the whole defect class.
    for (const fn of ['drop_partitions_guarded', 'sync_recent_trgm_indexes']) {
        const d = await def(fn);
        const pin = d.indexOf("SET LOCAL TimeZone");
        const cut = d.indexOf('cutoff :=');
        if (pin !== -1 && cut !== -1 && cut > pin) {
            ok(`${fn}: cutoff is assigned AFTER the UTC pin`);
        } else bad(`${fn}: the cutoff/zone ordering regressed`, { pin, cut });
    }
}
{
    // No function name resolves to more than one signature - the trap
    // checkForOverloads closes at apply time, re-asserted from the converged
    // state because this tool applied outside apply-schema.
    const r = await client.query(`
        SELECT p.proname, count(*) AS n
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' GROUP BY 1 HAVING count(*) > 1`);
    if (r.rows.length === 0) ok('no public function carries two signatures');
    else bad('overloads installed', JSON.stringify(r.rows));
}

await client.end();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
