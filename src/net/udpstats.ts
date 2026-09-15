// Kernel-side UDP counters.
//
// WHY THIS EXISTS. The spike's ingest worker generated its datagrams in-thread,
// so its `dropped` counter could only ever count its own queue shedding. With a
// real socket that counter is no longer sufficient and is actively misleading:
// the kernel drops datagrams into the void when the socket receive buffer is
// full, BEFORE Node ever sees them, and our own counter stays serenely at zero
// while reporting a number that is not true.
//
// BUILD-PLAN's done-when criterion is "zero dropped datagrams". Satisfying it
// against our own counter would be the sixth flattering failure: a too-narrow
// measurement looks exactly like a fast subject. So the authority is the
// kernel's own per-socket drop count, and it is printed every run.
//
// Sources, in order of authority for our purposes:
//
//   /proc/net/udp[6]  per-socket. `drops` is the count for THIS socket, and
//                     `rx_queue` is its current backlog in bytes, which is the
//                     early warning: it tells you that you are near the edge
//                     before you go over it.
//   /proc/net/snmp    system-wide Udp: RcvbufErrors and InErrors. A cross
//                     check, and the same numbers `netstat -su` prints.
//
// Linux only, by inspection rather than by assumption: on any other platform
// these return null and say so, because a silent zero would be the same lie in
// a different coat.

import fs from 'node:fs';

export interface SocketUdpStats {
    /** Bytes currently queued in the socket receive buffer, waiting for us. */
    rxQueueBytes: number;
    /** Datagrams the kernel discarded for this socket. The number that matters. */
    drops: number;
}

export interface SystemUdpStats {
    /** Datagrams dropped because a socket receive buffer was full, all sockets. */
    rcvbufErrors: number;
    inErrors: number;
}

export const PROC_AVAILABLE = process.platform === 'linux' && fs.existsSync('/proc/net/udp');

function parseProcNetUdp(path: string, port: number): SocketUdpStats | null {
    let text: string;
    try {
        text = fs.readFileSync(path, 'utf8');
    } catch {
        return null;
    }

    const wantedPort = port.toString(16).toUpperCase().padStart(4, '0');
    let found: SocketUdpStats | null = null;

    // sl local_address rem_address st tx_queue:rx_queue tr tm->when retrnsmt
    //    uid timeout inode ref pointer drops
    for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 13) continue;

        const local = f[1] as string;
        const colon = local.lastIndexOf(':');
        if (colon < 0) continue;
        if (local.slice(colon + 1).toUpperCase() !== wantedPort) continue;

        const queues = (f[4] as string).split(':');
        const rxQueueBytes = parseInt(queues[1] ?? '0', 16);
        const drops = parseInt(f[f.length - 1] as string, 10);
        if (Number.isNaN(drops)) continue;

        // A wildcard bind can appear once per address family; sum rather than
        // taking the first, or a dual-stack listener reports half its drops.
        found = found === null
            ? { rxQueueBytes, drops }
            : { rxQueueBytes: found.rxQueueBytes + rxQueueBytes, drops: found.drops + drops };
    }
    return found;
}

/** Per-socket counters for a listening UDP port, or null if not on Linux. */
export function socketStats(port: number): SocketUdpStats | null {
    if (!PROC_AVAILABLE) return null;
    const v4 = parseProcNetUdp('/proc/net/udp', port);
    const v6 = parseProcNetUdp('/proc/net/udp6', port);
    if (v4 === null && v6 === null) return null;
    return {
        rxQueueBytes: (v4?.rxQueueBytes ?? 0) + (v6?.rxQueueBytes ?? 0),
        drops: (v4?.drops ?? 0) + (v6?.drops ?? 0),
    };
}

/** System-wide UDP counters, the same ones `netstat -su` reports. */
export function systemStats(): SystemUdpStats | null {
    if (!PROC_AVAILABLE) return null;
    let text: string;
    try {
        text = fs.readFileSync('/proc/net/snmp', 'utf8');
    } catch {
        return null;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (!line.startsWith('Udp:')) continue;
        const headers = line.trim().split(/\s+/);
        const values = (lines[i + 1] ?? '').trim().split(/\s+/);
        if (values[0] !== 'Udp:') continue;
        const get = (name: string): number => {
            const idx = headers.indexOf(name);
            return idx < 0 ? 0 : Number(values[idx] ?? 0);
        };
        return { rcvbufErrors: get('RcvbufErrors'), inErrors: get('InErrors') };
    }
    return null;
}

/**
 * A receive-buffer report that states requested and actual separately.
 *
 * The gotcha worth writing down: getsockopt returns DOUBLE what setsockopt was
 * given. The kernel reserves half for bookkeeping (see socket(7), SO_RCVBUF),
 * so asking for 8MB and reading back 16MB is correct behaviour and not a bug in
 * anything. Reporting only the read-back value invites someone to file a bug
 * against a working kernel; reporting only the requested value hides a request
 * that got clamped by net.core.rmem_max, which is a real and common failure.
 * Both, always.
 */
export interface RcvbufReport {
    requestedBytes: number;
    actualBytes: number;
    /** True when the kernel gave less than the doubling rule predicts. */
    clamped: boolean;
}

export function describeRcvbuf(requested: number, actual: number): RcvbufReport {
    return {
        requestedBytes: requested,
        actualBytes: actual,
        clamped: actual < requested * 2,
    };
}
