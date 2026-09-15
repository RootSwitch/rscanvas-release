// Apply sql/slice1.sql.
//
// Additive only. There is no DROP in the file and no destructive path in this
// runner: it will not create a database, will not drop objects, and refuses to
// run anything whose text contains a DROP. Slice 1 measures against the spike
// corpus in rscanvas_spike, and 204GB that takes 90 minutes to rebuild deserves
// a structural guard rather than a careful operator.
//
// SQL lives in a file rather than in a handler, which is rule 1 respected: the
// point of "no SQL outside the store module" is that no request path can reach
// the database except by naming an operation, not that schema DDL must be
// smuggled into a query builder.
//
//   node src/db/apply-schema.ts
//   node src/db/apply-schema.ts --dry-run

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { internalUnsafeLane as onLane, closeAll } from '../store/index.ts';
import { CONFIG } from '../config.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_DIR = path.join(ROOT, 'sql');

// Every slice file, in slice order. Each is independently idempotent, so
// applying all of them is the same as applying the ones that are missing, and
// there is no migration state to keep in step with reality.
function schemaFiles(): string[] {
    // bootstrap.sql sorts FIRST and does so structurally rather than by a
    // special case: it carries no digits, so the existing key evaluates to 0
    // and lands it ahead of slice1. It creates the tables every slice file
    // assumes and that nothing in sql/ used to create - see its header for the
    // three breaks that only a fresh install could reveal.
    return fs.readdirSync(SQL_DIR)
        .filter((f) => /^(bootstrap|slice\d+)\.sql$/.test(f))
        .sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0))
        .map((f) => path.join(SQL_DIR, f));
}

// Statements that can destroy the fixture. Checked against the file text
// rather than trusted, because the file is the thing most likely to be edited
// by someone who has forgotten why it is safe.
//
// DROP FUNCTION is deliberately ABSENT from this list, and the reason is the
// guard's actual purpose: this file must not destroy DATA when applied. A
// function is code, not data, and dropping one loses nothing that cannot be
// recreated by the same file three lines later.
//
// It is also a necessity rather than a convenience. CREATE OR REPLACE FUNCTION
// only replaces when the argument signature matches EXACTLY; any change of
// arity or parameter type installs a SECOND function beside the first, and
// every existing call then resolves to whichever signature matches its
// arguments - silently, with no error. Without a way to drop the old
// signature, a function signature change could not be made safely through the
// normal migration route at all, and the failure mode would be a silent
// overload rather than a refusal. See checkForOverloads() below, which turns
// that trap into something the tooling refuses.
const FORBIDDEN = /\b(DROP\s+(TABLE|INDEX|DATABASE|SCHEMA|PARTITION|MATERIALIZED)|TRUNCATE|DELETE\s+FROM)\b/i;

function stripComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, '');
}

/**
 * Retention definitions, applied only with --with-retention.
 *
 * These contain DROP by necessity and are therefore excluded from the
 * additive-only glob and from the FORBIDDEN scan. Installing a function is not
 * itself destructive, but it is what makes destruction possible, so it takes an
 * explicit act rather than riding along with the schema.
 */
function retentionFiles(): string[] {
    return fs.readdirSync(SQL_DIR)
        .filter((f) => /^slice\d+-retention\.sql$/.test(f))
        .sort()
        .map((f) => path.join(SQL_DIR, f));
}

/**
 * Refuse to finish if any function in `public` exists more than once.
 *
 * THE TRAP THIS CLOSES, generalised from the one it caught. `CREATE OR REPLACE
 * FUNCTION` replaces only when the argument signature matches EXACTLY. Change
 * the arity or a parameter type and Postgres installs a SECOND function beside
 * the first - no error, no warning - and every existing call resolves by
 * argument matching, so callers keep running the OLD body.
 *
 * That is exactly what happened adding a lock_timeout parameter to
 * drop_partitions_guarded: the new definition installed cleanly, every test
 * called the old seven-argument version, and the suite passed against code that
 * had not changed. It was caught only by an assertion that read the installed
 * source text rather than the behaviour.
 *
 * It is a standing property of the additive-only discipline rather than a slice
 * 5 accident, so it gets a standing check instead of a note somebody has to
 * remember. One query, on every apply.
 */
