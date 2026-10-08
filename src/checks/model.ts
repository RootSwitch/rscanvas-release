// Service checks: the pure half. What a check IS, what its answer means, and
// when it runs. No sockets, no database, no clock - src/checks/probe.ts owns
// the I/O and the collector owns the timers; tools/test-service-checks.ts
// holds every decision here offline.
//
// SLICE-SERVICE-CHECKS-PLAN.md carries the design. The rules that shape this
// file:
//
//  * A CHECK IS AN ENTITY with source 'probe' (slice 57), its definition in
//    entities.extra. Nothing here is secret: a URL with credentials in it is
//    refused, because extra travels to the device page.
//  * THE ASSERTION IS A MENU, NOT A LANGUAGE (the operator's ruling on rung
//    3): a keyword present or absent, or ONE dotted JSON field compared with
//    equals, not-equals or one-of. No regex, no expressions. A failed
//    assertion is its own outcome - answering, wrong content - never "down".
//  * THE BODY IS NEVER KEPT. It is read only to judge an assertion, capped,
//    and what leaves this module is pass or fail.
//  * NO LINK-LOCAL TARGETS. Nothing legitimate on a LAN lives at
//    169.254.0.0/16 or fe80::/10, and cloud metadata services do: a check is
//    RSCanvas fetching a URL of an admin's choosing from inside the network,
//    so the one address class that is only ever an attack is refused at add
//    time and again at every run's resolution.

import net from 'node:net';

/** svc-* are services; path-voice (slice 60) is a path test against an
 *  iperf3 responder at a site. */
export type CheckKind = 'svc-http' | 'svc-tcp' | 'path-voice' | 'path-tput';
export const CHECK_KINDS: readonly CheckKind[] = ['svc-http', 'svc-tcp', 'path-voice', 'path-tput'];

/** The path tests: iperf3 against a responder at a site, sharing its one-test-at-a-time daemon. */
export function isPathKind(kind: string): boolean {
    return kind === 'path-voice' || kind === 'path-tput';
}

export function isCheckKind(v: unknown): v is CheckKind {
    return typeof v === 'string' && (CHECK_KINDS as readonly string[]).includes(v);
}

export interface Assertion {
    type: 'contains' | 'absent' | 'json';
    /** contains / absent: the plain text looked for. */
    text?: string;
    /** json: a dotted path - `status`, `checks.db.state`, `items.0.ok`. */
    path?: string;
    op?: 'equals' | 'not-equals' | 'one-of';
    /** json: compared with the field's text form. One value, or the set for one-of. */
    values?: string[];
}

export interface HttpCheckDef {
    url: string;
    method: 'GET' | 'HEAD';
    /** Normalised: "200-299" or "200,301-302". */
    expect: string;
    intervalS: number;
    timeoutS: number;
    /** resolve: look the name up every run. pin: connect to the device's address, send the name. */
    connect: 'resolve' | 'pin';
    verifyTls: boolean;
    assertion: Assertion | null;
    outside: OutsideSetting;
}

export interface TcpCheckDef {
    /** null connects to the owning device's address. */
    host: string | null;
    port: number;
    intervalS: number;
    timeoutS: number;
    outside: OutsideSetting;
}

/**
 * A voice path test (slice 60): one G.711-shaped call - 160-byte payloads,
 * 50 a second, 64 kbps - in both directions at once against an iperf3
 * responder, marked with `dscp` (46, EF, unless told otherwise).
 */
export interface VoiceCheckDef {
    /** null tests to the owning device's address - the responder IS the device. */
    host: string | null;
    port: number;
    intervalS: number;
    /** Seconds of call per test. */
    durationS: number;
    /** Derived, never set: the call plus room for iperf3 to connect and report. */
    timeoutS: number;
    dscp: number;
    /** Always 'no': a path to a site is not an internet service. */
    outside: OutsideSetting;
}

export type CheckDef = HttpCheckDef | TcpCheckDef | VoiceCheckDef | ThroughputCheckDef;

/** The voice test's shape, fixed: what a G.711 call puts on the wire. */
export const VOICE_BITRATE = '64K';
export const VOICE_PAYLOAD_BYTES = 160;
export const VOICE_INTERVAL_FLOOR_S = 60;
export const IPERF3_PORT = 5201;

/**
 * A throughput test (slice 61): TCP to an iperf3 responder, toward the site
 * and then back, each call `durationS` long after `OMIT_S` of slow start is
 * thrown away. HEADROOM caps each call at `capMbps` - "can this site still
 * get 200 Mbps right now" without taking the link from the people on it -
 * and is the default; MAX is uncapped, which is by construction the link
 * full for the length of a call, so it runs only inside its hours window
 * (local time, start inclusive, end exclusive, wrapping past midnight;
 * 0 to 24 is all day - the operator's setting, not a limit).
 */
export interface ThroughputCheckDef {
    host: string | null;
    port: number;
    intervalS: number;
    durationS: number;
    /** Derived: both calls, the latency pings around them, and room. */
    timeoutS: number;
    mode: 'headroom' | 'max';
    /** Headroom's cap per call, in Mbps; null for max. */
    capMbps: number | null;
    windowStart: number;
    windowEnd: number;
    outside: OutsideSetting;
}

export const OMIT_S = 2;
export const THROUGHPUT_INTERVAL_FLOOR_S = 300;
/** Seconds between one throughput test ending and the next starting. */
export const THROUGHPUT_GAP_S = 10;
/** The idle-latency pings before a throughput test: 10 at 200 ms. */
export const IDLE_PINGS = 10;
export const PING_PERIOD_MS = 200;
/** What share of every hour throughput tests may take, together: the rest is
 *  room for voice tests, which never run beside one. */
