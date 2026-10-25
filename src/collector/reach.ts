// Reachability: the pure half. State machine, fping output parsing, sweep
// aggregation. No sockets, no database, no timers - the collector worker owns
// those, this module owns the DECISIONS, and tools/test-reach.ts asserts them
// offline the way the alert machine's are.
//
// SLICE-9-PLAN.md carries the design; the two rules that shape everything:
//
//  * NO SECOND DEBOUNCER. The state follows raw probe truth one sweep at a
//    time; flap-resistance for PAGING belongs to the alert machine's
//    raiseScans alone. fping is invoked with -r 0 for the same reason - its
//    default 3-retries-with-backoff is a debouncer hiding in a flag.
//  * TRANSITIONS ARE THE ONLY OUTPUT WITH A COST. Every probe updates memory;
//    only a state CHANGE reaches the database. So the one place this module
//    deliberately shapes the signal is the degraded threshold's hysteresis,
//    which exists to bound the EVENT VOLUME, not to protect the pager.

import { isPublicAddress } from '../checks/model.ts';

export type ReachState = 'up' | 'degraded' | 'down' | 'unknown';

/** One device's reading from one sweep. null rtt with alive=true cannot
 *  happen from fping's format; it is treated as up at unknown speed.
 *  `sent` and `answered` are an OUTSIDE target's several pings in one sweep
 *  (slice 68): alive means any came back, and rttMs is their median. Absent
 *  for the single ping every other device gets. */
export interface ProbeReading {
    alive: boolean;
    rttMs: number | null;
    sent?: number;
    answered?: number;
}

/**
 * 30s is the SNMP floor and stays; PING IS WHERE SUB-30s DEMAND LIVES
 * (SLICE-6-PLAN, recorded 2026-07-29). 5s is a fresh derivation, not an
 * inheritance: time-to-page is raiseScans x scan interval + probe interval,
 * and at the 5s floor a down device pages in roughly 15-20s, which is what
 * the people asking for tighter timings actually want.
 *
 * The floor is also a fleet-size statement: a sweep costs about
 * N x send-spacing + timeout, so ~450 devices fit inside 5s and ~1,000 do
 * not. The worker measures its real sweeps and skips a tick rather than
 * overlapping - see the overrun note in the plan.
 */
export const PING_FLOOR_S = 5;

export function validatePingInterval(s: number): void {
    if (!Number.isFinite(s) || s < PING_FLOOR_S) {
        // Refused rather than silently raised, the same manner as the SNMP
        // floor: a caller who asked for 2s finds out they cannot have it.
        throw new Error(`PING_INTERVAL_S=${s} is below the ${PING_FLOOR_S}s floor`);
    }
}

/**
 * Hysteresis on the degraded threshold, and ONLY there.
 *
 * A WAN link that jitters around a fixed 150ms line would cross it dozens of
 * times an hour, and every crossing is a transition, and transitions are
 * writes - the exact per-probe write volume the storage design exists to
 * refuse. So degraded ENTERS at >= degradedMs and exits only below 80% of it.
 * A device sitting in the band stays whatever it already was.
 *
 * up/down gets NO hysteresis: alive is not jittery in the same way, a
 * genuine flap is signal the events table exists to record, and the pager is
 * already protected by raiseScans.
 */
export const DEGRADED_EXIT_RATIO = 0.8;

export function step(
    prev: ReachState, reading: ProbeReading | null, degradedMs: number,
): ReachState {
    if (reading === null) return 'unknown';
    if (!reading.alive) return 'down';
    if (reading.rttMs === null) return prev === 'degraded' ? 'degraded' : 'up';
    if (reading.rttMs >= degradedMs) return 'degraded';
    if (prev === 'degraded' && reading.rttMs >= degradedMs * DEGRADED_EXIT_RATIO) {
        return 'degraded';
    }
    return 'up';
}

