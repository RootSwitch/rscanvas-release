// Every UI endpoint spends a BOUNDED number of database queries per request.
//
//   node tools/test-page-budgets.ts        (needs a running app + database)
//
// WHY COUNTS AND NOT LATENCY. The parent's /api/devices cost 5,200 queries to
// render one page at 100 devices, and it did not present as "slow" - it
// presented as a page that got slower as the fleet grew, which reads like
// data growth rather than a defect. A latency assertion would have passed on
// a small fixture and failed mysteriously on a large one; a COUNT assertion
// fails identically on both, and it fails on the commit that introduces the
// loop rather than on the deployment that outgrows it.
//
// This is check-write-loops applied to the read side, and it closes the same
// class from the other direction: that one catches per-item writes by SHAPE at
// commit time, this catches per-item reads by COUNT at runtime - including any
// the syntactic check cannot see, such as a helper that queries once per row
// from inside a map callback in another module.
//
// The counter is the lane's own `admitted` figure from /api/health, which
// already counts every query that entered a lane. No new instrumentation:
// read it before, make one request, read it after.

const BASE = process.env.SOAK_BASE ?? 'http://127.0.0.1:18080';
const USER = process.env.UI_USER ?? 'admin';
const PASS = process.env.UI_PASS ?? 'rscanvas-demo-2026';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

let cookie = '';

async function req(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] as string;
    let body: any = null;
    try { body = await res.json(); } catch { /* non-JSON is a body of null */ }
    return { status: res.status, body };
}

async function login(): Promise<boolean> {
    const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USER, password: PASS }),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] as string;
    return res.status === 200;
}

/**
 * Queries admitted on the INTERACTIVE lane only.
 *
 * Not the total across lanes, which was the first version and was wrong: the
 * collector, ingest, alert-scan and jobs lanes run constantly on a live soak
 * box, so a global counter climbs whether or not the subject was called. UI
 * reads are interactive-lane by construction, so that is the lane to watch.
 */
async function admittedInteractive(): Promise<number> {
    const { body } = await req('/api/health');
    if (!body?.lanes) throw new Error('health did not report lanes');
    const lane = (body.lanes as Array<{ lane: string; admitted: number }>)
        .find((l) => l.lane === 'interactive');
    if (!lane) throw new Error('health reported no interactive lane');
    return lane.admitted ?? 0;
}

/**
 * Queries spent by ONE request to `path`, as the MINIMUM of several trials.
 *
 * TWO CORRECTIONS TO THE OBVIOUS DESIGN, both learned on this test's first
 * run against a live box:
 *
 * 1. Health itself costs a query (its db self-check), so its own spend is
 *    measured and subtracted - otherwise the observer charges the observation
 *    to the observed.
 * 2. ANY OTHER CLIENT ON THE SAME LANE INFLATES THE READING - a second
 *    browser tab polling every 10s is enough, and that is exactly what
 *    happened here. Contamination is STRICTLY ADDITIVE: a concurrent request
 *    can only add queries to the window, never remove them. So the minimum
 *    across trials converges on the true per-request cost from above, and a
 *    budget asserted against the minimum cannot fail because somebody else
 *    was using the app. Knowing the SIGN of an error is what makes it
 *    tractable - the same rule this project applies to sampled instruments.
 */
async function queriesFor(path: string, trials = 5): Promise<number> {
    // FOURTH CORRECTION, caught by a reading of ZERO on an endpoint that
    // provably makes one query. The first version subtracted a PER-TRIAL
    // health cost, so a trial whose health read was itself contaminated
    // subtracted too much and undershot - and an undershooting budget check
    // is worse than a noisy one, because it passes things it should catch.
    //
    // Both terms are contaminated the same way (additively, by other clients),
    // so BOTH get the minimum treatment: min(raw) - min(healthCost). Each
    // converges on its own true value from above, and the difference cannot
    // be dragged below zero by an unlucky pairing.
    const raws: number[] = [];
    const costs: number[] = [];
    for (let i = 0; i < trials; i++) {
        const a = await admittedInteractive();
        const b = await admittedInteractive();
        costs.push(b - a);
        await req(path);
        const after = await admittedInteractive();
        raws.push(after - b);
    }
    return Math.min(...raws) - Math.min(...costs);
}

