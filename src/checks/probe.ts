// Service checks: the I/O half. One run of one check, start to verdict.
//
// Never throws and never resolves twice: every path ends in a CheckResult,
// because the collector runs these concurrently with nothing but a result
// handler behind them, and a throw on that thread is fatal to the process.
//
// WHY node:http AND NOT fetch. Three things a check needs that fetch hides:
// the certificate (its expiry is half the reason to check https at all), the
// socket's own verdict on it (authorized / authorizationError), and redirect
// control - same host only, every hop's address judged again. So each hop is
// one request on a fresh connection (agent: false), which also keeps the
// timings honest: a pooled connection would report a handshake it never did.
//
// THE CERTIFICATE IS ALWAYS READ, then judged. Connecting with
// rejectUnauthorized: true destroys the socket before an expired
// certificate's date can be read, so the connection is made with false and
// the TLS socket's own authorizationError - which Node computes either way,
// hostname check included - decides. With verification on, an unauthorized
// connection is cut at secureConnect and the outcome names why; with it off
// (an internal site's self-signed certificate) the check goes on, and its
// expiry is still recorded.
//
// TRUST is Node's bundled roots plus the operating system's store, so an
// internal CA installed on the box (update-ca-certificates) is honoured
// without turning verification off for every internal site.

import { execFile } from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {
    addressRefusal, assertionPasses, bareHost, BODY_CAP_BYTES, certDaysFrom, classifyNetError,
    classifyTlsAuth, codeExpected, IDLE_PINGS, IPERF_CLIENT_INTERRUPTED, MAX_REDIRECTS, median, OMIT_S, OUTCOME_TEXT,
    parseFpingTimes, parseIperfOneWay,
    parseIperfTcp, PING_PERIOD_MS, voiceReading, VOICE_BITRATE, VOICE_PAYLOAD_BYTES,
    type CheckDef, type CheckKind, type CheckResult, type HttpCheckDef, type OutcomeName, type TcpCheckDef,
    type ThroughputCheckDef, type VoiceCheckDef,
} from './model.ts';

const ms = (t0: number): number => Number((performance.now() - t0).toFixed(1));

let ctxMade = false;
let ctx: tls.SecureContext | undefined;
/** One secure context for every check: bundled roots plus the system store.
 *  Built once - parsing a few hundred roots per request would be the cost
 *  of the whole check. Undefined (Node's default roots) if this Node cannot
 *  list them. */
function secureContext(): tls.SecureContext | undefined {
    if (ctxMade) return ctx;
    ctxMade = true;
    try {
        if (typeof tls.getCACertificates === 'function') {
            const ca = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
            ctx = tls.createSecureContext({ ca });
        }
    } catch {
        ctx = undefined;
    }
    return ctx;
}

class Failure extends Error {
    outcome: OutcomeName;
    constructor(outcome: OutcomeName, detail: string) {
        super(detail);
        this.outcome = outcome;
    }
}

function failureOf(err: unknown): Failure {
    if (err instanceof Failure) return err;
    const e = err as NodeJS.ErrnoException;
    const outcome = classifyNetError(e?.code, e?.message ?? '');
    return new Failure(outcome, `${OUTCOME_TEXT[outcome]}${e?.code ? ` (${e.code})` : ''}`);
}

/*
 * NAME LOOKUPS ARE RATIONED (2026-10-06). dns.lookup is getaddrinfo on
 * libuv's threadpool, and libuv runs at most half the pool's threads of
 * lookups at once - two, at the default four - for the whole process: every
 * worker thread's lookups, the mail sender's, and until the same day each
 * new database connection's ("localhost"; store/pool.ts now connects by
 * address). A lookup the DNS server never answers holds its slot for the
 * resolver's own timeouts (10 s at glibc's defaults, measured), long after
 * the check that asked has given up, and the next run asks again. In the
 * operator's second real outage (DNS blocked 21 minutes on the lab) the
 * name-based checks held both slots, database connects queued behind them
 * and timed out 93 times, and polls that could not reach the database read
 * as about a hundred lab devices going down and up.
 *
 * So checks hold ONE lookup between them, and leave the other slot to the
 * rest of the process. A check for a name already being looked up waits on
 * that lookup rather than starting another; a check that cannot get the
 * slot before its deadline fails as dns without asking - the slot is held
 * only while an earlier lookup is unanswered. Normally a lookup takes a
 * millisecond or so (the system resolver caches), so a check that waits at
 * all waits about that long. The state is per thread; checks run on the
 * collector's only.
 */