export const THROUGHPUT_BUDGET = 0.9;

/**
 * Whether a check counts toward the outside-services group alert (step 2 of
 * the plan): RSCanvas's own internet going down looks like every outside
 * check failing in the same minute. 'auto' decides by the address the check
 * last reached - a public one is outside - and 'yes' or 'no' is the
 * operator saying so, for the cases the address cannot: a SaaS reached
 * through a proxy on the LAN, or a public address that is really the next
 * room.
 */
export type OutsideSetting = 'auto' | 'yes' | 'no';

/** A public address: none of the private, shared, loopback, link-local,
 *  multicast or reserved ranges. What 'auto' calls outside. */
export function isPublicAddress(address: string): boolean {
    const kind = net.isIP(address);
    if (kind === 4) {
        const [a, b] = address.split('.').map(Number) as [number, number];
        if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 169 && b === 254) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;   // shared (CGNAT, and tailnets)
        return true;
    }
    if (kind === 6) {
        const x = address.toLowerCase();
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
        if (mapped) return isPublicAddress(mapped[1] as string);
        if (x === '::' || x === '::1') return false;
        if (/^f[cd][0-9a-f]{2}:/.test(x)) return false;       // unique local, fc00::/7
        if (/^fe[89ab][0-9a-f]:/.test(x)) return false;       // link-local
        if (x.startsWith('ff')) return false;                 // multicast
        return true;
    }
    return false;
}

/**
 * One run's verdict on "outside": true or false, or null for "this run
 * cannot say" - an 'auto' check that reached no address, which is exactly
 * what a check does when the internet is gone. The store keeps the
 * previous verdict for a null, so a check does not stop counting as outside
 * at the moment it matters most.
 */
export function outsideVerdict(setting: OutsideSetting, peer: string | null): boolean | null {
    if (setting === 'yes') return true;
    if (setting === 'no') return false;
    return peer === null ? null : isPublicAddress(peer);
}

function parseOutside(raw: unknown): OutsideSetting | null {
    if (raw === undefined || raw === null || raw === '') return 'auto';
    return raw === 'auto' || raw === 'yes' || raw === 'no' ? raw : null;
}

/** The floor is the SNMP floor: faster down-detection is ping's job, and a
 *  service check lands on somebody's application. */
export const CHECK_INTERVAL_FLOOR_S = 30;
export const CHECK_INTERVAL_CEILING_S = 86_400;
export const CHECK_TIMEOUT_MAX_S = 60;
/** An assertion reads at most this much of a body; past it the outcome is too-large. */
export const BODY_CAP_BYTES = 1_048_576;
/** Same-host redirects followed before the chain is called a failure. */
export const MAX_REDIRECTS = 5;

// --- outcomes -----------------------------------------------------------------
//
// Stored as a number in v5, so the codes are FROZEN once written: history
// written today must read the same next year. Append, never renumber.

export const OUTCOME = {
    ok: 0,
    timeout: 1,
    refused: 2,
    unreachable: 3,
    dns: 4,
    'tls-expired': 5,
    'tls-name': 6,
    'tls-untrusted': 7,
    'tls-error': 8,
    'wrong-status': 9,
    'wrong-content': 10,
    'other-host-redirect': 11,
    'too-large': 12,
    'address-refused': 13,
    reset: 14,
    error: 15,
    // Slice 60, the path tests against an iperf3 responder.
    busy: 16,
    auth: 17,
    'busy-always': 18,
    ours: 99,
} as const;

export type OutcomeName = keyof typeof OUTCOME;

/** The name for a stored code. A scan over seventeen entries rather than a
 *  module-level Map: this module is reached from three threads, and a
 *  module holding a container is what check-thread-state exists to refuse. */
export function outcomeName(code: number | null | undefined): OutcomeName | null {
    if (code === null || code === undefined) return null;
    for (const [k, v] of Object.entries(OUTCOME) as Array<[OutcomeName, number]>) if (v === code) return k;
    return null;
}

/** What each outcome says to a person, in the page's and the alert's words. */
export const OUTCOME_TEXT: Readonly<Record<OutcomeName, string>> = {
    ok: 'ok',
    timeout: 'no answer in time',
    refused: 'connection refused',
    unreachable: 'host or network unreachable',
    dns: 'the name did not resolve',
    'tls-expired': 'certificate expired or not yet valid',
    'tls-name': 'certificate is for another name',
    'tls-untrusted': 'certificate is not trusted',
    'tls-error': 'TLS handshake failed',
    'wrong-status': 'unexpected status',
    'wrong-content': 'answering, wrong content',
    'other-host-redirect': 'redirected to another host',
    'too-large': 'answering, body too large to check',
    'address-refused': 'resolved to a link-local address, which checks refuse',
    reset: 'connection reset',
    error: 'protocol error',
    busy: 'the responder was busy with another test',
    auth: 'the responder requires a login, which RSCanvas does not send',
    'busy-always': 'the responder has been busy for 12 tests in a row - something else is using it',
    ours: "the prober's own failure",
};

/** The service is not serving: svc-down raises on these. A busy responder is
 *  NOT among them - it answered, it was just testing with someone else - but
 *  one busy every time is. */
export const DOWN_OUTCOMES: ReadonlySet<OutcomeName> = new Set<OutcomeName>([
    'timeout', 'refused', 'unreachable', 'dns', 'tls-expired', 'tls-name', 'tls-untrusted',
    'tls-error', 'wrong-status', 'other-host-redirect', 'address-refused', 'reset', 'error',
    'auth', 'busy-always',
]);

