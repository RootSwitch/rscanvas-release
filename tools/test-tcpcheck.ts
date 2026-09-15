// The TCP reach transport (ruling 6, rung 1), against REAL sockets on
// localhost - no database, no network beyond the loopback and one
// deliberately unroutable address.
//
// The assertion that matters most is the measured one: the ruling recorded
// fping's cadence property - a sweep costs N x spacing + ONE timeout tail,
// never N x timeout - as the constraint the transport exists to honour, and
// a comment claiming it would be exactly the class this project keeps
// catching. So the all-dead sweep is TIMED, and the suite fails if it costs
// anything like serial.
//
//   node tools/test-tcpcheck.ts

import net from 'node:net';
import {
    tcpProbe, tcpSweep, sweepDurationMs, maxOutstanding, type TcpTarget,
} from '../src/collector/tcpcheck.ts';
import { tcpKey } from '../src/collector/reach.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

// RFC 5737 TEST-NET-1: reserved for documentation, never routed. A SYN to it
// either times out or comes back net/host-unreachable - both of which must
// read DEAD, so the assertion holds whichever the local stack produces.
const BLACKHOLE = '192.0.2.1';

async function main(): Promise<void> {
    console.log('the tcp reach transport, offline\n');

    console.log('the arithmetic, pinned as formulas:');
    eq('sweep duration is (N-1) x spacing + timeout', sweepDurationMs(10, 20, 2000), 9 * 20 + 2000);
    eq('zero targets cost zero - no timeout tail with nothing to wait for',
        sweepDurationMs(0, 20, 2000), 0);
    eq('one target costs one timeout, no spacing', sweepDurationMs(1, 20, 2000), 2000);
    eq('outstanding sockets are bounded by spacing, INDEPENDENT of fleet size',
        maxOutstanding(100000, 20, 2000), Math.ceil(2000 / 20) + 1);
    eq('and never exceed the fleet itself', maxOutstanding(3, 20, 2000), 3);

    console.log('\nverdicts, against real sockets:');
    const server = net.createServer(() => { /* accept and hold */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const openPort = (server.address() as net.AddressInfo).port;

    const alive = await tcpProbe('127.0.0.1', openPort, 1000);
    if (alive?.alive === true && typeof alive.rttMs === 'number' && alive.rttMs >= 0) {
        ok(`a listening port is ALIVE with an rtt (${alive.rttMs}ms)`);
    } else bad('a listening port did not read alive', alive);

    server.close();
    await new Promise<void>((resolve) => server.once('close', () => resolve()));
    const refused = await tcpProbe('127.0.0.1', openPort, 1000);
    // THE RUNG-1 READING, and the one assertion that documents the rung: a
    // refusal is the host's stack ANSWERING. This probe measures the HOST -
    // an ICMP substitute for machines whose firewalls eat echoes - so RST
    // proves exactly what an echo reply would have. "Down has flavours"
    // (host alive, service dead) is rung 2's surface, not a down here.
    if (refused?.alive === true) {
        ok('a REFUSED connection is ALIVE - the host answered, which is what rung 1 measures');
    } else bad('a refusal did not read alive', refused);

    const dead = await tcpProbe(BLACKHOLE, 9, 400);
    if (dead !== null && dead.alive === false) {
        ok('an unroutable address is DEAD (timeout or unreachable, either way)');
    } else bad('the blackhole did not read dead', dead);

    console.log('\nTHE CADENCE PROPERTY, measured rather than claimed:');
    {
        // Four dead targets, 250ms timeout, 25ms spacing. Overlapping:
        // (4-1) x 25 + 250 = 325ms. Serial - the disease - is 1000ms. The
        // bound sits between them with slack for a loaded machine, so a
        // regression to slot-holding fails this while honest jitter passes.
        const T = 250, S = 25, N = 4;
        const targets: TcpTarget[] = Array.from({ length: N }, (_, i) => ({
            key: tcpKey(BLACKHOLE, 9000 + i), host: BLACKHOLE, port: 9000 + i,
        }));
        const t0 = performance.now();
        const readings = await tcpSweep(targets, T, S);
        const took = performance.now() - t0;
        const formula = sweepDurationMs(N, S, T);
        const serial = N * T;
        if (took < (formula + serial) / 2) {
            ok(`an all-dead sweep of ${N} cost ${Math.round(took)}ms - near the formula's `
                + `${formula}ms, nowhere near serial's ${serial}ms`);
        } else {
            bad(`the all-dead sweep cost ${Math.round(took)}ms - the N x timeout disease`, {
                formula, serial,
            });
        }
        eq('every target got a verdict, keyed by its probe identity',
            [...readings.keys()].sort(), targets.map((t) => t.key).sort());
        if ([...readings.values()].every((r) => r !== null && r.alive === false)) {
            ok('and every verdict is dead, none unknown - the timeout is a verdict');
        } else bad('a blackhole verdict was not dead', [...readings.entries()]);
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

void main();
