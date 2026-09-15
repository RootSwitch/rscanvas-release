// Slice 3 done-when criteria, over the real routes.
//
//   ADMIN_PASSWORD=... node tools/export-test.ts
//
// Runs on the lab, against a running server. Sends hostile datagrams through
// the real UDP socket so the MOCK_EVIL check is a genuine round trip - parsed,
// stored, queried and CSV-encoded - rather than a unit test of the encoder
// standing in for one.

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { csvCell } from '../src/export/csv.ts';
import { closeAll } from '../src/store/index.ts';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SYSLOG_HOST = process.env.SYSLOG_HOST || '127.0.0.1';
const SYSLOG_PORT = Number(process.env.SYSLOG_PORT || 5514);

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, detail?: unknown): void => {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail)); }
};

let cookie = '';

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed: Record<string, unknown> = {};
    try { parsed = await res.json() as Record<string, unknown>; } catch { /* not json */ }
    return { status: res.status, body: parsed };
}

async function health(): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/api/health`, { headers: { cookie } });
    return await res.json() as Record<string, unknown>;
}

async function waitFor(id: string, timeoutMs = 600_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const r = await call('GET', `/api/exports/${id}`);
        const job = r.body.job as Record<string, unknown>;
        if (['done', 'failed', 'cancelled'].includes(String(job.state))) return job;
        if (Date.now() > deadline) throw new Error(`export ${id} did not finish in ${timeoutMs}ms`);
        await new Promise((res) => setTimeout(res, 500));
    }
}

// --- hostile content, sent through the real socket ---------------------------
const TAG = `evil-${crypto.randomBytes(4).toString('hex')}`;
const EVIL = [
    `=cmd|' /C calc'!A0 ${TAG}`,
    `+SUM(1+1) ${TAG}`,
    `-2+3 ${TAG}`,
    `@SUM(A1) ${TAG}`,
    `\tleading tab ${TAG}`,
    `he said "hello" and ,commas, ${TAG}`,
    `quote breakout" ,"injected ${TAG}`,
    `<script>alert(1)</script> ${TAG}`,
    `normal message ${TAG}`,
];

async function sendEvil(): Promise<void> {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((r) => sock.bind(0, () => r()));
    for (const body of EVIL) {
        // Wrapped in an ordinary RFC 3164 frame so the parser puts the hostile
        // text in msg, which is where an operator would see it.
        const line = `<13>Jul 26 12:00:00 evilhost evilapp: ${body}`;
        await new Promise<void>((resolve, reject) => {
            sock.send(Buffer.from(line, 'utf8'), SYSLOG_PORT, SYSLOG_HOST, (e) => e ? reject(e) : resolve());
        });
    }
    sock.close();
}

function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQ = false;
            else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

async function main(): Promise<void> {
    if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD required'); process.exit(2); }

    const login = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }),
    });
    const sc = login.headers.get('set-cookie');
    if (!sc) { console.error('could not sign in'); process.exit(1); }
    cookie = sc.split(';')[0] as string;

    // --- the formula guard, in isolation ------------------------------------
    console.log('formula guard');
    check(csvCell('=1+1') === `"'=1+1"`, 'a leading = is prefixed INSIDE the quotes', csvCell('=1+1'));
    check(csvCell('+1') === `"'+1"`, 'a leading + is guarded');
    check(csvCell('-1') === `"'-1"`, 'a leading - is guarded');
    check(csvCell('@x') === `"'@x"`, 'a leading @ is guarded');
    check(csvCell('\t=1') === `"'\t=1"`, 'a leading tab is guarded, since parsers strip it before the formula check');
    check(csvCell('a"b') === '"a""b"', 'an embedded quote is doubled');
    check(csvCell('normal') === '"normal"', 'an ordinary value is quoted and untouched');
    // The order is the whole rule: prefix the RAW value, then wrap. Wrapping
    // first would put the apostrophe outside the quotes, where it is CSV
    // syntax rather than cell content, and the guard would do nothing.
    check(!csvCell('=1+1').startsWith(`'`), "the apostrophe is INSIDE the quotes, not before them");

    // --- round trip through the socket and the database ---------------------
    console.log('\nhostile content round trip');
    await sendEvil();
    await new Promise((r) => setTimeout(r, 1500));

    const submitted = await call('POST', '/api/syslog/export', { hours: 1, q: TAG });
    check(submitted.status === 202, 'export accepted', submitted.body);
    const jobId = String((submitted.body.job as Record<string, unknown>)?.id ?? '');
    const done = await waitFor(jobId);
    check(done.state === 'done', 'export completed', done.state);

    const dl = await fetch(`${BASE}/api/exports/${jobId}/download`, { headers: { cookie } });
    check(dl.status === 200, 'download returns 200', dl.status);
    check((dl.headers.get('content-type') ?? '').startsWith('text/csv'), 'content-type is text/csv');
    check((dl.headers.get('content-disposition') ?? '').includes('attachment'), 'served as an attachment');
    const csv = await dl.text();
    const lines = csv.split('\n').filter(Boolean);
    check(lines.length >= EVIL.length + 1, `all ${EVIL.length} hostile rows came back`, lines.length);

    const header = parseCsvLine(lines[0] as string);
    const msgCol = header.indexOf('msg');
    const rawCol = header.indexOf('raw');
    check(msgCol >= 0 && rawCol >= 0, 'header names msg and raw');

    const cells = lines.slice(1).map((l) => parseCsvLine(l)[msgCol] ?? '');
    const dangerous = cells.filter((c) => /^[=+\-@\t\r]/.test(c));
    check(dangerous.length === 0,
        'NO exported cell begins with a formula character - Excel and LibreOffice will not execute one',
        dangerous.slice(0, 3));

    const guarded = cells.filter((c) => c.startsWith("'="));
    check(guarded.length >= 1, 'the =cmd payload is present and apostrophe-guarded', guarded[0]);

    // Every raw line must still be one CSV record: a quote breakout that
    // escaped would shift columns and the parse above would disagree with the
    // header width.
    const widths = new Set(lines.slice(1).map((l) => parseCsvLine(l).length));
    check(widths.size === 1 && widths.has(header.length),
        'every row has exactly the header width - no quote breakout escaped', [...widths]);

    const breakout = cells.find((c) => c.includes('quote breakout'));
    check(breakout !== undefined && breakout.includes('" ,"injected'),
        'the quote breakout survives as literal text inside one cell', breakout);

    // --- cancellation --------------------------------------------------------
    console.log('\ncancellation');
    const big = await call('POST', '/api/syslog/export', { hours: 336, confirm: true });
    if (big.status === 202) {
        const bigId = String((big.body.job as Record<string, unknown>).id);
        await new Promise((r) => setTimeout(r, 2500));
        const cancelled = await call('DELETE', `/api/exports/${bigId}`);
        check(cancelled.status === 200, 'a running export can be cancelled', cancelled.body);

        // The connection must come back. Bounded by one fetch batch, so allow
        // a little time rather than expecting it instantly.
        let released = false;
        for (let i = 0; i < 40; i++) {
            const h = await health();
            const lanes = h.lanes as Array<Record<string, unknown>>;
            const exp = lanes.find((l) => l.lane === 'export');
            if (Number(exp?.inFlight ?? 1) === 0) { released = true; break; }
            await new Promise((r) => setTimeout(r, 500));
        }
        check(released, 'cancelling releases the export lane connection');
        const after = await call('GET', `/api/exports/${bigId}`);
        check(String((after.body.job as Record<string, unknown>).state) === 'cancelled',
            'the job reports cancelled');
    } else {
        check(false, 'could not start a large export to cancel', big.body);
    }

    // --- rule 3: the per-user cap --------------------------------------------
    //
    // Note what this can and cannot assert. The cap is on jobs CONCURRENTLY
    // queued or running, not on lifetime submissions, so a long enough flood
    // legitimately accepts more than three in total as earlier jobs finish and
    // free slots. Asserting "at most 3 accepted" would be asserting the wrong
    // policy - and it did, on the first run, reporting a failure against
    // correct behaviour.
    console.log('\nrule 3: per-user cap under a flood');
    let maxConcurrentForUser = 0;
    const results: Array<{ status: number; reason?: string }> = [];
    for (let i = 0; i < 50; i++) {
        const r = await call('POST', '/api/syslog/export', { hours: 336, host: 'sw-0001' });
        results.push({ status: r.status, reason: r.body.reason as string | undefined });
        const listed = await call('GET', '/api/syslog/export');
        const live = (listed.body.jobs as Array<Record<string, unknown>>)
            .filter((j) => (j.state === 'queued' || j.state === 'running') && j.owner === ADMIN).length;
        if (live > maxConcurrentForUser) maxConcurrentForUser = live;
    }
    const accepted = results.filter((r) => r.status === 202).length;
    const perUser = results.filter((r) => r.reason === 'too-many-for-user').length;
    const other = results.filter((r) => r.status !== 202
        && !['too-many-for-user', 'queue-wait-too-long', 'busy'].includes(r.reason ?? '')).length;

    console.log(`  ${accepted} accepted over the flood, ${perUser} refused per-user, peak concurrent ${maxConcurrentForUser}`);
    check(maxConcurrentForUser <= 3, 'never more than 3 concurrently queued or running for one user', maxConcurrentForUser);
    check(perUser >= 30, 'the excess was refused with a structured, actionable reason', perUser);
    check(other === 0, 'no refusal was an unexplained error', other);

    for (const j of (await call('GET', '/api/syslog/export')).body.jobs as Array<Record<string, unknown>>) {
        if (j.state === 'queued' || j.state === 'running') await call('DELETE', `/api/exports/${String(j.id)}`);
    }

    // --- rule 2: the wait ceiling --------------------------------------------
    //
    // The two rules bind in different regimes, and the first run of this test
    // did not notice. With maxPerUser 3 and concurrency 2, ONE user can never
    // reach the wait ceiling: their fourth submission is refused for fairness
    // long before the queue is deep enough to be slow. The ceiling exists for
    // the case fairness does not cover - SEVERAL users, each within their own
    // cap, adding up to a queue nobody should join.
    //
    // So it has to be tested with several users, or it is not tested at all.
    console.log('\nrule 2: the wait ceiling, across several users');
    const helpers: Array<{ name: string; cookie: string }> = [];
    for (let i = 0; i < 4; i++) {
        const name = `exp-${crypto.randomBytes(3).toString('hex')}`;
        const pw = 'export-tester-1';
        const made = await call('POST', '/api/users', { username: name, password: pw, role: 'operator' });
        if (made.status !== 201) { check(false, `could not create helper ${name}`, made.body); continue; }
        const li = await fetch(`${BASE}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: name, password: pw }),
        });
        const c = li.headers.get('set-cookie');
        if (c) helpers.push({ name, cookie: c.split(';')[0] as string });
    }
    check(helpers.length === 4, 'four operator accounts created to fill the queue', helpers.length);

    // Each user submits large exports up to their own cap. Individually
    // legitimate; collectively a queue.
    let ceilingFired = 0;
    let ceilingDetail = '';
    const adminCookie = cookie;
    outer: for (let round = 0; round < 3; round++) {
        for (const h of helpers) {
            cookie = h.cookie;
            const r = await call('POST', '/api/syslog/export', { hours: 336, confirm: true });
            if (r.body.reason === 'queue-wait-too-long') {
                ceilingFired++;
                ceilingDetail = String(r.body.detail);
                break outer;
            }
        }
    }
    cookie = adminCookie;

    check(ceilingFired > 0, 'the wait ceiling refused a submission once the queue got deep', ceilingDetail);
    if (ceilingFired > 0) console.log(`  refusal said: ${ceilingDetail}`);

    const finalList = await call('GET', '/api/syslog/export');
    const stillLive = (finalList.body.jobs as Array<Record<string, unknown>>)
        .filter((j) => j.state === 'queued' || j.state === 'running');
    console.log(`  ${stillLive.length} jobs live at the ceiling`);
    for (const j of stillLive) await call('DELETE', `/api/exports/${String(j.id)}`);
    for (const h of helpers) await call('DELETE', `/api/users/${h.name}`);

    await closeAll();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('export test failed:', err);
    void closeAll();
    process.exit(1);
});