// Budgets are the endpoint's OWN spend, with the session lookup subtracted.
//
// THE THIRD CORRECTION, and it was the "failure" this test reported on its
// first run: every authenticated request costs one findSession query before
// the route is even reached (auth/index.ts validateSession). Charging that to
// each endpoint would make the numbers unreadable - a budget of 3 that means
// "1 real query" teaches nobody anything, and the first person to add a route
// would copy the wrong baseline. So /api/me is measured FIRST: it is an
// authenticated route that does nothing but return the principal, so its cost
// IS the session check, measured rather than assumed.
const BUDGETS: Array<{ path: string; budget: number; why: string }> = [
    { path: '/api/devices', budget: 1, why: 'the roster: ONE grouped statement, never per-device' },
    { path: '/api/alerts', budget: 2, why: 'open set plus recently-cleared; a THIRD is spent only '
        + 'when the open set exceeds UI_PAGE_CAP, to count what the slice cannot see' },
    { path: '/api/reachability/events', budget: 1, why: 'the U3 lane: events and device names in ONE join' },
    { path: '/api/alert-rules', budget: 1, why: 'the rules list: one table, no joins' },
    // The board list computes DRIFT for every board in the same statement. The
    // tempting shape is a drift request per board, which nobody would notice
    // at eight boards - and not noticing is exactly how the parent's device
    // page reached 5,200 queries.
    { path: '/api/boards', budget: 1, why: 'boards AND their drift in ONE statement, never per board' },
];

console.log(`page query budgets against ${BASE}`);

if (!await login()) {
    console.log('  SKIP - could not log in (is the app running with the demo admin?)');
    process.exit(0);
}

const sessionCost = await queriesFor('/api/me');
console.log(`  (the session check costs ${sessionCost} query per authenticated request, `
    + 'measured on /api/me and subtracted below)');

for (const { path, budget, why } of BUDGETS) {
    const n = await queriesFor(path) - sessionCost;
    if (n <= budget) ok(`${path} spent ${n} own quer(y/ies), budget ${budget} - ${why}`);
    else bad(`${path} spent ${n} own quer(y/ies), OVER its budget of ${budget} - ${why}`);
}


// ---------------------------------------------------------------------------
// PAYLOAD BUDGETS (2026-08-31, independent review C1/C2).
//
// The query budgets above are blind to payload size BY CONSTRUCTION, and that
// blindness had a cost: /api/devices and /api/alerts spent one query each and
// returned the ENTIRE set, pretty-printed, on the interactive lane with its 2s
// statement timeout. One query is the right count. It was never the whole
// question. This is section 8's COVERAGE family - the instrument misses part
// of the subject and passes.
//
// BYTES PER ROW, not total bytes. Total bytes grows with the fleet and would
// make this a latency assertion in disguise - passing on a small fixture,
// failing on a big one, which is the exact anti-pattern this file opens by
// rejecting. Bytes per row is the invariant: it fails on the commit that adds
// a column, identically at 27 devices and at 30,000.
//
// THE NUMBERS BELOW ARE PROVISIONAL AND SAY SO. They were chosen to catch a
// DOUBLING, not to be tight, and they have never been run - this file needs a
// live instance and the author had none. Re-pin them on the first real run
// against the demo box, and record what they actually were.
const PAYLOAD: Array<{ path: string; key: string; perRow: number; why: string }> = [
    { path: '/api/devices', key: 'devices', perRow: 1500,
      why: 'the roster row is ~40 columns; a doubling means somebody added a payload, not a column' },
    { path: '/api/alerts', key: 'open', perRow: 800,
      why: 'an alert row is narrower than a device row and must stay so' },
];

