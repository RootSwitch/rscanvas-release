// The ingest flush gate, offline: a timer that fires during a running flush
// must not leave the gate looking armed.
//
//   node tools/test-flush-gate.ts
//
// src/workers/flush-gate.ts records the defect (the lab-5 ingest run, 2026-09-24:
// 104 traps held in memory for over a minute). This drives the worker's own
// scheduling shape - enqueue arms the gate below FLUSH_ROWS, a flush disarms it
// and re-arms at the end if rows remain, a fire during a running flush returns
// early - against fake timers, and asserts the tail is written.

import { makeFlushGate, failureBackoffMs, shouldLogFailure, type TimerApi } from '../src/workers/flush-gate.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};

// --- fake time -----------------------------------------------------------------
let now = 0;
type T = { fn: () => void; due: number; live: boolean };
let timers: T[] = [];
const fake: TimerApi = {
    set: (fn, ms) => { const t: T = { fn, due: now + ms, live: true }; timers.push(t); return t; },
    clear: (h) => { (h as T).live = false; },
};
function advance(ms: number): void {
    const until = now + ms;
    for (;;) {
        const next = timers.filter((t) => t.live && t.due <= until).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due; next.live = false; next.fn();
    }
    now = until;
    timers = timers.filter((t) => t.live);
}

// --- the worker's scheduling shape, in miniature ----------------------------------
const FLUSH_MS = 300, FLUSH_ROWS = 200, FLUSH_TAKES_MS = 1000;
function makeWorker() {
    let queue = 0, written = 0, flushing = false, fires = 0, earlyReturns = 0;
    const gate = makeFlushGate(() => { fires++; flush(); }, FLUSH_MS, fake);
    function flush(): void {
        if (flushing) { earlyReturns++; return; }
        gate.disarm();
        if (queue === 0) return;
        flushing = true;
        chunk();
    }
    // The worker's while-loop: splice the queue into a batch, COPY it (slow),
    // then go round again if rows arrived meanwhile; re-arm only at the end.
    function chunk(): void {
        const batch = queue; queue = 0;
        fake.set(() => {
            written += batch;
            if (queue > 0) { chunk(); return; }
            flushing = false;
            if (queue > 0) gate.armIfIdle();
        }, FLUSH_TAKES_MS);
    }
    function enqueue(n: number): void {
        queue += n;
        if (queue >= FLUSH_ROWS) flush(); else gate.armIfIdle();
    }
    return { enqueue, gate, get queue() { return queue; }, get written() { return written; }, get fires() { return fires; }, get earlyReturns() { return earlyReturns; } };
}

console.log('the stale-handle sequence (what the lab-5 run hit):');
{
    now = 0; timers = [];
    const w = makeWorker();
    w.enqueue(250);             // over FLUSH_ROWS: a slow flush starts at t=0, runs to t=1000
    advance(50);
    w.enqueue(10);              // under the threshold during that flush: arms the gate (fires t=350)
    advance(400);               // t=450: the fire has happened INSIDE the running flush
    ok('the timer fired while a flush was running, and the fire returned early', w.fires === 1 && w.earlyReturns === 1,
        `fires ${w.fires}, early returns ${w.earlyReturns}`);
    ok('a fired timer does not leave the gate looking armed', !w.gate.armed());
    advance(1600);              // t=2050: the loop took the ten in a second chunk and finished at t=2000
    ok('the running flush wrote what arrived while it ran', w.written === 260, `written ${w.written}`);
    w.enqueue(5);               // the quiet tail: five rows, far under FLUSH_ROWS
    ok('the tail arms a timer', w.gate.armed());
    advance(FLUSH_MS + FLUSH_TAKES_MS + 10);
    ok('the tail is written within one timer and one flush, with no further traffic', w.queue === 0 && w.written === 265,
        `queue ${w.queue}, written ${w.written}`);
}

console.log('\nordinary behaviour kept:');
{
    now = 0; timers = [];
    const w = makeWorker();
    w.enqueue(3);
    ok('a lone row arms one timer', w.gate.armed());
    w.enqueue(4);
    ok('a second row does not arm a second timer', timers.filter((t) => t.live).length === 1);
    advance(FLUSH_MS + FLUSH_TAKES_MS);
    ok('both are written after one timer', w.written === 7 && w.queue === 0, `written ${w.written}`);
    w.enqueue(500);
    ok('a burst over FLUSH_ROWS flushes at once, without waiting for a timer', !w.gate.armed());
    advance(FLUSH_TAKES_MS);
    ok('and is written', w.written === 507, `written ${w.written}`);
    const g = makeFlushGate(() => {}, FLUSH_MS, fake);
    g.armIfIdle(); g.disarm();
    ok('disarm cancels a pending fire', !g.armed() && timers.filter((t) => t.live).length === 0);
}

console.log('\nfailureBackoffMs and shouldLogFailure - a failing database is tried, and reported, less often:');
{
    ok('no wait before a failure, or after a success', failureBackoffMs(0) === 0);
    ok('250 ms after the first failure', failureBackoffMs(1) === 250);
    ok('then doubling', failureBackoffMs(2) === 500 && failureBackoffMs(3) === 1000 && failureBackoffMs(4) === 2000);
    ok('capped at 2 s however long the outage runs', failureBackoffMs(5) === 2000 && failureBackoffMs(500) === 2000);
    ok('a nonsense streak waits nothing rather than NaN', failureBackoffMs(Number.NaN) === 0 && failureBackoffMs(-1) === 0);
    // The drill's own shape: 180 s at the cap is about 90 attempts, where one
    // flush per datagram at 50 a second took 8,701.
    let t = 0;
    let attempts = 0;
    while (t < 180_000) { attempts++; t += failureBackoffMs(attempts); }
    ok('a 3-minute outage costs about 90 attempts', attempts > 80 && attempts < 100, `${attempts}`);
    let lines = 0;
    for (let k = 1; k <= attempts; k++) if (shouldLogFailure(k)) lines++;
    ok('and under ten log lines', lines < 10, `${lines}`);
    ok('the first failure is always said', shouldLogFailure(1));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
