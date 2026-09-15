// What the search MATCHES, against a real database. Semantics, not SQL text.
//
//   DATABASE_URL=...rscanvas_test node tools/test-search-semantics.ts
//
// WHY THIS EXISTS, AND WHY IT COMPARES ROW SETS.
//
// The parent builds SQLite and this builds Postgres. Comparing generated SQL
// mismatches immediately for reasons that do not matter - different
// placeholders, different functions, different quoting. So the differential has
// to be on WHAT THE QUERY MATCHES: seed both engines with the same messages,
// run the same filter spec, and require the same rows back.
//
// That extends the differential technique past the free set. Anything that
// BUILDS A QUERY can be diffed by its result set even though its SQL must
// differ, which covers the rewrite surface - the 89% of parent modules that
// touch `db.js` - and not just the modules that are handed data.
//
// THE DEFECT THIS PINS. SQLite's LIKE is case-insensitive for ASCII; Postgres's
// LIKE is case-sensitive and ILIKE is the insensitive one. Measured on both,
// same four rows:
//
//   SQLite   LIKE  '%error%'  -> "Error: disk full", "error: disk full"
//   Postgres LIKE  '%error%'  -> "error: disk full"      <- the fork, before
//   Postgres ILIKE '%error%'  -> both                    <- the fork, after
//
// Same code, same intent, different engine, silently different behaviour, and
// no test on either side would have noticed because each is internally
// consistent. Second confirmed instance of the port changing behaviour; the
// first was the LIKE escaping, and both were found by comparing rather than
// reading.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const HOST = `sem-${process.pid}`;

/** Every message this test plants, with the property each one probes. */
const CORPUS = [
    'Error: disk full',        // capital E - the case-sensitivity probe
    'error: disk full',        // lower e
    'ERROR: disk full',        // all caps
    'link flap on Gi0/1',      // control: must never match "error"
    '100% used',               // the literal-percent probe
    '100X used',               // must NOT match a search for "100%"
    'user_1 logged in',        // the literal-underscore probe
    'userA1 logged in',        // must NOT match a search for "user_1"
];

