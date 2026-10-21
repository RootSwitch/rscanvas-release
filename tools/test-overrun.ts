// What a job's skip line says about the run it found still going (2026-10-20).
//
//   node tools/test-overrun.ts
//
// Production's alert-notify pass overran every 30-second tick for six hours
// on the night of 2026-10-19, and the skip line could only be counted. Now a
// job runs as a caller (src/store/caller.ts), the lanes note each call's
// caller and phase (src/store/pool.ts onLane), and the skip line describes
// the running pass. Pinned here: the description itself, the caller context
// across awaits and between interleaved runs, and - against a server that
// accepts connections and never answers - the lanes' record of who is
// waiting, who is connecting, and that every call leaves the record however
// it ends. The query phase needs a real server and is not exercised here.

import net from 'node:net';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const has = (label: string, text: string, part: string): void =>
    eq(`${label}: "${part}"`, text.includes(part) ? part : text, part);

// A server that accepts and never says a word: a connect to it waits until
// the lane's own connection timeout, which is the "connecting" phase held open.
const silent = net.createServer(() => { /* never answer */ });
await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
const port = (silent.address() as net.AddressInfo).port;
process.env.DATABASE_URL = `postgres://nobody:nothing@127.0.0.1:${port}/none`;

const { newCaller, runAs, step, currentCaller, describeOverrun } = await import('../src/store/caller.ts');
const { laneCalls, closeAll } = await import('../src/store/index.ts');
const { onLane } = await import('../src/store/pool.ts');

console.log('the description:');
const t = 1_000_000;
const notify = { name: 'alerts:notify', startedMs: t - 31_200, step: 'reading the raise queue', stepMs: t - 30_900 };
eq('a pass on no lane says so, with its step and how long it has been there',
    describeOverrun({ ...notify, step: 'raise for alert 7 by email' }, t, [{ lane: 'jobs', capacity: 2, calls: [] }]),
    'the running pass began 31.2 s ago and has been at "raise for alert 7 by email" for 30.9 s; not on a lane');
eq('a pass that named no step says that rather than an empty quote',
    describeOverrun({ ...notify, step: '' }, t, []),
    'the running pass began 31.2 s ago and has named no step; not on a lane');
const full = describeOverrun(notify, t, [
    { lane: 'alerts', capacity: 2, calls: [{ caller: 'alerts:scan', phase: 'query', ms: 40 }] },
    { lane: 'jobs', capacity: 2, calls: [
        { caller: 'rollup', phase: 'query', ms: 45_000 },
        { caller: 'temps:baseline', phase: 'connect', ms: 31_000 },
        { caller: 'alerts:notify', phase: 'admission', ms: 30_900 },
        { caller: null, phase: 'admission', ms: 1_000 },
    ] },
]);
eq('a pass waiting for its turn: what it waits on, who holds the lane, who else waits',
    full, 'the running pass began 31.2 s ago and has been at "reading the raise queue" for 30.9 s; '
        + 'waiting for a turn on the jobs lane for 30.9 s; '
        + 'jobs lane 2 of 2 in use: rollup in a query 45.0 s, temps:baseline connecting 31.0 s; also waiting: unnamed 1.0 s');
eq('a lane the pass is not on is left out (the scan on alerts)', full.includes('alerts lane'), false);

console.log('\nthe caller context:');
eq('outside a caller there is none', currentCaller(), undefined);
step('nobody');   // must not throw, must not land anywhere
eq('and step() does nothing there', currentCaller(), undefined);
const a = newCaller('a', 0), b = newCaller('b', 0);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
await Promise.all([
    runAs(a, async () => { step('a1', 1); await tick(); step('a2', 2); await tick(); }),
    runAs(b, async () => { await tick(); step('b1', 3); await tick(); }),
]);
eq('two interleaved runs keep their own steps', [a.step, a.stepMs, b.step, b.stepMs], ['a2', 2, 'b1', 3]);
const outer = newCaller('outer', 0), inner = newCaller('inner', 0);
await runAs(outer, async () => {
    await runAs(inner, async () => { await tick(); step('in'); });
    step('back');
});
eq('a run started inside another (the scan kicking notify) is its own caller', [inner.step, outer.step], ['in', 'back']);
const inTimer = newCaller('timer', 0);
await runAs(inTimer, () => new Promise<void>((r) => setTimeout(() => { step('from a timer'); r(); }, 5)));
eq('the context follows a timer started inside the run', inTimer.step, 'from a timer');

console.log('\nthe lanes, against a server that never answers:');
// The interactive lane: 16 slots, half a second to connect or be admitted.
const holder = newCaller('holder'), waiter = newCaller('waiter');
const calls: Array<Promise<unknown>> = [];
const settle = (p: Promise<unknown>): Promise<unknown> => p.then((x) => x, (e: unknown) => e);
for (let i = 0; i < 16; i++) calls.push(settle(runAs(holder, () => onLane('interactive', async (c) => { await c.query('select 1'); return { rows: [], rowCount: 0 }; }))));
calls.push(settle(runAs(waiter, () => onLane('interactive', async () => ({ rows: [], rowCount: 0 })))));
calls.push(settle(onLane('interactive', async () => ({ rows: [], rowCount: 0 }))));
await new Promise((r) => setTimeout(r, 150));
const lane = laneCalls().find((l) => l.lane === 'interactive')!;
const phases = (who: string | null) => lane.calls.filter((c) => c.caller === who).map((c) => c.phase);
eq('sixteen calls hold the lane, connecting', [phases('holder').length, [...new Set(phases('holder'))]], [16, ['connect']]);
eq('the seventeenth waits for its turn, named for its caller', phases('waiter'), ['admission']);
eq('a call made outside any caller is recorded unnamed', phases(null), ['admission']);
eq('each call says how long it has been in its phase', lane.calls.every((c) => c.ms >= 100 && c.ms < 1000), true);
const said = describeOverrun(waiter, performance.now(), laneCalls());
has('the description names the wait', said, 'waiting for a turn on the interactive lane for 0.');
has('and the holders', said, 'interactive lane 16 of 16 in use: holder connecting 0.');
has('and the other waiter', said, 'also waiting: unnamed 0.');
const outcomes = await Promise.all(calls);
eq('the connects ended in the lane\'s own timeout, the waiters were turned away',
    [outcomes.slice(0, 16).every((o) => o instanceof Error), (outcomes[16] as { reason?: string }).reason], [true, 'busy']);
eq('and every call left the record, whichever way it ended',
    laneCalls().find((l) => l.lane === 'interactive')!.calls.length, 0);

await closeAll();
silent.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
