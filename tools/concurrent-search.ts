// Drive N concurrent searches through the real HTTP route.
//
// BUILD-PLAN slice 1, done-when criterion 4, in its own words:
//
//   "Driving 8 concurrent searches against the 4-connection lane returns
//    structured busy responses within ~2s, not 20s waits, and waitMs is
//    visible separately from execMs in the logs."
//
// tools/admission-test.ts already proved the store's admission control with
// pg_sleep probes. This is the criterion as written: real searches, through the
// HTTP handler, so the refusal has to survive the whole path and come back as
// something a UI could render rather than as a driver error.
//
//   CONCURRENCY=8 node tools/concurrent-search.ts
//
// Use a query slow enough to hold its connection for longer than the lane's 2s
// wait ceiling, or nothing queues and the test passes without testing anything.
// A 14 day filtered search costs about 2.3s cold, which is why this is run
// against a cold cache.

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const HOURS = Number(process.env.HOURS || 336);
const HOST = process.env.BENCH_HOST || 'sw-0001';

interface Attempt {
    id: number;
    status: number;
    body: Record<string, unknown>;
    wallMs: number;
}

async function main(): Promise<void> {
    console.log(`driving ${CONCURRENCY} concurrent searches at ${BASE}`);
    console.log(`  window ${HOURS}h, host ${HOST}, fragment varies per request`);
    console.log('');

    const t0 = performance.now();
    const attempts: Attempt[] = await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, i): Promise<Attempt> => {
            // Vary the fragment so requests cannot share a hot posting list and
            // quietly stop being concurrent work.
            const fragment = `10.20.7.${10 + i}`;
            const url = `${BASE}/api/syslog/search?hours=${HOURS}&host=${HOST}&q=${encodeURIComponent(fragment)}&limit=500&count=0`;
            const started = performance.now();
            const res = await fetch(url);
            const body = await res.json() as Record<string, unknown>;
            return { id: i, status: res.status, body, wallMs: performance.now() - started };
        }),
    );
    const totalMs = performance.now() - t0;

    console.log('  id  status  wallMs   waitMs   execMs  outcome');
    for (const a of attempts.sort((x, y) => x.id - y.id)) {
        const timing = a.body.timing as { waitMs: number; execMs: number } | undefined;
        const waitMs = timing?.waitMs ?? (a.body.waitMs as number | undefined) ?? 0;
        const execMs = timing?.execMs ?? 0;
        const outcome = a.status === 200
            ? `ok, ${a.body.returned} rows`
            : `${a.body.reason} ${a.body.inFlight !== undefined ? `(inFlight ${a.body.inFlight}/${a.body.capacity})` : ''}`;
        console.log(
            `  ${String(a.id).padStart(2)}  ${String(a.status).padStart(6)}  ${a.wallMs.toFixed(0).padStart(6)}  ${waitMs.toFixed(1).padStart(7)}  ${execMs.toFixed(1).padStart(7)}  ${outcome}`,
        );
    }

    const ok = attempts.filter((a) => a.status === 200);
    const busy = attempts.filter((a) => a.body.reason === 'busy');
    const other = attempts.filter((a) => a.status !== 200 && a.body.reason !== 'busy');
    const worstWall = Math.max(...attempts.map((a) => a.wallMs));

    console.log('');
    console.log(`  served        ${ok.length}`);
    console.log(`  busy          ${busy.length}`);
    console.log(`  other refusal ${other.length}`);
    console.log(`  worst wall    ${worstWall.toFixed(0)}ms`);
    console.log(`  total         ${totalMs.toFixed(0)}ms`);

    const failures: string[] = [];
    if (busy.length === 0 && CONCURRENCY > 4) {
        failures.push(
            `nothing was refused with ${CONCURRENCY} concurrent requests against a 4-connection lane. `
            + 'Either the queries finished faster than the 2s wait ceiling, in which case this run did not '
            + 'test admission at all, or admission is not working.',
        );
    }
    for (const a of busy) {
        // The point of the whole design: a refusal arrives at the ceiling, not
        // at the back of the queue. This is the 20.7s failure, checked for.
        if (a.wallMs > 4000) {
            failures.push(`request ${a.id} was refused only after ${a.wallMs.toFixed(0)}ms - that is a queue, not a wait ceiling`);
        }
        if (a.body.inFlight === undefined || a.body.capacity === undefined) {
            failures.push(`request ${a.id} came back busy without inFlight/capacity - a UI cannot say how many are running`);
        }
        if (a.body.retriable !== true) {
            failures.push(`request ${a.id} did not say it was retriable`);
        }
    }
    for (const a of ok) {
        const timing = a.body.timing as { waitMs: number; execMs: number } | undefined;
        if (!timing || timing.waitMs === undefined || timing.execMs === undefined) {
            failures.push(`request ${a.id} succeeded without reporting waitMs and execMs separately`);
        }
    }

    console.log('');
    if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL - ${f}`);
        process.exit(1);
    }
    console.log(`PASS - ${ok.length} served, ${busy.length} refused as structured busy inside the wait ceiling, timing reported apart`);
}

main().catch((err) => {
    console.error('concurrent search failed:', err);
    process.exit(1);
});
