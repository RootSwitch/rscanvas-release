// Slice 9's decisions, asserted offline: the reachability state machine, the
// fping line parser, and sweep aggregation. Pure module, no database - the
// same standing as test-machine.ts, and for the same reason: what lives here
// is the DECISIONS; the worker wiring is verified live on the sandbox.
//
// The fixture bias is named in SLICE-9-PLAN.md and it is why this file leans
// hard on the degraded band: the live fixture (TEST-NET for down, LAN
// neighbours for up) cannot produce a half-dead device that answers slowly,
// so the hysteresis rules ship on these assertions alone.
//
// PROVEN ABLE TO FAIL, 2026-08-14 - six defects planted one at a time in the
// shipped module, every one caught:
//
//   hysteresis removed (exit at entry threshold)    -> 3
//   the floor check inverted                        -> 3
//   missing reading becomes DOWN instead of unknown -> 2
//   per-target error becomes DOWN (pages on a typo) -> 1
//   transitions fire every sweep, changed or not    -> 1
//   diagnostic lines parse as hosts (space optional)-> 1
//
// The last one is the suite's own first catch, promoted to a planted defect:
// on its first run it found `fping: usage` parsing as a phantom host named
// "fping", because the original regex made the pre-colon whitespace optional.

import {
    step, parseFpingLine, sweepReadings, applySweep, validatePingInterval,
    partitionChecks, SUPPORTED_CHECKS, tcpKey,
    PING_FLOOR_S, DEGRADED_EXIT_RATIO,
    type ReachState, type ProbeReading,
} from '../src/collector/reach.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

const D = 150;   // degradedMs used throughout; the exit line is 120

/** Run a probe sequence through step(), collecting the state trace. */
function run(start: ReachState, seq: Array<ProbeReading | null>): ReachState[] {
    const out: ReachState[] = [];
    let s = start;
    for (const r of seq) { s = step(s, r, D); out.push(s); }
    return out;
}

const up = (rtt: number): ProbeReading => ({ alive: true, rttMs: rtt });
const DEAD: ProbeReading = { alive: false, rttMs: null };