async function main(): Promise<void> {
    // It INSERTs and DELETEs, so it belongs on a disposable database.
    assertDestructiveTarget('test-search-semantics', CONFIG.databaseUrl);
    console.log('search semantics: what the query MATCHES\n');

    const now = new Date();
    const from = new Date(now.getTime() - 3_600_000);
    const to = new Date(now.getTime() + 3_600_000);

    // The whole `sem-%` namespace, not just this pid's tag: a crashed run
    // otherwise leaves rows nothing will ever clean up, and the sibling
    // differential harness was caught reporting six false divergences against
    // exactly that.
    await onLane('jobs', async (c) => {
        await c.query('DELETE FROM messages WHERE host LIKE $1', ['sem-%']);
        for (const msg of CORPUS) {
            await c.query(
                `INSERT INTO messages (ts, host, app, proto, msg, raw)
                 VALUES (now(), $1, 'test', 'udp', $2, $2)`, [HOST, msg]);
        }
        // Two rows on two OTHER hosts, for the free-text-matches-hostname case.
        // Their messages deliberately contain no hostname at all, so a match
        // can only have come from the host column.
        for (const [h, msg] of [['core-sw', 'alpha reset'], ['edge-rtr', 'beta reset']]) {
            await c.query(
                `INSERT INTO messages (ts, host, app, proto, msg, raw)
                 VALUES (now(), $1, 'test', 'udp', $2, $2)`, [`${HOST}-${h}`, msg]);
        }
        return { rows: [], rowCount: 0 };
    });

    const search = async (fragment: string): Promise<string[]> => {
        const r = await OPS.searchMessages({ from, to, host: HOST, fragment, limit: 100 });
        if (!('ok' in r) || r.ok !== true) throw new Error(`search refused: ${JSON.stringify(r)}`);
        return (r.rows as Array<{ msg: string }>).map((x) => x.msg).sort();
    };

    /** Free text with NO host filter, which is what the search box sends. */
    const freeText = async (fragment: string): Promise<string[]> => {
        const r = await OPS.searchMessages({ from, to, fragment, limit: 100 });
        if (!('ok' in r) || r.ok !== true) throw new Error(`search refused: ${JSON.stringify(r)}`);
        return (r.rows as Array<{ msg: string }>).map((x) => x.msg).sort();
    };

    try {
        // --- CASE INSENSITIVITY, the defect ---------------------------------
        const errors = await search('error');
        const expected = ['ERROR: disk full', 'Error: disk full', 'error: disk full'].sort();
        if (JSON.stringify(errors) === JSON.stringify(expected)) {
            ok('searching "error" matches Error, error AND ERROR - the parent\'s behaviour on SQLite');
        } else {
            bad('case-insensitive search is broken - this is the LIKE/ILIKE engine difference',
                JSON.stringify(errors));
        }

        const upper = await search('ERROR');
        if (JSON.stringify(upper) === JSON.stringify(expected)) {
            ok('and searching "ERROR" matches the same three - insensitivity works both directions');
        } else {
            bad('searching in capitals returned a different set', JSON.stringify(upper));
        }

        if (!errors.includes('link flap on Gi0/1')) {
            ok('and the control row that contains no "error" is NOT matched');
        } else {
            bad('the search matched a row it should not have - it is not filtering at all');
        }

        // --- LIKE WILDCARDS STAY LITERAL, the first instance ----------------
        const pct = await search('100%');
        if (JSON.stringify(pct) === JSON.stringify(['100% used'])) {
            ok('searching "100%" matches the literal percent only, not "100X" - wildcards escaped');
        } else {
            bad('the % wildcard escaped - this is the defect the parent had right from its first commit',
                JSON.stringify(pct));
        }

        const und = await search('user_1');
        if (JSON.stringify(und) === JSON.stringify(['user_1 logged in'])) {
            ok('and "user_1" does not match "userA1" - the _ wildcard is escaped too');
        } else {
            bad('the _ wildcard escaped', JSON.stringify(und));
        }

        // --- FREE TEXT SEARCHES msg OR host -------------------------------
        //
        // The parent searched msg OR host OR app OR source_ip; the port searched
        // msg alone, so typing a hostname into the search box found nothing.
        // Restored for host on 2026-07-27 after measuring the index (19MB
        // against msg's 129MB, and the OR plans as a BitmapOr over both).
        //
        // The two rows this reads carry no hostname in their message text, so
        // the host column is the only thing that can produce a match.
        const byHost = await freeText(`${HOST}-core-sw`);
        if (JSON.stringify(byHost) === JSON.stringify(['alpha reset'])) {
            ok('free text matching a HOSTNAME finds that host, and only its message');
        } else {
            bad('free text does not search the host column - typing a hostname into the '
                + 'search box finds nothing, which is what the port silently lost',
                JSON.stringify(byHost));
        }

        if (!byHost.includes('beta reset')) {
            ok('and the other host is NOT matched - it is filtering, not returning everything');
        } else {
            bad('a hostname search returned rows belonging to a different host');
        }

        const noHost = await freeText(`${HOST}-nosuchhost`);
        if (noHost.length === 0) {
            ok('and a hostname that exists on no row matches nothing');
        } else {
            bad('a hostname matching no row returned rows', JSON.stringify(noHost));
        }

        // --- a trailing backslash must refuse, not throw ---------------------
        const r = await OPS.searchMessages({ from, to, host: HOST, fragment: 'C:\\', limit: 10 });
        if ('ok' in r && r.ok === true) {
            ok('a fragment ending in a backslash is a normal search, not a 500');
        } else {
            bad('a trailing backslash broke the query', JSON.stringify(r));
        }
    } finally {
        await onLane('jobs', async (c) => {
            await c.query('DELETE FROM messages WHERE host LIKE $1', ['sem-%']);
            return { rows: [], rowCount: 0 };
        });
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('search semantics failed:', err);
    void closeAll();
    process.exit(1);
});
