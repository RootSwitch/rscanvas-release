// Two engines, one corpus, one question: do they MATCH THE SAME ROWS?
//
//   DATABASE_URL=...rscanvas_test node tools/test-engine-differential.ts
//
// WHY ROW SETS AND NOT SQL. The parent builds SQLite and this builds Postgres.
// Comparing generated SQL mismatches immediately for reasons that do not
// matter - different placeholders, different functions, different quoting. What
// can be compared is WHAT THE QUERY MATCHES: seed both with the same corpus,
// express the same user intent in each one's native form, and require the same
// rows back.
//
// That reaches the REWRITE surface. The free-set differentials
// (test-templates, test-rules) work by calling the parent's JavaScript
// directly, which only works for modules handed their data - about 11% of the
// parent server code. This works for anything that builds a query, which is
// most of the other 89%.
//
// --- WHY IT IS BUILT HERE, ON filter.js, AND NOT LATER ------------------------
//
// SESSION-NOTES' scanner rule: an instrument whose output is "here is
// everything of type X" must be validated against a KNOWN POSITIVE it is
// expected to find, because "found nothing" and "cannot see anything" are the
// same output. Two scanners in this project have already reported clean while
// seeing nothing.
//
// filter.js is the only module where the answer is already known. Two
// divergences were measured by hand before this existed:
//
//   1. CASE SENSITIVITY. SQLite's LIKE is case-insensitive for ASCII;
//      Postgres's is case-sensitive. Now fixed to ILIKE, so the harness must
//      report this as MATCHING - and the deliberately-regressed run below
//      proves it would have caught it.
//   2. FREE TEXT COLUMN SET. The parent searches msg OR host OR app OR
//      source_ip; the fork searched msg only. Host is now RESTORED, so the
//      hostname case must report as MATCHING; app and source_ip remain
//      deliberately out, so those two must still report as DIVERGENT. That
//      split is the point: the harness has to distinguish a divergence we
//      closed from two we chose to keep.
//
// If this harness cannot independently rediscover those, it cannot be trusted
// on a module where nobody knows the answer. The window to validate it closes
// the moment we move past filter.js, which is why it is built now.
//
// --- DECLARED DIVERGENCES, NOT TOLERATED ONES ---------------------------------
//
// Where the engines legitimately differ, the difference must be DECLARED with a
// reason. A new divergence fails; a known one passes and prints its reason.
// Without that it degrades into a list of exceptions nobody reads, which is how
// a suppression file becomes a place bugs go to live.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';
import { parseQuery } from '../src/search/grammar.ts';
import type { SearchFilters } from '../src/store/index.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

// The parent's builder, copied beside the run rather than vendored. Postgres
// listens on localhost only, so this has to execute on the lab, where the
// parent tree does not exist - PARENT_FILTER_JS names the copy.
const PARENT_FILTER = process.env.PARENT_FILTER_JS
    || 'C:/Workspace/syslogcanvas/SyslogCanvas/server/filter.js';

// THE COPY IS PINNED, because the parents are still maintained.
//
// Without this the harness compares against a snapshot that may no longer
// exist upstream and reports agreement WITH THE PAST - an instrument quietly
// measuring the wrong thing, which is the failure this whole thread was about.
// The hash is printed on every run, so a stale reference is visible in the
// output rather than invisible in a file.
//
// Re-pin deliberately when the parent's filter genuinely changes: run the
// differential, decide whether the change should be adopted here, then update
// both constants in the same commit as that decision.
const PINNED = {
    repo: 'SyslogCanvas',
    /** Repo HEAD when this copy was taken. */
    commit: '5724219',
    /** Last commit that touched server/filter.js. */
    fileCommit: '9b83911',
    /** sha256 of server/filter.js at that commit, first 16 hex. */
    sha256: 'fdea8adf09e7bb49',
};

// node:sqlite rather than better-sqlite3, so this adds no dependency to the
// fork. It embeds the same SQLite, and the first assertion below CHECKS that
// rather than assuming it: if this engine were not case-insensitive the whole
// comparison would be against the wrong baseline.
const HOST_TAG = `eng-${process.pid}`;

