// The soak's missing dimension: USERS.
//
// The first soak ran a day against a database nothing queried. That leaves
// the fork's whole architectural thesis untested - ONE PERSON'S HEAVY QUERY
// CANNOT FREEZE THE POLLER - because with nothing competing, the lanes carry
// no load, admission never fires and rule 7's lock_timeout never has a
// collision to lose. A week of that proves the process does not leak; it does
// not test the design.
//
// So this runs continuously beside the demo, issuing the mix a real operator
// would: cheap indexed lookups, free text inside and outside the trigram
// window, dashboard reads, and QUERIES THAT MUST BE REFUSED.
//
// THE REFUSALS ARE NOT DECORATION. An admission rule that is never triggered
// passes for the same reason a scanner with nothing to find passes - success
// and blindness look identical (SESSION-NOTES, question 1). So a share of
// every cycle asks for something the store must refuse, and the run counts
// the refusals BY REASON. Zero refusals in an hour is a failing soak, not a
// quiet one.
//
//   SOAK_BASE=http://127.0.0.1:18080 SOAK_USER=admin SOAK_PASS=... \
//   node tools/soak-query.ts
//
// Appends one line per minute to SOAK_QUERY_LOG, which tools/soak.sh folds
// into the hourly soak line.

import fs from 'node:fs';

const BASE = process.env.SOAK_BASE ?? 'http://127.0.0.1:18080';
const USER = process.env.SOAK_USER ?? 'admin';
const PASS = process.env.SOAK_PASS ?? '';
const LOG = process.env.SOAK_QUERY_LOG ?? '/tmp/soak-query.log';
/** Queries per cycle, and a cycle a second. Deliberately modest: this is a
 *  companion to the soak, not a load test - the point is CONTINUOUS
 *  competition for the lanes, not saturation. */
const PER_CYCLE = Number(process.env.SOAK_QPS ?? 2);
/** Heavy operations per hour. Few, because each is meant to collide. */
const HEAVY_PER_HOUR = Number(process.env.SOAK_HEAVY_PER_HOUR ?? 3);

let cookie = '';
const stats = {
    ok: 0, refused: 0, error: 0, heavy: 0,
    byReason: {} as Record<string, number>,
    maxMs: 0,
};

