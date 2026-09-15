// Prove the retention guards refuse, before anything is trusted to drop.
//
//   node tools/test-retention-guards.ts
//
// This is the control that must fail. Every call below is expected to be
// REFUSED, and a call that succeeds is the failure - which is the opposite of
// most tests and the reason this one is written first.
//
// The precedent: spike/src/locktest.ts called this function's ancestor with
// keep_days = 0 to guarantee it had something to drop, and dropped all fourteen
// partitions - 158GB. Every dangerous call it could have made is made here,
// against the real tables, and must come back as an exception.
//
// WHAT KEEPS THIS FILE FROM BECOMING THE ACCIDENT IT TESTS FOR.
//
// The original claim here was "nothing here can drop anything even if a guard
// is broken: every call that could reach the drop loop passes dry_run = true".
// That stopped being true when the guard-4 sections were added below, which
// necessarily pass dry_run = false - guard 4 SKIPS rather than raises, so the
// only way to prove it did not drop the wide partition is to let the drop loop
// actually run. Two calls therefore reach a real DROP TABLE.
//
// Their safety used to be a function of the CALENDAR: the eligibility set was
// discovered by scanning samples_hourly with keep_days = 30, and guard 5 does
// not cover samples_hourly because that table is the rollup's OUTPUT. Today
// nothing real is 30 days expired. On 2026-09-01, samples_hourly_202607 ages
// past that cutoff and this test permanently destroys a month of rollup -
// which, past raw retention, is the only copy there is.
//
// So the horizon is not 30 days, it is FIXTURE_ONLY_KEEP_DAYS below: a cutoff
// in 1974 that the scan can never reach past however old the corpus grows.
// Combined with the disposable 1970-dated partitions the assertions run
// against, the scan is confined to tables this file created.
//
// Three properties, in the order they are relied on:
//
//   1. The horizon cannot intersect real data (FIXTURE_ONLY_KEEP_DAYS).
//   2. The process refuses to start against a protected database at all
//      (assertDestructiveTarget, layer 3).
//   3. The partition inventory is compared before and after, as an
//      independent check that reports a loss even if 1 and 2 both fail.

import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { assertDestructiveTarget } from '../src/safety.ts';
import { CONFIG } from '../src/config.ts';

/**
 * A retention horizon that can only ever reach 1970.
 *
 * 19,000 days puts the cutoff around 1974, so every partition this file drops
 * for real is one it created, and no future date can bring a real partition
 * inside it. The number is deliberately absurd: it is not a tuning value, it is
 * the statement that this scan must never intersect production data.
 *
 * It passes guard 1 (19000 >= the 7-day floor), which is the point - a horizon
 * can be made SAFER without being made illegal.
 */
const FIXTURE_ONLY_KEEP_DAYS = 19_000;

let pass = 0;
let fail = 0;

function ok(label: string): void { pass++; console.log(`  ok   ${label}`); }
function bad(label: string, detail?: unknown): void {
    fail++;
    console.log(`  FAIL ${label}`, detail === undefined ? '' : String(detail));
}

interface CallResult { refused: boolean; message: string; rows: Array<Record<string, unknown>> }

async function call(sql: string, values: unknown[]): Promise<CallResult> {
    try {
        const res = await onLane('jobs', async (client) => {
            const r = await client.query(sql, values);
            return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount ?? 0 };
        });
        if (!res.ok) return { refused: true, message: `lane refused: ${res.reason}`, rows: [] };
        return { refused: false, message: '', rows: res.rows as Array<Record<string, unknown>> };
    } catch (err) {
        return { refused: true, message: (err as Error).message, rows: [] };
    }
}

const GUARDED = `SELECT * FROM drop_partitions_guarded($1, $2, $3, $4, $5, $6, $7, $8)`;

/** Expect a refusal, and expect the message to explain which guard fired. */
async function expectRefusal(
    label: string, args: unknown[], expectText: string,
): Promise<void> {
    const r = await call(GUARDED, args);
    if (!r.refused) {
        bad(`${label} - WAS NOT REFUSED (returned ${r.rows.length} rows)`, JSON.stringify(r.rows.slice(0, 3)));
        return;
    }
    if (!r.message.toLowerCase().includes(expectText.toLowerCase())) {
        bad(`${label} - refused, but for the wrong reason`, r.message);
        return;
    }
    ok(`${label} - refused: ${r.message.split('\n')[0]}`);
}

