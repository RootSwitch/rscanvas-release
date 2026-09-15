// Notification dispatch: one alert event in, syslog + ntfy out, every attempt
// recorded in the notifications table. Ported from alertcanvas/server/
// {notify,syslog-out,ntfy}.js with the settings table replaced by CONFIG -
// the fork has no settings UI yet, and a channel is enabled by giving it a
// target (ALERT_SYSLOG_HOST, ALERT_NTFY_SERVER + topic).
//
// EMAIL landed 2026-07-28, AND THE STATED REASON FOR DEFERRING IT WAS WRONG.
//
// Two commits claimed "an alert raised today still carries
// notified_raise=false, so the day the channel exists its retry pass delivers
// the backlog". Tested rather than repeated a third time, and it is false: an
// alert delivered by syslog settles notified_raise, so it leaves the owed
// queue and configuring email later does not back-deliver it. With NO channel
// configured the debt settles too, by the deliberate no-phantom-backlog rule
// two paragraphs down.
//
// The behaviour is right - enabling a channel should not flood it with
// history, and a bare deployment should not accrue debt it can never pay. The
// DESCRIPTION was wrong. What enabling email actually picks up is only what
// is still owed: alerts raised while every configured channel was failing,
// and everything raised afterwards. Deferring email cost nothing for the
// pipeline's correctness; it did not bank a deliverable backlog.
//
// THE RETRY CONTRACT. The scan marks what is owed; this module owns delivery.
// An event is "delivered" when every ENABLED channel accepted it - only then
// does markNotified flip the flag and zero the attempt counter. A failure
// increments the counter, and the retry pass re-dispatches with capped
// exponential backoff (60s doubling to 15 minutes, the parent's curve). With
// no channel enabled nothing is owed, so a bare deployment does not
// accumulate a phantom backlog.
//
// Outbound syslog is RFC 5424 over UDP, shaped so a SyslogCanvas-family
// parser stores it first-class - which includes THIS FORK'S OWN INGEST. Point
// ALERT_SYSLOG_HOST at the fork itself and a raised alert becomes a
// searchable message row: the vertical slice's observable end.

import dgram from 'node:dgram';
import os from 'node:os';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { CONFIG } from '../config.ts';
import { OPS, type AlertRecord } from '../store/index.ts';
import { NOTIFIER_APP } from './events.ts';
import { varsFor, render, type AlertEvent, type Alert } from './templates.ts';

const NL = String.fromCharCode(10);

/** The parent's shipped templates, verbatim. */
const TMPL = {
    subjectRaise: '[RSCanvas] {{severity}}: {{label}}',
    subjectClear: '[RSCanvas] cleared: {{label}}',
    syslogRaise: '{{severity}} {{label}} {{detail}}',
    syslogClear: 'clear {{label}} after {{duration}}{{reading}}',
    bodyRaise: [
        '{{time}}',
        '{{label}} is {{severity}}: {{detail}}.',
        '',
        '-- RSCanvas',
    ].join(NL),
    bodyClear: [
        '{{time}}',
        '{{label}} returned to normal after {{duration}}.{{reading}}',
        '',
        '-- RSCanvas',
    ].join(NL),
} as const;

/** AlertRecord (Date fields) -> the template module's Alert (epoch seconds). */
function toTemplateAlert(r: AlertRecord): Alert {
    const s = (d: Date | null): number | null => (d === null ? null : Math.floor(d.getTime() / 1000));
    return {
        kind: r.kind, severity: r.severity, label: r.label, host: r.host,
        code: r.code, unit: r.unit, value: r.value, threshold: r.threshold,
        raised_ts: s(r.raised_ts), first_breach_ts: s(r.first_breach_ts),
        cleared_ts: s(r.cleared_ts),
    };
}

interface SendResult { ok: boolean; detail: string }

// --- syslog ------------------------------------------------------------------

