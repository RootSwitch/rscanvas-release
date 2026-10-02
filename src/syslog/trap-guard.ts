// The trap socket's guard (2026-10-01, review F1 and F10).
//
// ONE DATAGRAM KILLED THE PROCESS. net-snmp's Receiver wraps only the DECODE
// of an incoming message in try/catch. For an InformRequest it then re-encodes
// the message as a GetResponse and sends it back, outside that try - and two
// varbind types decode fine but throw on re-encode: a BIT STRING (writeVarbinds
// has no case for it) and an INTEGER outside int32 (read leniently, written
// strictly). The throw escaped the socket's 'message' listener as an uncaught
// exception on the ingest worker, which main answers with process.exit(1). An
// 82-byte Inform under any community string did it, from a spoofable source,
// and Restart=always made one packet every ten seconds a permanent outage.
//
// The receiver's handler is bound to its socket inside createReceiver, before
// the app holds the receiver, so it cannot be wrapped at the library's door.
// It is wrapped at the socket's: every 'message' listener net-snmp attached is
// taken off and called from inside a try/catch that counts and never rethrows.
// The acknowledgement's send is wrapped too, so an Inform whose ack cannot be
// encoded is still recorded - the notification was readable; only the reply
// to it was not.
//
// AND SNMPv3 IS REFUSED HERE, BEFORE THE LIBRARY SEES IT. With authorization
// disabled - the app has no v3 users - net-snmp delivered a noAuthNoPriv v3
// trap under any user name, and answered v3 discovery with Report PDUs to
// whatever address the request claimed. KNOWN-ISSUES says v3 traps are refused
// (not planned, ruled 2026-10-01), so they now are: by the version field in
// the datagram's first bytes, counted, and never parsed.

import type dgram from 'node:dgram';
import { snmpVersion } from '../net/snmp-guard.ts';

export { snmpVersion };

export type TrapDrop = 'v3' | 'malformed' | 'ack';

/** Control characters out of text that reaches a log line: an error message
 *  can carry sender-chosen bytes (a v3 user name, an OID string), and a CR or
 *  LF in it forges the next log line. */
export function logSafe(text: string): string {
    return text.replace(/[\x00-\x1f\x7f]/g, '?');
}

/**
 * Guard every socket of a net-snmp receiver. Returns how many sockets were
 * guarded; 0 means the library's internals moved, and the caller must say so
 * - an unguarded receiver is the F1 crash again.
 */
export function guardTrapReceiver(
    receiver: unknown,
    onDrop: (why: TrapDrop, detail: string, rinfo?: dgram.RemoteInfo) => void,
): number {
    const listener = (receiver as {
        listener?: { sockets?: Record<string, dgram.Socket>; send?: (...args: unknown[]) => unknown };
    }).listener;
    if (listener === undefined) return 0;

    if (typeof listener.send === 'function') {
        const send = listener.send;
        listener.send = function guardedSend(this: unknown, ...args: unknown[]): unknown {
            try {
                return send.apply(this, args);
            } catch (err) {
                onDrop('ack', (err as Error).message);
                return undefined;
            }
        };
    }

    const sockets = Object.values(listener.sockets ?? {});
    for (const s of sockets) {
        const inner = s.listeners('message') as Array<(msg: Buffer, rinfo: dgram.RemoteInfo) => void>;
        s.removeAllListeners('message');
        s.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
            if (snmpVersion(msg) === 3) { onDrop('v3', '', rinfo); return; }
            for (const fn of inner) {
                try {
                    fn.call(s, msg, rinfo);
                } catch (err) {
                    onDrop('malformed', (err as Error).message, rinfo);
                }
            }
        });
    }
    return sockets.length;
}