/**
 * The corpus. Each message is unique, so the message text IS the row identity
 * and no id mapping between engines is needed.
 */
const CORPUS: Array<{ host: string; app: string; procid?: string; ip: string; msg: string }> = [
    { host: 'core-sw', app: 'kernel', ip: '10.0.0.1', msg: 'Error: disk full' },
    { host: 'core-sw', app: 'kernel', ip: '10.0.0.1', msg: 'error: link flap' },
    { host: 'edge-rtr', app: 'bgp', ip: '10.0.0.2', msg: 'ERROR: peer reset' },
    { host: 'edge-rtr', app: 'bgp', ip: '10.0.0.2', msg: 'session established' },
    { host: 'ups-1', app: 'apcupsd', ip: '110.0.0.7', msg: '100% used on battery' },
    { host: 'ups-1', app: 'apcupsd', ip: '110.0.0.7', msg: '100X used on battery' },
    { host: 'app-01', app: 'sshd', ip: '10.0.0.9', msg: 'user_1 logged in' },
    { host: 'app-01', app: 'sshd', ip: '10.0.0.9', msg: 'userA1 logged in' },
    // A host and an app that CONTAIN another one's name. Without these the
    // corpus cannot tell a substring match from an exact match, and the host
    // and app cases passed on luck rather than on agreement.
    { host: 'core-sw-2', app: 'bgpd', ip: '10.0.0.3', msg: 'secondary switch up' },
    // The SAME app in BOTH wire forms - bare and tag[pid]. Without this row
    // the corpus could not tell 'app matched every sshd' from 'app matched
    // only the sshd lines logged without a procid', and the harness agreed
    // vacuously on exactly the defect the procid split fixed: the fork's
    // parser used to flatten this row's app to 'sshd[1234]', so exact
    // app:sshd returned SOME sshd rows and the partial answer read as
    // complete. Same fixture failure as the /16 that was not in the corpus.
    // Each engine seeds it in its own native representation below: the
    // parent's parser concatenates (app = 'sshd[1234]'), the fork's splits.
    { host: 'app-01', app: 'sshd', procid: '1234', ip: '10.0.0.9', msg: 'userB2 logged in from pid form' },
];

/** A divergence that is expected, with the reason it is acceptable. */
interface Declared { intent: string; reason: string }

const DECLARED: Declared[] = [
    {
        intent: 'free text matching an APP NAME',
        reason: 'The parent free text searches app; the fork does not. Deliberate: app has a '
            + 'structured filter (app:bgp), typing a bare app name into free text is rare, and '
            + 'a trigram index on app would be carried on every partition to serve it. '
            + 'Declared so it fails the day it changes for any other reason.',
    },
    {
        intent: 'free text matching an IP ADDRESS',
        reason: 'The parent free text substring-matches source_ip, so "10.0.0." also matches '
            + '110.0.0.7. The fork uses source_ip <<= inet, which is real subnet containment '
            + 'and STRICTLY BETTER; pulling source_ip into free text would reintroduce the '
            + 'weaker behaviour. Declared, and the corpus carries 110.0.0.7 precisely so this '
            + 'case shows the parent over-matching rather than merely differing.',
    },
    {
        intent: 'host filter',
        reason: 'FOUND BY THIS HARNESS 2026-07-27, DECIDED same day. The parent matches '
            + '"host:sw1" as a SUBSTRING; the fork does host = $1, exact - which is a btree '
            + 'lookup and is ALSO what admits free text outside the trigram window, so '
            + 'substring-by-default would rest that rule on an unindexed predicate. The '
            + 'decision is TWO OPERATORS: host: exact, host~ substring, landing with the '
            + 'search grammar; plus the zero-result guidance requirement on the UI. Until '
            + 'the grammar exists this divergence must keep occurring. MIGRATION-NOTES 2, '
            + 'SLICE-6-PLAN for the reasoning.',
    },
    {
        intent: 'app filter',
        reason: 'Same decision as host: exact now, app~ when the grammar lands - extended '
            + 'to app for CONSISTENCY although no admission rule rests on it, because '
            + 'someone who learns host: is exact will assume app: is. MIGRATION-NOTES 2.',
    },
    {
        intent: 'NEGATION, and it must keep NULL-app rows',
        reason: 'The exact/substring decision showing through NOT, and this is where it '
            + 'surprises most: in the parent, -app:bgp means "does not CONTAIN bgp" and drops '
            + 'the bgpd rows; in the fork it means "is not EXACTLY bgp" and keeps them. Same '
            + 'divergence as the app filter above, one operator further out. The convergent '
            + 'form is -app~bgp, which is the case immediately after this one - and it needs '
            + 'a device filter, because a negated substring can never use an index either.',
    },
];

