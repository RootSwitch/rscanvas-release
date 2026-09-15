// Hot queries and the indexes they stand on, as a MANIFEST verified against
// sql/ - deliberately not a SQL parser.
//
// The class this guards (2026-09-01 review finding, store F6): the hourly
// ping prune ran `DELETE ... WHERE ts <` against a table whose only index
// was (device_id, ts) - the schema's own comment promised "an indexed
// delete by age" and the index that would make it one did not exist, for
// tens of millions of rows on the lane with no statement timeout. Nothing
// connected the query to its support, so nothing noticed the support was
// missing.
//
// WHY A MANIFEST AND NOT A PARSER, recorded because the review sketched the
// parser: a static matcher that reads WHERE clauses and guesses index
// applicability sits below planner fidelity, and its false positives would
// earn it the exception-then-ignored death P2 documented. A manifest is the
// honest floor: each entry NAMES a hot access path, the index (by its
// literal CREATE line substring) that serves it, and why - so deleting or
// renaming that index breaks the build with the reason in hand, and a
// DEFERRED entry turns "no index" from an accident into a recorded
// decision. New hot paths are added by hand, which is the point: the
// author of a query is the one person who knows it is hot.
//
//   node tools/check-index-manifest.mjs --self-test
//   node tools/check-index-manifest.mjs --check sql
//
// eslint-style disable: none needed - pure string containment.

import fs from 'node:fs';
import path from 'node:path';

// Each `needs` string must appear VERBATIM (whitespace-insensitively) in
// some file under sql/. Substrings of the CREATE line, not full statements,
// so cosmetic reflow does not fail the build while a column-list change
// does.
export const MANIFEST = [
    {
        path: 'prunePingSamples: hourly DELETE by bare ts on the no-timeout jobs lane',
        needs: 'ping_samples_ts_idx ON ping_samples (ts)',
        why: 'slice48: without it, an hourly full-table scan of ~tens of millions of rows (store F6)',
    },
    {
        path: 'ping charts and the device page: one device over a window',
        needs: 'ping_samples_device_ts_idx ON ping_samples (device_id, ts DESC)',
        why: 'slice36: every read is one device over a window',
    },
    {
        path: 'the alert scan: one open row per alert_key, read whole every cycle',
        needs: 'alerts_open_key',
        why: 'slice6: the partial unique index IS the identity model - alerts are mutable state',
    },
    {
        path: 'syslog search: structured host filter before the fragment',
        needs: 'messages_host_ts_idx ON messages (host, ts DESC)',
        why: 'the Loki model - btree filters first, trigram last over survivors',
    },
    {
        path: 'syslog search: source-ip filter',
        needs: 'messages_source_ip_idx ON messages (source_ip, ts DESC)',
        why: 'same rung of the search ladder',
    },
    {
        path: 'device add and rename: names are identity',
        needs: 'devices_name_idx ON devices (name)',
        why: 'the sysName-collision refusal and the rename clash check both stand on this unique index',
    },
    {
        path: 'entity discovery upserts: (device, kind, index) is the natural key',
        needs: 'entities_device_kind_index_idx',
        why: 'the ON CONFLICT backstop that stopped one bad sensor pair 500-ing a whole onboarding batch',
    },
    {
        path: 'board projection and roster joins: entities by device',
        needs: 'entities_device_idx ON entities (device_id)',
        why: 'every per-device read fans through it',
    },
    {
        path: 'boardProjection laterals, the roster alarm column, and rename: open alerts by host',
        needs: 'alerts_host_open_idx ON alerts (host)',
        why: 'slice51 (easy-win E12): three readers rode a seq scan that multiplies by board size at the ceiling',
    },
    {
        // The DEFERRED entry that closes review finding F12's documentation
        // half: ops.ts once said "structured filters, all indexed" while
        // slice7 deliberately deferred the app index "by measurement" and
        // the measurement never happened. Recording the deferral HERE makes
        // it a decision with a place to be revisited, not a comment that
        // outlived its plan.
        path: "syslog search: the app: filter walks the ts index for the whole window",
        deferred: 'slice7 defers (app, ts) until measured against real volume - the 2026-07 measurement never ran; '
            + 'revisit with the flap report or the first operator complaint about app: latency',
    },
];

export function verify(manifest, sqlText) {
    const squash = (s) => s.replace(/\s+/g, ' ');
    const hay = squash(sqlText);
    const missing = [];
    for (const m of manifest) {
        if (m.deferred !== undefined) continue;
        if (!hay.includes(squash(m.needs))) missing.push(m);
    }
    return missing;
}

function check(dir) {
    const sqlText = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
    const missing = verify(MANIFEST, sqlText);
    for (const m of missing) {
        console.error(`  MISSING support for: ${m.path}\n    needs: ${m.needs}\n    why: ${m.why}`);
    }
    if (missing.length > 0) { console.error(`FAIL - ${missing.length} hot path(s) unsupported`); process.exit(1); }
    const deferred = MANIFEST.filter((m) => m.deferred !== undefined).length;
    console.log(`ok - every manifest hot path has its index (${MANIFEST.length - deferred} verified, `
        + `${deferred} deferred by recorded decision)`);
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };

    const sql = 'CREATE INDEX IF NOT EXISTS a_ts_idx ON a (ts);\nCREATE INDEX b ON b (x,\n    y DESC);';
    // The planted defect is the F6 shape: the prune's index deleted.
    const m1 = [{ path: 'prune', needs: 'a_ts_idx ON a (ts)', why: 'w' }];
    if (verify(m1, sql).length === 0) ok('a present index verifies');
    else bad('missed a present index');
    const m2 = [{ path: 'prune', needs: 'gone_idx ON a (ts)', why: 'w' }];
    if (verify(m2, sql).length === 1) ok('a deleted index is caught with its why in hand');
    else bad('missed the deletion');
    const m3 = [{ path: 'x', needs: 'b ON b (x, y DESC)', why: 'w' }];
    if (verify(m3, sql).length === 0) ok('reflowed whitespace is not a schema change');
    else bad('whitespace false positive');
    const m4 = [{ path: 'app', deferred: 'until measured' }];
    if (verify(m4, sql).length === 0) ok('a DEFERRED entry is a recorded decision, not a failure');
    else bad('deferred entry failed');

    console.log(`${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--check') check(process.argv[3] ?? 'sql');
else { console.error('usage: check-index-manifest.mjs --self-test | --check <dir>'); process.exit(2); }
