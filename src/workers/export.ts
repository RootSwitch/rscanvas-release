// The export worker. Owns the export lane and all CSV formatting.
//
// WHY THIS EXISTS, and it is not a refinement. ARCHITECTURE.md section 1 gives
// the export concern "streamed rather than materialised, CPU-heavy formatting
// in a worker". Slice 3 was first built with the formatting inline on the main
// thread, and the heartbeat caught it immediately: main thread worst gap
// 55.6ms with 5 excursions past the 50ms threshold, while the ingest thread sat
// at 15.2ms with none.
//
// The cost is not the database and it is not the disk. It is encoding: 5,000
// rows per fetch, eleven columns each, a formula-guard regex and a quote
// replacement per cell. That is roughly 55,000 regular expression tests in one
// synchronous block, which is exactly the shape of work the whole fork exists
// to keep off a shared loop. A search that returns 500 rows never showed it; an
// export that returns 1.5 million does.
//
// So the worker does the whole job: it holds its own export-lane pool, runs the
// cursor, encodes, and writes the file. The main thread never sees a row. It
// keeps the queue and the admission policy, which are decisions rather than
// work, and talks to this thread by typed message.
//
// Note the lane accounting. This worker owns the ONLY export-lane pool in the
// process, the same way the ingest worker owns the only ingest-lane pool, so
// the lane's capacity of 2 is still a real global limit rather than a per
// thread one.

import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { CONFIG } from '../config.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { installSafetyNet } from '../safety.ts';
import { streamExportCsv, closeAll, type SearchFilters } from '../store/index.ts';
import { csvHeader, csvRowFromRecord } from '../export/csv.ts';

const hb = startHeartbeat('export', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);
installSafetyNet({ thread: 'export' });

const cancelled = new Set<string>();
let active = 0;

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[export-worker]', ...args);
}

interface RunMessage {
    type: 'run';
    jobId: string;
    filters: SearchFilters;
    filePath: string;
}

async function run(msg: RunMessage): Promise<void> {
    active++;
    const sink = fs.createWriteStream(msg.filePath);

    // THE LISTENER GOES ON BEFORE ANY ROW FLOWS, not after streaming ends.
    //
    // It used to be attached only in the sink.end() promise below - after the
    // whole export had already been written. A write error during streaming
    // (spool disk full, spool directory removed, EACCES) therefore emitted an
    // 'error' event with no listener, which is fatal to the worker.
    //
    // The blast radius is what makes it worth care: this worker owns the ONLY
    // export-lane pool, so killing it takes down every concurrent export. Two
    // jobs running, the spool fills while job A writes, and job B - innocent,
    // healthy, holding one of only two export connections - is destroyed with
    // it. Recorded rather than raised so the cancel/fail path handles it, and
    // so the drain-wait inside streamExportCsv cannot block forever waiting for
    // a 'drain' event from a stream that has already failed.
    let sinkError: Error | null = null;
    sink.on('error', (err: Error) => {
        sinkError = err;
        log(`spool write failed for ${msg.jobId}: ${err.message}`);
        // Unblocks any pending drain-wait. Without it a failed stream never
        // emits 'drain', and the export holds its connection until the process
        // ends.
        sink.emit('drain');
    });

    try {
        const res = await streamExportCsv(
            msg.filters,
            sink,
            csvRowFromRecord,
            csvHeader(),
            // A failed sink cancels the export: there is nowhere to put the
            // rows, so continuing to read them wastes a connection.
            () => cancelled.has(msg.jobId) || sinkError !== null,
        );

        if (sinkError !== null) {
            throw new Error(`spool write failed: ${(sinkError as Error).message}`);
        }

        await new Promise<void>((resolve, reject) => {
            sink.end(() => resolve());
            sink.on('error', reject);
        });

        // A SearchRefusal carries `ok: false`; a StreamExportResult has no `ok`
        // property at all, so the presence of the key is the discriminator.
        if ('ok' in res) {
            parentPort?.postMessage({
                type: 'failed', jobId: msg.jobId,
                error: `filters were rejected: ${res.reason} - ${res.detail}`,
            });
            return;
        }
        if (!res.outcome.ok) {
            parentPort?.postMessage({
                type: 'failed', jobId: msg.jobId,
                error: `export lane refused: ${res.outcome.reason}`,
            });
            return;
        }
        parentPort?.postMessage({
            type: 'done',
            jobId: msg.jobId,
            rows: res.rows,
            bytes: res.bytes,
            cancelled: res.cancelled || cancelled.has(msg.jobId),
        });
    } catch (err) {
        try { sink.destroy(); } catch { /* already gone */ }
        parentPort?.postMessage({ type: 'failed', jobId: msg.jobId, error: (err as Error).message });
    } finally {
        cancelled.delete(msg.jobId);
        active--;
    }
}

parentPort?.on('message', (msg: { type: string } & Record<string, unknown>) => {
    if (msg.type === 'run') {
        run(msg as unknown as RunMessage).catch((err: unknown) => {
            // Never unhandled: this worker holds an export-lane connection,
            // and dying with it open strands one of only two.
            log('run threw:', (err as Error).message);
            parentPort?.postMessage({ type: 'failed', jobId: String(msg.jobId), error: String(err) });
        });
        return;
    }
    if (msg.type === 'cancel') {
        // Observed by streamExportCsv between fetches, so the cursor closes and
        // the connection is released on the normal path rather than by killing
        // it. Bounded by one batch.
        cancelled.add(String(msg.jobId));
        return;
    }
    if (msg.type === 'stats') {
        parentPort?.postMessage({ type: 'stats', stats: { thread: 'export', active, heartbeat: hb.stats() } });
        return;
    }
    if (msg.type === 'stop') {
        log('SHUTDOWN stop-received');
        (async () => {
            await closeAll();
            hb.stop();
            process.exit(0);
        })().catch((err: unknown) => log('shutdown threw:', (err as Error).message));
    }
});

parentPort?.postMessage({ type: 'ready' });
log('ready');