interface Case {
    intent: string;
    /** What goes to the PARENT's filter.js. */
    q: string;
    /**
     * What goes to the fork. `fq` is a fork query string run through the
     * fork's own grammar - which is how a case says "the parent expressed it
     * this way, the fork expresses it that way, do they return the same
     * ROWS". `filters` is the older structured form, still used where no
     * grammar syntax is involved.
     */
    fq?: string;
    filters?: Omit<SearchFilters, 'from' | 'to'>;
}

const CASES: Case[] = [
    { intent: 'free text "error"', q: 'error', filters: { fragment: 'error' } },
    { intent: 'free text "ERROR" in capitals', q: 'ERROR', filters: { fragment: 'ERROR' } },
    { intent: 'free text with a literal percent', q: '100%', filters: { fragment: '100%' } },
    { intent: 'free text with a literal underscore', q: 'user_1', filters: { fragment: 'user_1' } },
    { intent: 'free text matching nothing', q: 'zzzznotpresent', filters: { fragment: 'zzzznotpresent' } },
    { intent: 'free text matching a HOSTNAME', q: 'core-sw', filters: { fragment: 'core-sw' } },
    { intent: 'free text matching an APP NAME', q: 'apcupsd', filters: { fragment: 'apcupsd' } },
    { intent: 'free text matching an IP ADDRESS', q: '10.0.0.', filters: { fragment: '10.0.0.' } },
    { intent: 'host filter', q: 'host:core-sw', filters: { host: 'core-sw' } },
    { intent: 'app filter', q: 'app:bgp', filters: { app: 'bgp' } },
    // MUST AGREE, and could not before the procid split: the fork's parser
    // used to store the pid row's app as 'sshd[1234]', so exact app:sshd
    // returned the two bare rows and silently missed the third - a partial
    // answer with no zero-result guidance to flag it, the one regression of
    // the exact-operator decision that returned MISLEADING data rather than
    // nothing. The parent's substring never had the problem. With app bare
    // and procid its own column, exact and substring coincide on this corpus
    // (no app contains 'sshd' without being it) and both engines must return
    // all three sshd rows.
    { intent: 'app filter finds BOTH procid forms', q: 'app:sshd', filters: { app: 'sshd' } },

    // --- THE CONVERGENCE CASES ------------------------------------------------
    //
    // These are the point of the whole grammar exercise. The parent's
    // substring host:/app: are DECLARED divergences above, because the fork's
    // colon form is exact - but the capability came back as its own operator,
    // and here it must match the parent ROW FOR ROW. A declared divergence
    // becoming a convergence at a named operator is the cleanest evidence
    // there is that the behaviour was restored rather than approximated.
    { intent: 'parent host: SUBSTRING == fork host~', q: 'host:core-sw', fq: 'host~core-sw' },
    // app~ ALWAYS needs a device filter (it is indexed on no partition), so
    // the fork side carries one - and the parent gets the same ip: term, which
    // is itself worth comparing: the parent's text-prefix LIKE '10.0.0.%' and
    // the fork's <<= 10.0.0.0/24 agree on this corpus, and the row that makes
    // them differ (110.0.0.7) is excluded by both. The FIRST version of this
    // case used `host~eng` as the device filter and the harness refused it -
    // which is the admission rule working: substring-class predicates can
    // never qualify, because narrowing by a scan is not narrowing.
    {
        intent: 'parent app: SUBSTRING == fork app~ (with the device filter app~ requires)',
        q: 'app:bgp ip:10.0.0.', fq: 'app~bgp ip:10.0.0.',
    },

    // The rest of the grammar, parent syntax on both sides.
    { intent: 'severity by name', q: 'sev:err', fq: 'sev:err' },
    { intent: 'severity with an operator', q: 'sev:<=5', fq: 'sev:<=5' },
    { intent: 'facility by name', q: 'fac:user', fq: 'fac:user' },
    { intent: 'proto', q: 'proto:syslog', fq: 'proto:syslog' },
    { intent: 'quoted phrase', q: '"disk full"', fq: '"disk full"' },
    { intent: 'two terms AND together', q: 'error disk', fq: 'error disk' },
    { intent: 'NEGATION, and it must keep NULL-app rows', q: '-app:bgp', fq: '-app:bgp' },
    // BOTH sides carry the ip: term. The first version put it only on the
    // fork side (where app~ requires it) and the harness reported a
    // divergence that was really two different questions: the 110.0.0.7 rows
    // are outside 10.0.0.0/24 and the parent, unfiltered, kept them.
    {
        intent: 'negation over the SUBSTRING form converges',
        q: '-app:bgp ip:10.0.0.', fq: '-app~bgp ip:10.0.0.',
    },
    { intent: 'negated free text', q: '-error', fq: '-error' },
    { intent: 'negation combined with a filter', q: 'error -host:edge-rtr', fq: 'error -host~edge-rtr' },
];