/** SD-PARAM values escape backslash, quote and closing bracket (RFC 5424 6.3.3). */
const sdEscape = (v: string): string => v.replace(/[\\"\]]/g, (c) => `\\${c}`);

const clamp = (v: number, lo: number, hi: number, dflt: number): number =>
    Number.isInteger(v) && v >= lo && v <= hi ? v : dflt;

/** raise/escalate/renotify carry the alert's severity; clear is notice. */
function syslogSeverity(event: AlertEvent, severity: string): number {
    if (event === 'clear' || event === 'test') return 5;
    return severity === 'crit' ? 2 : 4;
}

function sendSyslog(event: AlertEvent, alert: AlertRecord, message: string): Promise<SendResult> {
    const host = CONFIG.alertSyslogHost.trim();
    if (host === '') return Promise.resolve({ ok: false, detail: 'no syslog host configured' });
    const port = clamp(CONFIG.alertSyslogPort, 1, 65535, 514);
    const facility = clamp(CONFIG.alertSyslogFacility, 0, 23, 16);

    const pri = facility * 8 + syslogSeverity(event, alert.severity);
    const ts = new Date().toISOString();
    const sd = `[rscanvas@0 event="${sdEscape(event)}" severity="${sdEscape(alert.severity)}"`
        + ` kind="${sdEscape(alert.kind)}" host="${sdEscape(alert.host ?? '')}"`
        + (alert.code !== null ? ` code="${sdEscape(alert.code)}"` : '') + ']';
    // One datagram is one message: embedded newlines would make a
    // nonconforming multi-line payload.
    const flat = message.replace(/[\r\n]+/g, ' ');
    // NOTIFIER_APP, not a literal: the event matcher skips messages carrying
    // this APP-NAME to break the self-feeding loop (a notification matching
    // its own rule - see the constant's comment in events.ts). One constant,
    // two ends, no drift.
    const line = `<${pri}>1 ${ts} ${os.hostname()} ${NOTIFIER_APP} ${process.pid} `
        + `${event.toUpperCase()} ${sd} ${flat}`;

    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const buf = Buffer.from(line, 'utf8');
        const done = (ok: boolean, detail: string): void => {
            try { sock.close(); } catch { /* already closed */ }
            resolve({ ok, detail });
        };
        // 'error' listener attached BEFORE send - the SNMPCanvas remote-crash
        // lesson, an unlistened 'error' event is thrown, applies to every
        // socket this project ever opens.
        sock.once('error', (err) => done(false, err.message));
        sock.send(buf, 0, buf.length, port, host, (err) =>
            (err ? done(false, err.message) : done(true, `${host}:${port}`)));
    });
}

// --- ntfy --------------------------------------------------------------------

/** Priority and tag follow ntfy conventions: crit pages, warn is high. */
const ntfyPriority = (event: AlertEvent, severity: string): string =>
    event === 'clear' || event === 'test' ? '3' : severity === 'crit' ? '5' : '4';
const ntfyTag = (event: AlertEvent, severity: string): string =>
    event === 'clear' ? 'white_check_mark'
        : event === 'test' ? 'mag'
            : severity === 'crit' ? 'rotating_light' : 'warning';

/** HTTP headers must stay latin1; a fancy title loses a character, not the send. */
const headerSafe = (s: string): string => s.replace(/[^\x20-\x7E]/g, '?').slice(0, 250);

async function sendNtfy(
    event: AlertEvent, alert: AlertRecord, title: string, message: string,
): Promise<SendResult> {
    const server = CONFIG.alertNtfyServer.trim().replace(/\/+$/, '');
    const topic = CONFIG.alertNtfyTopic.trim();
    if (server === '' || topic === '') return { ok: false, detail: 'ntfy server/topic not configured' };
    if (!/^https?:\/\//i.test(server)) return { ok: false, detail: 'ntfy server must start with http:// or https://' };

    try {
        const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
            method: 'POST',
            body: message,
            headers: {
                Title: headerSafe(title),
                Priority: ntfyPriority(event, alert.severity),
                Tags: ntfyTag(event, alert.severity),
                ...(CONFIG.alertNtfyToken !== '' ? { Authorization: `Bearer ${CONFIG.alertNtfyToken}` } : {}),
            },
            signal: AbortSignal.timeout(15_000),
        });
        await res.text().catch(() => ''); // drain: an unread body pins the socket
        if (!res.ok) return { ok: false, detail: `${server}: HTTP ${res.status}` };
        return { ok: true, detail: `${server}/${topic}` };
    } catch (err) {
        return { ok: false, detail: (err as Error).message };
    }
}

