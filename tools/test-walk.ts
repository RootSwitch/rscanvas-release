// The walk's termination guarantees, against the SHIPPED walk() driven by a
// fake net-snmp session - no network, no agent, no database.
//
// AUDIT-2026-09-01 finding 1 demonstrated that the row cap's stop signal
// could not fire on the failure mode that leaks a poll slot: `out` is keyed
// by OID suffix, so a cycling or non-advancing agent re-delivers suffixes
// the map already holds, size never grows, and the walk ran 100,000 batches
// without stopping. The audit replicated the feed-callback loop body to
// show it; this suite drives the real function, so the demonstration cannot
// drift from the code it indicts.
//
//   node tools/test-walk.ts

import { walk, type Session } from '../src/collector/snmp.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

const BASE = '1.3.6.1.2.1.2.2.1.2';
const vb = (suffix: string): { oid: string; type: number; value: unknown } =>
    ({ oid: `${BASE}.${suffix}`, type: 4, value: `if-${suffix}` });

/** A fake session whose subtree feeds batches from a generator until the
 *  feed callback returns true or the generator ends. `done` then fires with
 *  no error, exactly net-snmp's contract. A batch budget guards the suite
 *  itself: a regression to never-stopping must fail the assertion, not hang
 *  npm test. */
function fakeSession(batches: () => Generator<Array<{ oid: string; type: number; value: unknown }>>,
    opts: { neverDone?: boolean } = {}): { session: Session; batchesFed: () => number } {
    let fed = 0;
    const session: Session = {
        close: () => { /* nothing to close */ },
        lastError: null,
        v3Level: null,
        inner: {
            subtree: (
                _oid: string,
                feed: (v: Array<{ oid: string; type: number; value: unknown }>) => boolean | void,
                done: (err: Error | null) => void,
            ): void => {
                void (async () => {
                    for (const batch of batches()) {
                        fed++;
                        if (fed > 5000) return;   // the suite's own belt
                        if (feed(batch) === true) break;
                        // Yield the loop so the deadline timer can fire in
                        // the never-done case.
                        await new Promise((r) => setImmediate(r));
                    }
                    if (!opts.neverDone) done(null);
                })();
            },
        },
    };
    return { session, batchesFed: () => fed };
}

