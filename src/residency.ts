// Cache residency as a measured output, never an assumption.
//
// Promoted from spike/src/residency.ts. The reasoning below is carried with it
// because the reasoning is the valuable part: run 1 of the spike was invalidated
// by believing something about the environment that nothing printed - that a
// 34GB corpus on a 32GB box would be disk bound. It was not, because Postgres
// double buffers and the correct denominator is total RAM, not shared_buffers.
//
// The fix is the same as the heartbeat's. Print it, next to every latency
// figure. A run whose cache state is not in its own output cannot be trusted
// later, and the search envelope in BUILD-PLAN's done-when list is a COLD
// figure, so a warm run reporting 40ms is not a pass - it is a different
// measurement wearing the same units.
//
// Three layers get recorded, because each answers a different question and the
// obvious one is the weakest:
//
//   1. pg_statio hit/read       - shared_buffers residency ONLY. A "read" here
//                                 has NOT necessarily touched a disk: it may
//                                 have been served by the kernel page cache
//                                 sitting underneath. Postgres cannot see the
//                                 lower layer. Reporting it alone would repeat
//                                 the original error in a new costume.
//   2. blk_read_time per block  - distinguishes the two layers by latency.
//                                 Page cache serves in single-digit
//                                 microseconds; NVMe random reads land around
//                                 80 to 120us.
//   3. /proc/diskstats deltas   - ground truth from below Postgres entirely.
//                                 Sectors actually read from the device.

import { readFile } from 'node:fs/promises';
import { OPS } from './store/index.ts';

export interface DiskSnapshot {
    device: string;
    sectorsRead: number;
    sectorsWritten: number;
    msReading: number;
}

export interface PgSnapshot {
    blksRead: number;
    blksHit: number;
    blkReadTimeMs: number;
}

export interface Residency {
    device: string;
    mbReadFromDevice: number;
    mbWrittenToDevice: number;
    pgBlksRead: number;
    pgBlksHit: number;
    pgBufferHitPct: number;
    usPerBlockRead: number | null;
    pgCountersLagging: boolean;
    verdict: string;
}

const SECTOR_BYTES = 512;

export const DISKSTATS_AVAILABLE = process.platform === 'linux';

// Watches every whole disk by default, discovered from /proc/diskstats rather
// than hardcoded.
//
// This has now been wrong twice for the same reason. First it watched one
// device and reported 1.7MB for a query running entirely on another. Then it
// watched a hardcoded pair and did it again the moment a third disk appeared.
// A default that enumerates cannot go stale when the hardware changes, and the
// failure mode of a too-narrow scope is indistinguishable from "the storage was
// fast", which is the most dangerous way for an instrument to be wrong.
//
// DATA_DEVICE still overrides, for deliberately narrowing to one device.
export async function diskSnapshot(devices = process.env.DATA_DEVICE ?? ''): Promise<DiskSnapshot> {
    const text = await readFile('/proc/diskstats', 'utf8');
    // Whole disks only: sda not sda1, nvme0n1 not nvme0n1p1, and no loop or sr.
    const isWholeDisk = (n: string): boolean => /^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+)$/.test(n);
    const want = devices
        ? devices.split(',').map((d) => d.trim()).filter(Boolean)
        : text.split('\n')
            .map((l) => l.trim().split(/\s+/)[2])
            .filter((n): n is string => n !== undefined && isWholeDisk(n));

    const found: string[] = [];
    let sectorsRead = 0;
    let sectorsWritten = 0;
    let msReading = 0;

    for (const line of text.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f[2] === undefined || !want.includes(f[2])) continue;
        found.push(f[2]);
        sectorsRead += Number(f[5]);
        msReading += Number(f[6]);
        sectorsWritten += Number(f[9]);
    }
    if (found.length === 0) {
        throw new Error(`none of [${want.join(', ')}] found in /proc/diskstats`);
    }
    return { device: found.join('+'), sectorsRead, sectorsWritten, msReading };
}

export async function pgSnapshot(): Promise<PgSnapshot> {
    const res = await OPS.pgBufferStats();
    if (!res.ok) throw new Error(`pgSnapshot: lane refused (${res.reason})`);
    const r = res.rows[0];
    return {
        blksRead: Number(r?.blks_read ?? 0),
        blksHit: Number(r?.blks_hit ?? 0),
        blkReadTimeMs: Number(r?.blk_read_time ?? 0),
    };
}

