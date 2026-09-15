// The measured half of slice 3: flat memory, lane isolation, heartbeat, and
// how wrong the duration estimator actually is.
//
//   ADMIN_PASSWORD=... node tools/export-measure.ts
//
// The estimator is load bearing for admission - the queue refuses on projected
// START time, which is a sum of estimates - so an estimate nobody checks is a
// policy resting on a number that has never been compared to reality. Slice 3
// is not done until that error is recorded.
//
// Both regimes are measured, because the whole point of the estimator is that
// they differ by 12x: a narrow export is a random page read per row, a wide one
// is a sequential scan (ARCHITECTURE.md 5a).

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let cookie = '';

async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return await res.json() as Record<string, unknown>;
}

interface Sample { rssBytes: number; heavyInFlight: number; interactiveMs: number; worstGap: number }

async function sample(): Promise<Sample> {
    const t = performance.now();
    const h = await call('GET', '/api/health');
    const interactiveMs = performance.now() - t;
    const lanes = h.lanes as Array<Record<string, unknown>>;
    return {
        rssBytes: Number((h.memory as Record<string, unknown>).rssBytes),
        heavyInFlight: Number(lanes.find((l) => l.lane === 'heavy')?.inFlight ?? 0),
        interactiveMs,
        worstGap: Number((h.heartbeat as Record<string, unknown>).worstGapMsAcrossThreads),
    };
}

async function runOne(label: string, req: Record<string, unknown>): Promise<void> {
    console.log(`\n--- ${label}`);
    const submitted = await call('POST', '/api/syslog/export', req);
    const job = submitted.job as Record<string, unknown> | undefined;
    if (!job) {
        console.log(`    refused: ${String(submitted.reason)} - ${String(submitted.detail)}`);
        return;
    }
    const id = String(job.id);
    const est = job.estimate as Record<string, unknown>;
    console.log(`    estimated ${Number(est.rows).toLocaleString()} rows, ${est.narrow ? 'narrow' : 'wide'}, `
        + `${est.duration} at ${Number(est.rowsPerSecond).toLocaleString()} rows/s, ${est.size}`);

    const base = await sample();
    let peakRss = base.rssBytes;
    let heavyTouched = 0;
    let worstInteractive = 0;
    let samples = 0;

    for (;;) {
        const s = await sample();
        samples++;
        if (s.rssBytes > peakRss) peakRss = s.rssBytes;
        if (s.heavyInFlight > 0) heavyTouched++;
        if (s.interactiveMs > worstInteractive) worstInteractive = s.interactiveMs;

        const st = await call('GET', `/api/exports/${id}`);
        const j = st.job as Record<string, unknown>;
        if (['done', 'failed', 'cancelled'].includes(String(j.state))) {
            const actual = j.actual as Record<string, unknown> | null;
            console.log(`    state ${String(j.state)}`);
            if (actual) {
                const ratio = Number(actual.estimateRatio);
                console.log(`    actual    ${Number(actual.rows).toLocaleString()} rows in ${(Number(actual.durationMs) / 1000).toFixed(1)}s`);
                console.log(`    estimate  ${(Number(est.durationMs) / 1000).toFixed(1)}s`);
                console.log(`    ratio     ${ratio.toFixed(2)}x  (${ratio > 1 ? 'slower' : 'faster'} than predicted)`);
                console.log(`    throughput ${Math.round(Number(actual.rows) / (Number(actual.durationMs) / 1000)).toLocaleString()} rows/s`);
            }
            break;
        }
        await new Promise((r) => setTimeout(r, 400));
    }

    const after = await sample();
    console.log(`    RSS       ${(base.rssBytes / 1048576).toFixed(1)}MB -> peak ${(peakRss / 1048576).toFixed(1)}MB `
        + `(delta ${((peakRss - base.rssBytes) / 1048576).toFixed(1)}MB) over ${samples} samples`);
    console.log(`    heavy lane touched during the export: ${heavyTouched} of ${samples} samples`);
    console.log(`    interactive health call worst ${worstInteractive.toFixed(0)}ms`);
    console.log(`    heartbeat worst gap across threads: ${after.worstGap}ms`);
}

async function main(): Promise<void> {
    if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD required'); process.exit(2); }
    const li = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }),
    });
    const sc = li.headers.get('set-cookie');
    if (!sc) { console.error('could not sign in'); process.exit(1); }
    cookie = sc.split(';')[0] as string;

    console.log('export measurement');

    // Narrow: one host over full retention. About 78,000 rows, and the case the
    // estimator has to slow down for.
    await runOne('NARROW: one host, 14 days', { hours: 336, host: 'sw-0001' });

    // Wide and large: the 400,000 row criterion. A 4 hour window across all
    // hosts lands in that range on this corpus.
    await runOne('WIDE: all hosts, 4 hours', { hours: 4, confirm: true });

    // Wide and very large, to check the estimator does not drift with size.
    await runOne('WIDE: all hosts, 24 hours', { hours: 24, confirm: true });

    console.log('\nnote: ratio is actual/estimated. Above 1 means the export took longer than');
    console.log('predicted, which is the direction that makes the queue ceiling optimistic.');
}

main().catch((err) => {
    console.error('export measurement failed:', err);
    process.exit(1);
});
