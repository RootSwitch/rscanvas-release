// Who is on a lane, and what they were doing when it went slow (2026-10-20).
//
// Found on production the night of 2026-10-19: from 22:10 to 04:40 the
// alert-notify pass was still running at nearly every 30-second tick, 751
// times by morning against 2 to 17 a day the week before, and the only
// record was "still running from the last tick, skipping this one". Its
// queries run in under a millisecond by hand, the box was idle, nothing
// else in the logs moved. A skip line that cannot say what the earlier
// pass is waiting ON is a line that can only be counted.
//
// So a job runs as a CALLER: its name, when it began, and the step it last
// named. The lanes (pool.ts) note every call's caller and phase - waiting
// for admission, connecting, or in its query - and when a job finds its
// previous run still going, describeOverrun() says where that run is and
// who else holds the lanes it is on.
//
// PER THREAD, ON PURPOSE. The context is an AsyncLocalStorage, which is
// per async chain inside one thread; the jobs thread is the only one that
// runs callers today, and a module loaded in another thread has nothing to
// share with it - the same reasoning as pool.ts's runtimes. Outside a
// caller, step() does nothing and the lanes record "unnamed", so main and
// the collector are untouched.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface Caller {
    name: string;
    /** performance.now() when the run began. */
    startedMs: number;
    /** The step it last named; '' until it names one. */
    step: string;
    stepMs: number;
}

const context = new AsyncLocalStorage<Caller>();

export function newCaller(name: string, nowMs = performance.now()): Caller {
    return { name, startedMs: nowMs, step: '', stepMs: nowMs };
}

/** Run fn as this caller: every lane call inside it, however deep, is named for it. */
export function runAs<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
    return context.run(caller, fn);
}

export function currentCaller(): Caller | undefined {
    return context.getStore();
}

/** Name what the running caller is doing now. Outside a caller, nothing. */
export function step(text: string, nowMs = performance.now()): void {
    const c = context.getStore();
    if (c === undefined) return;
    c.step = text;
    c.stepMs = nowMs;
}

export type LanePhase = 'admission' | 'connect' | 'query';

/** One lane's calls in flight, as pool.ts's laneCalls() reports them. */
export interface LaneCalls {
    lane: string;
    capacity: number;
    calls: Array<{ caller: string | null; phase: LanePhase; ms: number }>;
}

const PHASE_WORDS: Record<LanePhase, string> = {
    admission: 'waiting for a turn',
    connect: 'connecting',
    query: 'in a query',
};

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * What a skip line adds: how long the running pass has been at it, the
 * step it is on, what it is doing on each lane it is on, and who else
 * holds those lanes. "Not on a lane" is itself the answer when the pass is
 * awaiting something that is not the database (a mail server, say).
 */
export function describeOverrun(running: Caller, nowMs: number, lanes: LaneCalls[]): string {
    const parts = [`the running pass began ${secs(nowMs - running.startedMs)} ago and `
        + (running.step === '' ? 'has named no step'
            : `has been at "${running.step}" for ${secs(nowMs - running.stepMs)}`)];
    const mine = lanes.flatMap((l) => l.calls.filter((c) => c.caller === running.name)
        .map((c) => ({ lane: l.lane, ...c })));
    if (mine.length === 0) {
        parts.push('not on a lane');
    } else {
        parts.push(mine.map((c) => `${PHASE_WORDS[c.phase]} on the ${c.lane} lane for ${secs(c.ms)}`).join(', '));
    }
    // Who else is on the lanes it is on: the holders first, then the queue.
    for (const l of lanes) {
        if (!mine.some((c) => c.lane === l.lane)) continue;
        const others = l.calls.filter((c) => c.caller !== running.name);
        const holding = others.filter((c) => c.phase !== 'admission');
        const waiting = others.filter((c) => c.phase === 'admission');
        const inUse = l.calls.filter((c) => c.phase !== 'admission').length;
        let s = `${l.lane} lane ${inUse} of ${l.capacity} in use`;
        if (holding.length > 0) {
            s += `: ${holding.map((c) => `${c.caller ?? 'unnamed'} ${PHASE_WORDS[c.phase]} ${secs(c.ms)}`).join(', ')}`;
        }
        if (waiting.length > 0) {
            s += `; also waiting: ${waiting.map((c) => `${c.caller ?? 'unnamed'} ${secs(c.ms)}`).join(', ')}`;
        }
        parts.push(s);
    }
    return parts.join('; ');
}
