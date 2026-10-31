// One device's limits (beta list S6, 2026-10-31): the poll's deadline, as
// the session abort that carries it, and the device's interface and sensor
// caps. Offline, on loopback: a "silent agent" is a UDP socket that takes
// every request and answers none, so a request in flight stays in flight
// until its timeout - unless the abort ends it.
//
//   node tools/test-poll-limits.ts

import dgram from 'node:dgram';

// A timeout long enough that "ended by the abort" and "ended by the timeout"
// cannot be confused, and short enough that the suite's own wait for the
// library's late timers stays brief. Set before the config is first read.
process.env.SNMP_TIMEOUT_MS = '1500';
process.env.SNMP_RETRIES = '1';
const { createSession, get, walk, SnmpError } = await import('../src/collector/snmp.ts');
const { capEntities } = await import('../src/collector/caps.ts');

process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const uncaught: string[] = [];
process.on('uncaughtException', (err) => { uncaught.push(err.message); });

// --- the caps ----------------------------------------------------------------
console.log('the caps:');
type E = { kind: string; tracked: boolean; n: string };
const ifs = (spec: string): E[] => [...spec].map((c, i) => ({ kind: 'if', tracked: c === 'T', n: `if${i}` }));
const temps = (k: number): E[] => Array.from({ length: k }, (_, i) => ({ kind: 'temp', tracked: true, n: `t${i}` }));
{
    const all = [...ifs('TTT'), ...temps(2)];
    const c = capEntities(all, { interfaces: 3, sensors: 2 });
    eq('under both caps: everything kept, nothing said', [c.kept.length, c.refused, c.notes], [5, { interfaces: 0, sensors: 0 }, []]);
}
{
    // The agent lists two untracked interfaces FIRST; a cap of 2 keeps the
    // two discovery would watch, not the first two by position.
    const all = ifs('uuTT');
    const c = capEntities(all, { interfaces: 2, sensors: 10 });
    eq('the watched ones are kept before the plumbing', c.kept.map((e) => e.n), ['if2', 'if3']);
    eq('and the rest refused, counted', c.refused, { interfaces: 2, sensors: 0 });
    eq('said in one sentence naming the setting',
        c.notes, ['it serves 4 interfaces; a device may have 2 (MAX_INTERFACES_PER_DEVICE), so 2 were left out - '
            + 'the ones discovery would not watch go first']);
}
{
    const all = [...ifs('TuTu'), ...temps(3)];
    const c = capEntities(all, { interfaces: 3, sensors: 1 });
    eq('kept in discovery\'s own order, each class to its own cap', c.kept.map((e) => e.n), ['if0', 'if1', 'if2', 't0']);
    eq('two classes, two notes', c.notes.map((n) => n.split(';')[0]), ['it serves 4 interfaces', 'it serves 3 sensors']);
}
{
    const c = capEntities([...ifs('TT'), ...temps(1)], { interfaces: 0, sensors: 0 });
    eq('a cap of 0 refuses every one', [c.kept.length, c.refused], [0, { interfaces: 2, sensors: 1 }]);
}

// --- the abort ---------------------------------------------------------------
console.log('the session abort, against a silent agent:');
const agent = dgram.createSocket('udp4');
let heard = 0;
agent.on('message', () => { heard++; });
await new Promise<void>((ok) => agent.bind(0, '127.0.0.1', () => ok()));
const { port } = agent.address();
const target = { host: '127.0.0.1', port, version: '2c' as const, community: 'public' };
const SYSNAME = '1.3.6.1.2.1.1.5.0';
const REASON = 'the poll ran past its 60 s deadline (POLL_DEADLINE_MS)';

async function settle(p: Promise<unknown>): Promise<{ how: string; kind: string | null; ms: number }> {
    const t0 = performance.now();
    try {
        await p;
        return { how: 'resolved', kind: null, ms: Math.round(performance.now() - t0) };
    } catch (err) {
        return {
            how: (err as Error).message,
            kind: err instanceof SnmpError ? err.kind : 'not an SnmpError',
            ms: Math.round(performance.now() - t0),
        };
    }
}

{
    // Unaborted, the silent agent costs the full timeout and its retry.
    const s = createSession(target);
    const r = await settle(get(s, [SYSNAME]));
    s.close();
    eq('unaborted, a GET waits out its timeout and retry (about 3 s)', [r.kind, r.ms >= 2800], ['timeout', true]);
    eq('and its message is the timeout\'s, not a deadline', r.how.startsWith('Request timed out'), true);
}
{
    const s = createSession(target);
    const p = settle(get(s, [SYSNAME]));
    setTimeout(() => s.abort(REASON), 100);
    const r = await p;
    eq('a GET in flight fails at the abort, with the deadline as its message', [r.how, r.kind], [REASON, 'timeout']);
    eq('within a moment of it, not the 3 s the timeout would take', r.ms < 600, true);
    const after = await settle(get(s, [SYSNAME]));
    eq('a GET after the abort fails at once, the same way', [after.how, after.kind, after.ms < 50], [REASON, 'timeout', true]);
    const w = await settle(walk(s, '1.3.6.1.2.1.2.2.1.2'));
    eq('so does a walk', [w.how, w.kind, w.ms < 50], [REASON, 'timeout', true]);
    s.abort('a second reason');
    eq('a second abort changes nothing', s.aborted, REASON);
}
{
    const s = createSession(target);
    const p = settle(walk(s, '1.3.6.1.2.1.2.2.1.2'));
    setTimeout(() => s.abort(REASON), 100);
    const r = await p;
    eq('a walk in flight fails at the abort, with the deadline as its message', [r.how, r.kind, r.ms < 600], [REASON, 'timeout', true]);
}
{
    // The library's request timers are not cleared when its socket closes
    // (cancelRequests answers the request and leaves the timer); they fire
    // later and try to re-send on the closed socket. That must cost nothing:
    // no uncaught exception, no second settle.
    await new Promise((r) => setTimeout(r, 3500));
    eq('the library\'s late timers after an abort throw nothing', uncaught, []);
}
const heardBefore = heard;
{
    const s = createSession(target);
    s.abort(REASON);
    await settle(get(s, [SYSNAME]));
    await settle(walk(s, '1.3.6.1.2.1.2.2.1.2'));
    await new Promise((r) => setTimeout(r, 100));
    eq('a session aborted before it asks sends nothing at all', heard - heardBefore, 0);
}
agent.close();
{
    // net-snmp also refuses a request on a closed socket, so the silent
    // agent cannot tell whether the refusal above was ours. A fake session
    // counts what reaches the library: after an abort, nothing does.
    let reached = 0;
    const s: import('../src/collector/snmp.ts').Session = {
        close: () => { /* nothing */ }, lastError: null, v3Level: null, aborted: null,
        abort: (reason: string) => { s.aborted = reason; },
        inner: {
            get: (_o: unknown, cb: (err: Error) => void) => { reached++; cb(new Error('reached the library')); },
            subtree: (_o: unknown, _f: unknown, done: (err: Error) => void) => { reached++; done(new Error('reached the library')); },
        },
    };
    s.abort(REASON);
    const g = await settle(get(s, [SYSNAME]));
    const w = await settle(walk(s, '1.3.6.1.2.1.2.2.1.2'));
    eq('after an abort, neither a GET nor a walk reaches the library', [reached, g.how, w.how], [0, REASON, REASON]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
