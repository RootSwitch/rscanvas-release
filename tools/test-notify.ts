// Notification dispatch against real sockets: the debt settles ONLY on
// delivery, the backoff is real, and recovery drains the backlog.
//
// The test owns all three receivers - a UDP socket for syslog, an HTTP server
// for ntfy, an SMTP server for email - and runs the failure path FIRST, with
// only the UDP socket listening. Control-first: a dispatcher that reported
// success while ntfy was down would pass every happy-path test ever written;
// what has to be proven is that the failure ARRIVES as an unsettled debt with
// a growing counter.
//
// Channel targets come from CONFIG, so the runner must point them here:
//
//   ALERT_SYSLOG_HOST=127.0.0.1 ALERT_SYSLOG_PORT=39514 \
//   ALERT_NTFY_SERVER=http://127.0.0.1:39917 ALERT_NTFY_TOPIC=rsc-test \
//   DATABASE_URL=...rscanvas_test node tools/test-notify.ts
//
// It refuses to run if the channels are not aimed at localhost, and refuses
// any database not nominated disposable (it deletes alert rows wholesale).

import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';
import { retryPass, backoffS } from '../src/alerts/notify.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const LABEL = 'notify-probe cpu';
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

const sql = async (text: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    const r = await onLane<Record<string, unknown>>('jobs', async (c) => {
        const q = await c.query<Record<string, unknown>>(text, values);
        return { rows: q.rows, rowCount: q.rows.length };
    });
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    return r.rows;
};