// --- OUTSIDE TARGETS, judged by loss (slice 68) --------------------------------
//
// One lost ping is `down` above, and on the LAN that is right: a switch in
// the next room that drops a ping is news. Across the internet it is the
// path's weather. Production's two outside targets lost about one ping in
// six while a model downloaded at 600 Mbit/s (2026-10-23) - replies that
// came back took 22-105 ms, so lost, not late - and each read down and up
// dozens of times and sent twelve emails. The question for such a target
// is HOW MUCH it loses, so it gets several pings a sweep (fping.ts) and:
//
//   down      every ping in the sweep lost - a real outage is seen in one
//             sweep, as fast as before;
//   degraded  the last minute's pings lost at least LOSS ENTRY percent, held
//             until under LOSS EXIT (hysteresis, as for latency: it bounds
//             the event volume); or the latency rule, unchanged;
//   up        otherwise.
//
// NOT a second debouncer, and -r 0 still holds: nothing is retried, and
// `down` still follows the sweep. A sweep of several pings is a
// measurement, not a retry.

/** Is this device an outside target? 'auto' decides by its address - a
 *  public one is outside, the service checks' own rule - and 'yes' or 'no'
 *  is the operator saying so where the address cannot (a public address
 *  that is the next room). */
export function isOutsideTarget(setting: string | null | undefined, host: string): boolean {
    if (setting === 'yes') return true;
    if (setting === 'no') return false;
    return isPublicAddress(host);
}

/** One sweep of an outside target, for its loss window. */
export interface LossSample { sent: number; lost: number }

/** What a window holds right after a silent sweep: no pings, a marker. */
const OUTAGE_MARK: LossSample = Object.freeze({ sent: 0, lost: 0 });

/** Did the last sweep in this window find the target silent? */
export function followsOutage(window: readonly LossSample[]): boolean {
    return window.length === 1 && (window[0] as LossSample).sent === 0;
}

/** The window with this sweep's pings added, the oldest dropped past
 *  `size`. An unreadable sweep (null) adds nothing: no evidence either way.
 *
 *  A SILENT sweep starts the window again. It is an outage - `down`, and
 *  availability's business - not loss: counted as loss, the minute after a
 *  path came back read degraded at 93% on the outage's own pings, and the
 *  ping-loss alert raised as device-down cleared, at 49-65%, on a path that
 *  was answering everything (the lab drill, 2026-10-23). So loss is "lost
 *  while it answered", and the minute after an outage is judged on itself. */
export function pushLossSample(window: readonly LossSample[], reading: ProbeReading | null, size: number): LossSample[] {
    if (reading === null) return [...window];
    const sent = reading.sent ?? 1;
    const answered = reading.answered ?? (reading.alive ? 1 : 0);
    // The outage's mark: a window holding one empty sample.
    if (answered === 0) return [OUTAGE_MARK];
    // The first answer after an outage usually STRADDLES its end - some
    // pings went out while the path was still dark. Its losses are the
    // outage's, so a sweep that lost any is left out (the drill's second
    // run read "degraded 13%" a minute after recovery on just that sweep).
    if (followsOutage(window) && answered < sent) return [];
    const next = [...window.filter((s) => s.sent > 0), { sent, lost: Math.max(0, sent - answered) }];
    return next.length > size ? next.slice(next.length - size) : next;
}

/**
 * The window's loss in percent - or NULL until it holds `size` sweeps. A
 * restart starts the window empty, and one lost ping of the first five is
 * 20%: judging a part-filled window would mark a target degraded on the
 * first blip after every restart.
 */
export function windowLossPct(window: readonly LossSample[], size: number): number | null {
    if (window.length < size) return null;
    let sent = 0, lost = 0;
    for (const s of window) { sent += s.sent; lost += s.lost; }
    return sent > 0 ? (lost / sent) * 100 : null;
}

/** The next state of an outside target: `step`'s rules, with `down` meaning
 *  every ping lost and loss over the window able to make it degraded. */
