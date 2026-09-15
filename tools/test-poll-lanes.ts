// Poll lane budgets (slice 47). No database, no workers.
//
// The bug these exist to prevent cost the 30k run 77% of its throughput with
// the box 100% idle, and NOTHING caught it: the event loop was free, CPU and
// IO were flat, and every instrument reported health. So the properties are
// pinned here, with the measured numbers from the failure itself.

import fs from 'node:fs';
import { downBudget, downCap, liveBudget } from '../src/collector/lanes.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

console.log('poll lane budgets\n');

// --- THE FAILURE, IN ITS OWN NUMBERS -----------------------------------------
{
    // Stock config, the fleet that broke: 24 concurrency, 4 down, 78 dead
    // devices permanently at the head of the overdue ordering. The old shared
    // query handed live devices 4 of 48 candidate slots and inFlight sat at 4.
    // Whatever else changes, the live lane must come out of this with real
    // room.
    const down = downBudget(0, 0, 24, 4);
    const live = liveBudget(down, 24);
    if (down === 4 && live === 20) {
        ok('stock config: down gets its 4, live gets the other 20 - not 0');
    } else bad('the live lane did not get the remaining slots', { down, live });
}
{
    // And at the mitigated setting the run is on now.
    const down = downBudget(0, 0, 64, 4);
    const live = liveBudget(down, 64);
    if (down === 4 && live === 60) ok('at concurrency 64 the split is 4 and 60');
    else bad('wrong split at 64', { down, live });
}

// --- THE DOWN LANE CANNOT CROWD THE LIVE ONE ---------------------------------
{
    // The property in one line: however many devices are dead, the down lane
    // asks for at most its cap. 78 dead, 1000 dead, it does not matter -
    // the budget is not a function of how many are due.
    const a = downBudget(0, 0, 64, 4);
    const b = downBudget(0, 0, 64, 4);
    if (a === 4 && b === 4) ok('the down budget is its cap, never the size of the dead population');
    else bad('the down budget scaled with something it should not', { a, b });
}
{
    if (downBudget(0, 4, 64, 4) === 0) ok('a full down lane asks for nothing more');
    else bad('the down lane over-claimed', downBudget(0, 4, 64, 4));
}
{
    // A cap raised above the pool must not hand out slots that do not exist.
    const d = downBudget(60, 0, 64, 128);
    if (d === 4) ok('the down cap is clamped by the free pool, not just by itself');
    else bad('the down lane claimed slots that do not exist', d);
}

