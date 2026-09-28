// The SNMP transport. A thin promise wrapper over net-snmp.
//
// Ported from snmpcanvas/server/snmp.js. Two things in it are load bearing and
// easy to lose in a rewrite:
//
//   1. Counter64 arrives as a raw Buffer and MUST become a BigInt. It is the
//      64-bit octet counter, which is the whole reason ifXTable exists: a
//      Counter32 on a 10G link wraps in under 4 seconds. Coercing it through
//      Number would silently lose precision above 2^53 and produce throughput
//      figures that are wrong only sometimes.
//   2. A timeout is not an error to retry forever. The scheduler charges a
//      dead device roughly 200x what a live one costs, so the timeout and
//      retry count here are capacity decisions, not politeness.

import snmp from 'net-snmp';
import { CONFIG } from '../config.ts';
import { explainV3Error, explainV3Timeout, explainCommunityTimeout } from '../credentials/v3.ts';

/**
 * net-snmp ships no type declarations, so TypeScript infers what it can from
 * the JavaScript - and that inference stops short of the v3 API. A NAMED
 * view of exactly the four symbols this file needs beats casting twice at
 * the call site: it documents the surface the fork depends on, and a library
 * change that drops one becomes a compile error here rather than a runtime
 * surprise on the one device class that cannot speak anything else.
 */
interface NetSnmpV3Api {
    createV3Session: (host: string, user: Record<string, unknown>, options: unknown) => {
        on: (ev: string, cb: (err: Error) => void) => void;
        close: () => void;
    };
    SecurityLevel: Record<string, number>;
    AuthProtocols: Record<string, number>;
    PrivProtocols: Record<string, number>;
}
const snmpV3 = snmp as unknown as NetSnmpV3Api;

export interface Target {
    host: string;
    port: number;
    version: '1' | '2c' | '3';
    community: string;
    /** Present iff version is '3'. Protocol keys are already resolved to the
     *  library's own vocabulary by credentials/v3.ts - this layer indexes,
     *  it does not interpret. */
    v3?: {
        user: string;
        level: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
        authProto: string | null;
        authKey: string | null;
        privProto: string | null;
        privKey: string | null;
    } | null;
}

export interface Session {
    close: () => void;
    inner: unknown;
    /**
     * A session-level error that arrived outside any request, or null.
     *
     * Set by the listener in createSession. Read by the poll so a device that
     * sent something undecodable is reported as that, rather than as the
     * five-second timeout it would otherwise look like.
     */
    lastError: Error | null;
    /** The v3 security level this session negotiates with, or null on v1/v2c.
     *  Carried so translate() can say what a TIMEOUT means here - on
     *  authPriv it also fits a wrong priv key, because an agent that cannot
     *  decrypt drops the packet instead of reporting (measured). */
    v3Level: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv' | null;
}

/**
 * Slot-second budgeting depends on these two numbers, so they are config
 * rather than literals. Default 5s with 1 retry is the parent's, and it is
 * where "a dead device costs about 10s" comes from: 5s x (1 + 1 retry).
 */