// --- email --------------------------------------------------------------------

/**
 * Built per send rather than pooled. At alert volume - a few messages a day at
 * worst - connection reuse buys nothing, and rebuilding means a configuration
 * change takes effect on the next alert rather than the next restart. The
 * parent's reasoning, and it holds here.
 */
function smtpConfig(): SMTPTransport.Options {
    const mode = CONFIG.alertSmtpMode;
    const cfg: SMTPTransport.Options = {
        host: CONFIG.alertSmtpHost.trim(),
        port: CONFIG.alertSmtpPort,
        secure: mode === 'tls',            // implicit TLS from byte one
        requireTLS: mode === 'starttls',   // UPGRADE OR FAIL, never silently plaintext
        ignoreTLS: mode === 'none',
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
        tls: { rejectUnauthorized: !CONFIG.alertSmtpAllowSelfSigned },
    };
    const user = CONFIG.alertSmtpUser.trim();
    if (user !== '') cfg.auth = { user, pass: CONFIG.alertSmtpPassword };
    return cfg;
}

const recipients = (): string[] =>
    CONFIG.alertSmtpTo.split(',').map((a) => a.trim()).filter((a) => a !== '');

/**
 * Plain text only - an alert is a sentence, not a newsletter.
 *
 * WHAT ok=true MEANS HERE IS WEAKER THAN ON THE OTHER CHANNELS, and it is
 * worth naming: the relay ACCEPTED the message. It does not mean anyone
 * received it, and a relay that accepts and then silently drops is
 * indistinguishable from one that delivers. Email is the channel where the
 * notifications log is least able to answer "did anyone get told" - which is
 * an argument for having more than one channel, not against having this one.
 */
async function sendMail(subject: string, body: string): Promise<SendResult> {
    const cfg = smtpConfig();
    if (cfg.host === undefined || cfg.host === '') return { ok: false, detail: 'no SMTP host configured' };
    const from = CONFIG.alertSmtpFrom.trim();
    const to = recipients();
    if (from === '') return { ok: false, detail: 'no From address configured' };
    if (to.length === 0) return { ok: false, detail: 'no recipients configured' };

    let transport: nodemailer.Transporter | null = null;
    try {
        transport = nodemailer.createTransport(cfg);
        const info = await transport.sendMail({ from, to, subject, text: body });
        return { ok: true, detail: info.response ?? 'accepted' };
    } catch (err) {
        return { ok: false, detail: (err as Error).message };
    } finally {
        // In a finally, because a transport left open after a throw holds a
        // socket until its own timeout - and the retry pass builds another
        // one every backoff interval.
        transport?.close();
    }
}

// --- dispatch ----------------------------------------------------------------

const syslogEnabled = (): boolean => CONFIG.alertSyslogHost.trim() !== '';
/**
 * All three of host, from and to. A half-configured channel is OFF, not
 * broken: without this a deployment that set only ALERT_SMTP_HOST would
 * accrue an unpayable debt on every alert and never deliver one.
 */
const emailEnabled = (): boolean =>
    CONFIG.alertSmtpHost.trim() !== '' && CONFIG.alertSmtpFrom.trim() !== ''
    && recipients().length > 0;

/**
 * WHICH CHANNELS ARE CONFIGURED, AND WHICH ARE HALF-CONFIGURED.
 *
 * "Off rather than broken" is right at startup and produces a SILENT FAILURE
 * when it meets the no-phantom-backlog rule: set ALERT_SMTP_HOST and
 * ALERT_SMTP_FROM, fat-finger ALERT_SMTP_TO, and email does not exist -
 * alerts then settle as delivered because nothing owed them, and nothing
 * anywhere reports that notifications went nowhere. That is
 * fail-open-on-absent-data, in the notification path, which is the one place
 * this project has been most careful about everywhere else.
 *
 * The discrimination is the same one used for every other absence here:
 *
 *   ZERO of a channel's variables set   a DECISION. Silent.
 *   SOME BUT NOT ALL set                a MISTAKE. Loud at startup, and a
 *                                       health problem until it is fixed.
 *
 * Nothing configured at all is legitimate - somebody may simply watch the
 * page - but it is REPORTED rather than inferred, because "why was I not
 * alerted" deserves a visible answer.
 */
