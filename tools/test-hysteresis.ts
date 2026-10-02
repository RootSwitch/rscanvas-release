// Hysteresis, through the REAL machine: the flapping sensor raises once and
// holds, instead of raising and clearing on every crossing.
//
//   node tools/test-hysteresis.ts

import { step, type AlertRow, type MachineConfig } from '../src/alerts/machine.ts';
import { insideClearBand, clearBandThreshold, CLEAR_BAND } from '../src/alerts/hysteresis.ts';
import type { Condition, Severity } from '../src/alerts/rules.ts';

let pass = 0, fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string): void => { fail++; console.log(`  FAIL ${l}`); };
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? ok(l) : bad(`${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const CFG: MachineConfig = { raiseScans: 2, clearScans: 2, missingScans: 3 };
const T0 = new Date('2026-08-18T00:00:00Z');
const tick = (n: number): Date => new Date(T0.getTime() + n * 30_000);

/** A temperature reading against warn 45, exactly the MPC4 shape. */
const temp = (value: number): Condition => ({
    key: 'temp:MPC4:composite', severity: value >= 45 ? 'warn' : null, frozen: false,
    kind: 'temp', host: 'MPC4', code: 'MPC4C', label: 'MPC4 Temp: Composite',
    value, threshold: 45, unit: 'C',
});

function run(seq: Condition[]): { row: AlertRow | null; events: string[]; states: string[] } {
    let row: AlertRow | null = null;
    const events: string[] = [], states: string[] = [];
    seq.forEach((c, i) => {
        const r = step(row, c, CFG, tick(i));
        if (r.action === 'delete') { row = null; states.push('-'); return; }
        if (r.action !== 'none') { row = r.row; if (r.event !== null) events.push(r.event); }
        states.push(row?.state ?? '-');
    });
    return { row, events, states };
}

console.log('the pure band:');
eq('temp band is 2C', CLEAR_BAND.temp, 2);
eq('44.9C against warn 45 is INSIDE the band - held', insideClearBand('temp', 44.9, 45), true);
eq('43.0C is at the band edge - held (must fall BELOW threshold - band)', insideClearBand('temp', 43.0, 45), true);
eq('42.9C is past the band - clears', insideClearBand('temp', 42.9, 45), false);
eq('a kind with no band never holds', insideClearBand('nosuchkind', 44.9, 45), false);
eq('a null value never holds', insideClearBand('temp', null, 45), false);
eq('LOWER_IS_BAD: battery at 52 against warn 50 is inside a 5% band ABOVE - held', insideClearBand('battery', 52, 50), true);
eq('battery at 55.0 is AT the edge - held', insideClearBand('battery', 55.0, 50), true);
eq('battery at 55.1 has climbed past the band - clears', insideClearBand('battery', 55.1, 50), false);

console.log('\nthe table names the kinds the RULES emit, not near-misses:');
// The defect this section pins (2026-09-01 review): the table listed 'util'
// with a comment claiming link utilization, but rules.ts emits kind
// 'if-util' for interfaces - so the kind most likely to flap at 80% had no
// band, and no test here mentioned it. A band asserted per EMITTED kind
// cannot rot that way again.
eq('if-util (the kind rules.ts emits for links) has a band', CLEAR_BAND['if-util'], 5);
eq('76% against warn 80 is inside the if-util band - held', insideClearBand('if-util', 76, 80), true);
eq('74.9% is past the band - clears', insideClearBand('if-util', 74.9, 80), false);
// Deliberate zeros, asserted so a change here is a decision and not a drift:
// error and discard rates are spiky by nature, and a band in /s is a claim
// about jitter nobody has measured. See the note in hysteresis.ts.
eq('if-errors has NO band, deliberately (undecided, not forgotten)', insideClearBand('if-errors', 0.1, 1), false);
eq('if-discards has NO band, deliberately', insideClearBand('if-discards', 0.1, 1), false);

// THE COMPLETE TABLE, pinned entry by entry (review 4c item 9): a band is a
// per-kind decision, and this assertion is what makes adding a kind - or
// nudging a number - a decision someone states instead of a drift nobody
// sees. The deliberate zeros are listed too, each with its reason, so the
// if-util hole (a comment claiming coverage the emitted kind never had)
// cannot re-form around a kind this list forgot.
{
    const want: Record<string, number> = {
        temp: 2, cpu: 5, mem: 3, disk: 3, util: 5, 'if-util': 5, fan: 200, battery: 5,
    };
    const got = Object.fromEntries(Object.entries(CLEAR_BAND).sort());
    eq('the band table is EXACTLY its eight decisions, no more and no fewer',
        got, Object.fromEntries(Object.entries(want).sort()));
    // Kinds the rules emit that carry NO band, each on purpose:
    // device-down / if-down are booleans (a band over true/false is
    // meaningless); if-errors / if-discards are spiky rates awaiting the
    // flap report's field evidence; event kinds clear by TTL, not by value.
    for (const kind of ['device-down', 'if-down', 'if-errors', 'if-discards', 'event']) {
        eq(`${kind} is a deliberate zero`, insideClearBand(kind, 1, 2), false);
    }
}

console.log('\nthe MPC4 replay - 45.85 / 44.85 / 45.85 / 44.85 ..., the shape that cleared five times:');
{
    const seq = [45.85, 45.85, 44.85, 44.85, 45.85, 45.85, 44.85, 44.85, 45.85, 45.85, 44.85, 44.85].map(temp);
    const r = run(seq);
    eq('raises exactly ONCE across twelve oscillating scans', r.events, ['raise']);
    eq('and is still active at the end - never cleared, never re-raised', r.row?.state, 'active');
    eq('the displayed value tracks the reading while held', r.row?.value, 44.85);
}

console.log('\nand a genuine cool-down still clears:');
{
    const seq = [45.85, 45.85, 44.85, 43.5, 42.5, 41.0].map(temp);
    const r = run(seq);
    eq('raise, then clear once the value falls PAST the band', r.events, ['raise', 'clear']);
    eq('states: pending, active, held, held, clearing, cleared',
        r.states, ['pending', 'active', 'active', 'active', 'clearing', 'cleared']);
}

console.log('\nwhat the band must NOT do:');
{
    // A pending alert (never raised) that goes normal inside the band is
    // DELETED, not held: nothing was sent, nothing to protect.
    const r = run([temp(45.85), temp(44.9)]);
    eq('a pending alert going normal inside the band is deleted, not held', r.row, null);
}
{
    // The band never suppresses a raise or an escalation.
    const seq = [temp(45.85), temp(45.85), { ...temp(56), severity: 'crit' as Severity }];
    const r = run(seq);
    eq('a breach is never held - escalation still fires', r.events, ['raise', 'escalate']);
}
{
    // clearScans still counts consecutive PAST-BAND readings: a held reading
    // in the middle preserves the clear counter (like frozen) rather than
    // resetting it, which is the same semantics the machine already has for
    // "no evidence either way".
    const seq = [45.85, 45.85, 42.0, 44.0, 42.0].map(temp);
    const r = run(seq);
    eq('held reading between two past-band readings preserves the clear count: clears on the second',
        r.events, ['raise', 'clear']);
}

console.log('\na rule loosened mid-incident (alerts-F3, the stale-band wedge):');
{
    // CPU, band 5. An override warned at 30; the reading sits at 32 and the
    // alert raises. The override is deleted and the default 45 applies: 32
    // is now normal. It used to sit inside the band of the deleted 30 line
    // (32 >= 25) for ever.
    const cpu = (value: number, warn: number): Condition => ({
        key: 'cpu:pi:CPU', severity: value >= warn ? 'warn' : null, frozen: false,
        kind: 'cpu', host: 'pi', code: 'CPU1', label: 'pi CPU', value, threshold: warn, unit: '%',
    });
    const r = run([cpu(32, 30), cpu(32, 30), cpu(32, 45), cpu(32, 45), cpu(32, 45)]);
    eq('loosened from 30 to 45 at a steady 32: raises, then clears after clearScans', r.events, ['raise', 'clear']);
    eq('and the states say so', r.states, ['pending', 'active', 'clearing', 'cleared', 'cleared']);
    const held = run([cpu(32, 30), cpu(32, 30), cpu(42, 45), cpu(42, 45)]);
    eq('a reading inside the NEW line\'s band (42 >= 45 - 5) is still held - the live band works',
        held.states, ['pending', 'active', 'active', 'active']);
    const out = run([cpu(32, 30), cpu(32, 30), cpu(42, 45), cpu(38, 45), cpu(38, 45)]);
    eq('and it clears once it falls past that band', out.events, ['raise', 'clear']);
}
{
    // Unchanged rule: nothing moves. A warn-raised temp alert at 44.5 against
    // warn 45 (band 2) is held, exactly as before.
    const r = run([45.85, 45.85, 44.5, 44.5, 44.5].map(temp));
    eq('an unchanged rule holds inside its band as before', r.states, ['pending', 'active', 'active', 'active', 'active']);
}
{
    // A crit incident whose reading falls under the WARN line: the stored
    // crit line is the more lenient of the two and keeps its old behaviour.
    const t = (value: number): Condition => ({
        ...temp(value), severity: value >= 55 ? 'crit' : value >= 45 ? 'warn' : null,
        threshold: value >= 55 ? 55 : 45,
    });
    const r = run([56, 56, 44, 44].map(t));
    eq('a crit incident falling under warn clears as it always did', r.events, ['raise', 'clear']);
}
eq('lower-is-bad takes the lower line (a battery floor loosened from 30 to 20)',
    [clearBandThreshold('battery', 30, 20), clearBandThreshold('cpu', 30, 45), clearBandThreshold('cpu', null, 45), clearBandThreshold('cpu', 30, null)],
    [20, 45, 45, 30]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