for (const { path, key, perRow, why } of PAYLOAD) {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    const rows = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    const bytes = Buffer.byteLength(text, 'utf8');

    // COMPACT, asserted rather than assumed. `JSON.stringify(body, null, 2)`
    // was 1.40x the bytes and about 4x the main-thread stringify at 10k rows.
    // A two-space indent at the start of a line is what that looks like.
    if (/\n {2}"/.test(text)) bad(`${path} is PRETTY-PRINTED again - that is 1.4x the wire and 4x the stringify`);
    else ok(`${path} is compact`);

    if (rows.length === 0) {
        console.log(`  SKIP ${path} bytes/row - no rows in the fixture`);
    } else {
        const each = Math.round(bytes / rows.length);
        if (each <= perRow) ok(`${path} ${each} B/row over ${rows.length} rows, budget ${perRow} - ${why}`);
        else bad(`${path} ${each} B/row over ${rows.length} rows, OVER its budget of ${perRow} - ${why}`);
    }

    // THE CAP CONTRACT, asserted WITHOUT naming the number. Importing
    // UI_PAGE_CAP would drag the pg pool into a test that speaks only HTTP,
    // and re-declaring it here would be a second copy of a constant - which is
    // the failure S1 was, on the same day, in the same review. So assert the
    // PROPERTY instead: the response says whether it is a slice, and that
    // claim agrees with the total it reports.
    const total = typeof body.total === 'number' ? body.total
        : typeof body.openTotal === 'number' ? body.openTotal : null;
    if (typeof body.capped !== 'boolean') {
        bad(`${path} does not report \`capped\` - the client cannot tell a slice from the whole set`);
    } else if (total === null) {
        bad(`${path} reports capped=${String(body.capped)} but no total to check it against`);
    } else if (body.capped === (rows.length < total)) {
        ok(`${path} capped=${String(body.capped)} agrees with ${rows.length} of ${total}`);
    } else {
        bad(`${path} claims capped=${String(body.capped)} while returning ${rows.length} of ${total}`);
    }
}

// The drill-down needs a real device name, taken from the roster rather than
// invented: a budget measured against a name that matches nothing would pass
// on an empty result set, which is the vacuous-pass shape this project keeps
// finding. If the fixture has no devices, that is a SKIP, not a pass.
const roster = await req('/api/devices');
const first = roster.body?.devices?.[0]?.name as string | undefined;
if (first === undefined) {
    console.log('  SKIP /api/device - the fixture has no devices to drill into');
} else {
    const n = await queriesFor(`/api/device?name=${encodeURIComponent(first)}`) - sessionCost;
    const entities = (await req(`/api/device?name=${encodeURIComponent(first)}`))
        .body?.entities?.length ?? 0;
    if (entities === 0) {
        console.log(`  SKIP /api/device - "${first}" has no entities, so a budget proves nothing`);
    } else if (n <= 2) {
        ok(`/api/device spent ${n} own quer(y/ies) for ${entities} entities, budget 2 `
            + '- constant in entity count, which is the whole claim');
    } else {
        bad(`/api/device spent ${n} own for ${entities} entities, OVER its budget of 2`, { first });
    }

    // The history chart, and the claim is that it costs ONE statement
    // whatever the window - the bucketing happens IN the query, so a 30-day
    // chart is not thirty daily requests and not a client-side fold over
    // 86,400 raw rows.
    const code = (await req(`/api/device?name=${encodeURIComponent(first)}`))
        .body?.entities?.[0]?.code as string | undefined;
    if (code === undefined) {
        console.log('  SKIP /api/entity/history - no entity code to chart');
    } else {
        for (const hours of [24, 720]) {
            const hn = await queriesFor(`/api/entity/history?code=${encodeURIComponent(code)}&hours=${hours}`)
                - sessionCost;
            const pts = (await req(`/api/entity/history?code=${encodeURIComponent(code)}&hours=${hours}`))
                .body?.points?.length ?? 0;
            if (hn <= 1) {
                ok(`/api/entity/history?hours=${hours} spent ${hn} own quer(y/ies) for ${pts} points, `
                    + 'budget 1 - bucketed in SQL, constant in the window');
            } else {
                bad(`/api/entity/history?hours=${hours} spent ${hn}, OVER its budget of 1`, { code });
            }
        }
    }
}

// Same shape for the alert drill-down, and the same refusal to measure
// against nothing: an id taken from the live open set, and a SKIP if the
// fixture is all quiet. The claim is that the detail costs a constant two
// statements - the alert and its delivery log - no matter how long the
// incident ran or how many times it renotified.
const alerts = await req('/api/alerts');
const firstAlert = (alerts.body?.open as Array<{ id: string }> | undefined)?.[0]?.id;
if (firstAlert === undefined) {
    console.log('  SKIP /api/alert - no open alerts to drill into');
} else {
    const n = await queriesFor(`/api/alert?id=${encodeURIComponent(firstAlert)}`) - sessionCost;
    const events = (await req(`/api/alert?id=${encodeURIComponent(firstAlert)}`))
        .body?.history?.length ?? 0;
    if (n <= 2) {
        ok(`/api/alert spent ${n} own quer(y/ies) for ${events} delivery event(s), budget 2 `
            + '- constant in the length of the incident');
    } else {
        bad(`/api/alert spent ${n} own, OVER its budget of 2`, { firstAlert });
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