export function createSession(t: Target): Session {
    const options = {
        port: t.port || 161,
        retries: CONFIG.snmpRetries,
        timeout: CONFIG.snmpTimeoutMs,
        version: t.version === '3' ? snmp.Version3
            : t.version === '1' ? snmp.Version1
            : snmp.Version2c,
    };
    // SNMPv3 (slice 29). Deferred in slice 4 with a stated precondition -
    // "the credential plumbing is a security decision, adding it here without
    // that decision would be the wrong order" - and the precondition shipped:
    // profiles hold v3 identity beside an AES-256-GCM ciphertext, decrypted
    // in the collector thread alone. So this branch is the whole of "the fork
    // speaks v3", and everything downstream (probe, poll, walkMany, the
    // sensor pass) is a session consumer that changes not at all. That is the
    // test of the abstraction, and it passed on the first run.
    //
    // The user object is the library's shape; net-snmp performs engine
    // discovery itself on the first exchange, so nothing here manages
    // engineIDs, boots or time windows - it only has to REPORT them
    // honestly when they fail, which translate() below now does.
    const inner = t.version === '3' && t.v3
        ? snmpV3.createV3Session(t.host, {
            name: t.v3.user,
            level: snmpV3.SecurityLevel[t.v3.level],
            ...(t.v3.authProto !== null ? { authProtocol: snmpV3.AuthProtocols[t.v3.authProto] } : {}),
            ...(t.v3.authKey !== null ? { authKey: t.v3.authKey } : {}),
            ...(t.v3.privProto !== null ? { privProtocol: snmpV3.PrivProtocols[t.v3.privProto] } : {}),
            ...(t.v3.privKey !== null ? { privKey: t.v3.privKey } : {}),
        }, options)
        : snmp.createSession(t.host, t.community, options);

    // AN 'error' EVENT WITH NO LISTENER IS THROWN, NEVER DROPPED, and this
    // session is created PER POLL against a device nobody here controls.
    //
    // net-snmp's Session extends EventEmitter and emits 'error' from `onMsg`
    // when a response cannot be decoded (net-snmp 3.26.3, index.js:2417 -
    // `this.emit("error", error)` inside the createFromBuffer catch). A
    // malformed or hostile response packet therefore threw inside the collector
    // worker, which main treats as fatal, which exits the process - taking the
    // INGEST worker's queue with it. Same shape as the pg client error that
    // cost ~22,000 accepted rows, on a path reached by any device on the
    // network rather than only by a database restart.
    //
    // Recorded rather than rethrown. The in-flight request has its own 5s
    // timeout and will fail on its own; what this must not do is take the
    // thread down, and what it should do is explain WHY a poll failed rather
    // than leaving it looking like an ordinary timeout.
    const session: Session = {
        inner,
        lastError: null,
        v3Level: t.version === '3' && t.v3 ? t.v3.level : null,
        close: () => { try { (inner as { close: () => void }).close(); } catch { /* already closed */ } },
    };
    inner.on('error', (err: Error) => {
        session.lastError = err instanceof Error ? err : new Error(String(err));
    });

    // AND ONE CLASS OF ERROR CANNOT REACH THAT LISTENER AT ALL, which is an
    // upstream bug rather than a gap here. net-snmp's socket-error path is
    //
    //     Session.prototype.onError = function (error) { this.emit (error); }
    //
    // - the Error object passed as the EVENT NAME instead of `emit("error",
    // error)`. So dgram-level failures (EACCES, EHOSTUNREACH on send, EMFILE)
    // are emitted under a nonsense event name and silently vanish; no listener
    // can catch them. They do not crash the process, which is the one mercy,
    // and they degrade the poll to a timeout. Filed in UPSTREAM.md.
    return session;
}

export type SnmpValue = string | number | bigint | null;

/** Counter64 arrives as a Buffer; everything else is a number or a string. */
function coerce(vb: { type: number; value: unknown }): SnmpValue {
    if (vb.type === snmp.ObjectType.Counter64) {
        const buf = vb.value;
        if (!Buffer.isBuffer(buf) || buf.length === 0) return 0n;
        return BigInt('0x' + buf.toString('hex'));
    }
    if (Buffer.isBuffer(vb.value)) return vb.value.toString('utf8');
    return vb.value as SnmpValue;
}

export class SnmpError extends Error {
    readonly kind: 'timeout' | 'auth' | 'other';
    constructor(message: string, kind: 'timeout' | 'auth' | 'other') {
        super(message);
        this.kind = kind;
    }
}

function translate(err: Error, v3Level: Session['v3Level'] = null): SnmpError {
    const m = err.message || String(err);
    if (/timeout|timed out/i.test(m)) {
        // null is v1/v2c (Session.v3Level): a community is a key too.
        const hint = v3Level === null ? explainCommunityTimeout() : explainV3Timeout(v3Level);
        return new SnmpError(hint === null ? m : `${m} - ${hint}`, 'timeout');
    }
    // v3 (slice 29): a usmStats REPORT names the fault, so the message the
    // operator reads names it too. This is the diagnosability half of v3 -
    // where v2c answers a wrong community with silence indistinguishable
    // from a dead host, v3 says which of six things went wrong, and the
    // caller must not flatten that back into "auth failed".
    const v3 = explainV3Error(m);
    if (v3 !== null) return new SnmpError(`${m} - ${v3}`, 'auth');
    if (/authentication|auth|community/i.test(m)) return new SnmpError(m, 'auth');
    return new SnmpError(m, 'other');
}

type NetSnmpSession = {
    get: (oids: string[], cb: (err: Error | null, varbinds: Array<{ type: number; value: unknown }>) => void) => void;
    subtree: (
        oid: string,
        // Returning true from the feed callback is net-snmp's stop signal:
        // the walk ends and the done callback fires with no error.
        feedCb: (varbinds: Array<{ oid: string; type: number; value: unknown }>) => boolean | void,
        doneCb: (err: Error | null) => void,
    ) => void;
};

/**
 * GET a list of OIDs. Resolves to a Map of oid to value; anything the agent
 * does not have maps to null rather than rejecting, because a missing optional
 * column is normal and should not fail the poll.
 */