const LOOKUP_SLOTS = 1;
type Lookup = (host: string) => Promise<{ address: string }>;
let lookupImpl: Lookup = (host) => dns.promises.lookup(host, { verbatim: true });
const lookupsInFlight = new Map<string, Promise<{ address: string }>>();
const slotWaiters = new Set<() => void>();

/** For tools/test-service-checks.ts: a lookup that answers when told to. */
export function _setLookupForTests(fn: Lookup | null): void {
    lookupImpl = fn ?? ((host) => dns.promises.lookup(host, { verbatim: true }));
}
export function _lookupsInFlightForTests(): number { return lookupsInFlight.size; }

/** Settle with `p`, or fail as dns at the deadline - whichever is first. */
async function byDeadline<T>(p: Promise<T>, deadline: number, detail: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Failure('dns', detail)), Math.max(0, deadline - performance.now()));
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function rationedLookup(host: string, deadline: number): Promise<{ address: string }> {
    // A lookup that outlives the check is a DNS failure, not a service that
    // did not answer: the first real outage's DNS block (2026-10-05) read
    // "no answer in time" on every name-based check until this said what it was.
    const late = `${host}: the name lookup did not finish in time`;
    for (;;) {
        const shared = lookupsInFlight.get(host);
        if (shared) return byDeadline(shared, deadline, late);
        if (lookupsInFlight.size < LOOKUP_SLOTS) break;
        let wake: () => void = () => {};
        const freed = new Promise<void>((r) => { wake = r; });
        slotWaiters.add(wake);
        try {
            await byDeadline(freed, deadline, `${host}: not looked up - earlier name lookups are still unanswered`);
        } finally {
            slotWaiters.delete(wake);
        }
    }
    const p = lookupImpl(host);
    lookupsInFlight.set(host, p);
    // then(done, done), not finally(): finally's promise would carry a
    // rejection nobody awaits once every asker has passed its deadline.
    const done = (): void => {
        lookupsInFlight.delete(host);
        for (const w of slotWaiters) w();
    };
    p.then(done, done);
    return byDeadline(p, deadline, late);
}

/** Resolve a name within the deadline; addresses pass through untouched. */
async function resolve(host: string, deadline: number): Promise<{ address: string; dnsMs: number | null }> {
    if (net.isIP(host) !== 0) return { address: host, dnsMs: null };
    const t0 = performance.now();
    if (deadline - performance.now() <= 0) throw new Failure('timeout', 'no time left to resolve the name');
    try {
        const r = await rationedLookup(host, deadline);
        return { address: r.address, dnsMs: ms(t0) };
    } catch (err) {
        if (err instanceof Failure) throw err;
        const e = err as NodeJS.ErrnoException;
        throw new Failure('dns', `${host}: ${OUTCOME_TEXT.dns}${e.code ? ` (${e.code})` : ''}`);
    }
}

function refuseAddress(address: string): void {
    const why = addressRefusal(address);
    if (why !== null) throw new Failure('address-refused', `${address} is ${why} - checks refuse it`);
}

interface Hop {
    status: number;
    location: string | null;
    connectMs: number | null;
    certDays: number | null;
    body: string | null;
    tooLarge: boolean;
}