function main(): void {
    console.log('slice 9 offline: reachability decisions\n');

    console.log('classification');
    eq('a fast answer is up', step('unknown', up(5), D), 'up');
    eq('a slow answer is degraded', step('unknown', up(200), D), 'degraded');
    eq('no answer is down', step('up', DEAD, D), 'down');
    eq('no reading at all is unknown - absence of data is not an outage',
        step('up', null, D), 'unknown');
    eq('alive with unparsable rtt stays up rather than guessing degraded',
        step('up', { alive: true, rttMs: null }, D), 'up');
    eq('and if already degraded, an rtt-less answer does not clear it',
        step('degraded', { alive: true, rttMs: null }, D), 'degraded');
    eq('recovery: down then answering is up again', step('down', up(3), D), 'up');

    console.log('\nthe hysteresis band, which exists to bound WRITES not pages');
    {
        // Jitter around the 150 line: without hysteresis this writes a
        // transition per crossing; with it, ONE entry into degraded and hold.
        const trace = run('up', [up(149), up(151), up(149), up(151), up(130), up(145)]);
        eq('jitter around the threshold enters degraded once and HOLDS',
            trace, ['up', 'degraded', 'degraded', 'degraded', 'degraded', 'degraded']);
        const changes = trace.filter((s, i) => s !== (i === 0 ? 'up' : trace[i - 1])).length;
        eq('which is exactly one transition, not five', changes, 1);
    }
    eq(`exit is below ${DEGRADED_EXIT_RATIO * D} (${DEGRADED_EXIT_RATIO} of the threshold), not below the threshold`,
        run('degraded', [up(125), up(119)]), ['degraded', 'up']);
    eq('a device inside the band keeps its CURRENT state when that state is up',
        step('up', up(130), D), 'up');
    eq('down has NO hysteresis - a genuine flap is signal, and raiseScans owns the pager',
        run('up', [DEAD, up(5), DEAD]), ['down', 'up', 'down']);

    console.log('\nfping line parsing (stderr of fping -C 1 -q)');
    eq('an answer with rtt', parseFpingLine('10.0.0.1  : 5.42'),
        { host: '10.0.0.1', reading: { alive: true, rttMs: 5.42 } });
    eq('a dash is a no-answer', parseFpingLine('192.0.2.7 : -'),
        { host: '192.0.2.7', reading: { alive: false, rttMs: null } });
    eq('a per-target error is UNKNOWN, because down would page somebody about a typo',
        parseFpingLine('bad.name : Name or service not known'),
        { host: 'bad.name', reading: null });
    eq('blank lines are not results', parseFpingLine('   '), null);
    eq('garbage without a colon is not a result', parseFpingLine('fping: usage'), null);
    eq('an IPv6 target parses', parseFpingLine('2001:db8::1 : 12.0')?.host, '2001:db8::1');

    console.log('\na sweep fping did not finish (2026-10-08: a restart turned the fleet unknown)');
    const printed = '10.0.0.1  : 5.42\n192.0.2.7 : -\n';
    const done = sweepReadings(null, printed);
    eq('a sweep that ran to its end gives every line it printed', done === null ? null : [...done.keys()], ['10.0.0.1', '192.0.2.7']);
    eq('...a no-answer among them, which is a result', done?.get('192.0.2.7'), { alive: false, rttMs: null });
    eq('a sweep ended by a signal before printing says NOTHING - null, not an empty map', sweepReadings('SIGTERM', ''), null);
    eq('nor does one that printed part of its lines: the rest would read unknown', sweepReadings('SIGKILL', '10.0.0.1  : 5.42\n'), null);
    eq('a finished run that printed nothing is still a result (its hosts read unknown, as before)', sweepReadings(null, '')?.size, 0);

    console.log('\nsweep aggregation');
    {
        const fleet = [
            { id: '1', host: '10.0.0.1', prev: 'up' as ReachState },
            { id: '2', host: '10.0.0.2', prev: 'up' as ReachState },
            { id: '3', host: '10.0.0.1', prev: 'down' as ReachState },   // shares 1's host
            { id: '4', host: '10.0.0.9', prev: 'up' as ReachState },     // not in readings
        ];
        const readings = new Map<string, ProbeReading | null>([
            ['10.0.0.1', up(4)],
            ['10.0.0.2', DEAD],
        ]);
        const r = applySweep(fleet, readings, D);
        eq('unchanged devices produce NO transition', r.states.get('1'), 'up');
        eq('a death is a transition', r.transitions.find((t) => t.id === '2')?.to, 'down');
        eq('FANOUT: a second device row on the same host gets the same answer',
            r.states.get('3'), 'up');
        eq('and its recovery is its own transition',
            r.transitions.find((t) => t.id === '3')?.from, 'down');
        eq('a device the sweep never answered for goes UNKNOWN, not down',
            r.states.get('4'), 'unknown');
        eq('transition count is exactly the changed devices', r.transitions.length, 3);
        eq('rtt rides the transition when there is one',
            r.transitions.find((t) => t.id === '3')?.rttMs, 4);
        eq('and is null on a death, not a stale number',
            r.transitions.find((t) => t.id === '2')?.rttMs, null);
    }

    console.log('\nthe floor');
    try { validatePingInterval(PING_FLOOR_S); ok(`the floor itself (${PING_FLOOR_S}s) is legal`); }
    catch { bad('the floor refused its own value'); }
    try { validatePingInterval(2); bad('2s was accepted below the floor'); }
    catch { ok('below the floor is REFUSED, not silently raised - same manner as the SNMP floor'); }
    try { validatePingInterval(Number.NaN); bad('NaN was accepted'); }
    catch { ok('NaN is refused too'); }

    // ---- reach_check dispatch (2026-08-31) --------------------------------
    // The column carried three documented values while the query tested for
    // one. These assert BOTH mistakes that were available, because the second
    // is the one the obvious fix produces.
    console.log('\nreach_check dispatch:');
    {
        const dev = (id: string, check: string, port?: number | null) =>
            ({ id, host: `10.0.0.${id}`, prev: 'up' as ReachState, check, port });

        const plain = partitionChecks([dev('1', 'icmp'), dev('2', 'icmp')]);
        eq('icmp devices are probed', plain.probe.length, 2);
        eq('and nothing is reported unsupported', plain.unsupported.size, 0);

        // Since 2026-09-01 (ruling 6, rung 1) 'tcp' is a SUPPORTED check
        // with its own lane. The assertion this replaces said tcp must land
        // unsupported - which was the truth of a build that could not probe
        // it; the property both versions pin is the same one: a check goes
        // to ITS OWN transport or to the accounting, never to fping.
        const mixed = partitionChecks([dev('1', 'icmp'), dev('2', 'tcp', 443), dev('3', 'tcp', 8443)]);
        eq("'tcp' is still NOT handed to fping", mixed.probe.map((d) => d.id), ['1']);
        eq('it rides its own lane, port and all',
            mixed.tcp.map((d) => [d.id, d.port]), [['2', 443], ['3', 8443]]);
        eq('and nothing lands unsupported', mixed.unsupported.size, 0);

        // A tcp row without a usable port: both wrong answers refused, as
        // ever - a guessed port would report that port's truth under the
        // device's name, a drop would freeze its state.
        const noPort = partitionChecks([dev('1', 'tcp', null), dev('2', 'tcp', 0), dev('3', 'tcp', 70000)]);
        eq('a tcp row without a valid port is counted, not probed and not dropped',
            noPort.unsupported.get('tcp (no port)'), 3);
        eq('and rides neither lane', [noPort.probe.length, noPort.tcp.length], [0, 0]);

        const typo = partitionChecks([dev('1', 'ICMP')]);
        eq('a typo is unsupported rather than probed', typo.probe.length, 0);
        eq('and the alarm gets the offending value verbatim, not just a total',
            [...typo.unsupported.keys()], ['ICMP']);

        eq('the supported set is what the build can really do',
            [...SUPPORTED_CHECKS], ['icmp', 'tcp']);

        // 'none' never arrives - reachFleet filters it in SQL. If it ever did,
        // it must land unsupported rather than be probed: an opt-out that gets
        // probed is the same class of bug pointing the other way.
        const optout = partitionChecks([dev('1', 'none')]);
        eq("a leaked 'none' is refused a probe, not silently swept",
            [optout.probe.length, optout.tcp.length], [0, 0]);

        // The probe identity: '#', never ':', because an IPv6 host CONTAINS
        // ':' and the two lanes' readings merge into one map.
        eq('a tcp key cannot collide with an IPv6 icmp host',
            tcpKey('fe80::1', 443), 'fe80::1#443');
    }
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
