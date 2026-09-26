// Minimal ambient types for net-snmp, which ships none.
//
// Deliberately narrow: it declares only the receiver surface the ingest worker
// actually uses, verified against net-snmp 3.26.3 by reading index.js rather
// than by guessing from documentation. A broad `declare module 'net-snmp'`
// with an implicit any would typecheck just as well and catch nothing, which
// is worse than no types at all because it looks like coverage.
//
// Widened for slice 4, which needs the manager side: sessions, get, subtree
// and the Counter64 tag. Verified against net-snmp 3.26.3 by calling it -
// Version1/2c/3 are 0/1/3, ObjectType.Counter64 is 70, and a session exposes
// get, subtree, walk, table and close. Slice 10 owns trap-to-alert and will
// need the remaining PDU types.

declare module 'net-snmp' {
    export interface Varbind {
        oid: string;
        type: number;
        value: Buffer | number | string | bigint | null;
    }

    export interface TrapPdu {
        type: number;
        varbinds?: Varbind[];
        community?: string;
        user?: string;
        contextEngineID?: string;
    }

    export interface RemoteInfo {
        address: string;
        family: string;
        port: number;
        size: number;
    }

    export interface Notification {
        pdu: TrapPdu;
        rinfo: RemoteInfo;
    }

    export interface ReceiverOptions {
        port?: number;
        address?: string;
        disableAuthorization?: boolean;
        includeAuthentication?: boolean;
        transport?: string;
    }

    export interface Receiver {
        close(callback?: () => void): void;
    }

    export function createReceiver(
        options: ReceiverOptions,
        callback: (error: Error | null, notification: Notification) => void,
    ): Receiver;

    // --- manager side, slice 4 -------------------------------------------------

    export const Version1: number;
    export const Version2c: number;
    export const Version3: number;

    /** Only the tag slice 4 discriminates on. 70 in net-snmp 3.26.3. */
    export const ObjectType: { Counter64: number; [name: string]: number };

    export interface SessionOptions {
        port?: number;
        retries?: number;
        timeout?: number;
        version?: number;
        transport?: string;
        /** Where trap() sends (index.js:2036, default 162). tools/trap-load.ts. */
        trapPort?: number;
    }

    export interface WalkVarbind {
        oid: string;
        type: number;
        value: unknown;
    }

    export interface ManagerSession {
        get(
            oids: string[],
            callback: (error: Error | null, varbinds: WalkVarbind[]) => void,
        ): void;
        subtree(
            oid: string,
            feedCallback: (varbinds: WalkVarbind[]) => void,
            doneCallback: (error: Error | null) => void,
        ): void;
        close(): void;
        /**
         * Send one SNMPv2c trap: sysUpTime.0 and snmpTrapOID.0 (typeOrOid) are
         * prepended by the library, then these varbinds (index.js:2777). The
         * callback fires once the datagram is handed to the socket - a v2c
         * trap is unacknowledged. Declared for tools/trap-load.ts, the only
         * caller; the three-argument form is the one verified.
         */
        trap(
            typeOrOid: string | number, varbinds: Varbind[],
            callback: (error: Error | null) => void,
        ): void;
        /**
         * Session extends EventEmitter (index.js:2100,
         * `util.inherits(Session, events.EventEmitter)`), and it EMITS.
         *
         * Declared because leaving it off made the compiler complicit: an
         * emitter whose `on` is invisible to the type system is one nobody
         * attaches a listener to, and an 'error' event with no listener is
         * THROWN. `onMsg` emits 'error' on an undecodable response
         * (index.js:2417), so a malformed packet from any device on the
         * network killed the collector worker.
         *
         * Narrow on purpose - only 'error', because that is the only event this
         * code has verified and has a reason to handle. Widening it is a
         * decision, not a convenience.
         */
        on(event: 'error', listener: (error: Error) => void): void;
    }

    export function createSession(
        target: string, community: string, options?: SessionOptions,
    ): ManagerSession;

    export function isVarbindError(varbind: unknown): boolean;
}