/** One request on one fresh connection. */
function hop(u: URL, address: string, def: HttpCheckDef, readBody: boolean, deadline: number): Promise<Hop> {
    return new Promise((resolveHop, rejectHop) => {
        let settled = false;
        let connectMs: number | null = null;
        let certDays: number | null = null;
        const isTls = u.protocol === 'https:';
        const host = bareHost(u.hostname);
        const opts: https.RequestOptions & { secureContext?: tls.SecureContext } = {
            host: address,
            port: u.port === '' ? (isTls ? 443 : 80) : Number(u.port),
            method: def.method,
            path: `${u.pathname}${u.search}`,
            headers: {
                host: u.host,
                'user-agent': 'RSCanvas service check',
                accept: '*/*',
                connection: 'close',
            },
            agent: false,
        };
        if (isTls) {
            // SNI and the certificate's name check both use the URL's name,
            // whichever address the connection went to - that is what makes
            // pinning safe to offer. An address has no SNI.
            if (net.isIP(host) === 0) opts.servername = host;
            opts.rejectUnauthorized = false;
            const sc = secureContext();
            if (sc !== undefined) opts.secureContext = sc;
        }
        const req = (isTls ? https : http).request(opts);
        const finish = (err: Failure | null, h?: Hop): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            req.destroy();
            if (err) rejectHop(err); else resolveHop(h as Hop);
        };
        const left = Math.max(1, deadline - performance.now());
        const timer = setTimeout(() => finish(new Failure('timeout', OUTCOME_TEXT.timeout)), left);
        // Listeners with `on`, attached before anything can fire: an
        // unlistened 'error' is a thrown event on the collector thread, and
        // a second one after `once` un-listened would be too (tcpcheck.ts).
        req.on('error', (err) => finish(failureOf(err)));
        req.on('socket', (sock: net.Socket) => {
            const t0 = performance.now();
            sock.on('error', () => { /* the request's handler decides */ });
            if (!isTls) {
                sock.once('connect', () => { connectMs = ms(t0); });
                return;
            }
            sock.once('secureConnect', () => {
                connectMs = ms(t0);
                const ts = sock as tls.TLSSocket;
                certDays = certDaysFrom(ts.getPeerCertificate()?.valid_to, Date.now());
                if (def.verifyTls && !ts.authorized) {
                    const code = String(ts.authorizationError ?? 'UNKNOWN');
                    const outcome = classifyTlsAuth(code);
                    finish(Object.assign(new Failure(outcome, `${OUTCOME_TEXT[outcome]} (${code})`), { certDays }));
                }
            });
        });
        req.on('response', (res) => {
            res.on('error', () => { /* the request's handler decides */ });
            const base = {
                status: res.statusCode ?? 0,
                location: typeof res.headers.location === 'string' ? res.headers.location : null,
                connectMs, certDays,
            };
            // The body is read only when an assertion will judge it - an
            // answer whose status already failed the check has nothing to
            // say that the status did not.
            if (!readBody || !codeExpected(def.expect, res.statusCode ?? 0)) {
                finish(null, { ...base, body: null, tooLarge: false });
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
                size += c.length;
                if (size > BODY_CAP_BYTES) {
                    finish(null, { ...base, body: null, tooLarge: true });
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => finish(null, { ...base, body: Buffer.concat(chunks).toString('utf8'), tooLarge: false }));
        });
        req.end();
    });
}

function result(partial: Partial<CheckResult> & { outcome: OutcomeName; detail: string }): CheckResult {
    return {
        httpStatus: null, totalMs: null, connectMs: null, dnsMs: null, certDays: null,
        assertion: null, peer: null, ...partial,
    };
}

async function runHttp(def: HttpCheckDef, deviceHost: string): Promise<CheckResult> {
    const t0 = performance.now();
    const deadline = t0 + def.timeoutS * 1000;
    let u = new URL(def.url);
    let dnsMs: number | null = null;
    let peer: string | null = null;
    let certDays: number | null = null;
    let connectMs: number | null = null;
    try {
        for (let hops = 0; ; hops++) {
            let address: string;
            if (def.connect === 'pin') {
                address = deviceHost;
            } else {
                const r = await resolve(bareHost(u.hostname), deadline);
                address = r.address;
                if (r.dnsMs !== null) dnsMs = (dnsMs ?? 0) + r.dnsMs;
            }
            refuseAddress(address);
            peer = address;
            const h = await hop(u, address, def, def.assertion !== null, deadline);
            certDays = h.certDays ?? certDays;
            connectMs = h.connectMs;
            const base = { httpStatus: h.status, connectMs, dnsMs, certDays, peer };
            const expected = codeExpected(def.expect, h.status);
            if (h.status >= 300 && h.status < 400 && !expected && h.location !== null) {
                let next: URL;
                try {
                    next = new URL(h.location, u);
                } catch {
                    return result({ ...base, outcome: 'wrong-status', totalMs: ms(t0), detail: `${h.status} with a Location that is not a URL` });
                }
                const sameHost = next.hostname.toLowerCase() === u.hostname.toLowerCase()
                    && (next.protocol === 'http:' || next.protocol === 'https:');
                if (!sameHost) {
                    return result({ ...base, outcome: 'other-host-redirect', totalMs: ms(t0), detail: `${h.status} to ${next.host} - not followed; expect ${h.status} to accept the redirect, or check ${next.host} itself` });
                }
                if (hops >= MAX_REDIRECTS) {
                    return result({ ...base, outcome: 'wrong-status', totalMs: ms(t0), detail: `more than ${MAX_REDIRECTS} redirects` });
                }
                u = next;
                continue;
            }
            const totalMs = ms(t0);
            if (!expected) {
                return result({ ...base, outcome: 'wrong-status', totalMs, detail: `${h.status}, expected ${def.expect}` });
            }
            if (def.assertion === null) {
                return result({ ...base, outcome: 'ok', totalMs, detail: `${h.status} in ${Math.round(totalMs)} ms` });
            }
            if (h.tooLarge) {
                return result({ ...base, outcome: 'too-large', totalMs, detail: `${h.status}, but the body is over ${BODY_CAP_BYTES / 1_048_576} MB - the assertion was not judged` });
            }
            const pass = assertionPasses(def.assertion, h.body ?? '');
            return result({
                ...base, totalMs, assertion: pass ? 1 : 0,
                outcome: pass ? 'ok' : 'wrong-content',
                detail: `${h.status} in ${Math.round(totalMs)} ms, assertion ${pass ? 'passed' : 'FAILED'}`,
            });
        }
    } catch (err) {
        const f = failureOf(err);
        const cd = (err as { certDays?: number | null }).certDays;
        return result({
            outcome: f.outcome, dnsMs, peer, connectMs,
            certDays: cd ?? certDays, detail: f.message,
        });
    }
}