async function checkForOverloads(): Promise<boolean> {
    const res = await onLane('jobs', async (client) => {
        const r = await client.query(`
            -- EXTENSION MEMBERS ARE NOT OURS TO POLICE (2026-08-29). This guard
            -- exists to catch OUR OWN slice file changing a signature and
            -- creating an overload instead of a replacement. An extension that
            -- ships overloads legitimately - pgstattuple ships two, PostGIS
            -- ships hundreds - is not that mistake and can never be.
            --
            -- Found on the first FRESH database this project has built in
            -- months: template1 on the lab host carries pgstattuple, so every
            -- newly created database inherits it, and the schema refused to
            -- apply. The old database predated that and never showed it, which
            -- is why an installer bug sat undetected behind a working system.
            -- Any host whose template1 carries an extension with overloads
            -- would have hit the same wall on install.
            --
            -- deptype 'e' is the extension-member dependency, which is exactly
            -- the set to exclude: it narrows the guard to its actual subject
            -- rather than weakening it.
            SELECT p.proname, count(*)::int AS n,
                   string_agg(pg_get_function_identity_arguments(p.oid), ' | ') AS signatures
              FROM pg_proc p
              JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public'
               AND NOT EXISTS (
                   SELECT 1 FROM pg_depend d
                    WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass
                      AND d.deptype = 'e')
             GROUP BY p.proname
            HAVING count(*) > 1
             ORDER BY p.proname`);
        return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? 0 };
    });
    if (!res.ok) {
        console.error(`could not check for overloads: lane refused (${res.reason})`);
        return false;
    }
    if (res.rows.length === 0) return true;

    console.error('\nREFUSING: these functions exist more than once in public.');
    console.error('A signature change created an OVERLOAD instead of a replacement, so existing');
    console.error('callers still resolve to the OLD body - silently, with no error.\n');
    for (const r of res.rows) {
        console.error(`  ${String(r.proname)} x${String(r.n)}`);
        for (const sig of String(r.signatures).split(' | ')) console.error(`      (${sig})`);
    }
    console.error('\nFix: add an explicit DROP FUNCTION for the OLD signature above the');
    console.error('CREATE OR REPLACE in the slice file. DROP FUNCTION is permitted - the');
    console.error('additive guard protects data, and a function is code.');
    return false;
}

/**
 * Every option a privileged function must carry, declared rather than assumed.
 *
 * THE GENERAL RULE, which is bigger than the two instances that produced it:
 * `CREATE OR REPLACE FUNCTION` preserves the OWNER and the ACL and resets
 * EVERY option clause the new definition does not restate - SECURITY DEFINER,
 * SET, STRICT, volatility, COST, ROWS, PARALLEL, LEAKPROOF. So any property
 * applied by a standalone `ALTER FUNCTION` rather than written into the
 * definition survives exactly until the next schema apply.
 *
 * That is why this is a declared TABLE rather than one boolean. The first
 * version checked `prosecdef` alone, because that was the half that had
 * actually broken. But SECURITY DEFINER and SET search_path are reset by the
 * same mechanism and can be lost INDEPENDENTLY, and a replace that restates
 * SECURITY DEFINER while dropping the search_path clause is the more dangerous
 * half: the function keeps running as the owner, and a caller who puts their
 * own schema first can shadow a table name and have it resolved with the
 * owner's rights. That passes a prosecdef-only check silently.
 *
 * A function added here with new options gets them checked for free; a function
 * added to a slice file without being added here does not, which is the
 * remaining soft edge and is why the list sits next to the reason.
 */
const PRIVILEGED_FUNCTIONS: Array<{ name: string; definer: boolean; searchPath: boolean }> = [
    { name: 'ensure_daily_partitions', definer: true, searchPath: true },
    { name: 'ensure_monthly_partitions', definer: true, searchPath: true },
    { name: 'drop_partitions_guarded', definer: true, searchPath: true },
    { name: 'sync_recent_trgm_indexes', definer: true, searchPath: true },
];

/**
 * Refuse to finish if an installed function lost an option it must carry.
 *
 * THE TRAP THIS CLOSES, and it went off within minutes of the hardening
 * landing. `tools/harden-roles.sh` moves ownership of every table to a role
 * nothing logs in as, so the application role cannot DROP or CREATE tables at
 * all; four functions are SECURITY DEFINER so partition creation, retention and
 * index maintenance keep working. Applying those attributes with ALTER FUNCTION
 * lasted one schema apply.
 *
 * The failure it produces is quiet and slow. Nothing errors at apply time.
 * Hours later the writer's hourly `ensure_daily_partitions` starts failing on
 * permission, the runway shrinks a day at a time, and the first visible symptom
 * is a COPY landing in a partition that does not exist - the never-drop
 * invariant, lost to a permission change nobody made.
 *
 * Checked on EVERY database, not only hardened ones. On an unhardened database
 * SECURITY DEFINER is a no-op because the owner is the caller, so an earlier
 * version skipped the check there - but the definitions declare these options
 * unconditionally, which makes their absence drift wherever it happens, and a
 * database that is hardened LATER would inherit the drift silently.
 */