async function main(): Promise<void> {
    assertDestructiveTarget('test-engine-differential', CONFIG.databaseUrl);
    console.log('two-engine differential: same corpus, same intent, same rows?\n');

    if (!fs.existsSync(PARENT_FILTER)) {
        console.log('  skip: the parent filter.js is not reachable from here');
        console.log(`        (${PARENT_FILTER})`);
        console.log('\nSKIPPED - an absent comparison is not a matching one');
        process.exit(0);
    }

    // Identify what is actually being compared against, before comparing.
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(PARENT_FILTER)).digest('hex').slice(0, 16);
    console.log(`  compared against ${PINNED.repo} ${PINNED.commit} `
        + `(server/filter.js @ ${PINNED.fileCommit}, sha256 ${PINNED.sha256})`);
    if (actual !== PINNED.sha256) {
        bad(`THE PARENT COPY HAS CHANGED: sha256 ${actual}, pinned ${PINNED.sha256}. `
            + 'Every result below compares against a version this pin does not describe. '
            + 'Run the differential, decide whether the upstream change should be adopted '
            + 'here, then re-pin in the same commit as that decision.');
    } else {
        ok('the parent copy matches its pin, so the comparison is against a known version');
    }
    console.log('');

    const req = createRequire(import.meta.url);
    const filter = req(PARENT_FILTER) as { buildWhere: (q: string) => { sql: string; params: unknown[] } };
    const { DatabaseSync } = req('node:sqlite') as {
        DatabaseSync: new (p: string) => {
            exec: (s: string) => void;
            prepare: (s: string) => {
                run: (...a: unknown[]) => void;
                all: (...a: unknown[]) => Array<{ msg: string }>;
            };
            close: () => void;
        };
    };

    // --- SQLite side, the parent's schema and the parent's builder -----------
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, msg_ts INTEGER,
        source_ip TEXT NOT NULL, proto TEXT NOT NULL, facility INTEGER,
        severity INTEGER, host TEXT, app TEXT, msg TEXT NOT NULL, raw TEXT)`);
    const ins = db.prepare(
        `INSERT INTO messages (ts, source_ip, proto, facility, severity, host, app, msg, raw)
         VALUES (?, ?, 'syslog', 1, 5, ?, ?, ?, ?)`);
    const nowS = Math.floor(Date.now() / 1000);
    // The parent's parser concatenates tag and pid into app - that is what its
    // filter.js actually runs against, so the fixture reproduces it.
    for (const m of CORPUS) {
        ins.run(nowS, m.ip, m.host,
            m.procid !== undefined ? `${m.app}[${m.procid}]` : m.app, m.msg, m.msg);
    }

    // BASELINE CHECK, before any comparison. If this SQLite were not
    // case-insensitive, every "they agree" below would be measured against the
    // wrong reference and the harness would be confidently wrong.
    {
        const rows = db.prepare("SELECT msg FROM messages WHERE msg LIKE '%error%'")
            .all().map((r) => r.msg).sort();
        if (rows.length === 3) {
            ok('baseline: this SQLite LIKE is case-insensitive, matching 3 of Error/error/ERROR');
        } else {
            bad('BASELINE WRONG - this SQLite is not case-insensitive, so every comparison '
                + 'below is against the wrong reference', JSON.stringify(rows));
        }
    }

    const sqliteMatch = (q: string): string[] => {
        const w = filter.buildWhere(q);
        const sql = `SELECT msg FROM messages${w.sql ? ` WHERE ${w.sql}` : ''}`;
        return db.prepare(sql).all(...w.params).map((r) => r.msg).sort();
    };

    // --- Postgres side, the fork's schema and the fork's builder -------------
    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);

    // THE WHOLE `eng-%` NAMESPACE, not just this run's tag.
    //
    // The tag is per-pid so a crashed run's rows are identifiable, but cleaning
    // only this pid's rows is what let a crashed run poison the next one: every
    // free-text set came back doubled and six cases failed as "undeclared
    // divergence" when the divergence was the fixture. Loud, at least - but the
    // harness has no business reporting on the parent's filter when its own
    // corpus is wrong.
    //
    // Concurrent runs of this harness against one database are NOT supported,
    // and pretending otherwise is what cost the time.
    await onLane('jobs', async (c) => {
        // ADMISSION NOW READS pg_index, NOT A DATE WINDOW, so the free-text
        // cases need today's partition actually covered: msg's gin arrives
        // automatically (parent partitioned index), host's only via the sync,
        // which never runs against this database. Built here so this harness
        // does not depend on another test having run first - the covered
        // state is infrastructure the production sync maintains, recreated
        // per-database rather than assumed.
        const part = (await c.query<{ p: string }>(
            `SELECT 'messages_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD') AS p`)).rows[0]!.p;
        await c.query(`CREATE INDEX IF NOT EXISTS ${part}_host_trgm ON ${part} USING gin (host gin_trgm_ops)`);
        const stale = await c.query('DELETE FROM messages WHERE host LIKE $1', ['eng-%']);
        if ((stale.rowCount ?? 0) > 0) {
            console.log(`  note: removed ${stale.rowCount} stale row(s) left by a previous run`);
        }
        for (const m of CORPUS) {
            await c.query(
                `INSERT INTO messages (ts, source_ip, proto, facility, severity, host, app, procid, msg, raw)
                 VALUES (now(), $1::inet, 'syslog', 1, 5, $2, $3, $4, $5, $5)`,
                [m.ip, `${HOST_TAG}-${m.host}`, m.app, m.procid ?? null, m.msg]);
        }
        return { rows: [], rowCount: 0 };
    });

    // A CONTROL ON THE FIXTURE, before a single comparison. Both engines get
    // read below and the row TEXT is the identity, so a corpus that is doubled -
    // or short - produces confident nonsense in both directions.
    await onLane('jobs', async (c) => {
        const r = await c.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM messages WHERE host LIKE 'eng-%'");
        const n = Number(r.rows[0]?.n ?? -1);
        if (n === CORPUS.length) {
            ok(`fixture: the postgres corpus holds exactly ${n} row(s), as written`);
        } else {
            bad(`FIXTURE WRONG - ${n} row(s) in the harness namespace, expected `
                + `${CORPUS.length}. Every comparison below is against the wrong corpus.`);
        }
        return { rows: [], rowCount: 0 };
    });

    // Host-scoped intents are rewritten to carry the tag, which is a harness
    // detail and not a behavioural difference.
    const pgMatch = async (c: Case): Promise<string[]> => {
        let filters: SearchFilters;
        if (c.fq !== undefined) {
            // Host VALUES are tagged in the fork's corpus so concurrent runs
            // cannot collide, so a host-scoped query has to be rewritten the
            // same way the structured form is. A harness detail, not a
            // behavioural difference.
            const q = c.fq
                .replace(/host~/g, `host~${HOST_TAG}-`)
                .replace(/host:/g, `host:${HOST_TAG}-`);
            filters = { from, to, limit: 500, clauses: parseQuery(q) };
        } else {
            filters = { ...(c.filters ?? {}), from, to, limit: 500 };
            if (filters.host !== undefined) filters.host = `${HOST_TAG}-${filters.host}`;
        }

        // SCOPE EVERY QUERY TO THIS RUN'S NAMESPACE.
        //
        // The SQLite side is an in-memory database holding nothing but the
        // corpus, so it is isolated by construction. The Postgres side is a
        // SHARED disposable database that other tests write to - the alert
        // acceptance run leaves real notification messages in it - and until
        // the grammar cases arrived, every case happened to carry a fragment
        // or a host filter narrow enough to exclude them. That isolation was
        // ACCIDENTAL, and `sev:<=5`, `proto:syslog` and `-app:bgp` are broad
        // enough to find out: four cases failed on rows this harness never
        // wrote.
        //
        // Same shape as the corpus that could not tell exact from substring:
        // a fixture weaker than it looked, exposed only when a case finally
        // asked something of it. Scoping is explicit now rather than a
        // property of which cases happen to exist.
        filters.clauses = [
            ...(filters.clauses ?? []),
            { kind: 'host', op: 'substring', value: HOST_TAG, negate: false },
        ];
        const r = await OPS.searchMessages(filters);
        if (!('ok' in r) || r.ok !== true) throw new Error(`refused: ${JSON.stringify(r)}`);
        return (r.rows as Array<{ msg: string }>).map((x) => x.msg).sort();
    };

    try {
        let undeclared = 0;
        let declaredHit = 0;

        for (const c of CASES) {
            const a = sqliteMatch(c.q);
            const b = await pgMatch(c);
            const same = JSON.stringify(a) === JSON.stringify(b);
            const declared = DECLARED.find((d) => d.intent === c.intent);

            if (same && !declared) {
                ok(`${c.intent}: both engines match the same ${a.length} row(s)`);
            } else if (same && declared) {
                bad(`${c.intent}: DECLARED as divergent but the engines now AGREE - `
                    + 'delete the declaration, it is hiding nothing and will hide something later');
            } else if (!same && declared) {
                declaredHit++;
                ok(`${c.intent}: diverges, and it is DECLARED`);
                console.log(`         sqlite:   ${JSON.stringify(a)}`);
                console.log(`         postgres: ${JSON.stringify(b)}`);
                console.log(`         reason:   ${declared.reason.slice(0, 96)}...`);
            } else {
                undeclared++;
                bad(`${c.intent}: UNDECLARED DIVERGENCE`,
                    `\n         sqlite:   ${JSON.stringify(a)}\n         postgres: ${JSON.stringify(b)}`);
            }
        }

        if (undeclared === 0) ok('no undeclared divergence across the whole case set');
        if (declaredHit === DECLARED.length) {
            ok(`and all ${DECLARED.length} declared divergence(s) actually occurred - `
                + 'the declarations describe reality');
        } else {
            bad(`${DECLARED.length - declaredHit} declared divergence(s) did not occur`);
        }
    } finally {
        db.close();
        await onLane('jobs', async (c) => {
            await c.query('DELETE FROM messages WHERE host LIKE $1', ['eng-%']);
            return { rows: [], rowCount: 0 };
        });
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('engine differential failed:', err);
    void closeAll();
    process.exit(1);
});
