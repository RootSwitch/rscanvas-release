// The alert state machine's transitions, every subtle rule as an assertion.
//
// Offline: the machine is pure, so this needs no database and runs in npm
// test. The scan tick that persists rows and dispatches events is tested
// separately against the lab - what lives here is the DECISIONS.
//
// The two rules most likely to be silently lost in a rewrite - sticky
// severity and the bounce that must not re-raise - were proven to FAIL against
// a deliberately regressed machine before this file was trusted, the same
// discipline as the search-semantics controls. Run 2026-07-27:
//
//   sticky = false          -> 3 failures (sticky severity, sticky threshold,
//                              the wobble escalating), 21 pass
//   bounce emits 'raise'    -> 1 failure (["raise","raise","clear"]), 23 pass
//
// A test that has never failed has never demonstrated it can.

import {
    step, stepMissing, dedupeConditions,
    type AlertRow, type MachineConfig,
} from '../src/alerts/machine.ts';
import type { Condition, Severity } from '../src/alerts/rules.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const CFG: MachineConfig = { raiseScans: 2, clearScans: 2, missingScans: 3 };
const T0 = new Date('2026-07-27T00:00:00Z');
const tick = (n: number): Date => new Date(T0.getTime() + n * 30_000);

// A NORMAL reading carries a NORMAL VALUE. Until 2026-08-18 this fixture
// signalled "normal" through severity alone and left value at 97 against a
// threshold of 90 - a reading that is physically impossible (normal, yet
// breaching) and that no real scan produces. It went unnoticed for as long as
// the machine judged severity only. Hysteresis judges the value too, and a
// "normal" 97 sits inside the clear band forever, so five tests here failed
// the moment the band landed - correctly. 60 is well past cpu's 5% band.
const cond = (severity: Severity | null, over: Partial<Condition> = {}): Condition => ({
    key: 'cpu:host1', severity, frozen: false, kind: 'cpu', host: 'host1',
    code: 'H1', label: 'host1 cpu', value: severity === null ? 60 : 97, threshold: 90, unit: '%', ...over,
});

/** Run a sequence of conditions through the machine, collecting the trace. */
function run(seq: Condition[], cfg = CFG): { row: AlertRow | null; events: string[] } {
    let row: AlertRow | null = null;
    const events: string[] = [];
    seq.forEach((c, i) => {
        const r = step(row, c, cfg, tick(i));
        if (r.action === 'none') return;
        if (r.action === 'delete') { row = null; return; }
        row = r.row;
        if (r.event !== null) events.push(r.event);
    });
    return { row, events };
}