export function residency(
    d0: DiskSnapshot, d1: DiskSnapshot, p0: PgSnapshot, p1: PgSnapshot,
): Residency {
    const blksRead = p1.blksRead - p0.blksRead;
    const blksHit = p1.blksHit - p0.blksHit;
    const readTime = p1.blkReadTimeMs - p0.blkReadTimeMs;
    const usPerBlock = blksRead > 0 ? (readTime * 1000) / blksRead : null;
    const mbFromDevice = ((d1.sectorsRead - d0.sectorsRead) * SECTOR_BYTES) / 1_048_576;

    // DEVICE EVIDENCE WINS. Postgres counters are a derived view that can lag
    // or under-report; sectors off the block device cannot be argued with. An
    // earlier version consulted blksRead first and therefore announced "fully
    // resident" over the top of megabytes of real reads.
    let verdict: string;
    if (mbFromDevice >= 1) {
        verdict = 'disk bound';
    } else if (blksRead === 0) {
        verdict = 'fully resident, no device I/O';
    } else if (usPerBlock !== null && usPerBlock < 15) {
        verdict = 'served by kernel page cache, NOT disk';
    } else {
        verdict = 'mixed: little device I/O';
    }

    return {
        device: d1.device,
        mbReadFromDevice: Number(mbFromDevice.toFixed(1)),
        mbWrittenToDevice: Number((((d1.sectorsWritten - d0.sectorsWritten) * SECTOR_BYTES) / 1_048_576).toFixed(1)),
        pgBlksRead: blksRead,
        pgBlksHit: blksHit,
        pgBufferHitPct: blksRead + blksHit > 0
            ? Number(((blksHit / (blksRead + blksHit)) * 100).toFixed(2))
            : 100,
        usPerBlockRead: usPerBlock === null ? null : Number(usPerBlock.toFixed(1)),
        // True when the device did real reads but Postgres reported none, i.e.
        // the pg-side counters in this row are known to be under-reporting and
        // must not be read as evidence of cache residency.
        pgCountersLagging: mbFromDevice >= 1 && blksRead === 0,
        verdict,
    };
}

// PostgreSQL 15 and later flush backend statistics into shared memory on a
// minimum interval, so snapshotting immediately after a fast query reads stale
// counters and reports zero blocks read for a query that demonstrably hit the
// disk. The first version of this did exactly that, and printed "fully resident
// in shared_buffers" next to 10MB of device reads: the same class of error this
// module exists to catch, inside the module itself.
//
// The wait below helps but does NOT fully fix it, and saying so matters more
// than appearing to have fixed it. A pooled backend that has gone idle does not
// necessarily flush at all, so queries finishing in well under a second still
// report zero. Queries lasting seconds flush mid-flight and report correctly.
// This is why the verdict is decided on device evidence and why a discrepancy
// is flagged rather than smoothed over.
const STATS_FLUSH_MS = 1_500;

export async function measureResidency<T>(
    fn: () => Promise<T>,
): Promise<{ result: T; residency: Residency | null }> {
    if (!DISKSTATS_AVAILABLE) {
        // Honest null rather than a fabricated verdict. A residency figure
        // invented on a platform that cannot produce one is worse than none.
        return { result: await fn(), residency: null };
    }
    const [d0, p0] = await Promise.all([diskSnapshot(), pgSnapshot()]);
    const result = await fn();
    const d1 = await diskSnapshot();
    await new Promise((res) => setTimeout(res, STATS_FLUSH_MS));
    const p1 = await pgSnapshot();
    return { result, residency: residency(d0, d1, p0, p1) };
}

/** A cheap point-in-time reading for /api/health, with no fn to wrap. */
export async function currentResidency(windowMs = 1000): Promise<Residency | null> {
    if (!DISKSTATS_AVAILABLE) return null;
    const [d0, p0] = await Promise.all([diskSnapshot(), pgSnapshot()]);
    await new Promise((res) => setTimeout(res, windowMs));
    const [d1, p1] = await Promise.all([diskSnapshot(), pgSnapshot()]);
    return residency(d0, d1, p0, p1);
}
