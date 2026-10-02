// A sending budget per notification channel, and the digest for what is over
// it (2026-10-01, review F19; the operator's numbers). Pure: the jobs worker
// owns the one instance and hands it to notify.ts, so this module holds no
// state of its own (tools/check-thread-state).
//
// WHY. Each rule caps its own open alerts, but nothing capped the sum: an
// outage across many rules, or a flood a sender drives, sent one message per
// alert per channel as fast as the alerts arrived - and mail providers
// throttle far below that, so the messages that mattered queued behind the
// ones that did not, or were refused.
//
// WHAT. A channel may send `burst` messages at once (60 by default: a
// 48-port switch losing its downstream power is told port by port), and then
// refills at `perMinute` (one a second). An alert over the budget is HELD,
// never dropped: its debt stays open in the database exactly as an
// undelivered one does, and once a minute a channel with held alerts sends
// ONE message listing them. Delivering that message settles each listed
// alert on that channel; an alert held while its other channels delivered is
// settled by the next pass, which finds every channel done.

import type { AlertEvent } from './templates.ts';

export interface HeldNotice {
    alertId: string;
    event: AlertEvent;
    severity: string;
    /** The one-line form, as the syslog channel would have sent it. */
    line: string;
    heldAt: number;
}

export class NotifyBudget {
    private readonly tokens = new Map<string, { n: number; at: number }>();
    private readonly held = new Map<string, Map<string, HeldNotice>>();
    private readonly lastDigest = new Map<string, number>();

    readonly burst: number;
    readonly perMinute: number;
    readonly digestEveryMs: number;

    constructor(burst = 60, perMinute = 60, digestEveryMs = 60_000) {
        this.burst = burst;
        this.perMinute = perMinute;
        this.digestEveryMs = digestEveryMs;
    }

    /** Spend one message on `channel`, or say there is none to spend. */
    take(channel: string, now: number): boolean {
        const t = this.tokens.get(channel) ?? { n: this.burst, at: now };
        t.n = Math.min(this.burst, t.n + ((now - t.at) / 60_000) * this.perMinute);
        t.at = now;
        const ok = t.n >= 1;
        if (ok) t.n -= 1;
        this.tokens.set(channel, t);
        return ok;
    }

    /** Hold a notice for the channel's next digest. Keyed, so a pass that
     *  finds the same debt again does not list it twice. */
    hold(channel: string, key: string, notice: HeldNotice): void {
        const m = this.held.get(channel) ?? new Map<string, HeldNotice>();
        if (!m.has(key)) m.set(key, notice);
        this.held.set(channel, m);
    }

    /** It went out on its own after all: no longer for a digest. */
    release(channel: string, key: string): void {
        this.held.get(channel)?.delete(key);
    }

    /** Channels whose digest is due: something held, and a minute since the last. */
    dueDigests(now: number): Array<{ channel: string; keys: string[]; notices: HeldNotice[] }> {
        const out: Array<{ channel: string; keys: string[]; notices: HeldNotice[] }> = [];
        for (const [channel, m] of this.held) {
            if (m.size === 0) continue;
            const last = this.lastDigest.get(channel);
            if (last !== undefined && now - last < this.digestEveryMs) continue;
            out.push({ channel, keys: [...m.keys()], notices: [...m.values()] });
        }
        return out;
    }

    /** A digest went (or was tried): the next waits a minute, and what it
     *  delivered is no longer held. A failed one keeps its notices. */
    digestSent(channel: string, now: number, delivered: string[]): void {
        this.lastDigest.set(channel, now);
        const m = this.held.get(channel);
        if (m) for (const k of delivered) m.delete(k);
    }

    /** How many notices each channel holds, for the health report. */
    heldCounts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [channel, m] of this.held) if (m.size > 0) out[channel] = m.size;
        return out;
    }
}

/** The digest's words: a title, a body of one line per notice (the first
 *  `maxLines`, then how many more), and a single line for syslog. */
export function digestMessage(
    notices: readonly HeldNotice[], maxLines = 100,
): { title: string; body: string; line: string; severity: string } {
    const n = notices.length;
    const crit = notices.some((x) => x.event !== 'clear' && x.severity === 'crit');
    const allClear = notices.every((x) => x.event === 'clear');
    const severity = crit ? 'crit' : allClear ? 'notice' : 'warn';
    const title = `[RSCanvas] ${n} alert${n === 1 ? '' : 's'} in one message - more than this channel sends at once`;
    const listed = notices.slice(0, maxLines).map((x) => `${new Date(x.heldAt).toISOString()} ${x.line}`);
    const more = n > maxLines ? [`... and ${n - maxLines} more - the Alerts page lists them all.`] : [];
    const body = [
        `${n} alert notification${n === 1 ? '' : 's'} arrived faster than this channel sends`
            + ' them one by one, so they come together:',
        '',
        ...listed,
        ...more,
        '',
        '-- RSCanvas',
    ].join('\n');
    let line = `${n} alerts together:`;
    let shown = 0;
    for (const x of notices) {
        const next = `${line} ${x.line};`;
        if (next.length > 1500) break;
        line = next;
        shown++;
    }
    if (shown < n) line += ` and ${n - shown} more`;
    return { title, body, line, severity };
}
