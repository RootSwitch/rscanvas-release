// Measure the export worst case, before slice 3 depends on a guess.
//
// RESULTS-SLICE-1.md section 10 INFERS that a large export over full retention
// walks into the same heap fetches that make a 14 day filtered search cost
// 2.3s. That inference is the expensive one to get wrong, because export is the
// one lane with NO statement timeout and it streams, so the two plausible
// outcomes differ by a lot:
//
//   (a) the heap fetches spread out across the stream and it is merely slow, or
//   (b) one connection is held for minutes, and since the export lane has 2
//       connections and a 1s wait ceiling, two users doing this at once are a
//       denial of service against everybody else's exports.
//
// Those want different designs, so the answer is measured rather than reasoned.
//
//   node tools/export-probe.ts                 # all scenarios
//   node tools/export-probe.ts saturation      # just the 3-against-2 case
//
// What this deliberately does NOT test: the CSV formula guard, job ids, or
// cancellation. Those are slice 3. This is about how long a connection is held
// and what that does to everyone else.

import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { OPS, exportProbe, laneState, closeAll, type SearchFilters } from '../src/store/index.ts';
import { startHeartbeat } from '../src/heartbeat.ts';
import { CONFIG } from '../src/config.ts';

const HOST = process.env.BENCH_HOST || 'sw-0001';
const ONLY = process.argv[2];

/** Counts and discards. Keeps the disk out of the measurement. */
function nullSink(): NodeJS.WritableStream {
    return new Writable({
        write(_chunk, _enc, cb) { cb(); },
    });
}

function mb(bytes: number): string {
    return (bytes / 1_048_576).toFixed(1);
}

async function scenario(
    name: string, filters: SearchFilters, note: string,
): Promise<void> {
    console.log(`\n--- ${name}`);
    console.log(`    ${note}`);

    const hb = startHeartbeat('export-probe', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);

    // An interactive query every 250ms throughout. The whole claim of the lane
    // design is that a long export does not touch anybody else, and that has to
    // be observed rather than assumed.
    const interactive: number[] = [];
    let interactiveBusy = 0;
    const probe = setInterval(() => {
        void OPS.ping().then((r) => {
            if (r.ok) interactive.push(r.timing.execMs + r.timing.waitMs);
            else interactiveBusy++;
        });
    }, 250);

    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const rssTimer = setInterval(() => {
        const rss = process.memoryUsage().rss;
        if (rss > rssPeak) rssPeak = rss;
    }, 100);

    const res = await exportProbe(filters, nullSink());

    clearInterval(probe);
    clearInterval(rssTimer);
    hb.stop();

    if ('ok' in res && res.ok === false) {
        console.log(`    REFUSED by the store: ${res.reason} - ${res.detail}`);
        return;
    }
    const r = res as Exclude<typeof res, { ok: false }>;
    if (!r.outcome.ok) {
        console.log(`    lane refused: ${r.outcome.reason}`);
        return;
    }

    interactive.sort((a, b) => a - b);
    const p50 = interactive.length ? interactive[Math.floor(interactive.length / 2)] as number : 0;
    const worst = interactive.length ? interactive[interactive.length - 1] as number : 0;

    console.log(`    rows            ${r.rows.toLocaleString()}`);
    console.log(`    bytes           ${mb(r.bytes)}MB`);
    console.log(`    time to first   ${r.firstByteMs.toFixed(0)}ms`);
    console.log(`    connection held ${(r.heldMs / 1000).toFixed(1)}s`);
    console.log(`    throughput      ${Math.round(r.rows / (r.heldMs / 1000)).toLocaleString()} rows/s`);
    console.log(`    RSS             ${mb(rssBefore)}MB -> peak ${mb(rssPeak)}MB (delta ${mb(rssPeak - rssBefore)}MB)`);
    console.log(`    interactive     ${interactive.length} probes, p50 ${p50.toFixed(1)}ms, worst ${worst.toFixed(1)}ms, ${interactiveBusy} refused`);
    console.log(`    heartbeat       worst gap ${hb.stats().worstGapMs}ms, ${hb.stats().overThresholdCount} over ${CONFIG.heartbeatThresholdMs}ms`);
}

