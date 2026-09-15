// The TCP reach transport (DECISIONS-2026-09-01 ruling 6, rung 1): one port
// per device standing in for HOST reachability where ICMP is filtered but a
// service answers.
//
// THE CONSTRAINT THIS FILE EXISTS TO HONOUR, recorded in the ruling before a
// line of it was written: detection cadence must not degrade exactly when
// the fleet is broken. That is fping's property - per-target waits OVERLAP,
// so a sweep costs N x spacing + ONE timeout tail, never N x timeout - and
// "a naive bounded-parallel connect in Node reintroduces the precise disease
// fping was chosen to avoid": a worker pool where each dead target holds a
// slot for its full timeout makes the all-dead sweep cost N/pool x timeout,
// slowest exactly when the instrument matters most.
//
// So there is NO POOL. Each target's connect starts on a fixed spacing
// schedule and runs concurrently with its own timer, and the arithmetic
// bounds everything a pool would have:
//
//     sweep duration   = (N - 1) x spacing + timeout      (dead or alive)
//     max outstanding <= ceil(timeout / spacing) + 1
//
// The second line is the part that looks missing and is not: a socket
// started at t = i x spacing is gone by i x spacing + timeout, so at any
// instant only the starts from the last `timeout` window are live -
// spacing itself is the concurrency bound, independent of fleet size. At
// the defaults (TCP_CHECK_TIMEOUT_MS=2000 / TCP_CHECK_SPACING_MS=20) that
// is at most 101 sockets however many devices are on the lane - config.ts
// owns the defaults, this header owns the arithmetic, and the two once
// disagreed on this very number (AUDIT-2026-09-01 finding 4: a 3000ms
// draft survived here after config shipped 2000, in the file an operator
// reads to size a file-descriptor budget). Both formulas are exported and
// pinned by
// tools/test-tcpcheck.ts, which also MEASURES the overlap against real
// sockets - the property as a runtime assertion, not a comment.
//
// WHAT A RESULT MEANS, and the rung-1 reading of a refusal is the decision
// worth stating: this probe measures the HOST, not the service, so a
// connection REFUSED (RST) is ALIVE - the host's stack answered, which is
// exactly what an ICMP echo would have proven, from a machine whose
// firewall eats echoes. "Down has flavours" (SLICE-9-PLAN): RST means the
// host is alive and the service is dead; a timeout means the host is gone.
// Rung 2 - service state, many ports per device - is where the flavour
// becomes a distinct surface; here it collapses to alive, deliberately.
// Errors that are OUR failure rather than the network's (file descriptors,
// address exhaustion) yield null - no evidence either way, which reach.ts
// maps to `unknown` - because a page caused by the prober's own limits is
// the instrument testifying about itself.

import net from 'node:net';
import type { ProbeReading } from './reach.ts';

export interface TcpTarget { key: string; host: string; port: number }

/** The sweep-cost half of the header's arithmetic, exported so the test
 *  pins the formula rather than re-deriving it. Zero targets cost zero -
 *  there is no timeout tail with nothing to wait for. */
export function sweepDurationMs(n: number, spacingMs: number, timeoutMs: number): number {
    return n <= 0 ? 0 : (n - 1) * spacingMs + timeoutMs;
}

/** The concurrency half: spacing bounds outstanding sockets independent of
 *  fleet size. */
export function maxOutstanding(n: number, spacingMs: number, timeoutMs: number): number {
    return Math.min(n, Math.ceil(timeoutMs / spacingMs) + 1);
}

const DEAD_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ETIMEDOUT']);
const ALIVE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);

/** One connect, one verdict. Never throws; never resolves twice. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeReading | null> {
    return new Promise((resolve) => {
        const t0 = performance.now();
        const sock = new net.Socket();
        let settled = false;
        const done = (r: ProbeReading | null): void => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(r);
        };
        const rtt = (): number => Number((performance.now() - t0).toFixed(1));
        sock.setTimeout(timeoutMs);
        // 'error' attached BEFORE connect - the house rule for every socket
        // this project opens; an unlistened 'error' is a thrown event. And
        // `on`, not `once`, for the same rule's second clause: once()
        // un-listens after the first error, so a second error on the same
        // socket would throw in the collector worker, which main treats as
        // fatal (AUDIT-2026-09-01 finding 5 - this file stated the rule
        // four lines above the line that broke it). The settled guard makes
        // repeats harmless; the listener's job is only to exist.
        sock.on('error', (err: NodeJS.ErrnoException) => {
            if (ALIVE_CODES.has(err.code ?? '')) done({ alive: true, rttMs: rtt() });
            else if (DEAD_CODES.has(err.code ?? '')) done({ alive: false, rttMs: null });
            else done(null);
        });
        sock.once('timeout', () => done({ alive: false, rttMs: null }));
        sock.once('connect', () => done({ alive: true, rttMs: rtt() }));
        sock.connect(port, host);
    });
}

/**
 * One sweep over the lane: every target keyed by its probe identity
 * (tcpKey - the caller deduped), started on the spacing schedule, all
 * overlapping. Resolves when the last verdict is in; the caller's
 * skip-never-overlap guard owns what happens if that is late.
 */
export function tcpSweep(
    targets: readonly TcpTarget[], timeoutMs: number, spacingMs: number,
): Promise<Map<string, ProbeReading | null>> {
    const out = new Map<string, ProbeReading | null>();
    const started = targets.map((t, i) => new Promise<void>((resolve) => {
        setTimeout(() => {
            tcpProbe(t.host, t.port, timeoutMs).then((r) => {
                out.set(t.key, r);
                resolve();
            }).catch(() => { out.set(t.key, null); resolve(); });
        }, i * spacingMs);
    }));
    return Promise.all(started).then(() => out);
}