export interface ChannelConfig {
    enabled: string[];
    /** channel -> what is missing. Present means half-configured. */
    incomplete: Record<string, string[]>;
}

export function channelConfig(): ChannelConfig {
    const enabled: string[] = [];
    const incomplete: Record<string, string[]> = {};

    if (syslogEnabled()) enabled.push('syslog');

    const ntfyParts = {
        ALERT_NTFY_SERVER: CONFIG.alertNtfyServer.trim(),
        ALERT_NTFY_TOPIC: CONFIG.alertNtfyTopic.trim(),
    };
    const ntfyMissing = Object.entries(ntfyParts).filter(([, v]) => v === '').map(([k]) => k);
    if (ntfyMissing.length === 0) enabled.push('ntfy');
    else if (ntfyMissing.length < Object.keys(ntfyParts).length) incomplete.ntfy = ntfyMissing;

    const smtpParts = {
        ALERT_SMTP_HOST: CONFIG.alertSmtpHost.trim(),
        ALERT_SMTP_FROM: CONFIG.alertSmtpFrom.trim(),
        ALERT_SMTP_TO: recipients().join(','),
    };
    const smtpMissing = Object.entries(smtpParts).filter(([, v]) => v === '').map(([k]) => k);
    if (smtpMissing.length === 0) enabled.push('email');
    else if (smtpMissing.length < Object.keys(smtpParts).length) incomplete.email = smtpMissing;

    return { enabled, incomplete };
}

/**
 * The health verdict. Half-configured is UNHEALTHY - it is a typo standing
 * between an alert and the person who needs it. Nothing configured is
 * healthy-but-reported: the problem string is absent, and the caller shows
 * `enabled: []` on the health endpoint, which is where "nobody is being
 * told" becomes visible instead of silent.
 */
export function isNotifyConfigSane(cfg = channelConfig()): { healthy: boolean; problem?: string } {
    const broken = Object.entries(cfg.incomplete);
    if (broken.length === 0) return { healthy: true };
    return {
        healthy: false,
        problem: broken
            .map(([ch, missing]) => `notification channel "${ch}" is half-configured: `
                + `${missing.join(' and ')} not set, so it is silently disabled`)
            .join('; '),
    };
}
const ntfyEnabled = (): boolean =>
    CONFIG.alertNtfyServer.trim() !== '' && CONFIG.alertNtfyTopic.trim() !== '';

async function recordAttempt(
    alertId: string, channel: string, event: string, r: SendResult,
): Promise<void> {
    const log = await OPS.logNotification(alertId, event, channel, r.ok, r.detail.slice(0, 500));
    if (!log.ok) throw new Error(`lane refused the notification log (${log.reason})`);
}

/**
 * Send one event on the enabled channels, record every attempt, and settle
 * the debt on the row. Returns whether every enabled channel has delivered.
 *
 * raise, escalate and renotify all settle the RAISE debt; clear settles the
 * clear debt - the same folding the parent did, so the retry pass needs only
 * two queues.
 *
 * ON RETRY, DELIVERY IS PER CHANNEL. The debt flag on the row is one bit,
 * so without this a single misconfigured channel turned every alert into a
 * repeat on the channels that WORK: syslog fine, ntfy URL typo'd, and the
 * retry re-sent syslog every backoff interval forever - with the symptom
 * pointing at syslog, the one part behaving correctly. A retry consults the
 * notifications log (scoped to this incident's debt by raised_ts/cleared_ts)
 * and skips channels that already delivered, so a permanently broken channel
 * retries ALONE and its growing failure log names the actual culprit.
 *
 * Only retries skip. A fresh escalate or renotify is a NEW message and goes
 * to every channel even though the raise already delivered - which is also
 * why delivering any of raise/escalate/renotify settles that channel's debt.
 */