async function runTcp(def: TcpCheckDef, deviceHost: string): Promise<CheckResult> {
    const t0 = performance.now();
    const deadline = t0 + def.timeoutS * 1000;
    let dnsMs: number | null = null;
    let address: string;
    try {
        const r = await resolve(def.host ?? deviceHost, deadline);
        address = r.address;
        dnsMs = r.dnsMs;
        refuseAddress(address);
    } catch (err) {
        const f = failureOf(err);
        return result({ outcome: f.outcome, dnsMs, detail: f.message });
    }
    return new Promise<CheckResult>((done) => {
        const sock = new net.Socket();
        const tc = performance.now();
        let settled = false;
        const finish = (r: CheckResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            done(r);
        };
        const timer = setTimeout(() => finish(result({ outcome: 'timeout', dnsMs, peer: address, detail: OUTCOME_TEXT.timeout })),
            Math.max(1, deadline - performance.now()));
        sock.on('error', (err: NodeJS.ErrnoException) => {
            // RUNG 2's reading of a refusal, the opposite of rung 1's: the
            // host answered and the SERVICE is not there, which is exactly
            // what a service check exists to say.
            const f = failureOf(err);
            finish(result({ outcome: f.outcome, dnsMs, peer: address, detail: f.message }));
        });
        sock.once('connect', () => {
            const c = ms(tc);
            finish(result({
                outcome: 'ok', dnsMs, peer: address, connectMs: c, totalMs: ms(t0),
                detail: `connected in ${Math.round(c)} ms`,
            }));
        });
        sock.connect(def.port, address);
    });
}

/** One run of one check. Never throws. */
/**
 * One voice test (slice 60): the iperf3 CLIENT as a child process, the way
 * fping is run - an argument array, never a shell, JSON out, read once when
 * it exits. The program does the measuring and this thread only reads a
 * result, so a ten-second call costs the collector nothing.
 *
 * The name is resolved HERE, not by iperf3, so the address is judged by the
 * same refusal as every check's and the card can say which one answered.
 * The delay for the MOS estimate is the device's ping round trip, passed in:
 * iperf3 measures no latency over UDP.
 */
async function runVoice(def: VoiceCheckDef, deviceHost: string, rttMs: number | null): Promise<CheckResult> {
    const t0 = performance.now();
    const deadline = t0 + def.timeoutS * 1000;
    let address: string;
    let dnsMs: number | null = null;
    try {
        const r = await resolve(def.host ?? deviceHost, deadline);
        address = r.address;
        dnsMs = r.dnsMs;
        refuseAddress(address);
    } catch (err) {
        const f = failureOf(err);
        return result({ outcome: f.outcome, dnsMs, detail: f.message, voice: null });
    }
    // ONE WAY AT A TIME (model.ts, parseIperfOneWay, says why): toward the
    // site, then reversed. Either failing ends the test with its reason.
    const to = await oneWay(address, def, false, deadline);
    if (!to.ok) return result({ outcome: to.outcome, dnsMs, peer: address, voice: null, detail: to.detail });
    const from = await oneWay(address, def, true, deadline);
    if (!from.ok) return result({ outcome: from.outcome, dnsMs, peer: address, voice: null, detail: from.detail });
    const voice = voiceReading({ lossTo: to.loss, lossFrom: from.loss, jitterTo: to.jitter, jitterFrom: from.jitter }, rttMs);
    return result({
        outcome: 'ok', dnsMs, peer: address, totalMs: Math.round(performance.now() - t0), voice,
        detail: `toward the site ${to.loss}% lost, ${to.jitter} ms jitter; from it ${from.loss}% lost, `
            + `${from.jitter} ms jitter; ${voice.mos === null ? 'no MOS - the device has no ping round trip yet' : `MOS ${voice.mos}`}`,
    });
}