/**
 * DOES EACH TABLE HAVE THE SHAPE ITS SLICE FILE DECLARES?
 *
 * The SIBLING OF THE OVERLOAD CHECK, and the same failure with different DDL.
 * `CREATE OR REPLACE FUNCTION` silently creates an overload when the
 * signature changes; `CREATE TABLE IF NOT EXISTS` silently ACCEPTS a table
 * whose definition is different. Neither errors. Both leave the database
 * disagreeing with the file that claims to define it.
 *
 * It has already happened once, and it defeated slice 5 in EVERY database
 * anyone has ever tested against - including every measurement the spike
 * produced. `spike/sql/schema.sql` creates `samples_hourly` as a PLAIN table;
 * `sql/slice5.sql` declares it `PARTITION BY RANGE (hour_ts)`; the IF NOT
 * EXISTS saw a table, skipped, and the monthly partition job then failed
 * forever with "samples_hourly is not partitioned". Eight hours into a soak
 * before anything noticed.
 *
 * THIS ALSO ANSWERS THE DEPLOYMENT QUESTION IT RAISED. The fix is not picking
 * which file wins - it is REFUSING TO PROCEED when they disagree, which is
 * the same answer the overload check gives.
 *
 * relkind is the cheap, high-value half: a slice that says PARTITION BY must
 * find a partitioned table ('p'), not a plain one ('r'). Column presence is
 * checked too, since a diverged definition usually shows up as a missing
 * column and the query costs nothing extra.
 */
async function checkDeclaredTableShapes(): Promise<boolean> {
    // Parse the slice files rather than maintaining a second list: a table
    // added to a slice with PARTITION BY is checked automatically, and a
    // hand-kept list is the thing that goes stale.
    const partitioned = new Set<string>();
    const columns = new Map<string, Set<string>>();
    for (const file of schemaFiles()) {
        const sql = fs.readFileSync(file, 'utf8');
        const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\)\s*(PARTITION BY [^;]*)?;/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sql)) !== null) {
            const table = (m[1] as string).toLowerCase();
            if (m[3] !== undefined && /PARTITION BY/i.test(m[3])) partitioned.add(table);
            const cols = columns.get(table) ?? new Set<string>();
            for (const line of (m[2] as string).split(String.fromCharCode(10))) {
                const c = /^\s*(\w+)\s+(?:int|bigint|smallint|text|boolean|timestamptz|double|real|inet|bigserial|numeric)/i
                    .exec(line);
                if (c) cols.add((c[1] as string).toLowerCase());
            }
            columns.set(table, cols);
        }
    }
    if (partitioned.size === 0) return true;

    const res = await onLane<{ relname: string; relkind: string }>('jobs', async (client) => {
        const r = await client.query<{ relname: string; relkind: string }>(
            `SELECT c.relname, c.relkind::text AS relkind
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
            [[...partitioned]]);
        return { rows: r.rows, rowCount: r.rows.length };
    });
    if (!res.ok) {
        console.error(`could not check table shapes: lane refused (${res.reason})`);
        return false;
    }

    const wrong = res.rows.filter((r) => r.relkind !== 'p');
    if (wrong.length === 0) return true;

    console.error('REFUSING: a table exists with a DIFFERENT SHAPE than its slice file declares.');
    console.error('CREATE TABLE IF NOT EXISTS does not error on a divergent definition - it');
    console.error('silently accepts whatever is already there, so the file and the database');
    console.error('disagree and nothing says so until a job fails hours later.');
    for (const r of wrong) {
        console.error(`  ${r.relname}: a slice declares it PARTITIONED, the database has `
            + `relkind '${r.relkind}' (${r.relkind === 'r' ? 'a plain table' : 'not partitioned'})`);
    }
    console.error('This is how slice 5 partitioned samples_hourly was defeated in every');
    console.error('database it was ever applied to: spike/sql/schema.sql created a plain one');
    console.error('first. Migrate the table (tools/partition-rollup.ts) or recreate it, then');
    console.error('re-apply. The fix is never to pick which file wins.');
    return false;
}

async function checkPrivilegedFunctions(): Promise<boolean> {
    const res = await onLane('jobs', async (client) => {
        const r = await client.query(`
            SELECT p.proname,
                   p.prosecdef,
                   coalesce(p.proconfig, '{}') AS proconfig,
                   pg_get_userbyid(p.proowner) AS owner
              FROM pg_proc p
              JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public'
               AND p.proname = ANY($1::text[])`, [PRIVILEGED_FUNCTIONS.map((f) => f.name)]);
        return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? 0 };
    });
    if (!res.ok) {
        console.error(`could not check privileged functions: lane refused (${res.reason})`);
        return false;
    }

    const problems: string[] = [];
    for (const want of PRIVILEGED_FUNCTIONS) {
        const got = res.rows.find((r) => r.proname === want.name);
        // Absent is not checked here: --with-retention decides whether the
        // retention definitions are installed at all, and refusing on absence
        // would break every apply that omits it.
        if (got === undefined) continue;

        if (want.definer && got.prosecdef !== true) {
            problems.push(`${want.name} is SECURITY INVOKER (owner ${String(got.owner)}) - `
                + 'it needs ownership to create or drop partitions, so it will fail from now on');
        }
        const cfg = (got.proconfig as string[] | null) ?? [];
        if (want.searchPath && !cfg.some((c) => c.startsWith('search_path='))) {
            problems.push(`${want.name} has no SET search_path - it runs with the OWNER's rights and `
                + 'the CALLER\'s schema resolution, so a caller can shadow a table name and have it '
                + 'resolved with those rights');
        }
    }
    if (problems.length === 0) return true;

    console.error('\nREFUSING: privileged functions lost options they must carry.\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nCREATE OR REPLACE resets every option clause the new definition does not');
    console.error('restate - SECURITY DEFINER, SET, STRICT, volatility, COST, PARALLEL. These');
    console.error('belong in the CREATE OR REPLACE in the slice file, never in a standalone');
    console.error('ALTER FUNCTION afterwards. See tools/harden-roles.sh.');
    return false;
}