export function get(session: Session, oids: string[]): Promise<Map<string, SnmpValue>> {
    return new Promise((resolve, reject) => {
        if (oids.length === 0) { resolve(new Map()); return; }
        (session.inner as NetSnmpSession).get(oids, (err, varbinds) => {
            if (err) { reject(translate(err, session.v3Level)); return; }
            const out = new Map<string, SnmpValue>();
            for (let i = 0; i < varbinds.length; i++) {
                const vb = varbinds[i];
                const oid = oids[i] as string;
                out.set(oid, vb && snmp.isVarbindError(vb as never) ? null : coerce(vb as { type: number; value: unknown }));
            }
            resolve(out);
        });
    });
}

/**
 * Walk a subtree. Resolves to a Map of index-suffix to value, where the suffix
 * is whatever follows the base OID - for an ifTable column that is the ifIndex.
 *
 * Bounded THREE ways, because the collector's slot budget assumes a poll
 * ends and each bound covers a misbehaviour the others cannot see: maxRows
 * stops an oversized table (memory, and - since the stop signal - the time
 * to walk it); the progress guard stops a cycling or non-advancing agent,
 * which the row cap structurally cannot catch because re-delivered suffixes
 * overwrite in the map and never grow it (AUDIT-2026-09-01 finding 1,
 * demonstrated at 100,000 batches); and the deadline stops the walk that
 * produces no callbacks at all, the mode the probe once measured against
 * the lab's own mock agent. tools/test-walk.ts drives all three against
 * the shipped function.
 */
export function walk(
    session: Session, baseOid: string, maxRows = CONFIG.snmpWalkMaxRows,
    deadlineMs = CONFIG.snmpWalkDeadlineMs,
): Promise<Map<string, SnmpValue>> {
    return new Promise((resolve, reject) => {
        const out = new Map<string, SnmpValue>();
        let overflowed = false;
        let stalled = false;
        let settled = false;
        // Consecutive batches that carried NO data at all - only varbind
        // errors. See the guard below for why these are a stall in their
        // own right rather than the "no callbacks" mode the deadline covers.
        let emptyBatches = 0;
        // THE DEADLINE (AUDIT-2026-09-01 finding 1). The row cap's stop
        // signal cannot fire on the hang mode the probe once measured - a
        // walk that produces NO callbacks at all - because there is no
        // batch to judge. When this fires, the promise rejects and the
        // underlying walk is abandoned to die with the session in the
        // caller's finally; a later done-callback finds `settled` and is
        // ignored, so nothing resolves twice and nothing leaks a rejection.
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new SnmpError(
                `walk of ${baseOid} exceeded its ${deadlineMs}ms deadline - the agent `
                + 'stopped answering mid-walk', 'timeout'));
        }, deadlineMs);
        timer.unref();
        (session.inner as NetSnmpSession).subtree(
            baseOid,
            (varbinds) => {
                // THE PROGRESS GUARD, and why the row cap alone was not one:
                // `out` is keyed by OID suffix, so an agent that cycles or
                // fails to advance RE-DELIVERS suffixes the map already
                // holds - set() overwrites, size never grows, and the cap
                // never trips (demonstrated in AUDIT-2026-09-01: 100,000
                // batches, size pinned at the cycle length). A batch that
                // carried real varbinds and grew the map by NOTHING is that
                // misbehaviour caught at its first repetition, and true ends
                // the walk right there.
                const before = out.size;
                let sawData = false;
                for (const vb of varbinds) {
                    if (out.size >= maxRows) {
                        // true ENDS the walk, not just the storing - time is
                        // the resource the slot budget actually spends.
                        overflowed = true;
                        return true;
                    }
                    if (snmp.isVarbindError(vb as never)) continue;
                    sawData = true;
                    const suffix = vb.oid.startsWith(baseOid + '.')
                        ? vb.oid.slice(baseOid.length + 1)
                        : vb.oid;
                    out.set(suffix, coerce(vb));
                }
                if (sawData && out.size === before) {
                    stalled = true;
                    return true;
                }
                // THE BLIND SPOT THE DEMO FLEET FOUND (DEMO-FLEET-PLAN
                // section 11, 2026-09-02): some agents - net-snmp's own
                // agent library among them, so tools/mock-fleet.cjs and
                // every RSFleet device - answer a GETBULK that runs past
                // the end of their tree with NoSuchInstance AT THE REQUESTED
                // OID rather than endOfMibView. net-snmp's client walker
                // reads that as still-in-subtree and re-asks the same OID
                // forever; measured at 25 batches in 32ms with no progress
                // and no error. Those batches never reached the guard
                // above, because an error varbind is skipped without
                // setting sawData - so the walk spun until the deadline, and
                // the probe's 8s boundedWalk was paying for it on every
                // device whose tree ends before LM-SENSORS space ("the
                // firewall discovers slower than the switches"). Two
                // consecutive batches with no data and no growth is that
                // loop caught at its first repetition; a genuine end still
                // ends the walk through the done callback as before.
                if (!sawData && out.size === before) {
                    emptyBatches++;
                    if (emptyBatches >= 2) { stalled = true; return true; }
                } else {
                    emptyBatches = 0;
                }
            },
            (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) { reject(translate(err, session.v3Level)); return; }
                if (overflowed) {
                    // Loud rather than silent: a truncated walk means entities
                    // are missing from discovery, and a device quietly losing
                    // half its interfaces is worse than a failed poll.
                    console.warn(new Date().toISOString(),
                        `[snmp] walk of ${baseOid} hit the ${maxRows} row cap and was truncated`);
                }
                if (stalled) {
                    // Partial truth, loudly named - the overflow precedent.
                    // What was collected before the cycle is real data; the
                    // freed poll slot is the fix.
                    console.warn(new Date().toISOString(),
                        `[snmp] walk of ${baseOid} STOPPED: `
                        + (emptyBatches >= 2
                            ? 'the agent answered only NoSuchInstance past the end of its tree '
                              + '(no endOfMibView - net-snmp agents do this) '
                            : 'the agent re-delivered already-seen OIDs (cycling or non-advancing) ')
                        + `after ${out.size} row(s)`);
                }
                resolve(out);
            },
        );
    });
}