export function stepOutside(
    prev: ReachState, reading: ProbeReading | null, lossPct: number | null,
    degradedMs: number, lossEnterPct: number, lossExitPct: number,
): ReachState {
    if (reading === null) return 'unknown';
    if (!reading.alive) return 'down';
    const slow = reading.rttMs === null
        ? prev === 'degraded'
        : reading.rttMs >= degradedMs || (prev === 'degraded' && reading.rttMs >= degradedMs * DEGRADED_EXIT_RATIO);
    const lossy = lossPct !== null
        && (lossPct >= lossEnterPct || (prev === 'degraded' && lossPct >= lossExitPct));
    return slow || lossy ? 'degraded' : 'up';
}

/** The median of a non-empty list of numbers. */
function median(xs: readonly number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] as number : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/**
 * One line of `fping -C 1 -q` per-target output, which arrives on STDERR:
 *
 *   10.0.0.1  : 5.42        answered, rtt in ms
 *   10.0.0.1  : -           did not answer
 *   bad.name  : Name or service not known     (and other per-target errors)
 *
 * A PER-TARGET ERROR IS A RESULT, NOT A SWEEP ABORT - the parent's rule, and
 * U6's probe derived it independently, which is how this project decides a
 * rule is load-bearing. An unresolvable name maps to `unknown`: no evidence
 * either way, and 'down' would page somebody about a typo.
 */
export function parseFpingLine(line: string): { host: string; reading: ProbeReading | null } | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    // Whitespace before the colon is REQUIRED: per-target lines pad it
    // ("10.0.0.1 : 5.42") while fping's own diagnostics attach it
    // ("fping: option requires..."), and without this distinction the tool's
    // usage text parses as a phantom host named "fping". Caught by the suite
    // on its first run. The live bring-up must verify the per-target ERROR
    // line shape against a real fping too - this regex encodes the observed
    // format, and an unpadded error line would fall through to null, which
    // degrades to `unknown` for that device: wrong-ish, but never a page.
    const m = /^(\S+)\s+:\s*(.*)$/.exec(trimmed);
    if (m === null) return null;
    const host = m[1] as string;
    const rest = (m[2] as string).trim();
    if (rest === '-') return { host, reading: { alive: false, rttMs: null } };
    const rtt = Number(rest);
    if (Number.isFinite(rtt)) return { host, reading: { alive: true, rttMs: rtt } };
    // SEVERAL PINGS (`-C N`, an outside target - slice 68): one value per
    // ping, a dash for each lost - "203.0.113.4 : 22.10 - 23.40 22.80 -". Every
    // token must be one or the other; a word means fping is explaining a
    // failure, as below.
    const tokens = rest.split(/\s+/);
    if (tokens.length > 1 && tokens.every((t) => t === '-' || Number.isFinite(Number(t)))) {
        const rtts = tokens.filter((t) => t !== '-').map(Number);
        return {
            host,
            reading: {
                alive: rtts.length > 0, rttMs: rtts.length > 0 ? median(rtts) : null,
                sent: tokens.length, answered: rtts.length,
            },
        };
    }
    // Anything else is fping explaining a per-target failure in words.
    return { host, reading: null };
}

/**
 * One fping run's readings, from how it ended and what it printed - or NULL
 * when a signal ended it, which tells the caller to apply NOTHING.
 *
 * A SWEEP FPING DID NOT FINISH SAYS NOTHING (2026-10-08). fping -C prints its
 * per-host lines as it exits, so one ended by a signal leaves none - and a
 * map with no lines reads as every host unknown (hosts absent from it fall
 * through to `unknown` in applySweep). systemd's stop signals every process
 * in the service's cgroup at once, fping included, so a sweep in flight at a
 * restart turned the whole fleet unknown with a recorded transition each:
 * 41 devices at the SIGTERM's millisecond on the alpha.7 upgrade drill, and
 * the operator's whole ping fleet at five restarts in two weeks. The lab's
 * 30k box never showed it - its fleet is one address that answers in
 * microseconds, so a sweep is almost never in flight. A partial print is
 * no better than none: the hosts it lacks would still read unknown. The next
 * sweep decides.
 */