// --- THE CAP IS PROPORTIONAL (C6, 2026-09-06) ---------------------------------
//
// What a small fixed cap costs is measured in how long a RECOVERED device
// waits to be noticed: a dead population of N cycles every N x timeout / cap
// seconds. The numbers below are the 30k box's own - 78 dead, a 10 s dead
// poll (5 s timeout x 2 attempts), and a reported worst poll lag of 159 s
// under the old 4 - and the review's 400-dead case at a pool of 64.
const cycleS = (dead: number, cap: number): number => dead * 10 / cap;
{
    if (downCap(24, null) === 12 && downCap(64, null) === 32) ok('the default cap is half the pool: 12 of 24, 32 of 64');
    else bad('the default cap is not half the pool', { c24: downCap(24, null), c64: downCap(64, null) });
    if (downCap(4, null) === 2 && downCap(2, null) === 1 && downCap(1, null) === 1) {
        ok('small pools still get a down lane: 2 of 4, 1 of 2, and 1 of 1 as the only option');
    } else bad('small-pool default wrong', { c4: downCap(4, null), c2: downCap(2, null), c1: downCap(1, null) });
}
{
    // The property in the review's numbers: the fixed 4 made a 400-device
    // outage take ~17 minutes to clear at a pool of 64; half the pool makes
    // it ~2. And the 30k run's own 78 dead go from ~195 s to ~65 s.
    if (Math.round(cycleS(400, 4) / 60) === 17 && Math.round(cycleS(400, downCap(64, null)) / 60) === 2) {
        ok('a 400-device outage at a pool of 64 clears in ~2 minutes instead of ~17');
    } else bad('recovery arithmetic drifted', { old: cycleS(400, 4), now: cycleS(400, downCap(64, null)) });
    if (cycleS(78, 4) === 195 && cycleS(78, downCap(24, null)) === 65) {
        ok('the 30k box: 78 dead cycle in 65 s at the default instead of 195 s at the old 4');
    } else bad('30k recovery arithmetic drifted', { old: cycleS(78, 4), now: cycleS(78, downCap(24, null)) });
}
{
    // The lane arithmetic still holds at the new default: down takes its
    // half, live gets the other half - never zero.
    const down = downBudget(0, 0, 24, downCap(24, null));
    const live = liveBudget(down, 24);
    if (down === 12 && live === 12) ok('at the default split the live lane keeps half the pool');
    else bad('the default split starved a lane', { down, live });
}
{
    // An explicit setting still wins - the old 4 remains available, which is
    // what makes the measurements above reproducible - and the live lane
    // must keep at least one slot.
    if (downCap(24, 4) === 4 && downCap(24, 23) === 23) ok('an explicit POLL_DOWN_CONCURRENCY is honoured up to POLL_CONCURRENCY - 1');
    else bad('explicit cap not honoured', { four: downCap(24, 4), max: downCap(24, 23) });
    const refused = (c: number, e: number | null): string | null => {
        try { downCap(c, e); return null; } catch (err) { return (err as Error).message; }
    };
    const whole = refused(24, 24);
    if (whole !== null && whole.includes('1 to 23') && whole.includes('answering fleet')) {
        ok('a cap covering the whole pool is REFUSED, naming the ceiling and why');
    } else bad('a whole-pool cap was accepted or the refusal is mute', whole);
    if (refused(24, 0) !== null && refused(24, 2.5) !== null && refused(24, -1) !== null) {
        ok('zero, fractional and negative caps are refused - a down lane of nothing is the silent-recovery bug');
    } else bad('a nonsense cap was accepted');
    if (refused(0, null) !== null && refused(24.5, null) !== null) ok('a pool of zero or a fractional pool is refused');
    else bad('a nonsense pool was accepted');
}

// --- NEVER NEGATIVE -----------------------------------------------------------
{
    // Over-subscription is reachable: the cap can be lowered by config while
    // polls are already in flight above it.
    const d = downBudget(70, 9, 64, 4);
    const l = liveBudget(70, 64);
    if (d === 0 && l === 0) ok('over-subscription yields zero, not a negative budget');
    else bad('a negative budget escaped', { d, l });
}

// --- THE LANE ORDER, WHICH THE ARITHMETIC CANNOT SEE -------------------------
{
    // Down must be dispatched FIRST. Live first looks equally reasonable and
    // silently breaks recovery: a busy fleet fills every slot on every pass,
    // no dead device is ever retried, and one that comes back stays marked
    // down forever. That is a quieter bug than the one this replaces, so it
    // is pinned against the source rather than trusted to a comment.
    const src = fs.readFileSync(new URL('../src/workers/collector.ts', import.meta.url), 'utf8');
    const d = src.indexOf("dispatchLane('down'");
    const l = src.indexOf("dispatchLane('live'");
    if (d !== -1 && l !== -1 && d < l) {
        ok('the down lane is dispatched before the live lane');
    } else bad('lane order is wrong or a call was renamed', { downAt: d, liveAt: l });
}
{
    // And the two lanes must still BE two queries. If a future tidy-up merges
    // them back into one call the starvation returns exactly as it was.
    const src = fs.readFileSync(new URL('../src/workers/collector.ts', import.meta.url), 'utf8');
    const calls = src.match(/dispatchLane\(/g) ?? [];
    if (calls.length >= 2) ok('there are still two lane dispatches, not one merged pass');
    else bad('the lanes were merged back into a single pass', calls.length);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