type Fail = { ok: false; outcome: OutcomeName; detail: string };

/** One one-way voice call, never throwing. */
function oneWay(address: string, def: VoiceCheckDef, reverse: boolean, deadline: number):
    Promise<{ ok: true; loss: number; jitter: number } | Fail> {
    return iperf3([
        '-c', address, '-p', String(def.port),
        '-u', '-b', VOICE_BITRATE, '-l', String(VOICE_PAYLOAD_BYTES),
        '--dscp', String(def.dscp), '-t', String(def.durationS),
        ...(reverse ? ['-R'] : []), '-J', '--connect-timeout', '3000',
    ], deadline, parseIperfOneWay);
}

/** One TCP throughput call (slice 61), never throwing: slow start omitted,
 *  capped for headroom, one stream. */
function tcpCall(address: string, def: ThroughputCheckDef, reverse: boolean, deadline: number):
    Promise<{ ok: true; mbps: number; retransmits: number | null } | Fail> {
    return iperf3([
        '-c', address, '-p', String(def.port),
        '-t', String(def.durationS), '-O', String(OMIT_S),
        ...(def.capMbps !== null ? ['-b', `${def.capMbps}M`] : []),
        ...(reverse ? ['-R'] : []), '-J', '--connect-timeout', '3000',
    ], deadline, parseIperfTcp);
}

/**
 * fping's round trips to one address: `count` pings, PING_PERIOD_MS apart,
 * marked with `tos` (184 is EF) when given. Never throws; a ping that did
 * not come back is simply absent, and fping missing is an empty series.
 */
function pingSeries(address: string, count: number, tos: number): Promise<number[]> {
    return new Promise((done) => {
        const args = ['-C', String(count), '-p', String(PING_PERIOD_MS), '-q', ...(tos > 0 ? ['-O', String(tos)] : []), address];
        execFile('fping', args, { timeout: count * PING_PERIOD_MS + 5000, windowsHide: true }, (_err, stdout, stderr) => {
            // fping writes -C's lines to stderr and exits non-zero when any
            // ping was lost: the output decides, never the status.
            done(parseFpingTimes(`${String(stderr ?? '')}\n${String(stdout ?? '')}`));
        });
    });
}

/**
 * One throughput test (slice 61). Two seconds of idle pings first, then a
 * TCP call toward the site and one back, each with two fping streams beside
 * it - unmarked and marked EF - for its whole length:
 *
 *  * the unmarked stream's median under load, against the idle one, is
 *    BUFFERBLOAT - what everything else crossing the link feels while it is
 *    full, which SNMP and idle pings cannot show;
 *  * the EF stream is the QOS CHECK the operator's field collision was by
 *    accident: if it stays near idle while the unmarked one climbs, the
 *    path's priority queuing honours voice's mark; if both climb, voice is
 *    being treated as bulk, and the next full link will be heard on calls.
 *
 * The worse call's medians are kept. iperf3's own TCP round trip is the
 * loaded flow's view of the same queue; the pings are what other traffic
 * sees, which is the question.
 */