export async function dispatchEvent(
    event: AlertEvent, alert: AlertRecord, opts: { retry?: boolean } = {},
): Promise<boolean> {
    const vars = varsFor(toTemplateAlert(alert), event);
    const isClear = event === 'clear';
    const title = render(isClear ? TMPL.subjectClear : TMPL.subjectRaise, vars);
    const line = render(isClear ? TMPL.syslogClear : TMPL.syslogRaise, vars);

    let done = new Set<string>();
    if (opts.retry === true) {
        // For an escalate retry the debt is scoped by escalated_ts: a
        // channel that delivered any of raise/escalate/renotify SINCE the
        // escalation has heard about the crit by some name and is settled;
        // one that only heard the WARN raise has not.
        const since = (event === 'escalate' ? alert.escalated_ts
            : isClear ? alert.cleared_ts : alert.raised_ts) ?? alert.first_breach_ts;
        const d = await OPS.channelsDelivered(
            alert.id, isClear ? ['clear'] : ['raise', 'escalate', 'renotify'], since);
        if (!d.ok) throw new Error(`lane refused channelsDelivered (${d.reason})`);
        done = new Set(d.rows.map((r) => r.channel));
    }

    let allOk = true;
    let attempted = false;

    if (syslogEnabled()) {
        attempted = true;
        if (!done.has('syslog')) {
            const r = await sendSyslog(event, alert, line);
            await recordAttempt(alert.id, 'syslog', event, r);
            allOk = allOk && r.ok;
        }
    }
    if (ntfyEnabled()) {
        attempted = true;
        if (!done.has('ntfy')) {
            const r = await sendNtfy(event, alert, title, line);
            await recordAttempt(alert.id, 'ntfy', event, r);
            allOk = allOk && r.ok;
        }
    }
    if (emailEnabled()) {
        attempted = true;
        if (!done.has('email')) {
            const body = render(isClear ? TMPL.bodyClear : TMPL.bodyRaise, vars);
            const r = await sendMail(title, body);
            await recordAttempt(alert.id, 'email', event, r);
            allOk = allOk && r.ok;
        }
    }

    // No channel enabled: nothing owed, and saying otherwise would accumulate
    // a phantom backlog that fires in full the day a channel is configured.
    // An escalate settles its OWN debt (and, on success, the raise debt with
    // it - see markNotified); renotify keeps settling the raise debt, the
    // parent's folding, so a failed renotify re-enters the raise queue and
    // retries per channel.
    const delivered = attempted ? allOk : true;
    const which = isClear ? 'clear' : event === 'escalate' ? 'escalate' : 'raise';
    const m = await OPS.markNotified(alert.id, which, delivered, new Date());
    if (!m.ok) throw new Error(`lane refused markNotified (${m.reason})`);
    if (event === 'renotify') {
        const r = await OPS.markRenotified(alert.id, new Date());
        if (!r.ok) throw new Error(`lane refused markRenotified (${r.reason})`);
    }
    return delivered;
}

/** The parent's curve: 60s doubling per failure, capped at 15 minutes. */
export const backoffS = (attempts: number): number =>
    Math.min(60 * 2 ** Math.max(0, attempts - 1), 900);

// The backoff gates FAILURES, not attempts. notify_attempts is zeroed on every
// success, so a zero counter means nothing is being retried and the event is
// due now - without that, a clear arriving after a delivered raise waited out
// a 60s backoff it never earned, because last_attempt_ts still carried the
// raise's timestamp. tools/test-notify.ts caught exactly that.
const due = (r: AlertRecord, now: Date): boolean =>
    r.notify_attempts === 0
    || r.last_attempt_ts === null
    || (now.getTime() - r.last_attempt_ts.getTime()) / 1000 >= backoffS(r.notify_attempts);

/** What one pass found and did (easy-win E6): the depths and the age of
 *  the oldest untold incident are the "is anybody being told" numbers, and
 *  they ran through this function every pass while only `sent` came out. */
export interface RetryReport {
    sent: number;
    owed: { raise: number; escalate: number; clear: number; renotify: number };
    /** Oldest first_breach_ts across the raise and escalate queues - the
     *  age of the oldest incident nobody has fully heard about. */
    oldestOwedTs: Date | null;
}