async function main(): Promise<void> {
    console.log('the walk terminates, on every misbehaviour that was measured\n');
    // A SILENT EARLY EXIT IS A FAILURE, enforced rather than hoped: walk()'s
    // deadline timer is unref'd (right for the worker, which must not be
    // held open by an abandoned walk at shutdown), so in a process with
    // nothing else alive the loop can empty and node exits mid-suite - this
    // file's first run printed four ok lines and exited 0 with no verdict,
    // and a PLANTED regression did the same. exitCode starts at 1 and only
    // the verdict line at the bottom hands back 0; the keepalive makes the
    // normal path deterministic rather than a race with the last timer.
    process.exitCode = 1;
    const keepalive = setTimeout(() => { /* the verdict owns the exit */ }, 60_000);

    {
        // Healthy: three batches of fresh suffixes, then the natural end.
        const f = fakeSession(function* () {
            yield [vb('1'), vb('2')];
            yield [vb('3')];
        });
        const rows = await walk(f.session, BASE, 5000, 1000);
        if (rows.size === 3 && rows.get('2') === 'if-2') ok('a healthy walk collects and completes');
        else bad('healthy walk broke', [...rows.entries()]);
    }
    {
        // Oversized: unique suffixes forever. The cap stops it.
        const f = fakeSession(function* () {
            let i = 0;
            for (;;) { yield [vb(String(++i))]; }
        });
        const rows = await walk(f.session, BASE, 50, 5000);
        if (rows.size === 50) ok('an oversized table stops AT the cap');
        else bad('cap did not bind', rows.size);
        if (f.batchesFed() <= 51) ok('and stops ISSUING batches there - time, not just memory');
        else bad('the walk kept pulling past the cap', f.batchesFed());
    }
    {
        // CYCLING: the audit's smoking gun. 24 suffixes re-delivered forever;
        // before the progress guard this ran its full batch budget with
        // size pinned at 24 and the cap never tripping.
        const f = fakeSession(function* () {
            for (;;) {
                for (let i = 0; i < 24; i += 4) {
                    yield [vb(String(i)), vb(String(i + 1)), vb(String(i + 2)), vb(String(i + 3))];
                }
            }
        });
        const rows = await walk(f.session, BASE, 5000, 5000);
        if (rows.size === 24) ok('a cycling agent is stopped with the partial rows kept');
        else bad('cycling walk wrong size', rows.size);
        if (f.batchesFed() === 7) ok('at its FIRST repeated batch, not after a budget');
        else bad('cycle detection was late', f.batchesFed());
    }
    {
        // NON-ADVANCING: one suffix, forever. Size pins at 1.
        const f = fakeSession(function* () {
            for (;;) { yield [vb('1')]; }
        });
        const rows = await walk(f.session, BASE, 5000, 5000);
        if (rows.size === 1 && f.batchesFed() === 2) {
            ok('a non-advancing agent is stopped at its second batch');
        } else bad('non-advancing walk ran on', { size: rows.size, batches: f.batchesFed() });
    }
    {
        // PAST THE END OF THE TREE (DEMO-FLEET-PLAN section 11): an agent
        // that answers with NoSuchInstance at the requested oid, forever.
        // Error varbinds are skipped without counting as data, so the
        // progress guard above never saw these batches and the walk spun
        // to its deadline - measured by RSFleet at 25 batches in 32ms with
        // no progress. Now it stops at the second empty batch, with what it
        // had, through the ordinary resolve path.
        const noSuch = { oid: BASE, type: 129, value: null };   // ObjectType.NoSuchInstance
        const f = fakeSession(function* () {
            yield [vb('1'), vb('2')];
            for (;;) { yield [noSuch, noSuch, noSuch]; }
        });
        const t0 = performance.now();
        const rows = await walk(f.session, BASE, 5000, 5000);
        const ms = performance.now() - t0;
        if (rows.size === 2 && f.batchesFed() === 3 && ms < 1000) {
            ok('an agent answering NoSuchInstance past its tree is stopped at the second empty batch, rows kept');
        } else bad('the past-the-end loop ran on', { size: rows.size, batches: f.batchesFed(), ms: Math.round(ms) });
    }
    {
        // And ONE empty batch is not a stall: a walk whose last batch is a
        // lone endOfMibView ends through done() exactly as before.
        const f = fakeSession(function* () {
            yield [vb('1')];
            yield [{ oid: BASE, type: 130, value: null }];   // ObjectType.EndOfMibView
        });
        const rows = await walk(f.session, BASE, 5000, 5000);
        if (rows.size === 1 && f.batchesFed() === 2) ok('a single trailing error batch is a normal end, not a stall');
        else bad('a normal end was misread', { size: rows.size, batches: f.batchesFed() });
    }
    {
        // THE HANG the probe measured: no callbacks at all, done never
        // fires. Only the deadline can end this one, and it must REJECT as
        // a timeout - a poll cannot fabricate interfaces from silence.
        const f = fakeSession(function* () { /* feeds nothing */ }, { neverDone: true });
        const t0 = performance.now();
        try {
            await walk(f.session, BASE, 5000, 200);
            bad('a silent walk resolved');
        } catch (err) {
            const ms = performance.now() - t0;
            if ((err as { kind?: string }).kind === 'timeout' && ms >= 180 && ms < 2000) {
                ok(`a walk with no answers at all is ENDED by the deadline (${Math.round(ms)}ms), as a timeout`);
            } else bad('wrong rejection', { kind: (err as { kind?: string }).kind, ms });
        }
    }
    {
        // Error varbinds alone are not progress AND not a cycle verdict: a
        // batch with no real data reaches no conclusion, and the natural
        // done ends the walk.
        const errVb = { oid: `${BASE}.9`, type: 129, value: null };
        const orig = await import('net-snmp');
        void orig; // isVarbindError decides; type 129 (noSuchObject) is an error varbind
        const f = fakeSession(function* () {
            yield [vb('1')];
            yield [errVb];
        });
        const rows = await walk(f.session, BASE, 5000, 1000);
        if (rows.size === 1) ok('an all-error batch neither stalls the verdict nor stores garbage');
        else bad('error varbinds mishandled', [...rows.entries()]);
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    clearTimeout(keepalive);
    process.exit(fail === 0 ? 0 : 1);
}

void main();