function main(): void {
    console.log('alert machine: the transitions, rule by rule\n');

    // --- breach counter ------------------------------------------------------
    {
        const one = run([cond('warn')]);
        if (one.row?.state === 'pending' && one.events.length === 0) {
            ok('one breach with raiseScans=2 is PENDING and sends nothing');
        } else {
            bad('a single breach did not stay pending', JSON.stringify(one));
        }
        const two = run([cond('warn'), cond('warn')]);
        if (two.row?.state === 'active' && two.events.join() === 'raise') {
            ok('the second consecutive breach raises, exactly once');
        } else {
            bad('two breaches did not produce exactly one raise', JSON.stringify(two.events));
        }
        const instant = run([cond('crit')], { ...CFG, raiseScans: 1 });
        if (instant.row?.state === 'active' && instant.events.join() === 'raise') {
            ok('raiseScans=1 raises on the first breach, in the same step');
        } else {
            bad('raiseScans=1 did not raise immediately', JSON.stringify(instant));
        }
    }

    // --- clear counter -------------------------------------------------------
    {
        const half = run([cond('warn'), cond('warn'), cond(null)]);
        if (half.row?.state === 'clearing' && half.events.join() === 'raise') {
            ok('one normal scan moves active to CLEARING and sends nothing');
        } else {
            bad('one normal did not move to clearing', JSON.stringify(half));
        }
        const full = run([cond('warn'), cond('warn'), cond(null), cond(null)]);
        if (full.row?.state === 'cleared' && full.events.join() === 'raise,clear'
            && full.row.clearReason === 'normal') {
            ok('the second consecutive normal clears, exactly once, reason "normal"');
        } else {
            bad('two normals did not clear exactly once', JSON.stringify(full));
        }
    }

    // --- the bounce: clearing -> breach must NOT re-raise --------------------
    {
        const bounce = run([cond('warn'), cond('warn'), cond(null), cond('warn'), cond(null), cond(null)]);
        const raises = bounce.events.filter((e) => e === 'raise').length;
        if (raises === 1 && bounce.row?.state === 'cleared') {
            ok('a bounce (clearing -> breach -> normal) re-raises NOTHING - one incident, one raise');
        } else {
            bad('the bounce produced the wrong events', JSON.stringify(bounce.events));
        }
        // And the clear counter starts over: one normal after the bounce must
        // NOT clear, because the streak was broken.
        const broken = run([cond('warn'), cond('warn'), cond(null), cond('warn'), cond(null)]);
        if (broken.row?.state === 'clearing' && broken.row.clearCount === 1) {
            ok('and the bounce resets the clear counter - the normal streak starts over');
        } else {
            bad('the clear counter survived the bounce', JSON.stringify(broken.row));
        }
    }

    // --- sticky severity -----------------------------------------------------
    {
        const sticky = run([cond('crit'), cond('crit'), cond('warn')]);
        if (sticky.row?.severity === 'crit' && sticky.events.join() === 'raise') {
            ok('a raised crit stays crit when the value sags to warn - severity is sticky');
        } else {
            bad('severity was not sticky', JSON.stringify(sticky));
        }
        // The threshold sticks WITH the severity.
        const th = run([
            cond('crit', { threshold: 95 }), cond('crit', { threshold: 95 }),
            cond('warn', { threshold: 90 }),
        ]);
        if (th.row?.threshold === 95) {
            ok('and the crit threshold sticks with it - history shows the limit that was crossed');
        } else {
            bad('the threshold did not stick', JSON.stringify(th.row?.threshold));
        }
        // No escalate on the way back up: crit -> warn -> crit is one incident
        // at its recorded worst, not an escalation per wobble.
        const wobble = run([cond('crit'), cond('crit'), cond('warn'), cond('crit')]);
        if (wobble.events.join() === 'raise') {
            ok('crit -> warn -> crit produces NO escalate - the wobble is not news');
        } else {
            bad('the wobble escalated', JSON.stringify(wobble.events));
        }
        // But warn genuinely becoming crit IS news.
        const esc = run([cond('warn'), cond('warn'), cond('crit')]);
        if (esc.events.join() === 'raise,escalate' && esc.row?.severity === 'crit') {
            ok('warn genuinely crossing into crit escalates, once');
        } else {
            bad('warn -> crit did not escalate', JSON.stringify(esc.events));
        }
        // The transition is a FACT on the row, not only an event
        // (DECISIONS-2026-09-01 ruling 1): the event can be skipped by a
        // maintenance window, and for as long as escalation was only an
        // event, a skipped one was lost - no debt existed anywhere. The
        // owed-escalate queue reads this timestamp.
        if (esc.row?.escalatedTs !== null && esc.row?.escalatedTs !== undefined) {
            ok('the escalation is stamped on the row - the debt has a fact to open from');
        } else {
            bad('escalatedTs not stamped on escalate', JSON.stringify(esc.row));
        }
        // And it SURVIVES later scans: a subsequent breach must not blank it,
        // or the settled debt would reopen and the provenance would vanish.
        const after2 = step(esc.row, cond('crit'), CFG, tick(9));
        if (after2.action === 'update' && after2.row.escalatedTs?.getTime() === esc.row?.escalatedTs?.getTime()) {
            ok('escalatedTs survives subsequent scans unchanged');
        } else {
            bad('escalatedTs did not survive the next scan', JSON.stringify(after2));
        }
        // A row born crit never escalated: raise carries the severity, the
        // timestamp stays null, and the never-escalated fleet is not a queue.
        const born = run([cond('crit'), cond('crit')]);
        if (born.events.join() === 'raise' && born.row?.escalatedTs === null) {
            ok('born-crit is a raise with no escalation fact');
        } else {
            bad('born-crit produced an escalation fact', JSON.stringify(born.row));
        }
        // Pending is NOT sticky: nothing has been sent, so tracking the live
        // severity is honest.
        const pending = run([cond('crit')]);
        const after = step(pending.row, cond('warn'), { ...CFG, raiseScans: 3 }, tick(1));
        if (after.action === 'update' && after.row.severity === 'warn') {
            ok('a PENDING alert tracks live severity - nothing sent, nothing to stick to');
        } else {
            bad('pending severity stuck', JSON.stringify(after));
        }
    }

    // --- pending that never raised ------------------------------------------
    {
        const gone = run([cond('warn'), cond(null)]);
        if (gone.row === null && gone.events.length === 0) {
            ok('a pending alert that goes normal is DELETED - it never happened');
        } else {
            bad('a lapsed pending survived', JSON.stringify(gone));
        }
    }

    // --- frozen --------------------------------------------------------------
    {
        const frozenCond = cond(null, { frozen: true });
        const held = run([cond('warn'), frozenCond, cond('warn')]);
        if (held.row?.state === 'active' && held.events.join() === 'raise'
            && held.row.breachCount === 2) {
            ok('frozen advances NEITHER counter - the breach streak survives a blind scan');
        } else {
            bad('frozen moved a counter', JSON.stringify(held));
        }
        const clearing = run([cond('warn'), cond('warn'), cond(null), frozenCond, cond(null)]);
        if (clearing.row?.state === 'cleared') {
            ok('and a frozen scan does not break a clear streak either');
        } else {
            bad('frozen broke the clear streak', JSON.stringify(clearing.row));
        }
        if (step(null, frozenCond, CFG, T0).action === 'none') {
            ok('frozen with no open alert does nothing at all');
        } else {
            bad('frozen created something from nothing');
        }
    }

    // --- peak tracking, both directions --------------------------------------
    {
        const up = run([cond('warn', { value: 91 }), cond('warn', { value: 99 }), cond('warn', { value: 93 })]);
        if (up.row?.peakValue === 99) {
            ok('peak keeps the MAX for a higher-is-bad kind');
        } else {
            bad('peak lost the maximum', JSON.stringify(up.row?.peakValue));
        }
        const battery = (v: number): Condition => cond('warn', { key: 'battery:ups1', kind: 'battery', value: v });
        const down = run([battery(40), battery(15), battery(30)]);
        if (down.row?.peakValue === 15) {
            ok('and the MIN for battery, where lower is worse');
        } else {
            bad('peak went the wrong direction for battery', JSON.stringify(down.row?.peakValue));
        }
    }

    // --- missing / aging out -------------------------------------------------
    {
        const active = run([cond('warn'), cond('warn')]).row!;
        let row: AlertRow | null = active;
        const events: string[] = [];
        for (let i = 0; i < 3 && row !== null; i++) {
            const r = stepMissing(row, CFG, tick(10 + i));
            if (r.action !== 'update') { row = null; break; }
            row = r.row;
            if (r.event !== null) events.push(r.event);
        }
        if (row?.state === 'cleared' && row.clearReason === 'source-removed'
            && events.join() === 'clear') {
            ok('an active alert absent for missingScans clears as "source-removed", once');
        } else {
            bad('aging out misbehaved', JSON.stringify({ row, events }));
        }
        const pending = run([cond('warn')]).row!;
        let p = stepMissing(pending, CFG, tick(10));
        for (let i = 1; i < 3 && p.action === 'update'; i++) {
            p = stepMissing(p.row, CFG, tick(10 + i));
        }
        if (p.action === 'delete') {
            ok('a pending alert that ages out is deleted, not history');
        } else {
            bad('an aged pending was kept', JSON.stringify(p));
        }
        // Below the limit: counted, kept, no event.
        const counted = stepMissing(active, CFG, tick(10));
        if (counted.action === 'update' && counted.row.missingCount === 1
            && counted.row.state === 'active' && counted.event === null) {
            ok('below missingScans the alert is counted and kept, silently');
        } else {
            bad('a single missing scan did too much', JSON.stringify(counted));
        }
    }

    // --- dedup keeps the worst -----------------------------------------------
    {
        const collapsed = dedupeConditions([
            cond(null, { frozen: true }), cond('crit'), cond('warn'), cond(null),
        ]);
        if (collapsed.length === 1 && collapsed[0]!.severity === 'crit') {
            ok('four conditions on one key collapse to the crit - a real alarm beats its quiet twins');
        } else {
            bad('dedup kept the wrong condition', JSON.stringify(collapsed));
        }
        const distinct = dedupeConditions([cond('warn'), cond('warn', { key: 'cpu:host2' })]);
        if (distinct.length === 2) {
            ok('and distinct keys pass through untouched');
        } else {
            bad('dedup merged distinct keys', JSON.stringify(distinct));
        }
    }

    // --- purity: the input row is never mutated ------------------------------
    {
        const row = run([cond('warn'), cond('warn')]).row!;
        const copy = JSON.stringify(row);
        step(row, cond('crit'), CFG, tick(5));
        stepMissing(row, CFG, tick(6));
        if (JSON.stringify(row) === copy) {
            ok('step and stepMissing never mutate their input - the transaction owns the writes');
        } else {
            bad('the machine mutated its input row');
        }
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
