// Alert formatting: `{{variable}}` substitution into user-editable subject,
// body and syslog templates.
//
// PORTED FROM alertcanvas/server/templates.js, 2026-07-27. The first module of
// the slice 6 merge, chosen because it is genuinely free: no database, no
// module-level state, no I/O, no thread affinity. It depends on none of the
// seven assumptions the triage enumerated, which is what "free move" means.
//
// THE DIFF AGAINST THE PARENT IS THE REVIEW ARTIFACT, and every behavioural
// difference has to be intentional and named. SyslogCanvas's `filter.js` is why:
// it escaped its LIKE patterns correctly from its first commit, the fork's port
// silently lost that, and nothing caught it because a ported file reads fine on
// its own merits.
//
// So, exhaustively, what differs from the parent:
//
//   1. TYPES ADDED. `Alert` and `AlertEvent` below. The parent takes an
//      untyped alerts-table row. Nothing about the RENDERING changes; what
//      changes is that the shape is now declared, because this project has
//      already paid twice for untyped contracts between components.
//   2. `varsFor` returns `Record<string, string>` explicitly. In the parent
//      every value was already a string by construction; this states it, so
//      `render`'s substitution cannot silently interpolate an object.
//   3. `fmtDuration` takes `number | null` rather than an implicit any. Same
//      null/negative handling, same output.
//
// NOTHING ELSE DIFFERS. Same variable list, same `detailFor` branches in the
// same order, same UTC timestamp format, same "unknown variables render as-is"
// rule, same `reading` suppression for null values and `state` alarms. The
// arithmetic in `fmtDuration` is character-for-character the parent's.
//
// The behaviours worth not losing, called out because a reader would otherwise
// have to infer that they are deliberate:
//
//   * UNKNOWN VARIABLES RENDER AS THEMSELVES, so `{{hsot}}` appears in the mail
//     rather than becoming an empty string. A typo in a user-edited template is
//     visible instead of silent.
//   * `detailFor` exists because the generic template produced
//     "value -- (threshold --)" for alarms with no numeric reading - a device
//     that fell out of the feed, a downed link, a reboot. Each of those gets a
//     plain statement instead.
//   * TIMESTAMPS ARE UTC with an explicit trailing Z. The server has no
//     reliable local-timezone context, and UTC stays unambiguous across mail,
//     syslog and ntfy. This matches the fork's TimeZone=UTC pinning rather than
//     fighting it.

/** The rendering event. Drives wording, not just which template is chosen. */
export type AlertEvent = 'raise' | 'clear' | 'escalate' | 'renotify' | 'test';

/**
 * One alerts-table row, as the formatter needs it.
 *
 * Declared here rather than inferred from the parent's row shape, and
 * deliberately NOT exported from a store module: this file must stay free of
 * the database so it can be tested without one. When the rules engine lands it
 * supplies values of this type; if the two ever disagree, `tsc` says so.
 */
export interface Alert {
    kind: string;
    severity: string;
    label?: string | null;
    host?: string | null;
    code?: string | null;
    unit?: string | null;
    value?: number | null;
    threshold?: number | null;
    raised_ts?: number | null;
    first_breach_ts?: number | null;
    cleared_ts?: number | null;
}

/** Every substitutable name, for the template editor's help text. */
export const VARS = [
    'label', 'host', 'metric', 'kind', 'code', 'value', 'unit',
    'threshold', 'severity', 'event', 'time', 'duration', 'detail', 'reading',
] as const;

/**
 * A natural-language clause describing WHY an alarm is active, chosen by kind.
 *
 * Metric breaches keep the classic "value X (threshold Y)". Alarms with no
 * numeric reading get a plain statement instead of the bare
 * "value -- (threshold --)" the generic template used to produce.
 */
function detailFor(alert: Alert): string {
    const unit = alert.unit || '';
    // Binary status alarms first: their value/threshold are 1/1, and
    // "value 1 (threshold 1)" helps no one. The label already carries the
    // device's own wording ("Power On battery").
    if (alert.kind === 'state') return 'reporting an alarm condition';
    if (alert.value != null && alert.threshold != null) {
        return `value ${alert.value}${unit} (threshold ${alert.threshold}${unit})`;
    }
    switch (alert.kind) {
        // Said as what is KNOWN (2026-09-28, the notification drill): the
        // email for an agent stopped on a box that still answered ping read
        // "unreachable or powered off" - neither was true - and "status
        // feed" is the parent suite's word, not this product's. The poll is
        // what failed; the ping column is what tells the two cases apart.
        case 'device-down': return 'not answering SNMP polls (if it still answers ping, suspect '
            + 'the agent or its credential; if not, the device or the network)';
        case 'if-down':     return 'link is down';
        case 'ping-down':   return alert.severity === 'warn'
            ? `answering ping slowly${alert.value != null ? ` (${alert.value} ms)` : ''}`
            : 'not answering ping';
        case 'reboot':      return 'recently rebooted';
        case 'watchdog':    return 'a status feed is unavailable or stale';
        default:            return alert.value != null ? `value ${alert.value}${unit}` : 'state changed';
    }
}

export function fmtDuration(sec: number | null | undefined): string {
    if (sec == null || sec < 0) return '-';
    const t = Math.round(sec);
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function varsFor(alert: Alert, event: AlertEvent): Record<string, string> {
    const now = Math.floor(Date.now() / 1000);
    const since = alert.raised_ts || alert.first_breach_ts || now;
    const label = alert.label || `${alert.host || ''} ${alert.kind}`.trim();
    // label is "<host> <metric name>"; metric is the name part alone.
    const metric = alert.host && label.startsWith(`${alert.host} `)
        ? label.slice(alert.host.length + 1) : label;
    return {
        label,
        host: alert.host || '',
        metric,
        kind: alert.kind,
        code: alert.code || '',
        value: alert.value == null ? '--' : String(alert.value),
        unit: alert.unit || '',
        threshold: alert.threshold == null ? '--' : String(alert.threshold),
        severity: alert.severity,
        event,
        // UTC with an explicit Z. The server has no reliable local-timezone
        // context, and UTC stays unambiguous across mail, syslog and ntfy. This
        // is the moment the notification is RENDERED, not the breach.
        time: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
        duration: fmtDuration((alert.cleared_ts || now) - since),
        detail: detailFor(alert),
        // Recovered reading for clear messages; empty (not "--") when the alarm
        // had no numeric value, so a device-down clear reads cleanly. Binary
        // state alarms skip it too - "(now 0)" adds nothing.
        reading: (alert.value == null || alert.kind === 'state')
            ? '' : ` (now ${alert.value}${alert.unit || ''})`,
    };
}

/**
 * Substitute `{{name}}` from `vars`.
 *
 * UNKNOWN NAMES RENDER AS THEMSELVES. That is deliberate and is the parent's
 * behaviour: a typo in a user-edited template shows up in the mail as
 * `{{hsot}}` rather than silently becoming an empty string, which is the
 * difference between a visible mistake and a notification that quietly says
 * less than it should.
 */
export function render(template: string, vars: Record<string, string>): string {
    return String(template).replace(
        /\{\{(\w+)\}\}/g,
        (whole, name: string) => (vars[name] !== undefined ? vars[name] : whole),
    );
}