/**
 * Walk several subtrees on one session with BOUNDED concurrency, results in
 * input order.
 *
 * Firing every walk at once looked free and cost five seconds per poll on
 * every MikroTik in the fleet, forever. RouterOS silently DROPS SNMP
 * requests past roughly 8-10 concurrent in-flight PDUs - no error, no
 * tmDropped counter the operator can see, just a request that never
 * happened. The dropped walk then eats the full timeout and succeeds on its
 * retry, so every poll "worked" while carrying a constant ~5s of invisible
 * penalty, and the operator read their switches as slow devices.
 *
 * Measured on a CRS309 (2026-08-28): 14 concurrent walks = 5.2s with 4-5 of
 * them timing out and retrying; the same 14 at concurrency 8 = 413ms, at 4 =
 * 650ms, zero drops at either. The default of 6 leaves margin below the
 * observed cliff without meaningfully slowing agents that could take the
 * burst - three rounds of milliseconds against a 30s interval.
 */
export async function walkMany(
    session: Session, baseOids: string[], conc = CONFIG.snmpWalkConcurrency,
): Promise<Array<Map<string, SnmpValue>>> {
    const out: Array<Map<string, SnmpValue>> = new Array(baseOids.length);
    let next = 0;
    const runner = async (): Promise<void> => {
        while (next < baseOids.length) {
            const i = next;
            next += 1;
            out[i] = await walk(session, baseOids[i]);
        }
    };
    await Promise.all(Array.from(
        { length: Math.max(1, Math.min(conc, baseOids.length)) }, runner));
    return out;
}

export const asNumber = (v: SnmpValue): number | null => {
    if (v === null) return null;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Decode an OctetString, and STRIP THE NUL BYTES.
 *
 * Postgres `text` cannot hold 0x00 at all - it is not a question of encoding
 * or escaping, the type has no representation for it - so a single NUL
 * anywhere in a device-reported string makes the INSERT fail with
 * `invalid byte sequence for encoding "UTF8": 0x00`. That is the whole device
 * refused, not the one column.
 *
 * MEASURED 2026-08-17, against Windows' own SNMP service: two Windows hosts
 * were the only devices in a 23-device estate that could not be added, and
 * this was why. SNMP OctetStrings are byte strings with a length, not
 * C strings, so nothing in the protocol forbids a NUL - agents that build them
 * from a C buffer keep the terminator, and one that builds them from a UTF-16
 * buffer leaves a NUL between every character. Stripping is right for both:
 * the terminator is noise, and the interleaved case decodes to the readable
 * text the agent meant.
 *
 * DONE HERE because this is the ONE place every device-controlled string
 * enters the system - sysDescr, sysLocation, ifDescr, ifAlias, sensor names,
 * every vendor scalar. Fixing it at the insert would have left the next reader
 * of these strings to find it again, and there are several.
 *
 * It does not attempt to be a general sanitiser. Escaping for display is a
 * separate invariant handled at render time, and stripping more than the byte
 * the database genuinely cannot store would be quietly editing what a device
 * reported.
 */
export const asString = (v: SnmpValue): string | null => {
    if (v === null) return null;
    const s = String(v);
    // Escaped rather than literal: a raw NUL in source is invisible in every
    // editor, diff and grep, and inserting one here while writing this very
    // fix turned the file into something git reports as binary.
    return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
};

/** Counters stay BigInt so a 64-bit octet count keeps every bit. */
export const asCounter = (v: SnmpValue): bigint | null => {
    if (v === null) return null;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
    try { return BigInt(String(v)); } catch { return null; }
};
