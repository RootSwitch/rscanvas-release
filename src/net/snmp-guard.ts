// Guards for the sockets net-snmp owns (2026-10-01, review F1 and F1b).
//
// Twice the library's own try/catch has covered DECODING a datagram and not
// what it does next, and both times one packet ended the process: an Inform
// whose acknowledgement could not be re-encoded (F1, the trap receiver; see
// syslog/trap-guard.ts), and here a Report PDU in a v1 or v2c response (F1b,
// every polling session). The rule since: every socket net-snmp owns in this
// application has its 'message' listener wrapped.
//
// F1b. Session.prototype.onMsg (net-snmp 3.26.3, index.js:2413-2440) decodes
// inside a try, unregisters the request, and then, for a Report PDU, reads
// message.msgSecurityParameters.msgAuthoritativeEngineID - which a community
// (v1/v2c) message does not have. The TypeError escaped the socket's listener
// as an uncaught exception on the collector worker, and main exits on that.
// Any polled v1/v2c device could do it by answering a poll with a Report-
// tagged PDU, and so could any address an admin probes while onboarding: the
// fleet monitor could be taken down for good by the weakest device it
// watches - a printer, a UPS card, a camera.
//
// WRAPPING ALONE WOULD NOT HAVE BEEN ENOUGH, and the review's sketch of the
// fix missed this: unregisterRequest clears the request's timer BEFORE the
// throw, so a swallowed throw leaves a request with no timer and no answer -
// the poll waits for ever and holds its slot. So the known shape is dropped
// before the library sees it (the request then times out as unanswered and
// the poll says why), and for any throw not yet known, a request the failed
// message unregistered is answered with the error.

import type dgram from 'node:dgram';

/**
 * The SNMP version field of a datagram, read from its first bytes without
 * decoding the rest: 0 = v1, 1 = v2c, 3 = v3. Null when the bytes are not the
 * start of an SNMP message, which the library then refuses on its own.
 */
export function snmpVersion(buf: Buffer): number | null {
    // SEQUENCE, a length (short or long form), then INTEGER version.
    if (buf.length < 5 || buf[0] !== 0x30) return null;
    let i = 1;
    const len0 = buf[i++] as number;
    if (len0 & 0x80) {
        const n = len0 & 0x7f;
        if (n === 0 || n > 4) return null;
        i += n;
    }
    if (i + 2 >= buf.length || buf[i] !== 0x02) return null;
    const vlen = buf[i + 1] as number;
    if (vlen < 1 || vlen > 4 || i + 2 + vlen > buf.length) return null;
    let v = 0;
    for (let k = 0; k < vlen; k++) v = v * 256 + (buf[i + 2 + k] as number);
    return v;
}

/** Step over one BER element's tag and length; the index of its contents and
 *  their length, or null when the bytes run out. */
function berHeader(buf: Buffer, at: number): { body: number; len: number } | null {
    if (at + 1 >= buf.length) return null;
    let i = at + 1;
    const len0 = buf[i++] as number;
    let len = len0;
    if (len0 & 0x80) {
        const n = len0 & 0x7f;
        if (n === 0 || n > 4 || i + n > buf.length) return null;
        len = 0;
        for (let k = 0; k < n; k++) len = len * 256 + (buf[i + k] as number);
        i += n;
    }
    return { body: i, len };
}

/** The PDU tag of a v1/v2c message - SEQUENCE { version, community, PDU } -
 *  or null when it is not one. 0xA8 is a Report. */
export function communityPduTag(buf: Buffer): number | null {
    const seq = berHeader(buf, 0);
    if (buf[0] !== 0x30 || seq === null) return null;
    const ver = berHeader(buf, seq.body);
    if (ver === null || buf[seq.body] !== 0x02) return null;
    const commAt = ver.body + ver.len;
    const comm = berHeader(buf, commAt);
    if (comm === null || buf[commAt] !== 0x04) return null;
    const pduAt = comm.body + comm.len;
    return pduAt < buf.length ? (buf[pduAt] as number) : null;
}

export const PDU_REPORT = 0xa8;

/** A pending request as net-snmp keeps it: what its callback is. */
interface PendingRequest { responseCb?: (err: Error) => void }

/**
 * Guard a net-snmp Session's socket. Returns false when the library's
 * internals have moved and the socket could not be reached; the caller says
 * so, because an unguarded session is the F1b crash again.
 */
export function guardSession(inner: unknown, onProblem: (err: Error) => void): boolean {
    const s = inner as { dgram?: dgram.Socket; reqs?: Record<string, PendingRequest> };
    const sock = s.dgram;
    if (sock === undefined || typeof sock.listeners !== 'function') return false;
    const listeners = sock.listeners('message') as Array<(msg: Buffer, rinfo: dgram.RemoteInfo) => void>;
    if (listeners.length === 0) return false;
    sock.removeAllListeners('message');
    sock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        const v = snmpVersion(msg);
        if ((v === 0 || v === 1) && communityPduTag(msg) === PDU_REPORT) {
            onProblem(new Error('the device answered with a Report PDU in a '
                + `${v === 0 ? 'v1' : 'v2c'} message, which is not an answer; it was dropped`));
            return;
        }
        const before = Object.entries(s.reqs ?? {});
        for (const fn of listeners) {
            try {
                fn.call(sock, msg, rinfo);
            } catch (err) {
                const e = new Error(`the SNMP library failed on the device's response: ${(err as Error).message}`);
                onProblem(e);
                for (const [id, req] of before) {
                    if (s.reqs !== undefined && id in s.reqs) continue;
                    try { req.responseCb?.(e); } catch { /* the caller's own callback; nothing to add */ }
                }
            }
        }
    });
    return true;
}