async function saturation(): Promise<void> {
    console.log('\n--- saturation: 3 concurrent exports against a 2-connection lane');
    console.log(`    export lane waits ${1000}ms then refuses, and its policy is queue-job`);

    const now = Date.now();
    const filters: SearchFilters = {
        from: new Date(now - 14 * 86_400_000),
        to: new Date(now),
        host: HOST,
    };

    const t0 = performance.now();
    const results = await Promise.all(
        Array.from({ length: 3 }, async (_, i) => {
            const res = await exportProbe({ ...filters }, nullSink());
            if ('ok' in res && res.ok === false) return { i, refusal: res.reason, heldMs: 0, rows: 0 };
            const r = res as Exclude<typeof res, { ok: false }>;
            return {
                i,
                refusal: r.outcome.ok ? null : r.outcome.reason,
                heldMs: r.heldMs,
                rows: r.rows,
            };
        }),
    );
    const totalMs = performance.now() - t0;

    for (const r of results.sort((a, b) => a.i - b.i)) {
        console.log(`    export ${r.i}: ${r.refusal ?? 'served'} ${r.rows ? `${r.rows.toLocaleString()} rows` : ''} in ${(r.heldMs / 1000).toFixed(1)}s`);
    }
    console.log(`    total ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`    lane after: ${JSON.stringify(laneState('export'))}`);

    const refused = results.filter((r) => r.refusal !== null);
    console.log(refused.length > 0
        ? `    NOTE ${refused.length} refused. With policy queue-job that must become a job id, not an error.`
        : '    NOTE nothing refused: all three fitted, so this run did not test the ceiling.');
}

/**
 * The denial-of-service shape, demonstrated rather than inferred.
 *
 * Two users start exports big enough to hold both export connections, and a
 * third user - who wants 2,000 rows - is locked out. The saturation scenario
 * above cannot show this because host-filtered exports finish in about a
 * second warm, so all three fit.
 */
async function lockout(): Promise<void> {
    console.log('\n--- lockout: two large exports hold the lane, a small one arrives');

    const now = Date.now();
    // All hosts, 48h. Large enough to hold a connection for about a minute.
    const big: SearchFilters = { from: new Date(now - 48 * 3_600_000), to: new Date(now) };
    // One host, 24h. The export an operator actually wants: a couple of
    // thousand rows, well under a second when the lane has room.
    const small: SearchFilters = { from: new Date(now - 86_400_000), to: new Date(now), host: HOST };

    const t0 = performance.now();
    const bigOnes = [0, 1].map(async (i) => {
        const res = await exportProbe({ ...big }, nullSink());
        const r = res as Exclude<typeof res, { ok: false }>;
        console.log(`    big ${i}: ${r.rows?.toLocaleString()} rows, held ${(r.heldMs / 1000).toFixed(1)}s`);
        return r;
    });

    // Let both acquire before the small one asks.
    await new Promise((res) => setTimeout(res, 3000));

    const smallStart = performance.now();
    const smallRes = await exportProbe(small, nullSink());
    const smallWait = performance.now() - smallStart;

    if ('ok' in smallRes && smallRes.ok === false) {
        console.log(`    small: refused by the store (${smallRes.reason})`);
    } else {
        const r = smallRes as Exclude<typeof smallRes, { ok: false }>;
        if (r.outcome.ok) {
            console.log(`    small: SERVED ${r.rows.toLocaleString()} rows after ${smallWait.toFixed(0)}ms - the lane had room`);
        } else {
            console.log(`    small: REFUSED after ${smallWait.toFixed(0)}ms, reason ${r.outcome.reason}`);
            if (r.outcome.reason === 'busy') {
                console.log(`           inFlight ${r.outcome.inFlight}/${r.outcome.capacity}, policy ${r.outcome.policy}`);
                console.log('           A 2,000 row export is locked out by two large ones.');
                console.log('           Policy queue-job says this must become a job id, which slice 3 must build.');
            }
        }
    }

    await Promise.all(bigOnes);
    console.log(`    total ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
    const now = Date.now();
    console.log('export worst case');
    console.log(`  export lane: capacity 2, NO statement timeout, 1000ms wait ceiling`);
    console.log(`  host ${HOST}`);

    if (!ONLY || ONLY === 'scenarios') {
        // Ascending, so the shape of the growth is visible rather than one point.
        await scenario(
            'one host, 24h, no fragment',
            { from: new Date(now - 86_400_000), to: new Date(now), host: HOST },
            'the ordinary export an operator actually runs',
        );
        await scenario(
            'one host, 14d, no fragment',
            { from: new Date(now - 14 * 86_400_000), to: new Date(now), host: HOST },
            'full retention for one device: the index path, no heap filter',
        );
        await scenario(
            'one host, 14d, fragment',
            { from: new Date(now - 14 * 86_400_000), to: new Date(now), host: HOST, fragment: 'changed state' },
            'full retention WITH a fragment: the heap-fetch path section 4a found',
        );
        await scenario(
            'ALL hosts, 14d, no fragment',
            { from: new Date(now - 14 * 86_400_000), to: new Date(now) },
            'the real worst case. The store bounds the WINDOW but never the ROW COUNT, '
            + 'and no device filter is required when there is no fragment.',
        );
    }

    if (!ONLY || ONLY === 'saturation') await saturation();
    if (!ONLY || ONLY === 'lockout') await lockout();

    await closeAll();
}

main().catch((err) => {
    console.error('export probe failed:', err);
    void closeAll();
    process.exit(1);
});