/** Busy runs in a row before the responder reads as taken over. */
export const BUSY_RUNS_LIMIT = 12;

/** It answered with content an assertion could judge (or tried to). */
export const ANSWERED_OUTCOMES: ReadonlySet<OutcomeName> = new Set<OutcomeName>([
    'ok', 'wrong-content', 'too-large',
]);

// --- the transport's errors, classified ------------------------------------------

const NET_CODES: Readonly<Record<string, OutcomeName>> = {
    ETIMEDOUT: 'timeout',
    ECONNREFUSED: 'refused',
    EHOSTUNREACH: 'unreachable',
    ENETUNREACH: 'unreachable',
    EHOSTDOWN: 'unreachable',
    ENETDOWN: 'unreachable',
    ENOTFOUND: 'dns',
    EAI_AGAIN: 'dns',
    EAI_FAIL: 'dns',
    EAI_NONAME: 'dns',
    ENODATA: 'dns',
    ECONNRESET: 'reset',
    EPIPE: 'reset',
    ECONNABORTED: 'reset',
    // OUR failures, not the network's: a page caused by the prober's own
    // limits is the instrument testifying about itself (tcpcheck.ts's rule).
    EMFILE: 'ours',
    ENFILE: 'ours',
    EADDRNOTAVAIL: 'ours',
    ENOBUFS: 'ours',
    ENOMEM: 'ours',
};