async function login(): Promise<boolean> {
    try {
        const res = await fetch(`${BASE}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: USER, password: PASS }),
        });
        await res.text();
        if (!res.ok) return false;
        cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        return cookie !== '';
    } catch {
        return false;
    }
}

/**
 * WHICH refusal a case is asking for, because the three are independent rules
 * and only one of them has a precondition.
 *
 * This was a bare boolean until 2026-08-15, and that conflated all three into
 * a single ADMITTED-BUT-SHOULD-REFUSE counter. The cost was found on minipc:
 * its `free-text` case was being admitted every hour for the run's entire
 * life, correctly - a box holding three days of messages has every partition
 * inside the trigram window, so there IS no uncovered partition for a 240h
 * search to reach, and admitting it is the right answer (EXPLAIN confirmed a
 * Bitmap Index Scan per partition, not a scan wearing an admission pass).
 *
 * With one counter there was no way to say so without also suppressing
 * `no-index` and `window-ceiling`, whose preconditions ALWAYS hold and whose
 * admission is always a real finding. So the label is the fix: the evaluator
 * can excuse the case that has an unmet precondition and keep failing the two
 * that cannot have one.
 */
type RefusableCase =
    /** Free text outside the trigram window. Refusable ONLY while some
     *  partition inside the window lacks coverage - see trgm_uncov in
     *  soak.sh, which measures exactly that. */
    | 'free-text'
    /** app~ has no index on ANY partition, at any age. No precondition. */
    | 'no-index'
    /** Past the window ceiling, which is a constant. No precondition. */
    | 'window-ceiling';

/**
 * The query mix. `refusable` marks the ones the store SHOULD refuse - they
 * are the point, not noise, and the run fails if none of them ever is.
 */
const QUERIES: Array<{ path: string; refusable?: RefusableCase }> = [
    // Cheap and indexed: the common case.
    { path: '/api/syslog/search?hours=1&limit=50&q=host%3Aplanted-3' },
    { path: '/api/syslog/search?hours=1&limit=50&q=sev%3A%3C%3D3' },
    { path: '/api/syslog/search?hours=6&limit=50&q=fac%3Adaemon' },
    // Free text INSIDE the trigram window: indexed, and the shape the
    // measurements were taken on.
    { path: '/api/syslog/search?hours=24&limit=100&q=timeout' },
    { path: '/api/syslog/search?hours=48&limit=100&q=error%20link' },
    // Substring host inside the window - the operator that came back.
    { path: '/api/syslog/search?hours=24&limit=50&q=host~mock-00' },
    // Dashboard reads, which is what an idle browser does every 10s.
    { path: '/api/alerts' },
    { path: '/api/devices' },
    { path: '/api/health' },
    // MUST BE REFUSED: free text with no device filter outside the trigram
    // window. CONDITIONAL - on a box young enough that every partition is
    // still inside the window, there is nothing uncovered to reach and
    // admitting this is correct. The 240 here is the window the precondition
    // in soak.sh measures against; change one and change both.
    { path: '/api/syslog/search?hours=240&limit=50&q=timeout', refusable: 'free-text' },
    // MUST BE REFUSED: app~ has no index on any partition.
    { path: '/api/syslog/search?hours=1&limit=50&q=app~ssh', refusable: 'no-index' },
    // MUST BE REFUSED: past the window ceiling.
    { path: '/api/syslog/search?hours=400&limit=50', refusable: 'window-ceiling' },
];

/** Deliberately expensive, and rare. Meant to collide with the jobs. */
const HEAVY: string[] = [
    // A wide filtered search across full retention: permitted, and slow.
    '/api/syslog/search?hours=120&limit=5000&q=host~planted&count=1',
    // The largest legal window with a device filter.
    '/api/syslog/search?hours=336&limit=5000&q=host%3Aplanted-9',
];

async function hit(path: string, refusable: RefusableCase | null): Promise<void> {
    const t0 = performance.now();
    try {
        const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
        const body = await res.json() as { ok?: boolean; reason?: string };
        const ms = performance.now() - t0;
        if (ms > stats.maxMs) stats.maxMs = ms;

        if (res.status === 401) { await login(); return; }
        if (res.ok && body.ok === true) {
            stats.ok++;
            // A query that was SUPPOSED to be refused and was not is a
            // finding: the admission rule stopped applying. NAMED BY CASE,
            // because soak-check.sh can only excuse an unmet precondition if
            // it can tell which rule the admission belongs to. The glob it
            // matches on is unchanged, so an old evaluator still catches
            // these - it just cannot tell them apart.
            if (refusable !== null) {
                const key = `ADMITTED-BUT-SHOULD-REFUSE:${refusable}`;
                stats.byReason[key] = (stats.byReason[key] ?? 0) + 1;
            }
            return;
        }
        if (res.status === 400 || res.status === 503) {
            stats.refused++;
            const reason = body.reason ?? `http-${res.status}`;
            stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
            return;
        }
        stats.error++;
    } catch {
        stats.error++;
    }
}

function flush(): void {
    const reasons = Object.entries(stats.byReason)
        .map(([k, v]) => `${k}=${v}`).sort().join(',') || '-';
    const line = [
        new Date().toISOString().slice(0, 16),
        stats.ok, stats.refused, stats.error, stats.heavy,
        Math.round(stats.maxMs), reasons,
    ].join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch { /* disk is the soak's business */ }
    stats.ok = 0; stats.refused = 0; stats.error = 0; stats.heavy = 0;
    stats.maxMs = 0; stats.byReason = {};
}

async function main(): Promise<void> {
    if (PASS === '') {
        console.error('SOAK_PASS is required - this logs in as a real user');
        process.exit(2);
    }
    if (!await login()) {
        console.error('could not log in; is the demo up?');
        process.exit(1);
    }
    console.log(`soak query load: ${PER_CYCLE}/s against ${BASE}, ${HEAVY_PER_HOUR} heavy/hour`);
    console.log(`  per-minute counts -> ${LOG}`);

    let n = 0;
    setInterval(() => {
        for (let i = 0; i < PER_CYCLE; i++) {
            const q = QUERIES[(n + i) % QUERIES.length]!;
            void hit(q.path, q.refusable ?? null);
        }
        n += PER_CYCLE;
    }, 1000).unref();

    // The heavy operations, spread across the hour rather than bunched.
    const heavyEveryMs = Math.max(60_000, Math.round(3600_000 / Math.max(1, HEAVY_PER_HOUR)));
    setInterval(() => {
        const path = HEAVY[Math.floor(n / 7) % HEAVY.length]!;
        stats.heavy++;
        void hit(path, null);
    }, heavyEveryMs).unref();

    setInterval(flush, 60_000);
}

main().catch((err) => {
    console.error('soak-query failed:', err);
    process.exit(1);
});