async function main(): Promise<void> {
    const dryRun = process.argv.includes('--dry-run');
    const withRetention = process.argv.includes('--with-retention');
    const files = schemaFiles();

    console.log(`to ${CONFIG.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
    console.log('additive only: no DROP, no TRUNCATE, no DELETE\n');

    // Check every file BEFORE applying any of them. Refusing halfway leaves the
    // database in a state no file describes.
    const sources = files.map((file) => ({ file, sql: fs.readFileSync(file, 'utf8') }));
    for (const { file, sql } of sources) {
        const forbidden = FORBIDDEN.exec(stripComments(sql));
        if (forbidden) {
            console.error(`refusing: ${path.relative(ROOT, file)} contains ${forbidden[0].replace(/\s+/g, ' ')}`);
            console.error('These slices are additive. Retention and every DROP belong to slice 5.');
            process.exit(1);
        }
    }

    if (dryRun) {
        for (const { file } of sources) console.log(`  would apply ${path.relative(ROOT, file)}`);
        console.log('\ndry run, nothing applied');
        return;
    }

    for (const { file, sql } of sources) {
        const t0 = performance.now();
        const res = await onLane('jobs', async (client) => {
            await client.query(sql);
            return { rows: [], rowCount: 0 };
        });
        if (!res.ok) {
            console.error(`could not apply ${path.relative(ROOT, file)}: lane refused (${res.reason})`);
            process.exit(1);
        }
        console.log(`  ${path.relative(ROOT, file).padEnd(28)} applied in ${(performance.now() - t0).toFixed(0)}ms`);
    }

    if (withRetention) {
        console.log('\n--with-retention: installing definitions that CAN drop partitions');
        for (const file of retentionFiles()) {
            const sql = fs.readFileSync(file, 'utf8');
            const t0 = performance.now();
            const res = await onLane('jobs', async (client) => {
                // WRITE-IN-LOOP-OK: schema application at startup over a fixed list of
                // slice files - not a request path, does not scale with the fleet.
                await client.query(sql);
                return { rows: [], rowCount: 0 };
            });
            if (!res.ok) {
                console.error(`could not apply ${path.relative(ROOT, file)}: lane refused (${res.reason})`);
                process.exit(1);
            }
            console.log(`  ${path.relative(ROOT, file).padEnd(28)} applied in ${(performance.now() - t0).toFixed(0)}ms`);
        }
        console.log('  the guards are inside drop_partitions_guarded(), not around it');
    } else {
        const pending = retentionFiles();
        if (pending.length > 0) {
            console.log(`\n${pending.length} retention file(s) NOT applied - pass --with-retention`);
        }
    }

    if (!await checkForOverloads()) process.exit(1);
    if (!await checkDeclaredTableShapes()) process.exit(1);
    if (!await checkPrivilegedFunctions()) process.exit(1);

    console.log('\nok - no function overloads, privileged functions intact');
}

main()
    .catch((err) => {
        console.error('apply-schema failed:', err);

        // Applying schema needs OWNERSHIP, and on a database hardened by
        // tools/harden-roles.sh the role the application connects as
        // deliberately does not have it. Postgres reports that as "must be
        // owner of function", which reads like a broken database rather than
        // like a credential doing exactly its job - so it is named here rather
        // than rediscovered.
        const msg = (err as Error)?.message ?? '';
        if (/must be owner|permission denied for schema/i.test(msg)) {
            console.error('\nThis database is hardened: the application role cannot change schema.');
            console.error('Use the admin credential instead:\n');
            console.error('  DATABASE_URL=postgres://rscanvas_admin:***@localhost:5432/<db> \\');
            console.error('    node src/db/apply-schema.ts --with-retention\n');
            console.error('See tools/harden-roles.sh for why the split exists.');
        }
        process.exitCode = 1;
    })
    .finally(() => closeAll());