export function classifyNetError(code: string | undefined, message = ''): OutcomeName {
    if (code !== undefined && code in NET_CODES) return NET_CODES[code] as OutcomeName;
    if (code !== undefined && (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_'))) return 'tls-error';
    if (code === 'EPROTO' && /ssl|tls/i.test(message)) return 'tls-error';
    return 'error';
}

/** A TLS socket's authorizationError, when verification is on. */
export function classifyTlsAuth(authorizationError: string): OutcomeName {
    switch (authorizationError) {
        case 'CERT_HAS_EXPIRED':
        case 'CERT_NOT_YET_VALID':
            return 'tls-expired';
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
            return 'tls-name';
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
        case 'CERT_UNTRUSTED':
        case 'CERT_REVOKED':
        case 'CERT_SIGNATURE_FAILURE':
            return 'tls-untrusted';
        default:
            return 'tls-error';
    }
}

// --- addresses ------------------------------------------------------------------

/** Why an address may not be a check's target, or null when it may. */
export function addressRefusal(address: string): string | null {
    const kind = net.isIP(address);
    if (kind === 4) {
        const o = address.split('.').map(Number);
        if (o[0] === 169 && o[1] === 254) return 'link-local (169.254.0.0/16)';
        if (o[0] === 0) return 'unspecified (0.0.0.0/8)';
        if ((o[0] as number) >= 224) return 'multicast or reserved';
        return null;
    }
    if (kind === 6) {
        const a = address.toLowerCase();
        // An IPv4-mapped address is judged as the IPv4 address it carries.
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
        if (mapped) return addressRefusal(mapped[1] as string);
        if (/^fe[89ab][0-9a-f]:/.test(a)) return 'link-local (fe80::/10)';
        if (a === '::') return 'unspecified (::)';
        if (a.startsWith('ff')) return 'multicast (ff00::/8)';
        return null;
    }
    return 'not an address';
}

/** A URL's hostname without IPv6 brackets. */
export function bareHost(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

// --- expected status codes -------------------------------------------------------

/** "200-299,301" -> normalised text, or an error. */
export function parseExpect(raw: unknown): { ok: true; expect: string } | { ok: false; detail: string } {
    const s = raw === undefined || raw === null || String(raw).trim() === '' ? '200-299' : String(raw);
    const parts = s.split(',').map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length === 0 || parts.length > 10) return { ok: false, detail: 'expected codes: one to ten codes or ranges, such as 200-299 or 200,301' };
    const out: string[] = [];
    for (const p of parts) {
        const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
        if (m === null) return { ok: false, detail: `expected codes: ${JSON.stringify(p)} is not a code or a range` };
        const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
        if (a < 100 || b > 599 || b < a) return { ok: false, detail: `expected codes: ${p} is outside 100-599 or backwards` };
        out.push(a === b ? String(a) : `${a}-${b}`);
    }
    return { ok: true, expect: out.join(',') };
}

export function codeExpected(expect: string, code: number): boolean {
    for (const p of expect.split(',')) {
        const [a, b] = p.split('-').map(Number) as [number, number | undefined];
        if (code >= a && code <= (b ?? a)) return true;
    }
    return false;
}

// --- the assertion ------------------------------------------------------------------

const PATH = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/;

/** A field's text form: what one-of and equals compare against. */
export function jsonText(v: unknown): string {
    if (typeof v === 'string') return v;
    if (v === null) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
}

/** Walk a dotted path; undefined when any step is missing. */
export function jsonPathGet(doc: unknown, path: string): unknown {
    let cur: unknown = doc;
    for (const seg of path.split('.')) {
        if (Array.isArray(cur)) {
            if (!/^\d+$/.test(seg)) return undefined;
            cur = cur[Number(seg)];
        } else if (cur !== null && typeof cur === 'object') {
            if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
            cur = (cur as Record<string, unknown>)[seg];
        } else {
            return undefined;
        }
        if (cur === undefined) return undefined;
    }
    return cur;
}

/** Pass or fail. A body that is not JSON, or a field that is not there, FAILS:
 *  an assertion is a claim the answer must support, and absence supports none. */
export function assertionPasses(a: Assertion, body: string): boolean {
    if (a.type === 'contains') return body.includes(a.text ?? '');
    if (a.type === 'absent') return !body.includes(a.text ?? '');
    let doc: unknown;
    try {
        doc = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
    } catch {
        return false;
    }
    const v = jsonPathGet(doc, a.path ?? '');
    if (v === undefined) return false;
    const t = jsonText(v);
    const values = a.values ?? [];
    if (a.op === 'equals') return t === values[0];
    if (a.op === 'not-equals') return t !== values[0];
    return values.includes(t);
}

function parseAssertion(raw: unknown): { ok: true; assertion: Assertion | null } | { ok: false; detail: string } {
    if (raw === undefined || raw === null || raw === '') return { ok: true, assertion: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, detail: 'assertion must be an object' };
    const r = raw as Record<string, unknown>;
    const type = r.type;
    if (type === undefined || type === null || type === '' || type === 'none') return { ok: true, assertion: null };
    if (type === 'contains' || type === 'absent') {
        const text = typeof r.text === 'string' ? r.text : '';
        if (text === '' || text.length > 200) return { ok: false, detail: 'the keyword must be 1 to 200 characters' };
        return { ok: true, assertion: { type, text } };
    }
    if (type === 'json') {
        const path = typeof r.path === 'string' ? r.path.trim() : '';
        if (!PATH.test(path) || path.length > 200) {
            return { ok: false, detail: 'the JSON field must be a dotted path such as status, checks.db.state or items.0.ok' };
        }
        const op = r.op;
        if (op !== 'equals' && op !== 'not-equals' && op !== 'one-of') {
            return { ok: false, detail: 'the JSON comparison must be equals, not-equals or one-of' };
        }
        const values = (Array.isArray(r.values) ? r.values : [r.values])
            .filter((v) => v !== undefined && v !== null).map((v) => String(v));
        if (values.length === 0 || values.length > 20 || values.some((v) => v.length > 200)) {
            return { ok: false, detail: 'the JSON comparison needs one to twenty values of up to 200 characters' };
        }
        if (op !== 'one-of' && values.length !== 1) {
            return { ok: false, detail: `${op} compares with exactly one value - one-of takes a list` };
        }
        return { ok: true, assertion: { type, path, op, values } };
    }
    return { ok: false, detail: 'the assertion type must be contains, absent or json' };
}

// --- names ----------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\u0085\u2028\u2029]/;

export function parseCheckName(raw: unknown, fallback: string): { ok: true; name: string } | { ok: false; detail: string } {
    const s = typeof raw === 'string' ? raw.trim() : '';
    const name = s === '' ? fallback : s;
    if (name.length > 80) return { ok: false, detail: 'a check name is at most 80 characters' };
    if (CONTROL.test(name)) return { ok: false, detail: 'a check name cannot contain control characters' };
    return { ok: true, name };
}

export function defaultCheckName(kind: CheckKind, def: CheckDef): string {
    if (kind === 'path-tput') {
        const d = def as ThroughputCheckDef;
        return `Throughput to ${d.host ?? 'this device'}`;
    }
    if (kind === 'path-voice') {
        const d = def as VoiceCheckDef;
        return `Voice to ${d.host ?? 'this device'}`;
    }
    if (kind === 'svc-tcp') {
        const d = def as TcpCheckDef;
        return `TCP ${d.host ?? 'device'}:${d.port}`;
    }
    const d = def as HttpCheckDef;
    const u = new URL(d.url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${d.method === 'HEAD' ? 'HEAD ' : ''}${u.host}${path}`.slice(0, 80);
}

// --- the definition, from a request body -----------------------------------------

function int(raw: unknown, dflt: number): number | null {
    if (raw === undefined || raw === null || raw === '') return dflt;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
}

/**
 * A check definition from untrusted input, defaults applied, or the first
 * reason it is refused - in words the add form shows as they are.
 */
/** A target host from input: null for "the device", else a name or an
 *  address checks may reach. */
function parseTargetHost(raw: unknown): { ok: true; host: string | null } | { ok: false; detail: string } {
    const hostRaw = typeof raw === 'string' ? raw.trim() : '';
    const host = hostRaw === '' ? null : bareHost(hostRaw);
    if (host === null) return { ok: true, host };
    if (net.isIP(host) === 0 && !HOSTNAME.test(host)) return { ok: false, detail: `${JSON.stringify(host)} is not a host name or address` };
    if (net.isIP(host) !== 0) {
        const why = addressRefusal(host);
        if (why !== null) return { ok: false, detail: `checks refuse ${host}: ${why}` };
    }
    return { ok: true, host };
}

function parseVoiceDef(raw: Record<string, unknown>): { ok: true; def: VoiceCheckDef } | { ok: false; detail: string } {
    // Five minutes by default: the plan's cadence, which is the operator's
    // work practice at twice the rate, and ~90 kbps for 10 s costs nothing.
    const intervalS = int(raw.intervalS, 300);
    if (intervalS === null || intervalS < VOICE_INTERVAL_FLOOR_S || intervalS > CHECK_INTERVAL_CEILING_S) {
        return { ok: false, detail: `a voice test's interval is whole seconds from ${VOICE_INTERVAL_FLOOR_S} to ${CHECK_INTERVAL_CEILING_S}` };
    }
    const durationS = int(raw.durationS, 10);
    if (durationS === null || durationS < 5 || durationS > 30) return { ok: false, detail: 'a voice test lasts 5 to 30 seconds' };
    const port = int(raw.port, IPERF3_PORT);
    if (port === null || port < 1 || port > 65535) return { ok: false, detail: 'the port is 1 to 65535' };
    const dscp = int(raw.dscp, 46);
    if (dscp === null || dscp < 0 || dscp > 63) return { ok: false, detail: 'the DSCP mark is 0 to 63 (46 is EF, what voice uses)' };
    const h = parseTargetHost(raw.host);
    if (!h.ok) return h;
    // The timeout is the two calls (one each way - see parseIperfOneWay)
    // plus room for each to connect (3 s) and report: not the operator's to
    // set, since a voice test that is cut short measures nothing.
    return { ok: true, def: { host: h.host, port, intervalS, durationS, timeoutS: 2 * durationS + 25, dscp, outside: 'no' } };
}

function hourOf(raw: unknown, dflt: number, min: number, max: number): number | null {
    const n = int(raw, dflt);
    return n === null || n < min || n > max ? null : n;
}

function parseThroughputDef(raw: Record<string, unknown>): { ok: true; def: ThroughputCheckDef } | { ok: false; detail: string } {
    // Hourly by default: the operator's own practice.
    const intervalS = int(raw.intervalS, 3600);
    if (intervalS === null || intervalS < THROUGHPUT_INTERVAL_FLOOR_S || intervalS > CHECK_INTERVAL_CEILING_S) {
        return { ok: false, detail: `a throughput test's interval is whole seconds from ${THROUGHPUT_INTERVAL_FLOOR_S} to ${CHECK_INTERVAL_CEILING_S}` };
    }
    const durationS = int(raw.durationS, 10);
    if (durationS === null || durationS < 5 || durationS > 30) return { ok: false, detail: 'a throughput call lasts 5 to 30 seconds' };
    const port = int(raw.port, IPERF3_PORT);
    if (port === null || port < 1 || port > 65535) return { ok: false, detail: 'the port is 1 to 65535' };
    const mode = raw.mode === undefined || raw.mode === null || raw.mode === '' ? 'headroom' : raw.mode;
    if (mode !== 'headroom' && mode !== 'max') return { ok: false, detail: 'the mode is headroom (capped) or max (uncapped, inside its hours)' };
    let capMbps: number | null = null;
    if (mode === 'headroom') {
        const c = Number(raw.capMbps);
        if (raw.capMbps === undefined || raw.capMbps === null || raw.capMbps === '' || !Number.isFinite(c) || c < 1 || c > 100_000) {
            return { ok: false, detail: 'a headroom test needs the rate to prove, 1 to 100000 Mbps - say what the site should still be able to get' };
        }
        capMbps = Math.round(c);
    }
    const windowStart = hourOf(raw.windowStart, 1, 0, 23);
    const windowEnd = hourOf(raw.windowEnd, 5, 1, 24);
    if (windowStart === null || windowEnd === null) return { ok: false, detail: 'the hours window is a start hour 0 to 23 and an end hour 1 to 24' };
    if (windowStart === windowEnd) return { ok: false, detail: 'the hours window is empty - for all day use 0 to 24' };
    const h = parseTargetHost(raw.host);
    if (!h.ok) return h;
    return {
        ok: true,
        def: {
            host: h.host, port, intervalS, durationS, mode, capMbps, windowStart, windowEnd, outside: 'no',
            // Two calls of omit + duration, the idle pings, and room for each
            // call to connect (3 s) and report.
            timeoutS: 2 * (OMIT_S + durationS) + Math.ceil(IDLE_PINGS * PING_PERIOD_MS / 1000) + 30,
        },
    };
}

/** Whether a MAX test may run at this local hour; headroom always may. */
export function inWindow(def: ThroughputCheckDef, localHour: number): boolean {
    if (def.mode !== 'max') return true;
    const { windowStart: a, windowEnd: b } = def;
    return a < b ? localHour >= a && localHour < b : localHour >= a || localHour < b;
}

/** The seconds one throughput test holds the path: both calls, the idle
 *  pings, and the gap before the next may start - the plan's arithmetic,
 *  2 x (2 + 10) + 10 = 34 s at the defaults, plus the 2 s of idle pings. */
export function throughputCostS(def: { durationS: number }): number {
    return 2 * (OMIT_S + def.durationS) + Math.ceil(IDLE_PINGS * PING_PERIOD_MS / 1000) + THROUGHPUT_GAP_S;
}

/**
 * Whether a set of throughput tests fits: together they may hold the path
 * THROUGHPUT_BUDGET of every hour, the rest left for voice. A schedule that
 * does not fit is refused when it is saved, naming the numbers - never
 * quietly stretched until "hourly" means every seventy minutes.
 */
export function throughputFits(tests: ReadonlyArray<{ durationS: number; intervalS: number }>):
    { ok: true; share: number } | { ok: false; detail: string } {
    // In seconds of the hour, rounded to the millisecond: a sum of fractions
    // put exactly-the-budget a hair over it.
    const perHour = Math.round(tests.reduce((a, t) => a + throughputCostS(t) * 3600 / t.intervalS, 0) * 1000) / 1000;
    const share = perHour / 3600;
    if (perHour <= THROUGHPUT_BUDGET * 3600) return { ok: true, share };
    return {
        ok: false,
        detail: `throughput tests run one at a time, and these ${tests.length} would need ${Math.round(perHour)} s of every hour `
            + `- more than the ${Math.round(THROUGHPUT_BUDGET * 3600)} s they may take. Run them less often or shorter.`,
    };
}

export function parseCheckDef(
    kind: CheckKind, raw: Record<string, unknown>,
): { ok: true; def: CheckDef } | { ok: false; detail: string } {
    if (kind === 'path-voice') return parseVoiceDef(raw);
    if (kind === 'path-tput') return parseThroughputDef(raw);
    const intervalS = int(raw.intervalS, 60);
    if (intervalS === null || intervalS < CHECK_INTERVAL_FLOOR_S || intervalS > CHECK_INTERVAL_CEILING_S) {
        return { ok: false, detail: `the interval is whole seconds from ${CHECK_INTERVAL_FLOOR_S} to ${CHECK_INTERVAL_CEILING_S}` };
    }
    const timeoutS = int(raw.timeoutS, 10);
    if (timeoutS === null || timeoutS < 1 || timeoutS > CHECK_TIMEOUT_MAX_S) {
        return { ok: false, detail: `the timeout is whole seconds from 1 to ${CHECK_TIMEOUT_MAX_S}` };
    }
    if (timeoutS >= intervalS) return { ok: false, detail: 'the timeout must be shorter than the interval' };
    const outside = parseOutside(raw.outside);
    if (outside === null) return { ok: false, detail: 'outside is auto, yes or no' };

    if (kind === 'svc-tcp') {
        const port = int(raw.port, -1);
        if (port === null || port < 1 || port > 65535) return { ok: false, detail: 'the port is 1 to 65535' };
        const h = parseTargetHost(raw.host);
        if (!h.ok) return h;
        return { ok: true, def: { host: h.host, port, intervalS, timeoutS, outside } };
    }

    const urlRaw = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (urlRaw === '' || urlRaw.length > 2048) return { ok: false, detail: 'a URL is required, up to 2048 characters' };
    let u: URL;
    try {
        u = new URL(urlRaw);
    } catch {
        return { ok: false, detail: `${JSON.stringify(urlRaw)} is not a URL` };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, detail: 'checks fetch http and https URLs only' };
    // A password in the URL would be stored in the clear and shown on the
    // device page. Refused rather than stripped: stripping would change what
    // the check does without saying so.
    if (u.username !== '' || u.password !== '') {
        return { ok: false, detail: 'a URL with a user name or password in it is refused - it would be stored and shown in the clear' };
    }
    const host = bareHost(u.hostname);
    if (host === '') return { ok: false, detail: 'the URL needs a host' };
    if (net.isIP(host) !== 0) {
        const why = addressRefusal(host);
        if (why !== null) return { ok: false, detail: `checks refuse ${host}: ${why}` };
    }
    u.hash = '';
    const method = raw.method === undefined || raw.method === null || raw.method === '' ? 'GET' : String(raw.method).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return { ok: false, detail: 'the method is GET or HEAD' };
    const expect = parseExpect(raw.expect);
    if (!expect.ok) return expect;
    const connect = raw.connect === undefined || raw.connect === null || raw.connect === '' ? 'resolve' : raw.connect;
    if (connect !== 'resolve' && connect !== 'pin') return { ok: false, detail: 'connect is resolve or pin' };
    const verifyTls = raw.verifyTls !== false;
    const a = parseAssertion(raw.assertion);
    if (!a.ok) return a;
    if (a.assertion !== null && method === 'HEAD') {
        return { ok: false, detail: 'a HEAD request has no body for an assertion to read - use GET' };
    }
    return {
        ok: true,
        def: {
            url: u.toString(), method, expect: expect.expect, intervalS, timeoutS, connect, verifyTls,
            assertion: a.assertion, outside,
        },
    };
}

/** A stored definition back from entities.extra; null when it is not one this build can run. */
export function storedDef(kind: string, extra: unknown): CheckDef | null {
    if (!isCheckKind(kind) || extra === null || typeof extra !== 'object') return null;
    const r = parseCheckDef(kind, extra as Record<string, unknown>);
    return r.ok ? r.def : null;
}

// --- the schedule ---------------------------------------------------------------

/** FNV-1a over the code: a stable offset, so a restart does not move a check
 *  and checks added together do not fire together. */
export function scheduleOffsetMs(code: string, intervalMs: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < code.length; i++) {
        h ^= code.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % intervalMs;
}

/** The first grid point at or after `nowMs` for this check. */
export function firstDueMs(nowMs: number, intervalMs: number, offsetMs: number): number {
    const into = ((nowMs - offsetMs) % intervalMs + intervalMs) % intervalMs;
    return into === 0 ? nowMs : nowMs + (intervalMs - into);
}

/** The next due time after a run that was due at `dueMs`. Lateness past a
 *  whole interval re-anchors on the grid rather than paying the backlog back
 *  as a burst - the poll schedule's rule (src/collector/schedule.ts). */
export function nextDueMs(dueMs: number, nowMs: number, intervalMs: number, offsetMs: number): number {
    const next = dueMs + intervalMs;
    return next > nowMs ? next : firstDueMs(nowMs, intervalMs, offsetMs);
}

// --- the sample -----------------------------------------------------------------

export interface CheckResult {
    outcome: OutcomeName;
    /** The HTTP status of the answer that decided the outcome; null when none came. */
    httpStatus: number | null;
    /** Start to answer: headers, or the body when an assertion read it. Null when nothing answered. */
    totalMs: number | null;
    /** Connect, plus the TLS handshake for https. */
    connectMs: number | null;
    /** The name lookup; null when pinned or the target is an address. */
    dnsMs: number | null;
    certDays: number | null;
    /** 1 passed, 0 failed, null no assertion or nothing to judge. */
    assertion: 1 | 0 | null;
    /** The address the last connection went to. */
    peer: string | null;
    /** One line for the add form's Test button. Never response content. */
    detail: string;
    /** The run was cut short on THIS box - iperf3's client stopped, the
     *  service stopping with it - so there is nothing to record (2026-10-07). */
    interrupted?: boolean;
    /**
     * A voice test's reading (slice 60): an object when the call ran, null
     * when it did not, and absent on every other kind - which is how
     * sampleOf picks the layout.
     */
    voice?: VoiceReading | null;
    /** A throughput test's reading (slice 61), the same convention. */
    tput?: ThroughputReading | null;
}

/** Both calls of one throughput test, and the latency around them. */
export interface ThroughputReading {
    /** Mbps the responder received; what the site can be sent. */
    mbpsTo: number;
    /** Mbps RSCanvas received; what the site can send. */
    mbpsFrom: number;
    /** Median ping during the calls, unmarked - the worse call's. Null when no ping came back. */
    loadedMs: number | null;
    /** The same, marked EF: whether the path's QoS honours voice's mark. */
    loadedEfMs: number | null;
    /** Median ping just before the calls. */
    idleMs: number | null;
    retransmits: number | null;
}

/** Both directions of one test call. "To" is RSCanvas toward the site, as the
 *  responder measured it; "from" is the site toward RSCanvas. */
export interface VoiceReading {
    lossTo: number;
    lossFrom: number;
    jitterTo: number;
    jitterFrom: number;
    /** The worse direction's estimate; null without a round trip to take delay from. */
    mos: number | null;
    /** The ping round trip the estimate used. */
    rttMs: number | null;
}

/** THE COLUMN LAYOUT, in one place (plan, "What a check records"):
 *  services - v0 total ms, v1 connect ms, v2 certificate days, v3 assertion,
 *  v4 lookup ms, v5 outcome code; status is the HTTP code.
 *  voice (slice 60) - v0 loss % toward the site, v1 loss % from it, v2 and
 *  v3 jitter ms the same two ways, v4 the MOS estimate, v5 the outcome;
 *  loss in v0/v1 because the hourly rollup keeps their maxima, and a loss
 *  burst is the peak a voice chart must not average away. */
export function sampleOf(r: CheckResult): { status: number | null; rttMs: number | null; v: Array<number | null> } {
    // throughput (slice 61) - v0 Mbps toward the site, v1 from it (where the
    // rollup keeps maxima), v2 latency under load unmarked, v3 the same marked
    // EF, v4 idle latency, v5 the outcome; rtt is the idle latency.
    if (r.tput !== undefined) {
        const x = r.tput;
        return {
            status: null,
            rttMs: x?.idleMs ?? null,
            v: [x?.mbpsTo ?? null, x?.mbpsFrom ?? null, x?.loadedMs ?? null, x?.loadedEfMs ?? null,
                x?.idleMs ?? null, OUTCOME[r.outcome]],
        };
    }
    if (r.voice !== undefined) {
        const x = r.voice;
        return {
            status: null,
            rttMs: x?.rttMs ?? null,
            v: [x?.lossTo ?? null, x?.lossFrom ?? null, x?.jitterTo ?? null, x?.jitterFrom ?? null,
                x?.mos ?? null, OUTCOME[r.outcome]],
        };
    }
    return {
        status: r.httpStatus,
        rttMs: r.totalMs,
        v: [r.totalMs, r.connectMs, r.certDays, r.assertion, r.dnsMs, OUTCOME[r.outcome]],
    };
}

// --- voice (slice 60) -------------------------------------------------------------

/**
 * A MOS estimate by the simplified E-model most monitoring tools use: one
 * way delay (half the ping round trip) plus twice the jitter plus 10 ms of
 * codec, then 2.5 R points per percent lost. 4.4 is a clean G.711 call; 3.6
 * is where people start to notice; under 3.1 they complain. An ESTIMATE -
 * it knows nothing of the codec's loss concealment or the jitter buffer.
 */
export function mosEstimate(oneWayMs: number, jitterMs: number, lossPct: number): number {
    const eff = oneWayMs + 2 * jitterMs + 10;
    let r = eff < 160 ? 93.2 - eff / 40 : 93.2 - (eff - 120) / 10;
    r -= 2.5 * lossPct;
    if (r <= 0) return 1;
    if (r >= 100) return 4.5;
    return Math.round((1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r)) * 100) / 100;
}

/**
 * iperf3's words when ITS OWN CLIENT is stopped (2026-10-07): it catches the
 * signal, prints this as a JSON error and exits normally, so the crash path
 * (execFile's err.signal) never sees it. On the lab it came at the second
 * the service was restarted for a deploy - systemd stops the client with
 * the service - and read as "protocol error" against the path, which every
 * upgrade would have repeated on whatever test was mid-call. It is this
 * box's doing, never the path's: classified as ours, and a run cut short
 * this way is not recorded at all (runCheck flags it, the collector drops
 * it), so the check keeps its last real reading.
 */
export const IPERF_CLIENT_INTERRUPTED = /interrupt - the client has terminated/i;

/** What one of iperf3's error sentences means. Its words, as 3.16 says them. */
export function classifyIperfError(message: string): OutcomeName {
    if (IPERF_CLIENT_INTERRUPTED.test(message)) return 'ours';
    if (/busy/i.test(message)) return 'busy';
    if (/authori[sz]ation|authenticat/i.test(message)) return 'auth';
    if (/refused/i.test(message)) return 'refused';
    if (/timed out/i.test(message)) return 'timeout';
    if (/no route to host|network is unreachable|host is unreachable/i.test(message)) return 'unreachable';
    if (/name or service not known|nodename nor servname|name resolution/i.test(message)) return 'dns';
    return 'error';
}

interface IperfSum { packets?: unknown; lost_packets?: unknown; lost_percent?: unknown; jitter_ms?: unknown }

/** One direction's loss and jitter from the receiver's sum. Nothing received
 *  of what was sent is 100% - iperf3 itself says 0% for a receiver that saw
 *  no packet at all, having nothing to count from. */
function direction(rcv: IperfSum | undefined, sent: IperfSum | undefined): { loss: number; jitter: number } | null {
    if (rcv === undefined || typeof rcv.lost_percent !== 'number' || typeof rcv.jitter_ms !== 'number') return null;
    const got = Number(rcv.packets ?? 0);
    const sentN = Number(sent?.packets ?? 0);
    const loss = got === 0 && sentN > 0 ? 100 : rcv.lost_percent;
    return { loss: Math.round(loss * 1000) / 1000, jitter: Math.round(rcv.jitter_ms * 1000) / 1000 };
}

/**
 * One one-way call's `-J` output from iperf3 3.16, read: `end.sum_received`
 * is the RECEIVING end's count whichever way the call went - the responder's
 * for a forward run, RSCanvas's own for a reversed one (`-R`). An "error"
 * key is iperf3 refusing or failing, in its own words.
 *
 * ONE WAY AT A TIME, and the reason is measured, not preferred: the plan
 * said `--bidir` (both ways at once, half the time), and on the slice 60
 * drill iperf3 3.16's client SEGFAULTED on 3 of 10 `--bidir` calls under
 * 2% loss with jitter, with or without -J - the very conditions a voice
 * test exists to see - while 20 one-way calls under the same impairment ran
 * clean. Two calls back to back cost the responder twice as long; a test
 * that crashes when the path is bad costs the measurement.
 */
export function parseIperfOneWay(text: string):
    | { ok: true; loss: number; jitter: number }
    | { ok: false; outcome: OutcomeName; detail: string } {
    let j: { error?: unknown; end?: Record<string, IperfSum | undefined> };
    try {
        j = JSON.parse(text);
    } catch {
        return { ok: false, outcome: 'error', detail: 'iperf3 wrote something that is not its JSON' };
    }
    if (typeof j.error === 'string') {
        // The cause is the part after iperf3's stock preamble.
        const cause = j.error.replace(/^unable to connect to server - server may have stopped running or use a different port, firewall issue, etc\.:\s*/i, '');
        return { ok: false, outcome: classifyIperfError(j.error), detail: `iperf3: ${cause}` };
    }
    const d = direction(j.end?.sum_received, j.end?.sum_sent);
    if (d === null) return { ok: false, outcome: 'error', detail: 'iperf3 reported no receiver figures' };
    return { ok: true, ...d };
}

/** The voice reading with its estimate: the worse direction's MOS, and none
 *  without a round trip to take delay from. */
export function voiceReading(
    p: { lossTo: number; lossFrom: number; jitterTo: number; jitterFrom: number }, rttMs: number | null,
): VoiceReading {
    const mos = rttMs === null ? null : Math.min(
        mosEstimate(rttMs / 2, p.jitterTo, p.lossTo), mosEstimate(rttMs / 2, p.jitterFrom, p.lossFrom));
    return { ...p, mos, rttMs };
}

/** Days until a certificate's notAfter, one decimal; null when unreadable. */
export function certDaysFrom(validTo: string | undefined, nowMs: number): number | null {
    if (typeof validTo !== 'string' || validTo === '') return null;
    const t = Date.parse(validTo);
    if (!Number.isFinite(t)) return null;
    return Math.round((t - nowMs) / 8_640_000) / 10;
}

// --- throughput (slice 61) ------------------------------------------------------------

/**
 * One TCP call's `-J` output from iperf3 3.16, read: `end.sum_received` is
 * the receiving end's rate whichever way the call went (the responder's for
 * a forward call, RSCanvas's own reversed), the slow-start seconds already
 * omitted; `end.sum_sent.retransmits` the sender's, which a reversed call
 * reports from the responder.
 */
export function parseIperfTcp(text: string):
    | { ok: true; mbps: number; retransmits: number | null }
    | { ok: false; outcome: OutcomeName; detail: string } {
    let j: { error?: unknown; end?: { sum_received?: { bits_per_second?: unknown }; sum_sent?: { retransmits?: unknown } } };
    try {
        j = JSON.parse(text);
    } catch {
        return { ok: false, outcome: 'error', detail: 'iperf3 wrote something that is not its JSON' };
    }
    if (typeof j.error === 'string') {
        const cause = j.error.replace(/^unable to connect to server - server may have stopped running or use a different port, firewall issue, etc\.:\s*/i, '');
        return { ok: false, outcome: classifyIperfError(j.error), detail: `iperf3: ${cause}` };
    }
    const bps = j.end?.sum_received?.bits_per_second;
    if (typeof bps !== 'number' || !Number.isFinite(bps)) return { ok: false, outcome: 'error', detail: 'iperf3 reported no receiver rate' };
    const rt = j.end?.sum_sent?.retransmits;
    return { ok: true, mbps: Math.round(bps / 10_000) / 100, retransmits: typeof rt === 'number' ? rt : null };
}

/** fping -C's per-target line ("10.0.0.1 : 0.31 0.29 - 0.30"), as round
 *  trips in ms; a "-" is a ping that did not come back, and is left out. */
export function parseFpingTimes(text: string): number[] {
    const out: number[] = [];
    for (const line of text.split('\n')) {
        const m = /^\S+\s+:\s+(.*)$/.exec(line.trim());
        if (m === null) continue;
        for (const t of (m[1] as string).split(/\s+/)) {
            const n = Number(t);
            if (t !== '-' && Number.isFinite(n)) out.push(n);
        }
    }
    return out;
}

/** The median, one decimal; null for none. A median, not a mean: one late
 *  reply must not read as the queue. */
export function median(xs: readonly number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    const m = s.length % 2 === 1 ? s[mid] as number : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
    return Math.round(m * 10) / 10;
}