async function inventory(): Promise<Map<string, number>> {
    const res = await OPS.partitionStats();
    if (!res.ok) throw new Error(`partitionStats refused: ${res.reason}`);
    return new Map(res.rows.map((r) => [r.partition_name, Number(r.bytes)]));
}

async function main(): Promise<void> {
    assertDestructiveTarget('test-retention-guards', CONFIG.databaseUrl);
    console.log('retention guards - every call below MUST be refused\n');
    const before = await inventory();
    console.log(`  ${before.size} partitions present before the test\n`);

    // GUARD 1: the locktest.ts accident, exactly.
    await expectRefusal('keep_days = 0 on samples',
        ['samples', 0, 7, 3, 2, 31, true, '2s'], 'below the floor');
    await expectRefusal('keep_days = 0 on samples_hourly',
        ['samples_hourly', 0, 7, 3, 2, 31, true, '2s'], 'below the floor');
    await expectRefusal('keep_days = 1, still under the floor',
        ['samples', 1, 7, 3, 2, 31, true, '2s'], 'below the floor');
    await expectRefusal('keep_days negative',
        ['samples', -30, 7, 3, 2, 31, true, '2s'], 'below the floor');

    // GUARD 2 no longer refuses, and that IS the fix. Refusing dropped nothing,
    // so the eligible count never decreased and the condition was permanent -
    // four missed daily runs wedged retention forever. It now takes max_drop
    // and defers the rest. Checked below under "a backlog makes progress"; here
    // only that it does not raise.
    // ON `messages`, NOT `samples`, AND THAT IS A CORRECTION RATHER THAN A
    // PREFERENCE.
    //
    // Both of these used to run against `samples`. Guard 5 - added later -
    // defers every samples partition while the rollup frontier is unset, and it
    // does so BEFORE the eligible list is built. So the eligible count is zero,
    // the function returns early, and guards 2 and 3 are never reached: the
    // guard-2 assertion saw only `deferred-unrolled` rows and the guard-3
    // assertion saw no refusal because there was nothing left to refuse.
    //
    // This file was not rerun after guard 5 landed, so it has been failing
    // since - and worse than failing, it had silently stopped covering two of
    // the five guards. A new guard that pre-empts an older one removes the
    // older one's test coverage without touching its test.
    //
    // `messages` has no downstream consumer, so guard 5 does not apply to it
    // and the arithmetic these two assertions are about is reachable. Guard 5's
    // interaction with samples is then asserted directly, below.
    {
        const r = await call(GUARDED, ['messages', 7, 7, 1, 2, 31, true, '2s']);
        if (r.refused) {
            bad('guard 2 raised on a backlog - retention would wedge permanently', r.message);
        } else if (r.rows.filter((x) => x.action === 'would-drop').length === 1
                   && r.rows.some((x) => x.action === 'deferred')) {
            ok('max_drop 1 with a backlog drops one and defers the rest, rather than refusing both');
        } else {
            bad('guard 2 did not make bounded progress', JSON.stringify(r.rows.slice(0, 3)));
        }
    }

    // GUARD 3: leaving too few behind.
    await expectRefusal('a horizon that would leave fewer than min_keep',
        ['messages', 7, 7, 99, 99, 31, true, '2s'], 'below min_keep');

    // GUARD 3 MUST COUNT HISTORY, NOT INVENTORY.
    //
    // It counted every child of the parent, including the seven days of EMPTY
    // FUTURE partitions both writers keep ahead of need. That inflates the
    // denominator by about eight permanently, so `total - dropping < min_keep`
    // could not fire in production - guard 3 was dead code whose comment
    // promised "there is always a history".
    //
    // Asserted through the refusal message, which names the total it used: add
    // a far-future partition, and the number must NOT move.
    {
        const totalIn = async (): Promise<number> => {
            const r = await call(GUARDED, ['messages', 7, 7, 99, 99, 31, true, '2s']);
            return Number(/dropping \d+ of (\d+) partitions/.exec(r.message)?.[1] ?? -1);
        };

        const before = await totalIn();
        await call(`CREATE TABLE IF NOT EXISTS messages_29990101
                    PARTITION OF messages FOR VALUES FROM ('2999-01-01') TO ('2999-01-02')`, []);
        const after = await totalIn();
        await call('DROP TABLE IF EXISTS messages_29990101', []);

        if (before > 0 && after === before) {
            ok(`a future partition does not inflate guard 3's total (${before} both times)`);
        } else {
            bad('guard 3 counted an empty future partition as history',
                JSON.stringify({ before, after }));
        }

        // The control. If the total were simply hardcoded or unparsed, the
        // assertion above would pass without measuring anything - so a PAST
        // partition must move it.
        const pastBefore = await totalIn();
        await call(`CREATE TABLE IF NOT EXISTS messages_19710101
                    PARTITION OF messages FOR VALUES FROM ('1971-01-01') TO ('1971-01-02')`, []);
        const pastAfter = await totalIn();
        await call('DROP TABLE IF EXISTS messages_19710101', []);

        if (pastAfter === pastBefore + 1) {
            ok(`and a PAST partition does move it (${pastBefore} -> ${pastAfter}), so the count is real`);
        } else {
            bad('adding a past partition did not change the total - the count is not being measured',
                JSON.stringify({ pastBefore, pastAfter }));
        }
    }

    // GUARD 5 PRE-EMPTS BOTH OF THEM ON `samples`, which is correct and was
    // untested. Retention cannot drop a raw partition the rollup has not
    // consumed, so with the frontier unset every eligible partition comes back
    // deferred-unrolled and no later guard gets a say. Asserted explicitly so
    // that the reason the two checks above moved tables is recorded as
    // behaviour rather than as a comment.
    {
        const r = await call(GUARDED, ['samples', 7, 7, 1, 2, 31, true, '2s']);
        if (r.refused) {
            bad('guard 5 raised instead of deferring', r.message);
        } else if (r.rows.length === 0) {
            ok('no samples partition is expired yet, so guard 5 has nothing to defer');
        } else if (r.rows.every((x) => x.action === 'deferred-unrolled')) {
            ok(`guard 5 defers all ${r.rows.length} expired samples partitions while the frontier is unset`);
        } else {
            bad('an unrolled samples partition escaped guard 5', JSON.stringify(r.rows.slice(0, 3)));
        }
    }

    // GUARD 4 skips rather than refuses, so it is checked differently from the
    // other three. messages partitions are one day wide, so max_span_days = 0
    // makes every one of them too wide: all must be reported skipped, and none
    // dropped.
    {
        const r = await call(GUARDED, ['messages', 7, 7, 99, 1, 0, true, '2s']);
        if (r.refused) {
            bad('guard 4 raised instead of skipping', r.message);
        } else if (r.rows.length > 0 && r.rows.every((x) => x.action === 'skipped-too-wide')) {
            ok(`every over-wide partition is skipped, not dropped (${r.rows.length} of them)`);
        } else {
            bad('guard 4 did not skip every over-wide partition', JSON.stringify(r.rows.slice(0, 3)));
        }
    }

    // GUARD 4, on a genuinely wide and genuinely expired partition.
    //
    // The check above proved the mechanism by shrinking max_span_days to 0. It
    // did not prove the case that matters: a partition that IS old enough to
    // drop and IS too wide to drop in one step - which is what the 122-day
    // pre-cutover rollup partition becomes once time passes. That cannot be
    // demonstrated against the real one today, because its upper bound is in
    // the future and no legal keep_days dooms it yet.
    //
    // So it is demonstrated on a disposable 1970-dated partition, which is
    // layer 2 of the fixture guard: it exercises the same code path against
    // the same parent while being incapable of holding real rows.
    console.log('');
    const made = await call(
        `CREATE TABLE IF NOT EXISTS samples_hourly_guardtest
         PARTITION OF samples_hourly FOR VALUES FROM ('1970-01-01') TO ('1970-04-01')`, []);
    if (made.refused) {
        bad('could not create the disposable 90-day partition', made.message);
    } else {
        ok('created a disposable 1970 partition spanning 90 days');

        // Not a refusal: a SKIP, reported in the result set. Guard 4 excludes
        // the wide partition rather than aborting the run, so retention keeps
        // working on everything else.
        const wide = await call(GUARDED,
            ['samples_hourly', FIXTURE_ONLY_KEEP_DAYS, 7, 3, 1, 31, false, '2s']);
        if (wide.refused) {
            bad('guard 4 aborted the run instead of skipping the wide partition', wide.message);
        } else {
            const skipped = wide.rows.filter((r) => r.action === 'skipped-too-wide');
            const s = skipped.find((r) => String(r.partition_name).includes('guardtest'));
            if (s && Number(s.span_days) === 90) {
                ok(`the 90-day partition is reported skipped-too-wide (span ${s.span_days} days)`);
            } else {
                bad('the wide partition was not reported as skipped', JSON.stringify(wide.rows));
            }
            if (!wide.rows.some((r) => r.action === 'dropped' && String(r.partition_name).includes('guardtest'))) {
                ok('and it was NOT dropped, on a non-dry-run call');
            } else {
                bad('THE WIDE PARTITION WAS DROPPED - guard 4 leaked');
            }
        }

        const still = await call(
            `SELECT 1 FROM pg_class WHERE relname = 'samples_hourly_guardtest'`, []);
        if (!still.refused && still.rows.length === 1) {
            ok('the wide partition is still present afterwards');
        } else {
            bad('THE WIDE PARTITION IS GONE - guard 4 leaked');
        }

        // The correction that this test forced: a NARROW expired partition must
        // still be droppable while a wide one exists. The first version of
        // guard 4 raised, which protected one partition by disabling retention
        // for all of them - so once the pre-cutover partition aged past the
        // horizon, expiry would have stopped working permanently.
        await call(
            `CREATE TABLE IF NOT EXISTS samples_hourly_guardtest2
             PARTITION OF samples_hourly FOR VALUES FROM ('1970-06-01') TO ('1970-06-15')`, []);
        const narrow = await call(GUARDED,
            ['samples_hourly', FIXTURE_ONLY_KEEP_DAYS, 7, 3, 1, 31, false, '2s']);
        if (narrow.refused) {
            bad('a narrow partition was blocked by the wide one - retention is disabled', narrow.message);
        } else {
            const dropped = narrow.rows.filter((r) => r.action === 'dropped');
            if (dropped.some((r) => String(r.partition_name).includes('guardtest2'))) {
                ok('a 14-day partition IS dropped while the 90-day one is skipped');
            } else {
                bad('the narrow partition was neither dropped nor explained', JSON.stringify(narrow.rows));
            }
        }

        await call('DROP TABLE IF EXISTS samples_hourly_guardtest', []);
        await call('DROP TABLE IF EXISTS samples_hourly_guardtest2', []);
        ok('disposable partitions removed');
    }

    // --- guard 2 must make PROGRESS, not wedge ------------------------------
    //
    // The finding: guard 2 raised when more than max_drop partitions were
    // eligible, so it dropped nothing, so the eligible count never decreased,
    // so the condition was permanent. Miss four daily runs and retention is
    // wedged forever while disk grows.
    //
    // The fix is that it drops the oldest max_drop and defers the rest, so a
    // backlog drains over several runs. Asserted here as a dry-run, which
    // exercises the same arithmetic without touching anything.
    console.log('');
    {
        const r = await call(GUARDED, ['messages', 7, 7, 3, 2, 31, true, '2s']);
        if (r.refused) {
            bad('guard 2 still raises on a backlog - retention would wedge', r.message);
        } else {
            const would = r.rows.filter((x) => x.action === 'would-drop');
            const deferred = r.rows.filter((x) => x.action === 'deferred');
            if (would.length === 3 && deferred.length > 0) {
                ok(`a backlog makes progress: ${would.length} would drop, ${deferred.length} deferred to later runs`);
            } else {
                bad('guard 2 did not drop a prefix and defer the rest',
                    JSON.stringify({ would: would.length, deferred: deferred.length }));
            }
            // Oldest first, or a backlog drains in an order that leaves the
            // oldest data longest.
            const names = would.map((x) => String(x.partition_name));
            const sorted = [...names].sort();
            if (JSON.stringify(names) === JSON.stringify(sorted)) {
                ok('and it takes the OLDEST first');
            } else {
                bad('the prefix was not the oldest partitions', names.join(','));
            }
        }
    }

    // A too-wide partition must not consume a guard-2 slot. It is excluded
    // from the eligible set, not counted and then skipped - counting it first
    // is what would have wedged the rollup after two missed runs instead of
    // three.
    {
        await call(
            `CREATE TABLE IF NOT EXISTS samples_hourly_wideslot
             PARTITION OF samples_hourly FOR VALUES FROM ('1971-01-01') TO ('1971-06-01')`, []);
        const r = await call(GUARDED,
            ['samples_hourly', FIXTURE_ONLY_KEEP_DAYS, 7, 3, 1, 31, true, '2s']);
        await call('DROP TABLE IF EXISTS samples_hourly_wideslot', []);
        if (r.refused) {
            bad('a wide partition still blocks the run', r.message);
        } else {
            const wide = r.rows.filter((x) => x.action === 'skipped-too-wide');
            const counted = r.rows.filter((x) => x.action === 'would-drop' || x.action === 'deferred');
            if (wide.length >= 1) {
                ok(`a ${wide[0]?.span_days}-day partition is excluded from the eligible set, not counted against max_drop`);
            } else {
                bad('the wide partition was not reported', JSON.stringify(r.rows));
            }
            if (!counted.some((x) => String(x.partition_name).includes('wideslot'))) {
                ok('and it occupies no guard-2 slot');
            } else {
                bad('the wide partition consumed a slot');
            }
        }
    }

    // --- rule 7: the function sets its own lock_timeout ---------------------
    //
    // Not observable from the outside, so it is checked by reading the
    // installed definition. A lock_timeout the caller has to remember is not
    // rule 7, by the same doctrine that puts the guards inside.
    {
        const r = await call(
            `SELECT prosrc FROM pg_proc WHERE proname = 'drop_partitions_guarded'`, []);
        const src = String((r.rows[0] as { prosrc?: string })?.prosrc ?? '');
        if (/SET LOCAL lock_timeout/i.test(src)) {
            ok('the function sets SET LOCAL lock_timeout itself, per rule 7');
        } else {
            bad('no lock_timeout inside the function - a DROP on the jobs lane would wait forever');
        }
    }

    // --- the guards must not be so eager they refuse everything -------------
    //
    // A guard that refuses every call is indistinguishable from a broken
    // function, and would pass every assertion above. So one call must SUCCEED
    // - in dry-run, naming what it would have dropped.
    console.log('');
    const allowed = await call(GUARDED, ['messages', 7, 7, 20, 2, 31, true, '2s']);
    if (allowed.refused) {
        bad('a legitimate dry-run call was refused - the guards are too eager', allowed.message);
    } else if (allowed.rows.length === 0) {
        bad('a legitimate dry-run call returned nothing - nothing is old enough to test with');
    } else {
        ok(`a legitimate dry-run names ${allowed.rows.length} partitions it would drop`);

        // The claim is "a dry run never DROPS", and that is what is asserted.
        //
        // It used to assert that every row said would-drop and nothing else,
        // which is a different and fixture-dependent claim: with more expired
        // partitions than max_drop the run correctly reports the surplus as
        // `deferred`, and the assertion failed on a database with a longer
        // messages runway than the one it was written against. An assertion
        // that depends on how much history happens to exist is measuring the
        // fixture, not the code.
        const actions = new Set(allowed.rows.map((r) => String(r.action)));
        if (!actions.has('dropped')) {
            ok(`a dry run reports [${[...actions].join(', ')}] and never 'dropped'`);
        } else {
            bad('A DRY RUN REPORTED AN ACTUAL DROP', [...actions].join(','));
        }
    }

    // --- independent check: nothing actually went ---------------------------
    console.log('');
    const after = await inventory();
    const lost = [...before.keys()].filter((n) => !after.has(n));
    if (lost.length === 0) {
        ok(`all ${before.size} partitions still present after the test`);
    } else {
        bad(`${lost.length} partitions DISAPPEARED during a guard test`, lost.join(', '));
    }

    await closeAll();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('guard test failed:', err);
    void closeAll();
    process.exit(1);
});