async function runThroughput(def: ThroughputCheckDef, deviceHost: string): Promise<CheckResult> {
    const t0 = performance.now();
    const deadline = t0 + def.timeoutS * 1000;
    let address: string;
    let dnsMs: number | null = null;
    try {
        const r = await resolve(def.host ?? deviceHost, deadline);
        address = r.address;
        dnsMs = r.dnsMs;
        refuseAddress(address);
    } catch (err) {
        const f = failureOf(err);
        return result({ outcome: f.outcome, dnsMs, detail: f.message, tput: null });
    }
    const idleMs = median(await pingSeries(address, IDLE_PINGS, 0));
    const count = Math.ceil((OMIT_S + def.durationS) * 1000 / PING_PERIOD_MS);
    const legs: Array<{ mbps: number; rt: number | null; plain: number | null; ef: number | null }> = [];
    for (const reverse of [false, true]) {
        const [call, plain, ef] = await Promise.all([
            tcpCall(address, def, reverse, deadline), pingSeries(address, count, 0), pingSeries(address, count, 184),
        ]);
        if (!call.ok) return result({ outcome: call.outcome, dnsMs, peer: address, tput: null, detail: call.detail });
        legs.push({ mbps: call.mbps, rt: call.retransmits, plain: median(plain), ef: median(ef) });
    }
    const worse = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
    const [to, from] = legs as [typeof legs[0], typeof legs[0]];
    const tput = {
        mbpsTo: to.mbps, mbpsFrom: from.mbps,
        loadedMs: worse(to.plain, from.plain), loadedEfMs: worse(to.ef, from.ef), idleMs,
        retransmits: to.rt === null && from.rt === null ? null : (to.rt ?? 0) + (from.rt ?? 0),
    };
    const ms = (x: number | null): string => (x === null ? 'no reply' : `${x} ms`);
    return result({
        outcome: 'ok', dnsMs, peer: address, totalMs: Math.round(performance.now() - t0), tput,
        detail: `toward the site ${to.mbps} Mbps, from it ${from.mbps} Mbps${def.capMbps !== null ? ` (capped at ${def.capMbps})` : ''}; `
            + `latency ${ms(idleMs)} idle, ${ms(tput.loadedMs)} loaded, ${ms(tput.loadedEfMs)} loaded and marked EF`
            + `${tput.retransmits !== null ? `; ${tput.retransmits} retransmits` : ''}`,
    });
}

/** iperf3 as a child process, its result read by `parse`, never throwing. */
function iperf3<T extends { ok: true }>(args: string[], deadline: number, parse: (text: string) => T | Fail): Promise<T | Fail> {
    const left = Math.floor(deadline - performance.now());
    if (left < 1000) return Promise.resolve({ ok: false, outcome: 'timeout', detail: 'no time left for the call back' });
    return new Promise((done) => {
        // A whole number: execFile refuses a fractional timeout outright.
        execFile('iperf3', args, { timeout: left, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
            const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
            if (e !== null && e.code === 'ENOENT') {
                done({ ok: false, outcome: 'ours', detail: 'iperf3 is not installed on the RSCanvas box' });
                return;
            }
            if (e !== null && e.killed === true) {
                done({ ok: false, outcome: 'timeout', detail: 'iperf3 did not finish in time' });
                return;
            }
            // A CRASH is the instrument's failure, not the path's: 'ours',
            // which freezes the rules - it must not read as the responder
            // down (the --bidir segfaults read as 'error' on the drill).
            if (e !== null && typeof e.signal === 'string' && e.signal !== '') {
                done({ ok: false, outcome: 'ours', detail: `iperf3 crashed (${e.signal})` });
                return;
            }
            // Otherwise iperf3 reports its own failures as JSON with an exit
            // status of its choosing, so the output decides, not the status.
            done(parse(String(stdout ?? '')));
        });
    });
}

/** What a run needs beyond its definition: for a voice test, the device's
 *  ping round trip (the MOS estimate's delay). */
export interface RunContext { rttMs?: number | null }

export async function runCheck(kind: CheckKind, def: CheckDef, deviceHost: string, ctx: RunContext = {}): Promise<CheckResult> {
    try {
        if (kind === 'path-voice' || kind === 'path-tput') {
            const r = kind === 'path-voice'
                ? await runVoice(def as VoiceCheckDef, deviceHost, ctx.rttMs ?? null)
                : await runThroughput(def as ThroughputCheckDef, deviceHost);
            return r.outcome === 'ours' && IPERF_CLIENT_INTERRUPTED.test(r.detail) ? { ...r, interrupted: true } : r;
        }
        return kind === 'svc-tcp'
            ? await runTcp(def as TcpCheckDef, deviceHost)
            : await runHttp(def as HttpCheckDef, deviceHost);
    } catch (err) {
        // Unreachable by construction; kept so a bug here is a reading
        // that names the prober, not a crash of the collector thread.
        return result({ outcome: 'ours', detail: `the prober failed: ${(err as Error).message}` });
    }
}