/**
 * Drain the owed queues: raises still unsent on active alerts, clears still
 * unsent on recently cleared ones. This is ALSO the first-attempt path for
 * anything the scan raised while dispatch was failing or absent - the queue
 * is the database, so nothing depends on which process was alive when.
 */
export async function retryPass(now = new Date()): Promise<RetryReport> {
    if (!syslogEnabled() && !ntfyEnabled() && !emailEnabled()) {
        return { sent: 0, owed: { raise: 0, escalate: 0, clear: 0, renotify: 0 }, oldestOwedTs: null };
    }
    // Maintenance windows (slice 22): the owed queries exclude in-window
    // alerts themselves - one predicate against a table that is small by
    // construction, riding statements this pass already makes. The one case
    // needing an action rather than a filter is settled FIRST: a clear whose
    // raise was never delivered and whose clear landed inside a window must
    // have its debt waived now, or it would deliver as a "resolved" page
    // about an unknown incident once the window expires.
    const settled = await OPS.settleInWindowClears();
    if (!settled.ok) throw new Error(`lane refused the in-window settle (${settled.reason})`);
    // Slice 25: the policy twin. A raise-and-clear that both happened under
    // a standing policy must have the clear's debt waived while the policy
    // still stands - otherwise DELETING the policy owes a "resolved" page
    // about an incident nobody was told of.
    const settledPolicy = await OPS.settleUnderPolicyClears();
    if (!settledPolicy.ok) throw new Error(`lane refused the policy settle (${settledPolicy.reason})`);
    let sent = 0;
    const raises = await OPS.alertsOwingRaise();
    if (!raises.ok) throw new Error(`lane refused the raise queue (${raises.reason})`);
    for (const r of raises.rows) {
        if (!due(r, now)) continue;
        if (await dispatchEvent('raise', r, { retry: true })) sent++;
    }
    // The third queue (DECISIONS-2026-09-01 ruling 1): escalations whose
    // live dispatch was skipped by a window or policy, or failed. Disjoint
    // from the raise queue by construction - it requires notified_raise -
    // and delivered before clears so an incident that worsened and then
    // ended reads in that order on a channel that was down for both.
    const escalates = await OPS.alertsOwingEscalate();
    if (!escalates.ok) throw new Error(`lane refused the escalate queue (${escalates.reason})`);
    for (const r of escalates.rows) {
        if (!due(r, now)) continue;
        if (await dispatchEvent('escalate', r, { retry: true })) sent++;
    }
    const clears = await OPS.alertsOwingClear();
    if (!clears.ok) throw new Error(`lane refused the clear queue (${clears.reason})`);
    for (const r of clears.rows) {
        if (!due(r, now)) continue;
        if (await dispatchEvent('clear', r, { retry: true })) sent++;
    }
    // The renotify generator (DECISIONS-2026-09-01 ruling 2): OFF unless
    // ALERT_RENOTIFY_H is set, crit-only, ack-aware, clock restarted by any
    // communication. The delivery plumbing below this line existed complete
    // for the fork's whole life with nothing generating the event - a crit
    // active for a month paged exactly once. Not a retry: a renotify is a
    // NEW message and goes to every channel; a failed one folds back into
    // the raise debt (markNotified) and retries per channel from there.
    let renotifyOwed = 0;
    if (CONFIG.alertRenotifyH > 0) {
        const renotifies = await OPS.alertsOwingRenotify(CONFIG.alertRenotifyH);
        if (!renotifies.ok) throw new Error(`lane refused the renotify queue (${renotifies.reason})`);
        renotifyOwed = renotifies.rows.length;
        for (const r of renotifies.rows) {
            if (!due(r, now)) continue;
            if (await dispatchEvent('renotify', r)) sent++;
        }
    }
    const untold = [...raises.rows, ...escalates.rows];
    return {
        sent,
        owed: {
            raise: raises.rows.length,
            escalate: escalates.rows.length,
            clear: clears.rows.length,
            renotify: renotifyOwed,
        },
        oldestOwedTs: untold.length === 0 ? null
            : untold.reduce((m, r) => (r.first_breach_ts < m ? r.first_breach_ts : m),
                untold[0]!.first_breach_ts),
    };
}