export function sweepReadings(
    signal: string | null, stderr: string,
): Map<string, ProbeReading | null> | null {
    if (signal !== null) return null;
    const readings = new Map<string, ProbeReading | null>();
    for (const line of stderr.split('\n')) {
        const parsed = parseFpingLine(line);
        if (parsed !== null) readings.set(parsed.host, parsed.reading);
    }
    return readings;
}

export interface ReachDevice {
    id: string;
    host: string;
    prev: ReachState;
    /** An outside target (slice 68): several pings a sweep, judged by loss. */
    outside?: boolean;
}

export interface ReachTransition {
    id: string;
    from: ReachState;
    to: ReachState;
    rttMs: number | null;
    /** An outside target's loss over its window when the state moved; null
     *  for every other device, and while the window is filling. */
    lossPct: number | null;
}

/**
 * The probes THIS BUILD can actually perform.
 *
 * `reach_check` names one probe per device and was deliberately given more
 * values than the code ever read: sql/slice12.sql says it is "'icmp' today"
 * and that when the TCP follow-on lands "it is a value here ('tcp'), not a
 * migration". The column kept that promise. The query did not - `reachFleet`
 * asked `reach_check <> 'none'`, which is A BOOLEAN TEST WEARING A
 * DISPATCH'S CLOTHES: everything that was not the opt-out went to fping, so
 * a row set to the documented next value would have been probed by ICMP and
 * reported under a TCP label. Found 2026-08-31 while costing that follow-on,
 * before anything had written 'tcp' - latent, not live.
 *
 * 'tcp' LANDED 2026-09-01 (DECISIONS-2026-09-01 ruling 6, rung 1): one
 * port per device standing in for HOST reachability where ICMP is filtered
 * but a service answers. The transport lives in tcpcheck.ts; what this
 * module gained is the lane in partitionChecks below, and everything else -
 * step(), the degraded band, applySweep - consumes the TCP lane's
 * ProbeReading unchanged, which is exactly why the digest called this rung
 * "a transport plus a dispatch, not a design".
 */
export const SUPPORTED_CHECKS: readonly string[] = ['icmp', 'tcp'];

/** A fleet row as the sweep receives it: a ReachDevice plus the probe it
 *  asked for, and the port when that probe is 'tcp'. 'none' is filtered in
 *  SQL and never arrives here. */
export interface CheckedDevice extends ReachDevice {
    check: string;
    port?: number | null;
}

/** A device on the TCP lane, its port validated by the partition. */
export interface TcpCheckedDevice extends ReachDevice {
    port: number;
}

/** The probe identity for one TCP target. '#' rather than ':', because an
 *  IPv6 host contains ':' and 'fe80::1' probed on 443 must never collide
 *  with another lane's bare-host key when the sweeps' readings merge. */
export const tcpKey = (host: string, port: number): string => `${host}#${port}`;

/**
 * Split the fleet into what can be probed and what cannot.
 *
 * BOTH WRONG ANSWERS ARE AVAILABLE HERE, AND THIS REFUSES BOTH. Probing an
 * unsupported check with fping reports ICMP truth under another probe's
 * name. Dropping it instead - which is what simply changing the query to
 * `= 'icmp'` would do - freezes that device's reach_state at whatever it
 * last was, and on a ping-only device (slice 35, where reach IS the status)
 * that reads as 'up' forever. The second is the worse failure and it is the
 * one the obvious fix produces, so unsupported rows are RETURNED rather than
 * discarded and the worker alarms on them exactly as it alarms on a missing
 * fping.
 *
 * Counted BY VALUE rather than totalled, because the value is the diagnosis:
 * a deliberate 'tcp' and a typo'd 'ICMP' are one defect to this function and
 * two entirely different ones to whoever reads the log. That is also why no
 * CHECK constraint is proposed alongside - a typo caught here names itself,
 * where a constraint would only have refused the write that made it.
 */