async function main(): Promise<void> {
    assertDestructiveTarget('test-notify', CONFIG.databaseUrl);
    if (CONFIG.alertSyslogHost !== '127.0.0.1' || !CONFIG.alertNtfyServer.startsWith('http://127.0.0.1')
        || CONFIG.alertSmtpHost !== '127.0.0.1') {
        console.error('refusing: this test sends real notifications, so the channels must be');
        console.error('aimed at localhost (see the header for the exact environment).');
        process.exit(2);
    }
    console.log('notify: debts settle on delivery, and only then\n');

    // The whole table: this database is nominated disposable, and rows left
    // by other tests would be drained into this test's receivers otherwise.
    await sql('DELETE FROM alerts');

    // --- receivers -----------------------------------------------------------
    const datagrams: string[] = [];
    const udp = dgram.createSocket('udp4');
    udp.on('message', (m) => datagrams.push(m.toString('utf8')));
    udp.on('error', () => { /* the test asserts on content, not transport */ });
    await new Promise<void>((res) => udp.bind(CONFIG.alertSyslogPort, '127.0.0.1', res));

    const posts: Array<{ title: string; priority: string; body: string }> = [];
    const httpServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
        req.on('end', () => {
            posts.push({
                title: String(req.headers.title ?? ''),
                priority: String(req.headers.priority ?? ''),
                body,
            });
            res.writeHead(200).end('{}');
        });
    });
    // NOT listening yet - the failure path comes first.

    // A minimal SMTP sink. MODE=none, so no TLS and no AUTH to negotiate.
    const mails: string[] = [];
    const smtp = net.createServer((sock) => {
        let buf = '';
        let inData = false;
        let msg = '';
        sock.write('220 rsc-test ESMTP' + CRLF);
        sock.on('error', () => { /* nodemailer hangs up its own way */ });
        sock.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            let idx: number;
            while ((idx = buf.indexOf(CRLF)) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (inData) {
                    if (line === '.') {
                        inData = false;
                        mails.push(msg);
                        msg = '';
                        sock.write('250 2.0.0 queued as TEST' + CRLF);
                    } else {
                        msg += line + CRLF;
                    }
                    continue;
                }
                const verb = line.slice(0, 4).toUpperCase();
                if (verb === 'EHLO') sock.write('250-rsc-test' + CRLF + '250 8BITMIME' + CRLF);
                else if (verb === 'HELO') sock.write('250 rsc-test' + CRLF);
                else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 2.1.0 ok' + CRLF);
                else if (verb === 'DATA') { inData = true; sock.write('354 go ahead' + CRLF); }
                else if (verb === 'QUIT') { sock.write('221 2.0.0 bye' + CRLF); sock.end(); }
                else sock.write('250 2.0.0 ok' + CRLF);
            }
        });
    });
    smtp.on('error', () => { /* asserted through delivery, not transport */ });
    // NOT listening yet - email joins the failure-path-first run below.

    const waitFor = async (pred: () => boolean, ms = 3000): Promise<boolean> => {
        const t0 = Date.now();
        while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
        return pred();
    };

    try {
        // --- an owed raise ---------------------------------------------------
        const ins = await OPS.insertAlert({
            alertKey: 'metric:NOTIFY1', state: 'active', severity: 'crit', kind: 'cpu',
            host: 'probe-host', code: 'NOTIFY1', label: LABEL, value: 99, peakValue: 99,
            threshold: 95, unit: '%', breachCount: 2,
            firstBreachTs: new Date(Date.now() - 60_000), raisedTs: new Date(), lastSeenTs: new Date(),
        });
        if (!ins.ok || ins.rows[0] === undefined) throw new Error('fixture insert failed');
        const id = ins.rows[0].id;

        // --- 1. partial failure: syslog up, ntfy DOWN ------------------------
        await retryPass();
        const gotSyslog = await waitFor(() => datagrams.some((d) => d.includes(LABEL)));
        const d = datagrams.find((x) => x.includes(LABEL)) ?? '';
        if (gotSyslog && /^<130>1 /.test(d) && d.includes('[rscanvas@0 event="raise"')
            && d.includes('code="NOTIFY1"')) {
            ok('syslog datagram arrived: RFC 5424, PRI 130 (local0.crit), SD block carries the alert');
        } else {
            bad('the syslog datagram is missing or malformed', JSON.stringify(d.slice(0, 120)));
        }

        let row = (await sql('SELECT notified_raise, notify_attempts, last_attempt_ts FROM alerts WHERE id = $1::bigint', [id]))[0]!;
        if (row.notified_raise === false && Number(row.notify_attempts) === 1) {
            ok('ntfy down: the debt STAYS on the row and the counter reads 1 - partial delivery is not delivery');
        } else {
            bad('a failed channel settled the debt anyway', JSON.stringify(row));
        }
        const logged = await sql(
            `SELECT channel, ok FROM notifications WHERE alert_id = $1::bigint ORDER BY id`, [id]);
        if (logged.some((l) => l.channel === 'syslog' && l.ok === true)
            && logged.some((l) => l.channel === 'ntfy' && l.ok === false)
            && logged.some((l) => l.channel === 'email' && l.ok === false)) {
            ok('and the log holds all THREE attempts - one delivered, two failed');
        } else {
            bad('the notifications log is incomplete', JSON.stringify(logged));
        }

        // --- 2. the backoff is real ------------------------------------------
        const before = datagrams.length;
        await retryPass();
        row = (await sql('SELECT notify_attempts FROM alerts WHERE id = $1::bigint', [id]))[0]!;
        if (Number(row.notify_attempts) === 1 && datagrams.length === before) {
            ok(`an immediate retry is gated: attempt 1 waits ${backoffS(1)}s before attempt 2`);
        } else {
            bad('the backoff did not gate', JSON.stringify({ attempts: row.notify_attempts }));
        }

        // --- 2b. THE MISCONFIGURED-CHANNEL SCENARIO ---------------------------
        // ntfy STILL down, backoff elapsed: the retry must hit ntfy ALONE.
        // Without per-channel delivery, one typo'd ntfy URL turned every alert
        // into a repeating syslog notification - with the symptom pointing at
        // syslog, the channel behaving correctly.
        await sql(`UPDATE alerts SET last_attempt_ts = last_attempt_ts - interval '10 minutes'
                    WHERE id = $1::bigint`, [id]);
        const syslogsBefore = datagrams.filter((x) => x.includes(LABEL)).length;
        await retryPass();
        await new Promise((r) => setTimeout(r, 300));
        const syslogsAfter = datagrams.filter((x) => x.includes(LABEL)).length;
        if (syslogsAfter === syslogsBefore) {
            ok('a broken channel retries ALONE - the delivered syslog is NOT re-sent');
        } else {
            bad(`the working channel repeated: ${syslogsAfter - syslogsBefore} extra datagram(s) - `
                + 'one misconfigured channel is spamming the channel people actually use');
        }
        const ntfyFails = await sql(
            `SELECT count(*) AS n FROM notifications
              WHERE alert_id = $1::bigint AND channel = 'ntfy' AND NOT ok`, [id]);
        if (Number(ntfyFails[0]!.n) >= 2) {
            ok('while the ntfy failure log grows - the evidence names the actual culprit');
        } else {
            bad('the broken channel was not retried', JSON.stringify(ntfyFails));
        }

        // --- 3. recovery drains the debt -------------------------------------
        await new Promise<void>((res) => httpServer.listen(39917, '127.0.0.1', res));
        await new Promise<void>((res) => smtp.listen(39025, '127.0.0.1', res));
        await sql(`UPDATE alerts SET last_attempt_ts = last_attempt_ts - interval '10 minutes'
                    WHERE id = $1::bigint`, [id]);
        const syslogsAtRecovery = datagrams.filter((x) => x.includes(LABEL)).length;
        await retryPass();
        const gotNtfy = await waitFor(() => posts.length > 0);
        if (gotNtfy && posts[0]!.priority === '5' && posts[0]!.title.includes('crit')) {
            ok('ntfy back up: the POST arrives, priority 5 with the crit title');
        } else {
            bad('recovery did not deliver to ntfy', JSON.stringify(posts));
        }
        const gotMail = await waitFor(() => mails.length > 0);
        const mail = mails[0] ?? '';
        if (gotMail && /^Subject: .*crit/mi.test(mail) && mail.includes(LABEL)
            && mail.includes('ops@example.invalid')) {
            ok('and the mail lands through a REAL SMTP conversation - headers, recipient, body');
        } else {
            bad('the mail did not arrive intact', JSON.stringify(mail.slice(0, 200)));
        }

        row = (await sql('SELECT notified_raise, notify_attempts FROM alerts WHERE id = $1::bigint', [id]))[0]!;
        if (row.notified_raise === true && Number(row.notify_attempts) === 0) {
            ok('and the debt settles: notified_raise=true, attempts back to 0');
        } else {
            bad('delivery did not settle the debt', JSON.stringify(row));
        }
        await new Promise((r) => setTimeout(r, 300));
        if (datagrams.filter((x) => x.includes(LABEL)).length === syslogsAtRecovery) {
            ok('and recovery still did not re-send the channel that delivered first');
        } else {
            bad('recovery re-sent the already-delivered channel');
        }

        // --- 4. the clear debt goes the same way -----------------------------
        await sql(`UPDATE alerts SET state = 'cleared', cleared_ts = now(),
                          clear_reason = 'normal', notified_clear = false
                    WHERE id = $1::bigint`, [id]);
        const posted = posts.length;
        await retryPass();
        const gotClear = await waitFor(() => posts.length > posted);
        const clearDatagram = datagrams.filter((x) => x.includes('CLEAR')).pop() ?? '';
        if (gotClear && posts[posts.length - 1]!.priority === '3' && /^<133>1 /.test(clearDatagram)) {
            ok('the clear dispatches too: ntfy priority 3, syslog PRI 133 (local0.notice)');
        } else {
            bad('the clear did not dispatch', JSON.stringify({ clearDatagram: clearDatagram.slice(0, 80), posts: posts.length }));
        }
        row = (await sql('SELECT notified_clear FROM alerts WHERE id = $1::bigint', [id]))[0]!;
        if (row.notified_clear === true) {
            ok('and settles its own flag');
        } else {
            bad('the clear debt did not settle');
        }

        // --- 5. the log is bounded BY AGE, not only by cascade ----------------
        // A broken channel's failures against a never-clearing alert are rows
        // the cascade cannot reach; the age prune is what bounds them.
        await sql(`INSERT INTO notifications (ts, alert_id, event, channel, ok, detail)
                   VALUES (now() - interval '120 days', $1::bigint, 'raise', 'ntfy', false, 'ancient')`,
            [id]);
        const pruned = await OPS.pruneNotifications(90);
        if (!pruned.ok) throw new Error('prune refused');
        const left = await sql(
            `SELECT count(*) FILTER (WHERE detail = 'ancient') AS old,
                    count(*) AS total
               FROM notifications WHERE alert_id = $1::bigint`, [id]);
        if (Number(left[0]!.old) === 0 && Number(left[0]!.total) > 0) {
            ok('age retention removes the 120-day row and keeps the fresh ones - the log is bounded');
        } else {
            bad('the age prune misbehaved', JSON.stringify(left));
        }
    } finally {
        await sql('DELETE FROM alerts');
        udp.close();
        httpServer.close();
        smtp.close();
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('notify test failed:', err);
    void closeAll();
    process.exit(1);
});