export function partitionChecks(devices: readonly CheckedDevice[]): {
    probe: ReachDevice[];
    tcp: TcpCheckedDevice[];
    unsupported: Map<string, number>;
} {
    const probe: ReachDevice[] = [];
    const tcp: TcpCheckedDevice[] = [];
    const unsupported = new Map<string, number>();
    for (const d of devices) {
        if (d.check === 'tcp') {
            // A tcp row without a usable port cannot be probed, and both
            // wrong answers are refused here the same way they are for an
            // unknown value: probing a GUESSED port would report that
            // port's truth under the device's name, and dropping the row
            // would freeze its reach_state - on a ping-only device, its
            // status - forever. The write route requires the port; this
            // catches direct SQL and history, and names what it caught.
            const port = Number(d.port);
            if (Number.isInteger(port) && port >= 1 && port <= 65535) {
                tcp.push({ id: d.id, host: d.host, prev: d.prev, port });
            } else {
                unsupported.set('tcp (no port)', (unsupported.get('tcp (no port)') ?? 0) + 1);
            }
        } else if (SUPPORTED_CHECKS.includes(d.check)) {
            // The outside verdict rides along to choose the fping run; the
            // TCP lane above is one connect a sweep either way.
            probe.push({ id: d.id, host: d.host, prev: d.prev, outside: d.outside === true });
        } else {
            unsupported.set(d.check, (unsupported.get(d.check) ?? 0) + 1);
        }
    }
    return { probe, tcp, unsupported };
}

/**
 * Apply one sweep's readings to the fleet. Pure: returns the transitions and
 * the new per-device states; the worker turns transitions into exactly two
 * statements (one devices UPDATE, one events INSERT, both over unnest - the
 * write-loop checker should never see a per-device write here).
 *
 * DEDUPE BY HOST is the caller's job when building the fping target list -
 * the parent probes a device once however many boards it is on - but the
 * FANOUT lives here: every device row sharing the answering host gets the
 * same reading, so two names for one address cannot disagree about it.
 *
 * The `host` slot is really the PROBE IDENTITY, and the caller chooses it
 * per lane: a bare host for ICMP, tcpKey(host, port) for TCP - so two TCP
 * devices declaring the same host:port share one probe and cannot disagree,
 * while the same host on two ports is two probes, honestly. The fanout
 * property is per key either way, which is what it always meant.
 */
export function applySweep(
    devices: ReachDevice[], readings: Map<string, ProbeReading | null>, degradedMs: number,
    loss?: LossJudge,
): { transitions: ReachTransition[]; states: Map<string, ReachState>; losses: Map<string, number | null> } {
    const transitions: ReachTransition[] = [];
    const states = new Map<string, ReachState>();
    const losses = new Map<string, number | null>();
    for (const d of devices) {
        const reading = readings.has(d.host) ? (readings.get(d.host) ?? null) : null;
        let next: ReachState;
        let lossPct: number | null = null;
        if (d.outside === true && loss !== undefined) {
            const window = pushLossSample(loss.windows.get(d.id) ?? [], reading, loss.size);
            loss.windows.set(d.id, window);
            lossPct = windowLossPct(window, loss.size);
            losses.set(d.id, lossPct);
            next = stepOutside(d.prev, reading, lossPct, degradedMs, loss.enterPct, loss.exitPct);
        } else {
            next = step(d.prev, reading, degradedMs);
        }
        states.set(d.id, next);
        if (next !== d.prev) {
            transitions.push({
                id: d.id, from: d.prev, to: next,
                rttMs: reading === null ? null : reading.rttMs,
                lossPct,
            });
        }
    }
    return { transitions, states, losses };
}

/**
 * How outside targets are judged (slice 68). `windows` is the caller's,
 * kept across sweeps and MUTATED here - one entry per outside device id,
 * its last `size` sweeps; the collector drops ids that stop being outside.
 * A restart starts it empty, and windowLossPct says nothing until it fills.
 */
export interface LossJudge {
    windows: Map<string, LossSample[]>;
    size: number;
    enterPct: number;
    exitPct: number;
}
