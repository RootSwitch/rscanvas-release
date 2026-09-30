// The thin client: session check, login, live tables on a 10s refresh.
// Everything it shows came through an authenticated /api route; this file
// holds no data and no rules, only rendering.
//
// The render primitives live in dom.js so the hostile round-trip test can
// exercise THE SAME CODE the browser runs rather than a re-implementation.

import { cell, pill, badge, dotCell, rowEl } from './dom.js';
import { parseHosts, parseDeviceFilter, deviceMatches } from './parse.js';
import * as Charts from './charts.js';

const $ = (id) => document.getElementById(id);

// WHAT THIS USER MAY DO, from the server (2026-09-25). /api/me and login
// carry `can`, the role's actions read from the same table authorize() uses,
// and every write control on the page names the action its route enforces
// in data-can. The page used to know only "admin or not", which hid
// operator controls from operators (untrack, mute) and showed viewers forms
// the server then refused (maintenance, grouping, transient, export). This
// is still not the access control - every route enforces - it is which
// doors are advertised. check-can-attrs.mjs refuses a data-can or can()
// naming an action the server does not have, because a typo here fails
// CLOSED and silently: the control just never appears. Declared first so
// nothing that runs during load can reach it before it exists.
let myCan = new Set();
const can = (action) => myCan.has(action);
/** data-can may name alternatives separated by spaces: shown if ANY is held. */
const canAny = (spec) => String(spec || '').split(/\s+/).filter(Boolean).some(can);

async function api(path, opts) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
    return { status: res.status, ...(await res.json()) };
}

function fmtAgo(iso) {
    if (!iso) return '';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 129600) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

/**
 * How long an alert was open, from raised to cleared.
 *
 * The information was always in the payload - both timestamps ride in
 * ALERT_COLUMNS - and reading it meant opening the drill-down one alert at a
 * time, which is the wrong shape for the question it answers. "Which of
 * these was a blip and which ran for six hours" is a scan across rows, not a
 * click into each.
 *
 * Coarse ON PURPOSE: seconds under two minutes, then minutes, hours, days.
 * The difference between 4h11m and 4h is not one anybody acts on, and the
 * extra digits cost the eye more than they inform it - the same rule fmtAgo
 * already follows.
 */
function fmtDuration(fromIso, toIso) {
    if (!fromIso || !toIso) return '';
    const s = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
    if (!Number.isFinite(s) || s < 0) return '';
    if (s < 120) return `${s}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    if (s < 172800) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

function fmtValue(v, unit) {
    if (v === null || v === undefined) return '';
    const n = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v;
    return `${n}${unit || ''}`;
}

// --- alerts -------------------------------------------------------------------
//
// The alert list is not a log. Every row is a piece of LIVE STATE with a
// machine behind it, and the machine has semantics the row has to carry
// honestly or the page is lying about the system it watches:
//
//   pending   has NOT raised and may never. Nobody was told. If the metric
//             goes normal the row is DELETED, not cleared - the incident
//             never happened, and history stays a record of real ones.
//   active    the null value. No badge, because a badge on every row teaches
//             the eye to skip the column.
//   clearing  on its way out. It has NOT cleared, and it can bounce back.
//   cleared   over, and in the lower table.
//
// THE BOUNCE IS THE HARD ONE, and it is what the counters are on screen for.
// A breach during `clearing` sends the row back to active, resets the clear
// counter, and emits NO EVENT - deliberately, because the raise was already
// sent and the incident never ended. So a bounce is invisible in the delivery
// log by design. The only place it can be seen is the clear counter going
// back to zero, which is why "clearing 2 of 3" is rendered rather than a bare
// word: an operator watching that number reset is watching the bounce happen.
//
// The denominators come from the SERVER, from the same config the scan reads.
// A page with `3` typed into it would go quietly wrong the day someone
// retunes it, and quietly is the bad part.

let alertData = { open: [], recentCleared: [], raiseScans: null, clearScans: null };
// Active and upcoming maintenance windows (slice 22), refreshed with the rest.
let maintData = [];
let currentAlert = null;

const ALERT_SCOPES = {
    open: () => true,
    crit: (a) => a.severity === 'crit',
    // A PENDING alert is not undelivered, it is not yet owed - nothing has
    // raised, so nothing was ever due to be sent. Counting it here would put
    // the scope out of step with the heading, which is exactly how the two
    // disagreed the first time this was looked at: "1 undelivered" over a
    // list of 2. Pending has its own scope; this one is for real debt.
    undelivered: (a) => a.state !== 'pending' && !a.notified_raise,
    pending: (a) => a.state === 'pending',
};

/** The progress a transitional state has made, or '' for a settled one. */
function stateProgress(a) {
    const { raiseScans, clearScans } = alertData;
    if (a.state === 'pending' && raiseScans) return `${a.breach_count} of ${raiseScans}`;
    if (a.state === 'clearing' && clearScans) return `${a.clear_count} of ${clearScans}`;
    return '';
}

/**
 * Delivery, which is NOT the same question as state. `notified_raise` is the
 * folded per-incident bit: it says the debt is settled, not that nothing ever
 * failed - an alert can read "sent" over a log holding three failures and a
 * success, and the log is the only place that history exists.
 *
 * `notify_attempts` IS NOT A LIFETIME TALLY. The store zeroes it on every
 * success, because it exists to drive the retry backoff and a settled debt
 * must not wait out a delay it never earned. So it is only meaningful while
 * something is OWED, where it counts consecutive failures - rendering it
 * beside "sent" would print 0 on every delivered alert and invite the reader
 * to think nothing was ever tried.
 */
function deliveryCell(a) {
    if (a.state === 'pending') return pill('not yet', 'badge');
    if (a.notified_raise) return pill('sent', 'badge ok');
    // Slice 22: withheld is not owed-and-failing, and the column must say
    // which it is. This marker is load-bearing - a suppressed alert that is
    // not visibly marked is the silent all-quiet the design refused.
    // Delivery resumes as "owed" the moment the window stops matching.
    if (a.in_maintenance) return pill('in maintenance', 'badge maint');
    // Slice 25: a standing policy, distinct from a window because the reader's
    // next question differs - "when does it end" versus "who declared this
    // group unpaged". Same marker discipline: withheld must be visible.
    if (a.under_policy) return pill('unpaged - policy', 'badge policy');
    // Slice 55: held under its group's alert, which names it. Same marker
    // discipline - withheld must be visible, and say by what.
    if (a.in_group) return pill('held - group alert', 'badge policy');
    return a.notify_attempts > 0
        ? pill(`owed (${a.notify_attempts} failed)`, 'badge owed')
        : pill('owed', 'badge owed');
}

function renderAlerts(data) {
    if (data !== null) alertData = data;
    if (currentDevice !== null) renderDeviceAlerts();
    const all = alertData.open || [];
    const scope = ALERT_SCOPES[$('alert-scope').value] || ALERT_SCOPES.open;
    const needle = $('alert-filter').value.trim().toLowerCase();
    const matches = (a) => needle === '' || (a.host || '').toLowerCase().includes(needle)
        || (a.kind || '').toLowerCase().includes(needle)
        || (a.label || '').toLowerCase().includes(needle);

    // Worst first, then oldest: 700 open alerts is a wall of text in any
    // order, but the top of THIS order is the thing to look at. Capped like
    // the roster, and it says so - see RENDER_CAP.
    const sev = { crit: 0, warn: 1 };
    const hits = all.filter((a) => scope(a) && matches(a));
    const open = [...hits].sort((x, y) =>
        (sev[x.severity] ?? 2) - (sev[y.severity] ?? 2)
        || Date.parse(x.raised_ts ?? x.first_breach_ts ?? 0)
         - Date.parse(y.raised_ts ?? y.first_breach_ts ?? 0)).slice(0, RENDER_CAP);

    const tbody = $('alerts').querySelector('tbody');
    tbody.replaceChildren();
    for (const a of open) {
        const val = cell(fmtValue(a.value, a.unit), 'num');
        if (a.severity === 'crit') val.classList.add('cell-crit');
        else if (a.severity === 'warn') val.classList.add('cell-warn');
        const progress = stateProgress(a);
        const row = rowEl([
            pill(a.severity, `sev ${a.severity}`),
            a.state === 'active' ? cell('')
                : pill(progress === '' ? a.state : `${a.state} ${progress}`, `sev ${a.state}`),
            cell(a.label),
            val,
            cell(fmtValue(a.peak_value, a.unit), 'num'),
            cell(fmtValue(a.threshold, a.unit), 'num'),
            // A pending alert has no raise time, and rendering first_breach_ts
            // in that column would claim it raised. Show the breach, labelled.
            cell(a.raised_ts ? fmtAgo(a.raised_ts) : `breach ${fmtAgo(a.first_breach_ts)}`),
            cell(fmtAgo(a.last_seen_ts)),
            deliveryCell(a),
        ]);
        row.className = 'clickable';
        if (a.in_maintenance || a.under_policy || a.in_group) row.classList.add('maint-row');
        row.addEventListener('click', () => showAlert(a.id));
        tbody.appendChild(row);
    }

    $('no-alerts').classList.toggle('hidden', all.length > 0);
    // COUNTS COME FROM THE WHOLE SET, THE LIST FROM A SLICE. When the server
    // capped the list it also sends the real totals, because these three
    // numbers are read as fact - and undelivered especially so: the heading
    // exists to make an alert nobody received impossible to miss, and a count
    // taken over a truncated list would understate exactly that.
    const capped = alertData.capped === true;
    const total = capped && typeof alertData.openTotal === 'number' ? alertData.openTotal : all.length;
    const crits = capped && typeof alertData.openCrits === 'number'
        ? alertData.openCrits : all.filter((a) => a.severity === 'crit').length;
    const owed = capped && typeof alertData.openOwed === 'number'
        ? alertData.openOwed : all.filter((a) => a.state !== 'pending' && !a.notified_raise).length;
    const counts = [`${total} open`, `${crits} crit`];
    // Undelivered is called out in the heading rather than left to be found
    // by scrolling: an alert nobody received is the one failure this page
    // exists to make impossible to miss.
    if (owed > 0) counts.push(`${owed} undelivered`);
    $('alert-counts').textContent = all.length === 0 ? '' : counts.join(', ');

    // The server orders worst-first before it cuts, so a capped list still
    // holds the crits - but it is a slice, and the filter only sees the slice.
    const sliced = capped ? ` - the server sent the worst ${all.length} of ${total},`
        + ' so the filter is incomplete' : '';
    const msg = (hits.length === 0 && all.length > 0 ? 'nothing matches that filter'
        : open.length < hits.length ? `showing the worst ${open.length} of ${hits.length} matching`
        : hits.length < all.length ? `${hits.length} of ${all.length} match` : '') + sliced;
    const el = $('alerts-msg');
    el.textContent = msg;
    el.classList.toggle('hidden', msg === '');

    // Flap radar (easy-win E11). An alert that raised and cleared five times
    // today never shows in "open" for long and each individual clear looks
    // like a success - the pattern only exists across rows, and the operator
    // who should tune this threshold or fix this device is the one who never
    // sees it. Cycles, not instances: the grouped count is the diagnosis.
    const fl = $('alert-flaps');
    fl.replaceChildren();
    const flaps = alertData.flaps || [];
    if (flaps.length > 0) {
        const head = document.createElement('div');
        head.className = 'muted';
        head.textContent = 'flapping in the last 24h - raise/clear cycles, worst first:';
        fl.appendChild(head);
        for (const f of flaps) {
            const d = document.createElement('div');
            d.textContent = `${f.label} - ${f.cycles} cycles`;
            d.className = 'error-text';
            fl.appendChild(d);
        }
    }
    fl.classList.toggle('hidden', flaps.length === 0);

    const ctbody = $('cleared').querySelector('tbody');
    ctbody.replaceChildren();
    for (const a of alertData.recentCleared || []) {
        const row = rowEl([
            pill(a.severity, 'sev cleared'),
            cell(a.label),
            cell(fmtValue(a.peak_value, a.unit), 'num'),
            cell(fmtDuration(a.raised_ts, a.cleared_ts), 'num'),
            cell(fmtAgo(a.cleared_ts)),
            cell(a.clear_reason, 'muted'),
        ]);
        row.className = 'clickable';
        row.addEventListener('click', () => showAlert(a.id));
        ctbody.appendChild(row);
    }
}

/** One labelled line in the detail panel, textContent only. */
function factLine(label, value) {
    const d = document.createElement('div');
    const k = document.createElement('span');
    k.className = 'muted';
    k.textContent = `${label}: `;
    const v = document.createElement('span');
    v.textContent = value;
    d.append(k, v);
    return d;
}

function renderAlertDetail(a, history) {
    $('alert-title').textContent = a.label;
    $('alert-sub').textContent = `${a.severity} - ${a.state}`;

    const facts = $('alert-facts');
    facts.replaceChildren();
    if (a.host) {
        // a.host carries the device NAME for every scan-fed kind (the scan
        // builds conditions with host: device.name); watchdog alerts carry
        // null and stay plain text. showDevice answers a deleted device with
        // its own error line, so the link is safe to render unconditionally.
        const d = factLine('device', '');
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = a.host;
        link.title = 'open device details - untrack interfaces or sensors from there';
        link.addEventListener('click', (ev) => {
            ev.preventDefault();
            showSection('devices');
            showDevice(a.host);
        });
        d.lastChild.appendChild(link);
        facts.appendChild(d);
    } else {
        facts.appendChild(factLine('device', '(none)'));
    }
    facts.appendChild(factLine('kind', a.kind + (a.code ? ` / ${a.code}` : '')));
    // Not every alert has a number. A reachability alert is a fact, not a
    // measurement, and the whole line is omitted rather than rendered as
    // "value:  against" - a label with nothing after it reads as a bug in
    // the page, which is a bad way to say "this kind has no threshold".
    if (a.value !== null || a.threshold !== null) {
        facts.appendChild(factLine('value',
            (a.value !== null ? fmtValue(a.value, a.unit) : 'unknown')
            + (a.threshold !== null ? ` against ${fmtValue(a.threshold, a.unit)}` : '')
            + (a.peak_value !== null ? `, peak ${fmtValue(a.peak_value, a.unit)}` : '')));
    }
    // PROVENANCE, resolved by the server through the scan's own resolver:
    // which tier answers for this threshold TODAY. The stored threshold is
    // what fired (frozen); when someone has moved it since, both numbers are
    // shown rather than letting the page imply the alert fired against the
    // current value. Muted is called out in words because its consequence
    // (the alert will age out as source-removed) is invisible otherwise.
    if (a.threshold_source) {
        const label = a.threshold_source === 'override' ? 'per-entity override'
            : a.threshold_source === 'host override' ? 'host override'
                : a.threshold_source === 'kind override' ? 'kind override'
                    : a.threshold_source === 'default' ? 'built-in default' : a.threshold_source;
        let txt = label;
        if (a.threshold_muted) {
            txt += ' - MUTED now, so this alert gets no more readings and will clear as source-removed';
        } else if (a.threshold_now !== null && a.threshold_now !== undefined
            && a.threshold !== null && a.threshold_now !== a.threshold) {
            txt += ` - now ${fmtValue(a.threshold_now, a.unit)}, was ${fmtValue(a.threshold, a.unit)} when this fired`;
        }
        // if-down is a yes/no rule with no threshold to have set.
        facts.appendChild(factLine(a.kind === 'if-down' ? 'rule set by' : 'threshold set by', txt));
    }
    // MUTE FROM HERE (operator, 2026-09-23: the Alerts page was where they
    // looked for it, and found only the event rules, which are about syslog).
    // Offered on alerts that carry a per-entity rule the scan evaluates:
    // interface and sensor alerts. device-down keys by host and has the
    // transient declaration as its lever; event alerts belong to their rule.
    // Code scope only - the wider scopes live on the device page's gears.
    detailAlert = a;
    {
        const mb = $('alert-mute');
        const mutable = can('alertrule.write') && !!a.code && a.kind !== 'device-down' && a.kind !== 'event'
            && a.state !== 'cleared' && !a.threshold_muted;
        mb.classList.toggle('hidden', !mutable);
        if (mutable) {
            const on = String(a.kind).startsWith('if-') ? 'this interface' : 'this sensor';
            mb.textContent = `Mute ${a.kind === 'if-down' ? 'link-down' : a.kind} alerts on ${on}`;
            mb.title = 'Suspend this one rule for this one interface or sensor. Polling and history continue, '
                + 'this alert clears as source-removed within a few scans, and the device page shows the mute and undoes it.';
        }
    }
    // The wedge, said out loud (easy-win E8). Clearing is judged against the
    // stored threshold - the one this incident crossed - so raising the
    // effective threshold above it leaves a band where the value is normal by
    // today's rule yet never clears the alert. The operator who raised the
    // threshold to silence this exact alert is the person reading this line.
    if (a.held_by_stale_band) {
        const d = factLine('warning',
            'the threshold was RAISED after this fired, and clearing is still judged'
            + ' against the old stored value - a reading that is normal under the new'
            + ' threshold can hold this alert open indefinitely. To release it, mute'
            + ' the threshold briefly (the alert clears as source-removed) and unmute;'
            + ' it will not re-raise unless the NEW threshold is crossed.');
        d.className = 'error-text';
        facts.appendChild(d);
    }
    // THE LAPTOP-OR-UPS HINT. A state sensor reading 1 is crit by default,
    // which is right for a UPS on battery and wrong for an undocked laptop -
    // and in the feed those are the same device. The machine says what it
    // noticed; the operator decides what it means. Nothing is suppressed:
    // the alert raised, it is on this page, and the hint sits next to the
    // control that acts on it rather than in place of the alarm.
    if (a.battery_host) {
        const d = factLine('note',
            'this device reports BOTH a battery and a filesystem - a laptop on battery'
            + ' and a server backed by a UPS look identical here. If it is a laptop, mute'
            + ' state for this device from its sensor card. If it is UPS-backed, this is'
            + ' the alert you want.');
        d.className = 'hint';
        facts.appendChild(d);
    }
    // Slice 22: the alert is recorded and shown; only delivery waits.
    if (a.in_maintenance) {
        const d = factLine('maintenance',
            'inside an active maintenance window - this alert is recorded and'
            + ' visible but not delivered. If it is still active when the window'
            + ' ends, delivery happens on the next pass.');
        d.className = 'hint';
        facts.appendChild(d);
    }
    // Slice 25: the standing sibling. No end time to promise, so the line
    // says what lifts it instead.
    if (a.under_policy) {
        const d = factLine('policy',
            'covered by a standing notify policy - this alert is recorded and'
            + ' visible but never delivered while the policy stands. Dropping'
            + ' the policy (System > Notify policies) delivers anything still'
            + ' active on the next pass.');
        d.className = 'hint';
        facts.appendChild(d);
    }
    // Slice 55: a member held under its group's alert.
    if (a.in_group) {
        const d = factLine('group',
            'its location or application has an open group alert - this alert is recorded'
            + ' and visible, and its email is held: the group\'s email names it. If it is'
            + ' still down when the group alert clears, it is emailed then.');
        d.className = 'hint';
        facts.appendChild(d);
    }
    // A group alert names its members as they stand now; the down ones open
    // their device page.
    if (a.group) {
        const members = a.group.members || [];
        const down = members.filter((m) => m.status === 'down');
        const known = members.filter((m) => m.status === 'up' || m.status === 'down').length;
        facts.appendChild(factLine(a.group.axis,
            `${a.group.value} - ${down.length} of ${known} down now; trips at ${a.threshold}%`
            + ` and ${a.group.minDown ?? '?'} down`));
        if (down.length > 0) {
            const line = factLine('down now', '');
            const v = line.lastChild;
            down.forEach((m, i) => {
                if (i > 0) v.appendChild(document.createTextNode(', '));
                const link = document.createElement('a');
                link.href = '#';
                link.textContent = m.name;
                link.addEventListener('click', (ev) => { ev.preventDefault(); showSection('devices'); showDevice(m.name); });
                v.appendChild(link);
            });
            facts.appendChild(line);
        }
    }
    facts.appendChild(factLine('first breach', fmtAgo(a.first_breach_ts)));
    facts.appendChild(factLine('raised',
        a.raised_ts ? fmtAgo(a.raised_ts) : 'never - still pending, nobody has been told'));
    if (a.cleared_ts) facts.appendChild(factLine('cleared', `${fmtAgo(a.cleared_ts)} (${a.clear_reason})`));
    facts.appendChild(factLine('last seen', fmtAgo(a.last_seen_ts)));

    // The counters, with what they COUNT. `clear_count` back at 0 on an alert
    // that has been open for hours is the bounce, and this is the only place
    // it shows - see the note at the top of this section.
    const { raiseScans, clearScans } = alertData;
    facts.appendChild(factLine('scans',
        `${a.breach_count} breaching`
        + (a.state === 'pending' && raiseScans ? ` of ${raiseScans} needed to raise` : '')
        + `, ${a.clear_count} consecutive normal`
        + (clearScans ? ` of ${clearScans} needed to clear` : '')
        + (a.missing_count > 0 ? `, ${a.missing_count} scans with no reading at all` : '')));
    // THE NOTE BELONGS ON `clearing`, AND ONLY THERE.
    //
    // The first version put it on any active alert with clear_count 0 and
    // called that a bounce. It is not: 0 is what an active alert carries
    // normally, from the moment it raises until it first goes quiet. That
    // rendering asserted a bounce had happened on every ordinary alert on
    // the page - the page inventing an event the machine never recorded.
    //
    // A bounce genuinely CANNOT be recovered from the row: it leaves no
    // event by design, and it resets the counter to the same 0 a
    // never-cleared alert already has. So the honest thing is to say what
    // WILL happen to the alert in front of you, on the one state where it
    // can happen, and let the operator watching the counter see it.
    if (a.state === 'clearing') {
        facts.appendChild(factLine('note',
            'if this breaches again before it clears it goes straight back to '
            + 'active and the clear counter restarts, with no event sent - the '
            + 'raise already went out and the incident never ended, so a bounce '
            + 'shows here as the counter resetting and never in the log below'));
    }
    if (a.acked_ts) facts.appendChild(factLine('acknowledged', fmtAgo(a.acked_ts)));
    facts.appendChild(factLine('delivery',
        (a.state === 'pending' ? 'nothing owed yet - has not raised'
            : a.notified_raise ? 'raise settled' : 'raise OWED')
        + (a.cleared_ts ? (a.notified_clear ? ', clear settled' : ', clear OWED') : '')
        // Only while owed: the counter is zeroed on success, so beside a
        // settled debt it would always read zero and mean nothing.
        + (!a.notified_raise && a.notify_attempts > 0
            ? `, ${a.notify_attempts} consecutive failure(s) driving the retry backoff` : '')
        + (a.last_attempt_ts ? `, last attempt ${fmtAgo(a.last_attempt_ts)}` : '')
        + (a.renotified_ts ? `, renotified ${fmtAgo(a.renotified_ts)}` : '')));

    const tbody = $('alert-history').querySelector('tbody');
    tbody.replaceChildren();
    for (const h of history) {
        tbody.appendChild(rowEl([
            cell(fmtAgo(h.ts)),
            cell(h.event),
            cell(h.channel),
            pill(h.ok ? 'ok' : 'failed', h.ok ? 'badge ok' : 'badge owed'),
            cell(h.detail || '', 'muted'),
        ]));
    }
    const empty = history.length === 0;
    $('alert-history').classList.toggle('hidden', empty);
    $('no-history').classList.toggle('hidden', !empty);
    // An empty log has several very different causes and the operator needs
    // to know which: nothing was ever owed, or nothing has been sent yet.
    // FOUR causes, not two. The first version enumerated two and asserted the
    // wrong one for everything else: an alert whose raise was WITHHELD read
    // "no channel was enabled ... so nothing was owed" directly beneath a
    // badge reading "raise OWED". Caught on the operator's live maintenance
    // window drill. The log cannot see channels - it can only see whether a
    // debt stands - so it must not name a cause it has no way to know.
    $('no-history').textContent = empty
        ? (a.state === 'pending'
            ? 'nothing sent - this alert has not raised yet'
            : !a.notified_raise
                ? (a.in_maintenance
                    ? 'nothing sent yet - the raise is owed and withheld by the maintenance '
                        + 'window above; it goes out on the first pass after the window ends'
                    : a.under_policy
                        ? 'nothing sent yet - the raise is owed and withheld by the standing '
                            + 'policy above; dropping the policy delivers it on the next pass'
                        : 'nothing sent yet - the raise is owed and goes out on the next delivery pass')
                : 'nothing sent - no channel was enabled when this raised, so nothing was owed')
        : '';
    // Said as "every attempt ever" to separate it from the row's counter
    // above, which is consecutive failures and resets on success.
    $('alert-history-note').textContent = history.length > 0
        ? `every attempt on this incident, newest first (${history.length})` : '';
}

async function showAlert(id) {
    currentAlert = id;
    $('alerts-panel').classList.add('hidden');
    $('alert-panel').classList.remove('hidden');
    $('alert-title').textContent = 'loading...';
    $('alert-sub').textContent = '';
    $('alert-facts').replaceChildren();
    $('alert-history').querySelector('tbody').replaceChildren();
    $('alert-mute').classList.add('hidden');
    $('alert-mute-msg').textContent = '';
    const r = await api(`/api/alert?id=${encodeURIComponent(id)}`);
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) {
        $('alert-title').textContent = 'could not load';
        $('alert-sub').textContent = r.detail || `(${r.status})`;
        return;
    }
    renderAlertDetail(r.alert, r.history || []);
}

function showAlertList() {
    currentAlert = null;
    $('alert-panel').classList.add('hidden');
    $('alerts-panel').classList.remove('hidden');
}

$('alert-back').addEventListener('click', showAlertList);
// From a device page with more alerts than it shows: the Alerts page, filtered
// to the device's name, every open alert.
$('device-alerts-all').addEventListener('click', () => {
    if (currentDevice === null) return;
    $('alert-filter').value = currentDevice;
    $('alert-scope').value = 'open';
    showAlertList();
    showSection('alerts');
    renderAlerts(null);
});
// The alert the detail panel last rendered, for the mute button's handler:
// renderAlertDetail runs on every refresh, the listener is wired once.
let detailAlert = null;
$('alert-mute').addEventListener('click', async () => {
    const a = detailAlert;
    if (!a || !a.code) return;
    const r = await saveThreshold({
        kind: a.kind, host: null, code: a.code, warn: null, crit: null, enabled: false,
        note: `muted from alert ${a.id}`,
    });
    $('alert-mute-msg').textContent = r.ok
        ? `${r.detail}. This alert clears as source-removed within a few scans; unmute from the device page.`
        : (r.detail || `refused (${r.status})`);
    if (!r.ok) return;
    const id = currentAlert;
    const d = await api(`/api/alert?id=${encodeURIComponent(id)}`);
    if (d.ok && currentAlert === id) renderAlertDetail(d.alert, d.history || []);
});
$('alert-filter').addEventListener('input', () => renderAlerts(null));
$('alert-scope').addEventListener('change', () => renderAlerts(null));

// --- event rules (slice 10) ---------------------------------------------------

/** Fetch and render the rules (System tab since 2026-09-25). Operators read
 *  the list (alertrule.read); the enable and delete buttons, like the add
 *  row, are built only for a role that may write rules. The API enforces
 *  regardless - this is which doors are advertised. */
async function loadEventRules() {
    const r = await api('/api/alert-rules');
    if (!r.ok) return;
    const rules = r.rules || [];
    const armed = rules.filter((x) => x.enabled).length;
    $('rules-sub').textContent = rules.length === 0 ? 'none yet'
        : `${rules.length} rule(s), ${armed} enabled`;
    const tbody = $('rules-table').querySelector('tbody');
    tbody.replaceChildren();
    for (const rule of rules) {
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'delete';
        del.addEventListener('click', async () => {
            const res = await api('/api/alert-rules/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: rule.id }),
            });
            $('rules-msg').textContent = res.ok
                ? `deleted ${rule.name} - an open alert from it clears on the default TTL`
                : (res.detail || 'delete failed');
            loadEventRules();
        });
        const en = document.createElement('button');
        en.type = 'button';
        en.textContent = rule.enabled ? 'disable' : 'enable';
        en.addEventListener('click', async () => {
            await api('/api/alert-rules/enable', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
            });
            loadEventRules();
        });
        const actions = document.createElement('td');
        if (can('alertrule.write')) actions.append(en, document.createTextNode(' '), del);

        // "enabled: yes" and "matching nothing" can both be true: the
        // ingest worker disarms a rule whose regex blows the step budget,
        // and until easy-win E7 that fact was a counter on the health page
        // with no name attached. The badge puts the verdict on the row
        // that earned it, next to the enabled flag it contradicts.
        const disarmed = (lastHealth?.ingest?.disarmedRuleIds ?? [])
            .some((id) => String(id) === String(rule.id));
        const enCell = cell(rule.enabled ? 'yes' : 'no', rule.enabled ? '' : 'muted');
        if (disarmed) {
            enCell.appendChild(document.createTextNode(' '));
            enCell.appendChild(badge('DISARMED', 'badge fail'));
            enCell.title = 'the ingest worker stopped running this pattern - it took too long on a single message; editing the pattern is what rearms it';
        }
        const tr = rowEl([
            cell(rule.name),
            cell(rule.pattern + (rule.is_regex ? '  (regex)' : ''), 'muted'),
            cell(rule.source),
            pill(rule.severity, `sev ${rule.severity}`),
            cell(`${rule.clear_after_s}s`, 'num'),
            enCell,
        ]);
        tr.appendChild(actions);
        tbody.appendChild(tr);
    }
}

$('rule-add').addEventListener('click', async () => {
    const r = await api('/api/alert-rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: $('rule-name').value.trim(),
            pattern: $('rule-pattern').value,
            isRegex: $('rule-regex').checked,
            source: $('rule-source').value,
            severity: $('rule-severity').value,
            clearAfterS: Number($('rule-ttl').value) || 300,
        }),
    });
    // The server's refusal is the message - a broken regex comes back with
    // the compiler's own words, which beats anything recomposed here.
    $('rules-msg').textContent = r.ok ? 'rule armed - matching starts within 30s' : (r.detail || 'refused');
    if (r.ok) { $('rule-name').value = ''; $('rule-pattern').value = ''; }
    loadEventRules();
});

/**
 * The reachability lane (slice 9): the newest transitions, fleet-wide.
 *
 * An empty lane is a STATEMENT, not an absence - a fleet that holds its
 * state writes no events, and the all-quiet line says so the same way the
 * alerts table's does. Volume is bounded by flapping by design
 * (SLICE-9-PLAN), so this table never needs paging to stay honest; the
 * server caps at 100 and the newest are what an operator scans for.
 */
function renderReachEvents(data) {
    const events = data.events || [];
    const tbody = $('reach-events').querySelector('tbody');
    tbody.replaceChildren();
    for (const e of events) {
        const to = pill(e.to_state,
            `badge ${e.to_state === 'down' ? 'fail' : e.to_state === 'degraded' ? 'warn' : e.to_state === 'up' ? 'ok' : ''}`);
        // The transition reads as a sentence fragment: "unknown, now down".
        to.prepend(document.createTextNode(`${e.from_state} → `));
        tbody.appendChild(rowEl([
            cell(fmtAgo(e.ts)),
            cell(e.name),
            to,
            cell(e.rtt_ms === null ? '' : String(e.rtt_ms), 'num'),
        ]));
    }
    $('reach-events').classList.toggle('hidden', events.length === 0);
    $('no-reach-events').classList.toggle('hidden', events.length !== 0);
    $('reach-counts').textContent = events.length === 0 ? ''
        : `${events.length}${events.length === 100 ? ' (newest 100)' : ''}`;
}

// --- the roster ---------------------------------------------------------------
//
// 400 devices on one pane is not a page, it is a wall of text - and the fleet
// this is developed against has 450. Three things make it readable, and none
// of them is a scrollbar:
//
//   SORT DEFAULTS TO PROBLEMS FIRST. The operator's question is almost never
//   "list my estate", it is "what is wrong". Alphabetical order answers the
//   question nobody asked and buries the answer to the real one at position
//   270. Down devices, then worst severity, then alert count.
//
//   FILTER IS THE ANSWER TO SCALE, not paging. Paging makes you visit 5 pages
//   to find one device; a filter box finds it in four keystrokes. Paging is
//   still owed for the case where the FILTERED set is large (see RENDER_CAP).
//
//   THE RENDER IS CAPPED AND SAYS SO. Rule 3 - no unbounded result sets -
//   applies to the DOM as much as to SQL: 400 rows is survivable, 30,000
//   entities at the design ceiling is not, and a page that quietly renders
//   whatever it is given fails at exactly the scale the fork exists for. The
//   cap is stated in the UI rather than silently truncating, because a
//   truncated list that looks complete is the same lie as a stale reading
//   that looks fresh.

/**
 * Has anything actually MEASURED this device's state yet? (2026-08-31, from
 * the operator adding three ping targets and watching them sit at "pending"
 * while the reachability feed showed all three up.)
 *
 * ONE RULE, TWO POPULATIONS, and the roster had only the first:
 *   * a polled device is undetermined until its first poll;
 *   * a PING-ONLY device (slice 35) has no poll to wait for - the due query
 *     carries `AND snmp_enabled = true`, so `last_poll_ts` stays NULL for the
 *     rest of its life. Asking the poll question about it does not return
 *     "not yet", it returns "never", and the roster said `pending` forever.
 *
 * This is the same predicate the WALL already uses server-side, where slice
 * 35 got it right and wrote down why: "a ping-only device has no poll to be
 * old, so its freshness is whether reach has ever been determined. Keeping
 * the poll rule would have dimmed every external service permanently."
 * (ops.ts, boardProjection). The rule existed, in SQL, and the client never
 * learned it - the same shape as the reach_check dispatch and the env-ref
 * allowlist, both found in the same week.
 */
function notYetMeasured(d) {
    return d.snmp_enabled === false ? d.reach_state === 'unknown' : !d.last_poll_ts;
}

const RENDER_CAP = 100;

// Sort keys are CODE-controlled: the header's data-sort attribute names one of
// these, and anything else is ignored. A comparator chosen by arbitrary
// user-supplied text would be a small injection surface for no benefit.
const REACH_RANK = { down: 0, degraded: 1, unknown: 2, up: 3 };

/**
 * An address sorted as TEXT puts 10.0.0.10 before 10.0.0.2 and .100 before .2,
 * which is the single most reliable way to make a network tool feel like it was
 * written by someone who has never looked at a subnet. Packed into one integer
 * so the comparison is arithmetic on the octets rather than string order.
 *
 * Returns null for anything that is not dotted-quad - IPv6, or a hostname -
 * and those sort AFTER every v4 address, among themselves by text. Guessing at
 * an ordering across the two families would be inventing one.
 */
function ipKey(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s ?? ''));
    if (m === null) return null;
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

const DEVICE_SORTS = {
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
    host: (a, b) => {
        const x = ipKey(a.host), y = ipKey(b.host);
        if (x !== null && y !== null) return x - y;
        if (x !== null) return -1;
        if (y !== null) return 1;
        return String(a.host).localeCompare(String(b.host));
    },
    status: (a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)),
    entities: (a, b) => (b.tracked_ifs ?? b.entities ?? 0) - (a.tracked_ifs ?? a.entities ?? 0),
    tracked_sensors: (a, b) => (b.tracked_sensors ?? 0) - (a.tracked_sensors ?? 0),
    open_alerts: (a, b) => (b.open_alerts ?? 0) - (a.open_alerts ?? 0),
    last_poll_ts: (a, b) => Date.parse(b.last_poll_ts ?? 0) - Date.parse(a.last_poll_ts ?? 0),
    last_seen_ts: (a, b) => Date.parse(b.last_seen_ts ?? 0) - Date.parse(a.last_seen_ts ?? 0),
    // Ungrouped devices sort LAST rather than first. Sorting by an optional
    // field is usually somebody asking "what is at HQ" - and a wall of blanks
    // at the top answers a question nobody asked while burying the one they
    // did. The untagged are still reachable: they are at the bottom, and the
    // count in the heading says how many there are.
    location: (a, b) => String(a.location ?? '\uffff').localeCompare(String(b.location ?? '\uffff')),
    // `reach` and `application` live at the BOTTOM of this table. Each was
    // defined here too until 2026-09-01: JavaScript keeps whichever copy
    // comes last, the two `reach` comparators disagreed about where a
    // missing reach_state sorts (rank 2 here, rank 9 there), and every edit
    // to the copies here changed nothing while looking like it did.
    // check-dupe-keys.mjs now refuses the shape tree-wide.
    // Slowest first for the latency columns; unmeasured sorts last.
    ping_rtt_ms: (a, b) => (b.ping_rtt_ms ?? -1) - (a.ping_rtt_ms ?? -1),
    poll_lag_ms: (a, b) => (b.poll_lag_ms ?? -1) - (a.poll_lag_ms ?? -1),
    poll_interval_s: (a, b) => (a.poll_interval_s ?? 0) - (b.poll_interval_s ?? 0),
    credential_ref: (a, b) => String(a.credential_ref ?? '').localeCompare(String(b.credential_ref ?? '')),
    cpu_pct: (a, b) => (b.cpu_pct ?? -1) - (a.cpu_pct ?? -1),
    mem_pct: (a, b) => (b.mem_pct ?? -1) - (a.mem_pct ?? -1),
    fs_pct: (a, b) => (b.fs_pct ?? -1) - (a.fs_pct ?? -1),
    temp_c: (a, b) => (b.temp_c ?? -1e9) - (a.temp_c ?? -1e9),
    down_ports: (a, b) => (b.down_ports ?? 0) - (a.down_ports ?? 0) || String(a.name).localeCompare(String(b.name)),
    if_errs: (a, b) => (b.if_errs ?? -1) - (a.if_errs ?? -1),
    top_bps: (a, b) => (b.top_bps ?? -1) - (a.top_bps ?? -1),
    alarms: (a, b) => (b.alarms ?? 0) - (a.alarms ?? 0) || (b.state_sensors ?? 0) - (a.state_sensors ?? 0),
    batt_pct: (a, b) => (a.batt_pct ?? 1e9) - (b.batt_pct ?? 1e9),   // LOWEST charge first: that is the one to look at
    sys_descr: (a, b) => String(a.sys_descr ?? '\uffff').localeCompare(String(b.sys_descr ?? '\uffff')),
    cpu_model: (a, b) => String(a.cpu_model ?? '\uffff').localeCompare(String(b.cpu_model ?? '\uffff')),
    // Shortest uptime first: the recently rebooted are the ones to look at.
    uptime_s: (a, b) => (a.uptime_s ?? 1e15) - (b.uptime_s ?? 1e15),
    cpu_cores: (a, b) => (b.cpu_cores ?? -1) - (a.cpu_cores ?? -1),
    ram_kb: (a, b) => (b.ram_kb ?? -1) - (a.ram_kb ?? -1)
        || String(a.name).localeCompare(String(b.name)),
    // Worst reach first: down beats degraded beats unknown beats up. The
    // click that sorts this column is somebody asking "what can I not
    // reach", so up rows - the overwhelming majority - go last.
    reach: (a, b) => (REACH_RANK[a.reach_state] ?? 9) - (REACH_RANK[b.reach_state] ?? 9)
        || String(a.name).localeCompare(String(b.name)),
    application: (a, b) => String(a.application ?? '\uffff').localeCompare(String(b.application ?? '\uffff'))
        || String(a.name).localeCompare(String(b.name)),
};

// --- bulk removal from the roster --------------------------------------------
//
// THE FILTER PROPOSES; THE LIST EXECUTES. Selecting is done through the
// roster's filter because that is how a human finds forty switches - but what
// leaves this page is an explicit set of NAMES, and the server echoes them
// back. A filter that matched more than the operator believed is how you
// remove the wrong forty, which is the same reasoning drop_partitions_guarded
// and sync-lab.sh already live by.
//
// The selection is kept in a Set outside the render, so it survives the ten
// second refresh. A checkbox that clears itself while you are still choosing
// is how somebody ends up confirming a different set than the one they built.
const selected = new Set();

function renderSelection() {
    const n = selected.size;
    $('roster-actions').classList.toggle('hidden', n === 0);
    $('roster-selected').textContent = n === 0 ? ''
        : `${n} selected: ${[...selected].slice(0, 6).join(', ')}${n > 6 ? `, and ${n - 6} more` : ''}`;
    if (n === 0) $('roster-gate').classList.add('hidden');
}

/**
 * One gate, and the server writes its sentence.
 *
 * The client does NOT compose this from parts - it renders what came back.
 * That is the U2 lesson: a gate that renders "?" because the client guessed at
 * the shape is worse than no gate, and the server is the only side that knows
 * how many interfaces and board shapes are involved.
 */
async function removeSelected(mode, confirmCount, confirmed = false) {
    const names = [...selected];
    const body = { names, mode };
    // CONFIRMED IS ITS OWN ARGUMENT, and it has to be.
    //
    // This read `else if (mode !== 'delete')`, which made the gate
    // UNSATISFIABLE for a small delete: below the typed-confirmation
    // threshold of 20 there is no number to send, so confirmCount stayed
    // undefined, the mode WAS delete, and `confirm` was never set. Clicking
    // "Delete them" re-sent the identical request, the server returned
    // confirmation-required again, and the gate re-rendered - a closed loop
    // that looks exactly like a dead button. Delete worked above 20 devices
    // and could not be completed below it.
    //
    // A count is not a confirmation. Conflating them meant the only path that
    // set `confirm` was the one that happened to carry a number.
    if (confirmCount !== undefined) { body.confirm = true; body.confirmCount = confirmCount; }
    else if (confirmed || mode !== 'delete') { body.confirm = true; }

    const r = await api('/api/devices/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(); return; }

    const gate = $('roster-gate');
    gate.replaceChildren();
    gate.classList.remove('hidden');

    if (r.reason === 'confirmation-required' || r.reason === 'typed-confirmation-required') {
        gate.appendChild(factLine('this will', r.detail));
        const row = document.createElement('div');
        row.className = 'row';
        // Typed confirmation above the threshold. A click can become reflex;
        // typing the number cannot, and it forces the operator to have READ
        // the count the gate computed - which is why it was computed.
        let typed = null;
        if (r.typedConfirmation) {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.size = 6;
            inp.placeholder = String(r.typedConfirmation);
            row.appendChild(document.createTextNode(`type ${r.typedConfirmation} to confirm: `));
            row.appendChild(inp);
            typed = inp;
        }
        const go = document.createElement('button');
        go.className = 'btn-primary';
        go.textContent = mode === 'delete' ? 'Delete them' : 'Confirm';
        go.addEventListener('click', () => {
            // The third argument is the click itself. Without it a delete
            // below the typed threshold has no way to say "yes" at all.
            removeSelected(mode, typed === null ? undefined : Number(typed.value), true);
        });
        row.appendChild(go);
        gate.appendChild(row);
        return;
    }

    gate.appendChild(factLine(r.ok ? 'done' : 'refused',
        r.ok ? `${r.mode}: ${r.affected.length} device(s)`
             + (r.missing?.length ? `, ${r.missing.length} name(s) matched nothing` : '')
             : (r.detail || `(${r.status})`)));
    if (r.ok) {
        selected.clear();
        renderSelection();
        const d = await api('/api/devices');
        if (d.ok) renderDevices(d);
        gate.classList.remove('hidden');
    }
}

// Re-probe devices that already exist, and REPORT WHAT MOVED. A rediscover
// that says "done" leaves the operator to go and check whether anything
// happened, which for a policy change across 450 devices is not a check
// anybody performs - so every entity whose tracking changed is named.
async function rediscoverSelected(retrack) {
    const names = [...selected];
    if (names.length === 0) return;
    const gate = $('roster-gate');
    gate.replaceChildren();
    gate.classList.remove('hidden');
    gate.appendChild(factLine('rediscovering', `${names.length} device(s)${retrack ? ', resetting tracking to defaults' : ''}...`));

    const r = await api('/api/devices/rediscover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, retrack }),
    });
    if (r.status === 401) { showLogin(); return; }

    gate.replaceChildren();
    if (!r.ok) {
        gate.appendChild(factLine('refused', r.detail || `http ${r.status}`));
        return;
    }
    for (const d of r.devices || []) {
        if (!d.ok) { gate.appendChild(factLine(d.name, `could not probe - ${d.detail}`)); continue; }
        const bits = [`${d.seen} entities seen, ${d.trackedNow} tracked by policy`];
        if (d.added?.length) bits.push(`added ${d.added.length}: ${d.added.slice(0, 6).join(', ')}`);
        if (d.stoppedTracking?.length) {
            bits.push(`stopped tracking ${d.stoppedTracking.length}: ${d.stoppedTracking.slice(0, 8).join(', ')}`);
        }
        if (d.startedTracking?.length) {
            bits.push(`started tracking ${d.startedTracking.length}: ${d.startedTracking.slice(0, 8).join(', ')}`);
        }
        gate.appendChild(factLine(d.name, bits.join(' - ')));
    }
    for (const m of r.missing || []) gate.appendChild(factLine(m, 'no such device'));
    const d2 = await api('/api/devices');
    if (d2.ok) renderDevices(d2);
}

// Point the selection at a credential, all at once. The route checks the
// name resolves and refuses if not - that refusal is rendered as a question
// with a "do it anyway" rather than a wall, because "I am about to create
// that profile" is a legitimate order of operations.
async function setCredentialSelected(force) {
    const names = [...selected];
    const ref = $('roster-cred').value.trim();
    if (names.length === 0 || ref === '') return;
    const gate = $('roster-gate');
    gate.replaceChildren();
    gate.classList.remove('hidden');
    const r = await api('/api/devices/credential', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, credentialRef: ref, force: force === true }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (r.reason === 'unresolvable') {
        gate.appendChild(factLine('not found', r.detail));
        const row = document.createElement('div'); row.className = 'row';
        const go = document.createElement('button');
        go.textContent = 'Point them anyway'; go.className = 'btn-primary';
        go.addEventListener('click', () => setCredentialSelected(true));
        row.appendChild(go); gate.appendChild(row);
        return;
    }
    gate.appendChild(factLine(r.ok ? 'done' : 'refused', r.detail || `(${r.status})`));
    if (r.ok) {
        // Load the credentials list if the picker has not been filled yet, so
        // the next use offers names. Cheap, admin-only, and cached after.
        if (lastCredentials === null) api('/api/credentials').then((d) => { if (d.ok) renderCredentials(d); });
        const d = await api('/api/devices'); if (d.ok) renderDevices(d);
    }
}

// Slice 30: transient for the SELECTION. A gaming parlor is declared as a
// set, and the operator had to open six device pages to flip one boolean
// six times. The per-device checkbox stays - it is where the decision gets
// made while looking at one machine - and this is the same decision made
// about a group the operator has already selected.
async function setTransientSelected(transient) {
    const names = [...selected];
    if (names.length === 0) return;
    const gate = $('roster-gate');
    gate.replaceChildren();
    gate.classList.remove('hidden');
    const r = await api('/api/devices/transient', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, transient }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) {
        gate.appendChild(factLine('refused', r.detail || `http ${r.status}`));
        return;
    }
    const n = (r.changed || []).length;
    gate.appendChild(factLine(transient ? 'transient' : 'not transient',
        transient
            ? `${n} device(s) declared transient - device-down no longer raises for them, `
                + 'and any open one clears on the next scan'
            : `${n} device(s) back to normal - device-down raises for them again`));
    const d = await api('/api/devices');
    if (d.ok) renderDevices(d);
}
$('roster-transient').addEventListener('click', () => setTransientSelected(true));
$('roster-untransient').addEventListener('click', () => setTransientSelected(false));

// Slice 54: mute for the selection - the device page's toggle, made about a
// set the operator has already chosen. Same route, same audit.
async function setMutedSelected(muted) {
    const names = [...selected];
    if (names.length === 0) return;
    const gate = $('roster-gate');
    gate.replaceChildren();
    gate.classList.remove('hidden');
    const r = await api('/api/devices/mute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, muted }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) {
        gate.appendChild(factLine('refused', r.detail || `http ${r.status}`));
        return;
    }
    const n = (r.changed || []).length;
    gate.appendChild(factLine(muted ? 'muted' : 'unmuted',
        muted
            ? `${n} device(s) muted - nothing on them raises, and anything open clears within a few scans`
            : `${n} device(s) unmuted - anything still true raises again on the next scan`));
    const d = await api('/api/devices');
    if (d.ok) renderDevices(d);
}
$('roster-mute').addEventListener('click', () => setMutedSelected(true));
$('roster-unmute').addEventListener('click', () => setMutedSelected(false));
$('roster-setcred').addEventListener('click', () => setCredentialSelected(false));
$('roster-rediscover').addEventListener('click', () => rediscoverSelected(false));
$('roster-rediscover-reset').addEventListener('click', () => rediscoverSelected(true));
$('roster-disable').addEventListener('click', () => removeSelected('disable'));
$('roster-enable').addEventListener('click', () => removeSelected('enable'));
$('roster-delete').addEventListener('click', () => removeSelected('delete'));
$('roster-clear').addEventListener('click', () => { selected.clear(); renderSelection(); renderDevices(null); });
// The credential picker on the selection bar shares the add form's datalist;
// fill it the first time anything is selected so the names are there.
$('roster-cred').addEventListener('focus', () => {
    if (lastCredentials === null) api('/api/credentials').then((d) => { if (d.ok) renderCredentials(d); });
});
$('roster-all').addEventListener('change', () => {
    // "Select all" means all SHOWN, not all matching - the render cap is real
    // and selecting rows nobody can see is how a filter becomes a surprise.
    for (const b of $('devices').querySelectorAll('tbody input[type=checkbox]')) {
        b.checked = $('roster-all').checked;
        if (b.checked) selected.add(b.dataset.name); else selected.delete(b.dataset.name);
    }
    renderSelection();
});

/** Lower is worse: down beats crit beats warn beats healthy. */
function rank(d) {
    if (d.status === 'down') return 0;
    if (d.worst === 'crit') return 1;
    if (d.worst === 'warn') return 2;
    if ((d.open_alerts ?? 0) > 0) return 3;
    if (d.status !== 'up') return 4;
    return 5;
}

let lastDevices = [];
// Whether /api/devices truncated, and the true count when it did. Defaults
// mean an un-capped page renders exactly as it did before this existed.
let deviceCapped = false;
let deviceTotal = 0;
let deviceSort = null;      // null = use the scope selector's ordering

// THE ROSTER'S COLUMN REGISTRY. The first two columns (select box, device
// name with its liveness dot) are the row's identity and are not here;
// everything a row shows past them is one entry below, rendered in the
// operator's saved order. `sort` names a DEVICE_SORTS comparator; `on`
// false means hidden until chosen. DEFAULT order is exactly the table as it
// was before this registry existed, so an untouched install changes nothing.
//
// The cost rule: a column here may read the roster payload and nothing
// else. /api/devices is the most budget-sensitive statement in the system,
// and a column that needs a new aggregate is a server slice first
// (SLICE-ROSTER-COLUMNS-PLAN.md), never a client-side fetch per row.
const ROSTER_COLS = [
    { key: 'host', label: 'address', sort: 'host', on: true, cell: (d) => cell(d.host) },
    { key: 'status', label: 'status', th: 'mid', sort: 'status', on: true, cell: (d) => {
        // NEVER POLLED IS NOT UP. devices.status defaults to 'up' in the
        // schema, so a device added a second ago claims a state nothing has
        // measured. Pending says which it is, and the dot stays neutral.
        // notYetMeasured, not !last_poll_ts: a ping-only device never gets a
        // poll and read `pending` permanently.
        const unpolled = notYetMeasured(d);
        // ONE BADGE IN ONE CELL (operator, 2026-09-25). A transient device
        // used to show its status AND a second "transient" pill, built as a
        // table cell nested inside this one, which pushed its row out of
        // line with every other. A transient device now reads "transient"
        // IN PLACE of up or down, coloured by the same status - green
        // present, red away - so the declaration and the state are one
        // shape (the operator's own proposal). The dot beside the name keeps
        // the quiet "off" rendering, so a transient device that is away
        // still does not look like an outage at a glance.
        // Centred (operator, 2026-09-29): 'transient' is three times the
        // width of 'up', and left-aligned the column read ragged.
        const td = document.createElement('td');
        td.className = 'mid';
        const cls = `badge ${d.status === 'up' ? 'ok' : d.status === 'down' ? 'fail' : ''}`;
        const b = unpolled ? badge('pending', 'badge')
            : d.transient === true ? badge('transient', cls)
                : badge(d.status, cls);
        if (unpolled) b.title = 'added, not yet polled - the first poll is due within one interval';
        else if (d.transient === true) {
            b.title = `transient, ${d.status === 'up' ? 'present' : d.status === 'down' ? 'away - off is a state, not a fault' : d.status}: `
                + 'device-down never raises for it. Its readings still alert while it is present '
                + 'unless its alerts are muted too.';
        }
        td.appendChild(b);
        // Muted (slice 54) rides beside the status, dashed like the other
        // declarations: it is a decision about the device, not its state.
        if (d.alerts_muted === true) {
            const m = badge('muted', 'badge maint');
            m.title = 'alerts muted: nothing on this device raises - down, interfaces, sensors';
            td.append(document.createTextNode(' '), m);
        }
        return td;
    } },
    { key: 'reach', label: 'reach', sort: 'reach', on: true, cell: (d) => {
        // BLANK WHEN UP, a pill otherwise - the same rule as the grouping
        // columns: hundreds of healthy rows saying "up" twice is noise.
        // Shown SEPARATELY from the SNMP status on purpose: "pings but the
        // agent is dead" is a diagnosis a merged verdict would erase.
        if (d.reach_state && d.reach_state !== 'up') {
            // The AGE is in the pill, not only the tooltip (easy-win E10):
            // "down 3h" and "down 20s" are different evenings, a
            // hover-only fact violates the state-gets-a-shape rule, and
            // reach_since_ts was already in the payload doing nothing
            // visible.
            const age = d.reach_since_ts ? ` ${fmtAgo(d.reach_since_ts)}` : '';
            const c = pill(`${d.reach_state}${age}`,
                `badge ${d.reach_state === 'down' ? 'fail' : d.reach_state === 'degraded' ? 'warn' : ''}`);
            if (d.reach_since_ts) c.title = `since ${fmtAgo(d.reach_since_ts)}`;
            return c;
        }
        const c = cell('');
        if (d.reach_rtt_ms !== null && d.reach_rtt_ms !== undefined) c.title = `up, ${d.reach_rtt_ms} ms at last transition`;
        return c;
    } },
    // Blank, not a placeholder: "-" in hundreds of rows says nothing, and an
    // empty cell already reads as "not set".
    { key: 'location', label: 'location', sort: 'location', on: true, cell: (d) => clipCell(d.location ?? '', 'muted') },
    { key: 'application', label: 'application', sort: 'application', on: true, cell: (d) => clipCell(d.application ?? '', 'muted') },
    // TWO COUNTS, NOT ONE (operator, 2026-09-23). The column said
    // "interfaces" and counted every tracked entity, sensors included, so a
    // switch with 24 watched ports and 4 sensors read 28. The key stays
    // 'entities' so saved column orders keep their place; the sensors column
    // is new and lands at the end of a saved order, like any added column.
    // Both count TRACKED rows - the ones that alert and chart - and the
    // header titles say so, because the device page lists untracked ones too.
    { key: 'entities', label: 'interfaces', th: 'num', sort: 'entities', on: true,
      title: 'Tracked interfaces - the ones that alert and chart. The device page also lists the untracked ones.',
      cell: (d) => cell(String(d.tracked_ifs ?? d.entities), 'num') },
    { key: 'tracked_sensors', label: 'sensors', th: 'num', sort: 'tracked_sensors', on: true,
      title: 'Tracked sensors - cpu, memory, filesystems, temperatures and the rest',
      cell: (d) => cell(d.tracked_sensors > 0 ? String(d.tracked_sensors) : '', 'num') },
    { key: 'open_alerts', label: 'open alerts', th: 'num', sort: 'open_alerts', on: true, cell: (d) => {
        const c = cell(d.open_alerts > 0 ? String(d.open_alerts) : '', 'num');
        if (d.worst === 'crit') c.classList.add('cell-crit');
        else if (d.worst === 'warn') c.classList.add('cell-warn');
        return c;
    } },
    { key: 'last_poll_ts', label: 'last poll', sort: 'last_poll_ts', on: true, cell: (d) => cell(fmtAgo(d.last_poll_ts)) },
    // Off by default (easy-win E10): last_seen_ts was in every roster
    // payload doing nothing visible. Distinct from last poll - a poll is
    // this product asking; last seen is the device ANSWERING anything at
    // all - and the gap between the two columns is itself a diagnosis.
    { key: 'last_seen_ts', label: 'last seen', sort: 'last_seen_ts', on: false,
      title: 'When ANY instrument last heard from this device',
      cell: (d) => cell(fmtAgo(d.last_seen_ts)) },
    // Off by default: already in the payload, free to show, noise for most.
    { key: 'ping_rtt_ms', label: 'ping', th: 'num', sort: 'ping_rtt_ms', on: false,
      title: 'ICMP round trip at the last reachability sweep',
      cell: (d) => cell(d.ping_rtt_ms === null || d.ping_rtt_ms === undefined ? '' : `${Number(d.ping_rtt_ms).toFixed(1)} ms`, 'num') },
    { key: 'poll_lag_ms', label: 'poll lag', th: 'num', sort: 'poll_lag_ms', on: false,
      title: 'How late the last poll started against when it was due - the responsiveness signal',
      cell: (d) => cell(d.poll_lag_ms === null || d.poll_lag_ms === undefined ? '' : `${Math.round(d.poll_lag_ms)} ms`, 'num') },
    { key: 'poll_interval_s', label: 'interval', th: 'num', sort: 'poll_interval_s', on: false,
      cell: (d) => cell(`${d.poll_interval_s}s`, 'num') },
    { key: 'credential_ref', label: 'credential', sort: 'credential_ref', on: false,
      title: 'The profile or environment variable this device polls with',
      cell: (d) => clipCell(d.credential_ref ?? '', 'muted') },
    // THE AGGREGATE COLUMNS (SLICE-ROSTER-COLUMNS-PLAN): computed on the
    // roster query's own entities pass. Blank, never N/A or zero, when the
    // device has no fresh reading of the kind - a value older than three
    // poll intervals is not a value. Titles carry the caveats the parent's
    // do, because a number an operator cannot qualify is a number they
    // will argue with.
    { key: 'cpu_pct', label: 'CPU', th: 'num', sort: 'cpu_pct', on: false,
      title: 'Highest tracked CPU reading, per cent',
      cell: (d) => numCell(d.cpu_pct, (v) => `${Math.round(v)}%`) },
    { key: 'mem_pct', label: 'memory', th: 'num', sort: 'mem_pct', on: false,
      title: 'Used memory as the agent reports it - many Linux agents count cache and buffers, where high is healthy; trust the trend over the number',
      cell: (d) => numCell(d.mem_pct, (v) => `${Math.round(v)}%`) },
    { key: 'fs_pct', label: 'fullest FS', th: 'num', sort: 'fs_pct', on: false,
      title: 'The fullest tracked filesystem - a pick, never a sum, so nested and ZFS namespaces cannot double-count',
      cell: (d) => {
          const c = numCell(d.fs_pct, (v) => `${v >= 99.5 ? 100 : Math.round(v)}%`);
          if (d.fs_pct !== null && d.fs_pct !== undefined && d.fs_name) {
              c.appendChild(document.createTextNode(' '));
              const n = document.createElement('span');
              n.className = 'muted';
              n.textContent = d.fs_name.length > 14 ? `${d.fs_name.slice(0, 13)}\u2026` : d.fs_name;
              n.title = d.fs_name;
              c.appendChild(n);
          }
          return c;
      } },
    { key: 'temp_c', label: 'temp', th: 'num', sort: 'temp_c', on: false,
      title: 'Hottest tracked sensor - open the device for all of them',
      cell: (d) => numCell(d.temp_c, (v) => `${Math.round(v)}\u00b0C`) },
    { key: 'down_ports', label: 'down ports', th: 'num', sort: 'down_ports', on: false,
      title: 'Tracked interfaces operationally down while administratively up - ports someone shut on purpose are not counted',
      cell: (d) => {
          if (!d.if_count) return cell('', 'num');
          const c = cell('', 'num');
          if (d.down_ports > 0) {
              const b = document.createElement('strong');
              b.textContent = String(d.down_ports);
              c.appendChild(b);
              c.appendChild(document.createTextNode(` of ${d.if_count}`));
          } else {
              c.textContent = `0 of ${d.if_count}`;
              c.classList.add('muted');
          }
          return c;
      } },
    { key: 'if_errs', label: 'errors/s', th: 'num', sort: 'if_errs', on: false,
      title: 'Worst tracked interface right now, in plus out errors per second',
      cell: (d) => numCell(d.if_errs, (v) => fmtRate(v)) },
    { key: 'top_if', label: 'top interface', sort: 'top_bps', on: false,
      title: 'The tracked interface carrying the most traffic right now',
      cell: (d) => clipCell(d.top_if ?? '') },
    { key: 'top_bps', label: 'top usage', th: 'num', sort: 'top_bps', on: false,
      title: 'Traffic on the busiest tracked interface, and its share of a speed the measurement trusts',
      cell: (d) => {
          if (d.top_bps === null || d.top_bps === undefined) return cell('', 'num');
          const c = cell(fmtBps(d.top_bps), 'num');
          if (d.top_speed > 0) {
              const pct = (100 * d.top_bps) / d.top_speed;
              const s = document.createElement('span');
              s.className = 'muted';
              s.textContent = ` (${pct < 1 ? '<1' : Math.round(pct)}%)`;
              c.appendChild(s);
          }
          return c;
      } },
    { key: 'health', label: 'health', sort: 'alarms', on: false,
      title: 'Worst case over the device\u2019s state sensors (on battery, fan and PSU alarms); blank when the device exposes none',
      cell: (d) => {
          if (!d.state_sensors) return cell('');
          return d.alarms > 0
              ? pill(`${d.alarms} alarm${d.alarms === 1 ? '' : 's'}`, 'badge fail')
              : pill('ok', 'badge ok');
      } },
    { key: 'ups', label: 'UPS', th: 'num', sort: 'batt_pct', on: false,
      title: 'Battery charge and estimated runtime, on devices that report them',
      cell: (d) => {
          const parts = [];
          if (d.batt_pct !== null && d.batt_pct !== undefined) parts.push(`${Math.round(d.batt_pct)}%`);
          if (d.runtime_s !== null && d.runtime_s !== undefined) parts.push(fmtRuntime(d.runtime_s));
          return cell(parts.join(' \u00b7 '), 'num');
      } },
    { key: 'sys_descr', label: 'OS', sort: 'sys_descr', on: false,
      title: 'The agent\u2019s own description at discovery; use Rediscover after upgrades',
      cell: (d) => clipCell(d.sys_descr ?? '', 'muted') },
    { key: 'cpu_model', label: 'hardware', sort: 'cpu_model', on: false,
      title: 'Processor model from HOST-RESOURCES, refreshed daily; blank when the agent does not expose it',
      cell: (d) => clipCell(d.cpu_model ?? '', 'muted') },
    // Slice 21: the three values nothing collected until now.
    { key: 'uptime_s', label: 'uptime', th: 'num', sort: 'uptime_s', on: false,
      title: 'sysUpTime at the last poll - note it wraps at about 497 days, which looks like a reboot',
      cell: (d) => numCell(d.uptime_s, (v) => fmtRuntime(v)) },
    { key: 'cpu_cores', label: 'cores', th: 'num', sort: 'cpu_cores', on: false,
      title: 'Logical processors the agent reports (hrProcessorTable rows), refreshed daily',
      cell: (d) => numCell(d.cpu_cores, (v) => String(Math.round(v))) },
    { key: 'ram_kb', label: 'RAM', th: 'num', sort: 'ram_kb', on: false,
      title: 'Physical memory the agent reports (hrMemorySize), refreshed daily',
      cell: (d) => numCell(d.ram_kb, (v) => fmtBytes(v * 1024)) },
];
// A numeric cell that is BLANK for null - the roster's rule for "no fresh
// reading", as distinct from zero.
function numCell(v, fmt) {
    return cell(v === null || v === undefined ? '' : fmt(Number(v)), 'num');
}
function fmtRuntime(s) {
    s = Math.round(Number(s));
    if (!Number.isFinite(s) || s < 0) return '';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
function clipCell(text, cls) {
    const c = cell(text, cls ? `${cls} clip` : 'clip');
    if (text) c.title = text;
    return c;
}

// The preference: an ORDERED list of every registry key plus the hidden set.
// Keys the registry no longer has are dropped; keys it gained since the
// preference was saved are appended, so a new column from an upgrade shows up
// in the panel without resetting anyone's order.
const COLS_KEY = 'rscanvas-cols';
function loadColPrefs() {
    const valid = ROSTER_COLS.map((c) => c.key);
    let order = [], hidden = [];
    try {
        const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
        if (saved && Array.isArray(saved.order)) { order = saved.order; hidden = Array.isArray(saved.hidden) ? saved.hidden : []; }
    } catch { /* a corrupt preference is the default, not an error */ }
    const seen = new Set();
    const out = [];
    for (const k of order) if (valid.includes(k) && !seen.has(k)) { seen.add(k); out.push(k); }
    for (const k of valid) if (!seen.has(k)) { seen.add(k); out.push(k); }
    const hid = new Set(hidden.filter((k) => valid.includes(k)));
    // A never-saved preference hides what the registry says is off.
    if (!order.length) for (const c of ROSTER_COLS) if (!c.on) hid.add(c.key);
    return { order: out, hidden: hid };
}
function saveColPrefs(p) {
    try { localStorage.setItem(COLS_KEY, JSON.stringify({ order: p.order, hidden: [...p.hidden] })); } catch { /* private mode: the session keeps it */ }
}
let colPrefs = loadColPrefs();
function visibleCols() {
    const byKey = new Map(ROSTER_COLS.map((c) => [c.key, c]));
    return colPrefs.order.filter((k) => !colPrefs.hidden.has(k)).map((k) => byKey.get(k));
}

// Wide layout: a per-browser preference like the columns, applied as a body
// class so every view inherits it. Two switches show the one setting: the
// top bar's Width, on every tab, and the checkbox in the Devices columns
// panel, where the need for it is usually noticed. The value is held here as
// well as stored, so a browser that refuses storage still gets the switch for
// the session instead of a control that springs back.
const WIDE_KEY = 'rscanvas-wide';
let wideOn = false;
try { wideOn = localStorage.getItem(WIDE_KEY) === '1'; } catch { /* default */ }
function applyWide() {
    document.body.classList.toggle('wide', wideOn);
    $('wide-cb').checked = wideOn;
    $('width-select').value = wideOn ? 'wide' : 'normal';
}
function setWide(on) {
    wideOn = on;
    try { localStorage.setItem(WIDE_KEY, on ? '1' : '0'); } catch { /* session only */ }
    applyWide();
}

// The header past the two identity columns, rebuilt from the preference on
// every render. Sort clicks are wired here because the cells they belong to
// are created here - a static listener loop would miss every column the
// operator adds later.
function renderRosterHeader() {
    const tr = $('devices').querySelector('thead tr');
    while (tr.children.length > 2) tr.removeChild(tr.lastChild);
    for (const c of visibleCols()) {
        const th = document.createElement('th');
        th.textContent = c.label;
        if (c.th) th.className = c.th;
        if (c.title) th.title = c.title;
        if (c.sort && DEVICE_SORTS[c.sort]) {
            th.classList.add('clickable');
            th.dataset.sort = c.sort;
            th.addEventListener('click', () => { deviceSort = c.sort; renderDevices(null); });
        }
        tr.appendChild(th);
    }
}

// The panel: every registry column in saved order, a checkbox for shown, and
// up/down to move it. Moves apply immediately so the table is the preview.
$('cols-reset').addEventListener('click', () => {
    // Forgetting is the whole feature: drop the stored preference and
    // rebuild from the registry, exactly what a fresh browser sees.
    try { localStorage.removeItem(COLS_KEY); } catch { /* private mode */ }
    colPrefs = loadColPrefs();
    renderColsPanel(); renderRosterHeader(); renderDevices(null);
});

function renderColsPanel() {
    const list = $('cols-list');
    list.replaceChildren();
    const byKey = new Map(ROSTER_COLS.map((c) => [c.key, c]));
    colPrefs.order.forEach((k, i) => {
        const c = byKey.get(k);
        const on = !colPrefs.hidden.has(k);
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = on;
        box.addEventListener('change', () => {
            if (box.checked) colPrefs.hidden.delete(k); else colPrefs.hidden.add(k);
            saveColPrefs(colPrefs); renderColsPanel(); renderDevices(null);
        });
        const label = document.createElement('span');
        label.textContent = c.label;
        if (c.title) label.title = c.title;
        if (!on) label.className = 'col-off';
        const mk = (txt, delta) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = txt;
            b.disabled = i + delta < 0 || i + delta >= colPrefs.order.length;
            b.addEventListener('click', () => {
                const o = colPrefs.order;
                [o[i], o[i + delta]] = [o[i + delta], o[i]];
                saveColPrefs(colPrefs); renderColsPanel(); renderDevices(null);
            });
            return b;
        };
        list.append(box, label, mk('\u25B2', -1), mk('\u25BC', 1));
    });
}
$('cols-btn').addEventListener('click', () => {
    const p = $('cols-panel');
    const opening = p.classList.contains('hidden');
    if (opening) renderColsPanel();
    p.classList.toggle('hidden', !opening);
});
$('wide-cb').addEventListener('change', () => setWide($('wide-cb').checked));
$('width-select').addEventListener('change', () => setWide($('width-select').value === 'wide'));
applyWide();

function renderDevices(data) {
    if (data) {
        lastDevices = data.devices || [];
        // The SERVER's cap (UI_PAGE_CAP), which is a different thing from
        // RENDER_CAP below: this one means rows the browser never received,
        // so the filter box cannot find them either. Said out loud for that
        // reason - a filter that silently cannot see part of the fleet is
        // worse than a short list.
        deviceCapped = data.capped === true;
        deviceTotal = typeof data.total === 'number' ? data.total : lastDevices.length;
        // The open device's name line reads the roster row, so it follows
        // every roster fetch - the 10s refresh and each save's refetch alike.
        renderDeviceHeader();
        // So does the report's device list, and it must be HERE, where the
        // roster has just landed: filled from refresh()'s Dashboard branch it
        // ran before the first roster at sign-in and sat empty for a whole
        // refresh interval - found by the screenshot run timing out on it.
        fillReportDevices();
    }
    const all = lastDevices;
    const filter = parseDeviceFilter($('device-filter').value);
    const scope = $('device-scope').value;

    // The filter searches grouping too, which is what makes "PAM" find both
    // PAM Prod and PAM Dev - a compound application value is opaque to the
    // machine but not to a substring match, which is why two columns stretch
    // as far as they do. location:<name> and application:<name> match one
    // group exactly, and transient: and muted: narrow to the declared devices
    // (parse.js says why).
    let rows = all.filter((d) => deviceMatches(d, filter));
    if (scope === 'only-problems') rows = rows.filter((d) => rank(d) <= 3);
    if (scope === 'down') rows = rows.filter((d) => d.status === 'down');

    const cmp = deviceSort ? DEVICE_SORTS[deviceSort]
        : scope === 'name' ? DEVICE_SORTS.name : DEVICE_SORTS.status;
    rows = [...rows].sort(cmp);

    const shown = rows.slice(0, RENDER_CAP);
    renderRosterHeader();
    const cols = visibleCols();
    const tbody = $('devices').querySelector('tbody');
    tbody.replaceChildren();
    for (const d of shown) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.name = d.name;
        box.checked = selected.has(d.name);
        box.addEventListener('change', () => {
            if (box.checked) selected.add(d.name); else selected.delete(d.name);
            renderSelection();
        });
        const boxCell = document.createElement('td');
        boxCell.appendChild(box);

        const unpolled = notYetMeasured(d);
        // Slice 25: a transient device that is down renders OFF - dim and
        // deliberate, never red - because the operator declared offline a
        // state for it. The truth stays on screen; only the classification
        // changed, and a person changed it.
        const off = d.transient === true && d.status === 'down';
        const tr = rowEl([
            boxCell,
            dotCell(d.name, unpolled ? '' : off ? 'off' : d.status === 'up' ? 'ok' : d.status === 'down' ? 'bad' : ''),
            ...cols.map((c) => c.cell(d)),
        ]);
        tr.className = 'clickable';
        // The row still opens the drill-down, but a click on the checkbox must
        // not - selecting forty devices by accidentally opening forty panels
        // is not a workflow.
        tr.addEventListener('click', (ev) => {
            if (ev.target instanceof HTMLInputElement) return;
            showDevice(d.name);
        });
        tbody.appendChild(tr);
    }

    const up = all.filter((x) => x.status === 'up').length;
    // off and down counted apart (slice 25): "27 up, 2 off, 1 down" is a
    // different evening from "27 up, 3 down", and the header is where that
    // difference is read first.
    const off = all.filter((x) => x.transient === true && x.status === 'down').length;
    const down = all.filter((x) => x.status === 'down').length - off;
    const counts = [`${up}/${all.length} up`];
    if (off > 0) counts.push(`${off} off`);
    if (down > 0) counts.push(`${down} down`);
    // The UNEXPLAINED are counted too (easy-win E10): "27/30 up, 1 down"
    // silently omitted two devices in pending or unknown, and a ladder that
    // does not sum to its own denominator invites reading the gap as fine.
    const accounted = up + off + down;
    if (accounted < all.length) counts.push(`${all.length - accounted} pending/unknown`);
    $('device-counts').textContent =
        all.length === 0 ? 'none watched yet' : counts.join(', ');

    // The cap and the filter both get SAID. A list that is shorter than the
    // truth without explaining why is the readability problem wearing a
    // disguise.
    const loaded = deviceCapped ? ` - the server sent the first ${all.length} of `
        + `${deviceTotal}, so this list and its filter are incomplete` : '';
    const msg = (rows.length === 0
        ? (q === '' ? 'no devices match this view' : `nothing matches "${q}"`)
        : shown.length < rows.length
            ? `showing ${shown.length} of ${rows.length} - narrow the filter to see the rest`
            : rows.length < all.length ? `${rows.length} of ${all.length} devices` : '') + loaded;
    const el = $('roster-msg');
    el.textContent = msg;
    el.classList.toggle('hidden', msg === '');
}

// --- the device drill-down ----------------------------------------------------

let currentDevice = null;
let lastEntities = [];
// The server sent its first UI_DEVICE_ENTITY_CAP and there were more.
let lastEntitiesCapped = false;

/** bits/s with a unit that keeps small values readable and large ones honest. */
/**
 * The nominal interface speed - and whether it can be believed.
 *
 * Ported from SNMPCanvas app.js: an advertised speed that measured traffic
 * has exceeded past the jitter margin is shown as UNRATED, because a number
 * the operator can see and a utilization computed against it must agree, and
 * the honest thing to say about a virtio NIC claiming 1.41 Gbps while moving
 * more is that its rating is fiction. An operator override shows as SET, so a
 * figure that came from a person is distinguishable from one that came from
 * the agent. Blank when the agent reported none - the blank-not-placeholder
 * rule, same as every other column.
 */
// "1G", "100M", "2.5g", "1000000000" -> bps; '' / 'auto' / 'clear' -> null
// (advertised speed takes back over). NaN for anything else, so the caller
// can refuse rather than write garbage.
function parseSpeed(txt) {
    const t = txt.trim().toLowerCase();
    if (t === '' || t === 'auto' || t === 'clear') return null;
    const m = t.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmg]?)(?:b(?:ps)?)?$/);
    if (!m) return NaN;
    const mult = m[2] === 'g' ? 1e9 : m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
    return Math.round(Number(m[1]) * mult);
}

async function saveSpeed(e, td, input) {
    const bps = parseSpeed(input.value);
    if (Number.isNaN(bps) || (bps !== null && bps <= 0)) {
        input.classList.add('bad');
        input.title = 'say it like 1G, 100M, 2500000000 - or "auto" to clear';
        return;
    }
    const r = await api('/api/device/speed', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: currentDevice, index: e.snmp_index, bps }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('device-sub').textContent = r.detail || `speed change refused (${r.status})`; return; }
    // The editor leaves the DOM BEFORE the re-render, or the render guard
    // sees a live input and skips the very refresh that shows the result.
    td.replaceChildren();
    if (currentDevice) await showDevice(currentDevice);
    $('device-sub').textContent = bps === null
        ? `${r.name}: override cleared - advertised speed (and any unrated verdict) is back in charge`
        : `${r.name}: utilization now reckons against ${input.value.trim()}`;
}

// The pencil swaps the cell for a small inline input - Enter saves, Escape
// backs out. Lives in the cell because that is where the decision is made,
// the same reasoning as the threshold gear on sensor cards.
function speedEditButton(e, td) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-track';
    // 'edit' when an override stands, or the cell reads "set set" next to
    // the override pill.
    b.textContent = e.speed_override_bps > 0 ? 'edit' : 'set';
    b.title = 'set a speed override (utilization alerts use it instead of the advertised speed)';
    b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        td.replaceChildren();
        const input = document.createElement('input');
        input.type = 'text';
        input.size = 7;
        input.placeholder = '1G / auto';
        input.value = e.speed_override_bps > 0 ? String(e.speed_override_bps) : '';
        input.addEventListener('click', (ce) => ce.stopPropagation());
        input.addEventListener('keydown', (ke) => {
            ke.stopPropagation();
            if (ke.key === 'Enter') void saveSpeed(e, td, input);
            if (ke.key === 'Escape' && currentDevice) { td.replaceChildren(); void showDevice(currentDevice); }
        });
        td.appendChild(input);
        input.focus();
    });
    return b;
}

function speedCell(e) {
    const override = e.speed_override_bps;
    const bps = override && override > 0 ? override : e.speed_bps;
    const canTune = can('device.speed')
        && e.tracked && (!e.kind || e.kind === 'if') && e.snmp_index !== null && e.snmp_index !== undefined;
    if (e.speed_untrusted && !(override > 0)) {
        const c = badge('unrated', 'badge stale');
        c.title = 'Advertised speed disproven by measured traffic (common on virtio and Hyper-V NICs)'
            + ' - utilization is suspended. Set a speed override to restore it.';
        const td = document.createElement('td');
        td.className = 'num';
        td.appendChild(c);
        if (canTune) { td.appendChild(document.createTextNode(' ')); td.appendChild(speedEditButton(e, td)); }
        return td;
    }
    if (bps === null || bps === undefined || bps <= 0) return cell('', 'num');
    const txt = bps >= 1e9 ? `${(bps / 1e9) % 1 === 0 ? bps / 1e9 : (bps / 1e9).toFixed(1)} Gb`
        : bps >= 1e6 ? `${Math.round(bps / 1e6)} Mb`
        : `${Math.round(bps / 1e3)} kb`;
    const td = cell(txt, 'num');
    if (override > 0) {
        td.appendChild(document.createTextNode(' '));
        const b = badge('set', 'badge');
        b.title = 'Operator speed override - utilization uses this, not the advertised speed';
        td.appendChild(b);
    }
    if (canTune) { td.appendChild(document.createTextNode(' ')); td.appendChild(speedEditButton(e, td)); }
    // The 32-bit fallback is VISIBLE (easy-win E10): a hover-only marker
    // violates the state-gets-a-shape rule, and this is the state that
    // explains a 10GbE port whose rates cap oddly - the row title carries
    // the full sentence, the badge says there is a sentence to read.
    if (e.hc_missing) {
        td.appendChild(document.createTextNode(' '));
        const b = badge('32-bit', 'badge');
        b.title = 'no 64-bit (ifHC) counters - rates use wrap-corrected 32-bit counters';
        td.appendChild(b);
    }
    return td;
}

function fmtBps(v) {
    if (v === null || v === undefined) return '';
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mb/s`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)} kb/s`;
    return `${Math.round(v)} b/s`;
}

/**
 * Error and discard rates stay FRACTIONAL - the handoff's one-way door. One
 * CRC error a minute is 0.0167/s, and rounding it to an integer reports a
 * failing port as clean, which is the specific bug this rule was written
 * about. Small non-zero values get more decimals, not fewer.
 */
function fmtRate(v) {
    if (v === null || v === undefined) return '';
    if (v === 0) return '0';
    if (v < 0.01) return v.toFixed(4);
    if (v < 1) return v.toFixed(3);
    return v.toFixed(1);
}

// --- history charts ----------------------------------------------------------
//
// One chart open at a time: a drill-down answers "what has THIS been doing",
// and twenty charts at once is a dashboard, which is a different product.

/** What each kind's history means, in the chart's vocabulary. */
function chartSpec(e) {
    const name = e.name || e.code;
    switch (e.kind) {
        case 'cpu': return { unit: 'pct', yMax: 100, series: [{ label: 'CPU', cls: 'a', area: true, i: 0 }] };
        case 'mem':
        case 'fs': return {
            unit: 'bytes',
            series: [{ label: 'used', cls: 'a', area: true, i: 0 }, { label: 'total', cls: 'b', i: 1 }],
        };
        case 'temp': return { unit: 'degc', series: [{ label: name, cls: 'a', area: true, i: 0 }] };
        case 'fan': return { unit: 'rpm', series: [{ label: name, cls: 'a', i: 0 }] };
        case 'battery':
        case 'gauge': return { unit: 'pct', yMax: 100, series: [{ label: name, cls: 'a', area: true, i: 0 }] };
        case 'runtime': return { unit: 'dur', series: [{ label: name, cls: 'a', area: true, i: 0 }] };
        case 'power': return { unit: 'w', series: [{ label: name, cls: 'a', area: true, i: 0 }] };
        case 'meter': return {
            unit: (e.extra && e.extra.unit) || '', series: [{ label: name, cls: 'a', i: 0 }],
        };
        case 'state': return { unit: '', yMax: 1, series: [{ label: name, cls: 'a', area: true, i: 0 }] };
        default: return {
            unit: 'bps',
            series: [{ label: 'in', cls: 'a', area: true, i: 0 }, { label: 'out', cls: 'b', area: true, i: 1 }],
        };
    }
}

let chartEntity = null;
// Bumped per chart OPEN, because identity alone cannot see a RANGE change:
// the range <select> re-calls openChart with the SAME entity object, so a
// slow 24h reply could overdraw a fast 7d chart with the sub line naming
// the new range. openRttChart's fresh-marker-per-call had this right;
// openChart's entity doubles as the range handler's dispatch state and
// cannot be replaced by a marker, so it gets a generation beside it.
let chartGen = 0;

async function openChart(entity) {
    chartEntity = entity;
    const gen = ++chartGen;
    const hours = Number($('chart-range').value) || 24;
    $('chart-wrap').classList.remove('hidden');
    $('chart-title').textContent = entity.name || entity.code;
    $('chart-sub').textContent = 'loading...';
    const r = await api(`/api/entity/history?code=${encodeURIComponent(entity.code)}&hours=${hours}`);
    // A late reply for a chart the operator has already navigated away from
    // must not overwrite the one they are looking at - and a late reply for
    // a range they have already left must not either (the gen check).
    if (chartEntity !== entity || gen !== chartGen) return;
    if (!r.ok) { $('chart-sub').textContent = r.detail || 'no history'; return; }
    const spec = chartSpec(entity);
    const series = spec.series.map((s) => ({
        label: s.label, cls: s.cls, area: s.area,
        data: r.points.map((p) => [p[0], p[1 + s.i]]),
    }));
    // THE HOURLY MAXIMA, drawn at last (easy-win E3): the rollup computed
    // every hour's worst for v0/v1 from the day it existed and no reader
    // ever consumed them, so the long view lost every peak to the mean -
    // a two-minute saturation averaged into a calm-looking hour, which is
    // the raw view's own "a real fault renders as a rounding error"
    // warning happening one screen further out. Rollup rows carry them at
    // indexes 8/9; raw rows do not, and absence is the guard.
    const hasMax = r.points.some((p) => p.length > 8 && (p[8] != null || p[9] != null));
    if (hasMax) {
        for (const s of spec.series) {
            if (s.i !== 0 && s.i !== 1) continue;
            series.push({
                label: `${s.label} worst`, cls: s.i === 0 ? 'c' : 'd', area: false,
                data: r.points.map((p) => [p[0], p[8 + s.i] ?? null]),
            });
        }
    }
    const any = series.some((s) => s.data.some(([, v]) => v !== null && v !== undefined));
    // NAMING THE SOURCE, because raw and rollup look different and an
    // operator should not have to wonder why last week is smoother than
    // this morning.
    $('chart-sub').textContent = any
        ? `${r.points.length} points, ${r.source}`
        : 'no readings in this window';
    Charts.render($('chart-body'), {
        series, from: r.from, to: r.to, unit: spec.unit,
        yMax: spec.yMax, bucketSec: r.bucketSec,
    });
    renderErrorChart(entity, r);
}

/** max of two nullable readings - null only when BOTH are missing, so a
 *  direction that never reported does not drag a real count down to null. */
function maxOrNull(a, b) {
    if (a === null || a === undefined) return b === undefined ? null : b;
    if (b === null || b === undefined) return a;
    return Math.max(a, b);
}

/**
 * The errors-and-discards chart: interfaces only, and only when something
 * happened.
 *
 * A permanent flat line at zero is worse than no chart - it trains the eye
 * to skip that part of the screen, which is precisely where the eye needs to
 * go on the day it is not zero. So the chart appears when the window
 * contains a non-zero reading, and otherwise one quiet line says so, which
 * is the same information stated honestly. Same rule as the roster's blank
 * cells and the alerts table's all-quiet.
 */
function renderErrorChart(entity, r) {
    const isIf = !entity.kind || entity.kind === 'if';
    const errs = isIf ? r.points.map((p) => [p[0], maxOrNull(p[3], p[4])]) : [];
    const disc = isIf ? r.points.map((p) => [p[0], maxOrNull(p[5], p[6])]) : [];
    const any = [...errs, ...disc].some(([, v]) => v !== null && v > 0);

    $('chart-errs-head').classList.toggle('hidden', !isIf);
    $('chart-errs-quiet').classList.toggle('hidden', !isIf || any);
    if (!isIf) { $('chart-errs').replaceChildren(); return; }
    if (!any) {
        $('chart-errs').replaceChildren();
        $('chart-errs-sub').textContent = '';
        $('chart-errs-quiet').textContent =
            'no errors or discards in this window - which is the answer, not a missing chart';
        return;
    }
    $('chart-errs-sub').textContent = 'own scale - the traffic chart above is Gb/s, this is counts per second';
    Charts.render($('chart-errs'), {
        from: r.from, to: r.to, unit: 'pps', bucketSec: r.bucketSec,
        series: [
            // c and d, not a and b: the severity palette, because this
            // chart only exists when something is wrong and the traffic
            // colours read as reassuring. Errors are --se-down (a corrupted
            // frame is a physical fault), discards --se-warn (a drop is
            // usually congestion) - the same vocabulary the table's
            // cell-warn already speaks.
            {
                label: 'errors', cls: 'c', area: true, data: errs,
                parts: [
                    { label: 'in', data: r.points.map((p) => [p[0], p[3]]) },
                    { label: 'out', data: r.points.map((p) => [p[0], p[4]]) },
                ],
            },
            {
                label: 'discards', cls: 'd', area: true, data: disc,
                parts: [
                    { label: 'in', data: r.points.map((p) => [p[0], p[5]]) },
                    { label: 'out', data: r.points.map((p) => [p[0], p[6]]) },
                ],
            },
        ],
    });
}

/**
 * The responsiveness chart: SNMP round-trip for the whole device, opened
 * from the responsiveness line. The investigation tool for "this device
 * drifts toward degraded and clears before it alerts" - the operator's
 * MikroTik case, where a 5s median is how RouterOS behaves, not a fault,
 * and the only way to see that is the history. Median and worst per
 * bucket; raw samples only, and the sub line names the retention so a
 * 30-day range that draws two days is explained, not mysterious.
 */
async function openRttChart(name) {
    const marker = { rttDevice: name };
    chartEntity = marker;
    chartGen += 1;
    const hours = Number($('chart-range').value) || 24;
    $('chart-wrap').classList.remove('hidden');
    // Named after the fetch, once it is known which instruments answered -
    // "SNMP round-trip" on a ping-only device was a heading describing a
    // series that is not on the chart.
    $('chart-title').textContent = `${name} - round-trip`;
    $('chart-sub').textContent = 'loading...';
    const r = await api(`/api/device/rtt?name=${encodeURIComponent(name)}&hours=${hours}`);
    if (chartEntity !== marker) return;
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('chart-sub').textContent = r.detail || 'no history'; return; }
    const med = r.points.map((p) => [p[0], p[1]]);
    const worst = r.points.map((p) => [p[0], p[2]]);
    // Slice 36: ping rides the same chart. A device with no SNMP series (a
    // ping-only one) draws only these, and a device with both shows the
    // distinction that matters when something is slow - the agent or the
    // path.
    const ping = (r.ping || []).map((p) => [p[0], p[1]]);
    const pingWorst = (r.ping || []).map((p) => [p[0], p[2]]);
    const lossPts = (r.ping || []).filter((p) => p[3] !== null && p[3] > 0);
    const any = med.some(([, v]) => v !== null && v !== undefined)
        || ping.some(([, v]) => v !== null && v !== undefined);
    $('chart-sub').textContent = any
        ? `${r.points.length + (r.ping || []).length} buckets, ${r.source}`
            + (lossPts.length > 0
                ? ` - PACKET LOSS in ${lossPts.length} bucket(s), worst ${Math.max(...lossPts.map((p) => p[3]))}%`
                : '')
        : 'no rtt readings in this window';
    // The errors panel belongs to interface charts; clear it so a leftover
    // from the last interface does not sit under an rtt chart.
    $('chart-errs-head').classList.add('hidden');
    $('chart-errs-quiet').classList.add('hidden');
    $('chart-errs').replaceChildren();
    const series = [];
    if (med.some(([, v]) => v !== null)) {
        series.push({ label: 'SNMP median', cls: 'a', area: true, data: med });
        // worst in the warn colour: a spiky worst over a calm median is
        // the exact signature worth noticing here.
        series.push({ label: 'SNMP worst', cls: 'd', data: worst });
    }
    if (ping.some(([, v]) => v !== null)) {
        series.push({ label: 'ping median', cls: 'b', area: med.every(([, v]) => v === null), data: ping });
        series.push({ label: 'ping worst', cls: 'c', data: pingWorst });
    }
    $('chart-title').textContent = `${name} - `
        + (series.length === 0 ? 'round-trip'
            : series.some((x) => x.label.startsWith('SNMP'))
                ? (series.some((x) => x.label.startsWith('ping')) ? 'round-trip: SNMP and ping' : 'SNMP round-trip')
                : 'ping latency');
    Charts.render($('chart-body'), {
        from: r.from, to: r.to, unit: 'ms', bucketSec: r.bucketSec, series,
    });
}

/**
 * Close the chart and orphan any reply still in flight for it.
 *
 * A CHART BELONGS TO THE DEVICE IT WAS OPENED ON (operator, 2026-09-24): it
 * used to survive Back and a different device, still titled with the old
 * sensor, until closed by hand or replaced by another click. Leaving a device
 * closes it now; the generation bump makes a late reply for the old chart
 * drop itself at openChart's guard instead of redrawing on the new page.
 */
function closeChart() {
    chartEntity = null;
    chartGen += 1;
    $('chart-wrap').classList.add('hidden');
}

$('chart-close').addEventListener('click', closeChart);
$('chart-range').addEventListener('change', () => {
    if (chartEntity === null) return;
    if (chartEntity.rttDevice) openRttChart(chartEntity.rttDevice);
    else openChart(chartEntity);
});

/** Order the cards render in: the parent's page reads health-first. */
const SENSOR_ORDER = { battery: 0, runtime: 1, state: 2, cpu: 3, mem: 4, fs: 5, temp: 6, fan: 7, gauge: 8, meter: 9, power: 10 };

/** One sensor's presentation: big value, optional context line, optional
 *  0-100 bar, alarm flag. The VALUE SEMANTICS are the plan's table - v0/v1
 *  bytes for mem and fs with percent derived HERE, at render, never stored. */
function sensorPresentation(e) {
    const v0 = e.lv_v0;
    const none = v0 === null || v0 === undefined;
    const x = e.extra || {};
    switch (e.kind) {
        case 'cpu':
            return { value: none ? '-' : `${fmtRate(v0)}%`, pct: v0 };
        case 'mem':
        case 'fs': {
            const pct = !none && e.lv_v1 ? Math.round(100 * v0 / e.lv_v1) : null;
            return {
                value: pct === null ? '-' : `${pct}%`,
                sub: none ? '' : `${fmtBytes(v0)} of ${fmtBytes(e.lv_v1)}`,
                pct,
            };
        }
        case 'temp':
            // Bar against 100C: not a limit claim, just the same visual scale
            // every temperature shares so a hot one stands out at a glance.
            return { value: none ? '-' : `${Number(v0).toFixed(1)} C`, pct: v0 };
        case 'fan':
            return { value: none ? '-' : `${Math.round(v0)} rpm` };
        // Watts, as the alert scan has always called it; the card fell to
        // the default and showed a bare number (a GPU's 287 read as nothing).
        case 'power':
            return { value: none ? '-' : `${fmtRate(v0)} W` };
        case 'battery':
        case 'gauge':
            return { value: none ? '-' : `${fmtRate(v0)}%`, pct: v0 };
        case 'runtime': {
            if (none) return { value: '-' };
            const m = Math.floor(v0 / 60);
            return { value: m >= 90 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` };
        }
        case 'meter':
            return {
                value: none ? '-' : `${fmtRate(v0)}${x.unit ? ` ${x.unit}` : ''}`,
                pct: !none && x.max ? 100 * v0 / x.max : null,
            };
        case 'state':
            if (none) return { value: 'unknown', sub: 'no data is not ok and not alarm' };
            return v0 === 0
                ? { value: String(x.okText || 'OK') }
                : { value: String(x.alarmText || 'ALARM'), alarm: true };
        default:
            return { value: none ? '-' : fmtRate(v0) };
    }
}

// The collector-to-engine kind rename, needed wherever the client touches
// threshold rows (they store the ENGINE's word since slice 24).
function engineKind(k) { return k === 'fs' ? 'disk' : k === 'gauge' ? 'util' : k; }

/** Remove the override that currently governs this sensor (per the
 *  server-resolved source), after a confirm. Precedence stays decided in
 *  ONE place (the engine); this only looks up the row at that scope. */
async function unmuteSensor(s) {
    const t = s.threshold;
    const list = await api('/api/thresholds');
    if (list.status === 401) { showLogin(); return; }
    if (!list.ok) { window.alert(list.detail || `could not load overrides (${list.status})`); return; }
    const kind = engineKind(s.kind);
    const row = (list.overrides || []).find((o) => o.kind === kind && (
        t.source === 'override' ? o.code === s.code
            : t.source === 'host override' ? (o.code === null && o.host === currentDevice)
                : (o.code === null && o.host === null)));
    if (!row) { window.alert('that override row is already gone - refresh to see the current state'); return; }
    const what = t.source === 'override' ? `on this sensor`
        : t.source === 'host override' ? `for ${kind} on this device`
        : `for ${kind} everywhere`;
    if (!window.confirm(`Remove the ${row.enabled ? 'override' : 'mute'} ${what}? The next tier or the default applies on the next scan.`)) return;
    const r = await api('/api/thresholds/delete', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { window.alert(r.detail || `refused (${r.status})`); return; }
    refresh();
}

function renderSensorCards(sensors) {
    const wrap = $('sensor-cards');
    wrap.replaceChildren();
    wrap.classList.toggle('hidden', sensors.length === 0);
    const sorted = [...sensors].sort((a, b) =>
        (SENSOR_ORDER[a.kind] ?? 99) - (SENSOR_ORDER[b.kind] ?? 99)
        || String(a.name).localeCompare(String(b.name)));
    for (const s of sorted) {
        const p = sensorPresentation(s);
        const card = document.createElement('div');
        if (s.tracked) {
            card.className = `${p.alarm ? 'card alarm' : 'card'} clickable`;
            card.title = 'click for history';
            card.addEventListener('click', () => openChart(s));
        } else {
            // Discovery's own judgement (implausible readings, FS noise)
            // lands here too, dimmed - the operator can overrule it, and
            // "we saw this and chose not to watch it" stays visible.
            card.className = 'card untracked';
        }
        // THE NAME TRUNCATES, THE CONTROLS DO NOT (operator, 2026-09-23: a
        // long ZFS dataset name on a TrueNAS box pushed "untrack" out of the
        // card). The buttons used to live INSIDE the ellipsis box with the
        // text, so a long name clipped them along with itself. Now the head
        // is a row: the name takes what is left and ellipsizes, the buttons
        // keep their width, and the full name is on the name's tooltip.
        const head = document.createElement('div');
        head.className = 'card-head';
        const nm = document.createElement('span');
        nm.className = 'card-name';
        nm.textContent = s.name;
        nm.title = s.name;
        head.appendChild(nm);
        if (can('device.track') && s.snmp_index !== null) {
            head.appendChild(trackButton(s));
        }
        // The threshold control lives on the card because that is where the
        // decision is made: looking at the reading and saying "this is fine
        // here". Built only for a role that can write rules (alertrule.write).
        if (can('alertrule.write') && s.code) {
            const dev = currentDevice === null ? null : lastDevices.find((d) => d.name === currentDevice);
            const g = thresholdControl(s, dev);
            head.appendChild(g);
        }
        const val = document.createElement('div');
        val.className = 'card-value';
        val.textContent = s.tracked ? p.value : 'not watched';
        card.append(head, val);
        // Provenance ON the card (2026-08-27): a muted sensor looked
        // identical to a watched one, and the answer lived pages away in a
        // table of bare codes. A line appears only when something differs
        // from the default - the default is the quiet norm.
        if (s.threshold && s.tracked && (s.threshold.muted || s.threshold.source !== 'default')) {
            const srcLabel = s.threshold.source === 'override' ? 'this sensor'
                : s.threshold.source === 'host override' ? 'this device'
                    : s.threshold.source === 'kind override' ? `all ${engineKind(s.kind)}` : 'default';
            const th = document.createElement('div');
            th.className = 'muted small';
            if (s.threshold.muted) {
                th.textContent = `alerts MUTED (${srcLabel}) `;
                // Built only for a role that can write rules. The class that
                // used to gate it did nothing: the page's gate sweep runs
                // once at login, before any card exists, so every role saw
                // this button and every role but admin was refused on click.
                if (can('alertrule.write')) {
                    const un = document.createElement('button');
                    un.type = 'button';
                    un.className = 'small';
                    un.textContent = 'unmute';
                    un.title = 'Remove the mute; the next tier or the default applies on the next scan';
                    un.addEventListener('click', (ev) => { ev.stopPropagation(); unmuteSensor(s); });
                    th.appendChild(un);
                }
            } else {
                th.textContent = `warn ${s.threshold.warn ?? 'off'} / crit ${s.threshold.crit ?? 'off'} (${srcLabel})`;
            }
            card.appendChild(th);
        }
        if (p.sub) {
            const sub = document.createElement('div');
            sub.className = 'card-sub';
            sub.textContent = p.sub;
            card.appendChild(sub);
        }
        if (p.pct !== null && p.pct !== undefined && Number.isFinite(Number(p.pct))) {
            const bar = document.createElement('div');
            bar.className = 'bar';
            const fill = document.createElement('div');
            fill.className = 'bar-fill';
            fill.style.width = `${Math.max(0, Math.min(100, Number(p.pct)))}%`;
            bar.appendChild(fill);
            card.appendChild(bar);
        }
        wrap.appendChild(card);
    }
}

let lastSnmpRtt = null;
let lastAvailability = null;

let lastPollSlots = null;

// Flip one entity's tracked flag and re-render. The server ages any open
// alert for an untracked entity to source-removed within ALERT_MISSING_SCANS
// healthy scans - the same path a deleted device takes - so the message says
// what will happen rather than leaving a cleared-later alert to look like a
// page bug. Untracked interfaces keep their counters ticking (re-tracking has
// instant history); untracked sensors stop being polled at all.
async function setTracked(e, tracked) {
    const r = await api('/api/device/track', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: currentDevice,
            // The code is the identity; the index rides along for callers
            // without one. A parked row has no index and used to be
            // unreachable from this button (afternoon audit, finding 9).
            entities: [{ kind: e.kind || 'if', index: e.snmp_index, code: e.code, tracked }],
        }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('device-sub').textContent = r.detail || `track change refused (${r.status})`; return; }
    // AWAITED, or the re-render's count line lands after this message and
    // stomps it - the note explains a clearing that takes minutes, so losing
    // it means an operator watching an alert that "will not clear".
    if (currentDevice) await showDevice(currentDevice);
    // THE CONFIRMATION IS EARNED, not printed on any 200: the route names
    // what changed, and a no-op used to wear the same sentence as a
    // success above a button that still read "untrack" - the silent no-op
    // in a confirmation's clothing.
    const changed = (r.changed || []).some((c) => c.name === e.name);
    if (!changed) {
        $('device-sub').textContent = `${e.name}: nothing changed - the row already reads ${tracked ? 'tracked' : 'untracked'}, or it could not be matched`;
    } else if (!tracked) {
        $('device-sub').textContent = `${e.name} untracked - an open alert for it will clear as source-removed within a few scans`;
    }
}

// The button lives inside a clickable row/card, so it must not also open the
// chart - hence stopPropagation, same as the threshold gear.
function trackButton(e) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-track';
    b.textContent = e.tracked ? 'untrack' : 'track';
    b.title = e.tracked
        ? 'stop alerting and charting this - any open alert for it clears as source-removed'
        : 'watch this again';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); setTracked(e, !e.tracked); });
    return b;
}

// --- per-interface alert rules (2026-09-23) -----------------------------------
//
// THE GAP: sensor cards had a gear with Mute; interface rows had only
// untrack, which also stops the charts. The engine always honoured a
// per-interface override - the four interface rules resolve by code like any
// sensor - so this is the page catching up, not a new mechanism: the same
// /api/thresholds rows, the same three scopes, the engine's own kind names.
// Muting keeps polling and history; the open alert clears as source-removed.
const IF_RULES = [
    ['if-down', 'link down'], ['if-errors', 'errors'],
    ['if-discards', 'discards'], ['if-util', 'utilization'],
];
const IF_RULE_LABEL = new Map(IF_RULES);
let lastIfRuleDefaults = null;

function ifScopeWords(source, device) {
    return source === 'override' ? 'this interface'
        : source === 'host override' ? `every interface on ${device}`
            : source === 'kind override' ? 'every interface everywhere' : 'default';
}

/** The provenance badge on an interface row: which rules are muted, or that
 *  a threshold differs from the default. Null when everything is default -
 *  the quiet norm draws nothing. */
function ifRuleBadge(e) {
    if (!e.ifRules) return null;
    const muted = IF_RULES.filter(([k]) => e.ifRules[k]?.muted);
    const tuned = IF_RULES.filter(([k]) => !e.ifRules[k]?.muted
        && e.ifRules[k] && e.ifRules[k].source !== 'default' && e.ifRules[k].source !== 'none');
    if (muted.length === 0 && tuned.length === 0) return null;
    const lines = [
        ...muted.map(([k, l]) => `${l}: muted (${ifScopeWords(e.ifRules[k].source, currentDevice)})`),
        ...tuned.map(([k, l]) => `${l}: warn ${e.ifRules[k].warn ?? 'off'} / crit ${e.ifRules[k].crit ?? 'off'} (${ifScopeWords(e.ifRules[k].source, currentDevice)})`),
    ];
    const text = muted.length === IF_RULES.length ? 'muted'
        : muted.length > 0 ? `${muted.map(([, l]) => l).join(', ')} muted`
            : 'custom thresholds';
    // A span, not pill(): pill() builds a whole cell, and this sits inside
    // the name cell beside the interface's name.
    const b = document.createElement('span');
    b.className = muted.length > 0 ? 'badge warn if-rule-badge' : 'badge if-rule-badge';
    b.textContent = text;
    b.title = lines.join('\n') + (muted.length > 0 ? '\npolling and history continue; muted rules raise nothing' : '');
    return b;
}

/** Remove the mutes governing this interface, after naming each one. The
 *  scope comes from the server-resolved source, exactly as unmuteSensor
 *  finds its row, so precedence stays decided in the engine. */
async function unmuteInterface(e) {
    const muted = IF_RULES.filter(([k]) => e.ifRules?.[k]?.muted);
    if (muted.length === 0) return;
    const list = await api('/api/thresholds');
    if (list.status === 401) { showLogin(); return; }
    if (!list.ok) { window.alert(list.detail || `could not load overrides (${list.status})`); return; }
    const rows = new Map();
    const said = [];
    for (const [k, l] of muted) {
        const src = e.ifRules[k].source;
        const row = (list.overrides || []).find((o) => o.kind === k && (
            src === 'override' ? o.code === e.code
                : src === 'host override' ? (o.code === null && o.host === currentDevice)
                    : (o.code === null && o.host === null)));
        if (row && !rows.has(row.id)) { rows.set(row.id, row); said.push(`${l} (${ifScopeWords(src, currentDevice)})`); }
    }
    if (rows.size === 0) { window.alert('those mutes are already gone - refresh to see the current state'); return; }
    if (!window.confirm(`Remove ${rows.size === 1 ? 'this mute' : `these ${rows.size} mutes`}: ${said.join(', ')}? `
        + 'The next tier or the default applies on the next scan.')) return;
    for (const id of rows.keys()) {
        const r = await api('/api/thresholds/delete', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
        });
        if (r.status === 401) { showLogin(); return; }
        if (!r.ok) { window.alert(r.detail || `refused (${r.status})`); break; }
    }
    if (currentDevice) await showDevice(currentDevice);
}

/**
 * The per-interface control: a gear that opens a form ROW beneath the
 * interface. Which rule (all four, or one), which scope (this interface,
 * every interface on this device, every interface everywhere), levels for
 * the three rate rules, and Mute. Link down is a yes/no rule, so it offers
 * Mute alone.
 */
function ifRuleControl(e, tr) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'card-gear'; btn.textContent = '⚙';
    btn.title = 'Mute this interface\'s alerts, or set its error, discard and utilization thresholds';
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();   // the row itself opens the history chart
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('th-row')) { next.remove(); return; }
        const row = document.createElement('tr');
        row.className = 'th-row';
        const td = document.createElement('td');
        td.colSpan = tr.children.length;
        const f = document.createElement('form');
        f.className = 'th-form row';
        const which = document.createElement('select');
        for (const [v, l] of [['all', 'all alerts'], ...IF_RULES]) {
            const o = document.createElement('option'); o.value = v; o.textContent = l; which.appendChild(o);
        }
        const scope = document.createElement('select');
        for (const [v, l] of [['code', 'this interface'], ['host-kind', `every interface on ${currentDevice}`], ['kind', 'every interface everywhere']]) {
            const o = document.createElement('option'); o.value = v; o.textContent = l; scope.appendChild(o);
        }
        const warn = document.createElement('input'); warn.type = 'number'; warn.step = 'any'; warn.placeholder = 'warn'; warn.size = 6;
        const crit = document.createElement('input'); crit.type = 'number'; crit.step = 'any'; crit.placeholder = 'crit'; crit.size = 6;
        const note = document.createElement('input'); note.type = 'text'; note.placeholder = 'why (optional)'; note.size = 18;
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn-primary'; save.textContent = 'Set';
        const mute = document.createElement('button'); mute.type = 'button'; mute.textContent = 'Mute';
        mute.title = 'Suspend the chosen rule(s) at the chosen scope. Polling and history continue; an open alert clears as source-removed.';
        const msg = document.createElement('span'); msg.className = 'muted small';
        // Levels only mean something for the three rate rules. The inputs
        // prefill with what applies now: this row's override, else the
        // server's effective default.
        const syncLevels = () => {
            const k = which.value;
            const leveled = k !== 'all' && k !== 'if-down';
            for (const el of [warn, crit, save]) el.classList.toggle('hidden', !leveled);
            warn.value = ''; crit.value = '';
            if (!leveled) return;
            const cur = e.ifRules?.[k] && !e.ifRules[k].muted ? e.ifRules[k] : lastIfRuleDefaults?.[k];
            if (cur?.warn !== null && cur?.warn !== undefined) warn.value = String(cur.warn);
            if (cur?.crit !== null && cur?.crit !== undefined) crit.value = String(cur.crit);
        };
        which.addEventListener('change', syncLevels);
        syncLevels();
        const bodyFor = (kind, enabled) => ({
            kind,
            host: scope.value === 'host-kind' ? currentDevice : null,
            code: scope.value === 'code' ? e.code : null,
            warn: enabled && warn.value !== '' ? Number(warn.value) : null,
            crit: enabled && crit.value !== '' ? Number(crit.value) : null,
            enabled, note: note.value,
        });
        const finish = async (results) => {
            const bad = results.filter((r) => !r.ok);
            msg.textContent = bad.length === 0
                ? (results.length === 1 ? results[0].detail : `${results.length} rules suspended - live on the next scan`)
                : `${results.length - bad.length} of ${results.length} saved; refused: ${bad.map((r) => r.detail || r.status).join('; ')}`;
            if (bad.length === 0) {
                setTimeout(async () => { row.remove(); if (currentDevice) await showDevice(currentDevice); }, 1500);
                if (lastThresholds !== null) { const d = await api('/api/thresholds'); if (d.ok) renderThresholds(d); }
            }
        };
        f.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            finish([await saveThreshold(bodyFor(which.value, true))]);
        });
        mute.addEventListener('click', async () => {
            const kinds = which.value === 'all' ? IF_RULES.map(([k]) => k) : [which.value];
            // Everywhere is a fleet-wide decision made from one row, so it
            // is the one scope that asks first.
            if (scope.value === 'kind' && !window.confirm(
                `Mute ${which.value === 'all' ? 'every interface alert' : IF_RULE_LABEL.get(which.value)} on EVERY interface of EVERY device?`)) return;
            const results = [];
            for (const k of kinds) results.push(await saveThreshold(bodyFor(k, false)));
            finish(results);
        });
        f.append(which, scope, warn, crit, note, save, mute, msg);
        td.appendChild(f);
        row.appendChild(td);
        tr.after(row);
    });
    return btn;
}

// The open alerts for the device on screen, worst first then oldest - the
// same order as the Alerts section, because an operator who just read that
// page should not have to re-learn the sort here. Rows click through to the
// alert detail, the mirror of the device link on that page.
// The device page shows its worst few alerts and hands the rest to the Alerts
// page, which is built for a long list (index.html says why).
const DEVICE_ALERTS_SHOWN = 10;

function renderDeviceAlerts() {
    const block = $('device-alerts');
    if (currentDevice === null) { block.classList.add('hidden'); return; }
    const sev = { crit: 0, warn: 1 };
    const mine = (alertData.open || [])
        .filter((a) => a.host === currentDevice)
        .sort((a, b) => (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9)
            || String(a.first_breach_ts).localeCompare(String(b.first_breach_ts)));
    block.classList.toggle('hidden', mine.length === 0);
    if (mine.length === 0) return;
    $('device-alerts-title').textContent = `${mine.length} open alert${mine.length === 1 ? '' : 's'} on this device`;
    const tbody = block.querySelector('tbody');
    tbody.replaceChildren();
    const more = mine.length - DEVICE_ALERTS_SHOWN;
    $('device-alerts-more').classList.toggle('hidden', more <= 0);
    $('device-alerts-more-text').textContent = more > 0
        ? `showing the ${DEVICE_ALERTS_SHOWN} worst - ${more} more` : '';
    for (const a of mine.slice(0, DEVICE_ALERTS_SHOWN)) {
        const val = cell(fmtValue(a.value, a.unit), 'num');
        if (a.severity === 'crit') val.classList.add('cell-crit');
        else if (a.severity === 'warn') val.classList.add('cell-warn');
        const progress = stateProgress(a);
        const row = rowEl([
            pill(a.severity, `sev ${a.severity}`),
            a.state === 'active' ? cell('')
                : pill(progress === '' ? a.state : `${a.state} ${progress}`, `sev ${a.state}`),
            cell(a.label),
            val,
            cell(fmtValue(a.threshold, a.unit), 'num'),
            cell(a.raised_ts ? fmtAgo(a.raised_ts) : `breach ${fmtAgo(a.first_breach_ts)}`),
        ]);
        row.className = 'clickable';
        row.title = 'open this alert';
        row.addEventListener('click', () => { showSection('alerts'); showAlert(a.id); });
        tbody.appendChild(row);
    }
}

function renderEntities(data) {
    // A REDRAW IS A DATA REFRESH, and an open editor is user state the data
    // knows nothing about. The 10s refresh cycle re-renders this panel, and
    // re-rendering while a speed input or a threshold form is live wipes the
    // half-typed edit - so the cycle is skipped, not the edit. The next
    // cycle lands after the form is gone. This also covers the threshold
    // gear, which had the same latent wipe since it shipped.
    if (document.querySelector('#entities input, #sensor-cards .th-form')) return;
    if (data) {
        lastEntities = data.entities || [];
        lastEntitiesCapped = data.entitiesCapped === true;
        lastSnmpRtt = data.snmpRtt ?? null;
        lastPollSlots = data.pollSlots ?? null;
        lastAvailability = data.availability24h ?? null;
        lastIfRuleDefaults = data.ifRuleDefaults ?? null;
    }

    // THE SPLIT on kind (sensors slice): sensors become the cards above the
    // table; the table is interfaces alone. Tracked sensors were already
    // arriving in this payload and rendering as nonsense interface rows -
    // this split is the fix as much as the feature. The filter box stays an
    // interface filter, exactly as its placeholder says.
    renderSensorCards(lastEntities.filter((e) => e.kind && e.kind !== 'if'));

    const canTrack = can('device.track');
    const q = $('entity-filter').value.trim().toLowerCase();
    const rows = lastEntities.filter((e) => !e.kind || e.kind === 'if').filter((e) => q === ''
        || String(e.name ?? '').toLowerCase().includes(q)
        || String(e.alias ?? '').toLowerCase().includes(q)
        || String(e.descr ?? '').toLowerCase().includes(q));

    const shown = rows.slice(0, RENDER_CAP);
    // SAID, NOT SILENT (2026-09-30): past the cap the table stopped at a
    // hundred rows while the heading counted all of them. The server's own
    // cap is named too - a chassis past it would otherwise be counted short.
    const moreNote = [];
    if (rows.length > shown.length) {
        moreNote.push(`showing the first ${shown.length} of ${rows.length} interfaces, by index - type in the filter to find the rest`);
    }
    if (lastEntitiesCapped) {
        moreNote.push('this device reports more interfaces and sensors than the page receives (the first 500)');
    }
    $('entities-more').textContent = moreNote.join('; ');
    $('entities-more').classList.toggle('hidden', moreNote.length === 0);
    const tbody = $('entities').querySelector('tbody');
    tbody.replaceChildren();
    for (const e of shown) {
        // STALE IS PRESENT-WHEN-TRUE, and this is where that one-way door
        // finally reaches a human: a stale row shows WHEN it went quiet
        // instead of showing its last numbers as if they were current. "0 bps"
        // and "we have not heard about this port" must never look the same.
        const stale = e.lv_stale_since !== null && e.lv_stale_since !== undefined;
        const errs = Math.max(e.lv_v2 ?? 0, e.lv_v3 ?? 0);
        const discards = Math.max(e.lv_v4 ?? 0, e.lv_v5 ?? 0);
        const errCell = cell(fmtRate(e.lv_v2 === null ? null : errs), 'num');
        if (errs > 0) errCell.classList.add('cell-warn');
        // Discards warn the same way errors do: a non-zero rate in either
        // column is the same class of signal, and highlighting one while the
        // other renders plain splits the severity vocabulary for no reason.
        const discCell = cell(fmtRate(e.lv_v4 === null ? null : discards), 'num');
        if (discards > 0) discCell.classList.add('cell-warn');

        const state = e.oper_status === 1 ? 'up'
            : e.oper_status === 2 ? (e.admin_status === 2 ? 'admin down' : 'down')
                : 'unknown';
        // An untracked interface shows identity and state, never readings:
        // its counters still tick in the store (kept for instant history on
        // re-track) but rendering them would make "not watched" look
        // watched. The dim plus the empty cells is the honest rendering of
        // "we saw this and chose not to alert on it".
        const trackTd = document.createElement('td');
        if (canTrack) trackTd.appendChild(trackButton(e));
        // The STALE PILL (dup-interfaces remedy 5): the readings were already
        // blanked, but the state pill still wore a frozen green "up" - the
        // last thing the port said before its index left the agent's table,
        // shown as if it were a current observation. A stale row's state is
        // not known, so the pill says the one thing that IS known. The title
        // carries the diagnosis, because a leftover generation and a removed
        // port look identical in this row and differ in what to do next.
        const stalePill = () => {
            const p = pill('stale', 'badge stale');
            p.title = `the device answers, but this interface is gone from its agent's table (since ${fmtAgo(e.lv_stale_since)}). `
                + 'A duplicate row with the same name that reads normally means this is a leftover '
                + 'generation from an ifIndex change - untrack it and cleanup removes it after a week. '
                + 'No duplicate means the port itself was removed.';
            return p;
        };
        // The name cell carries the rule badge: which alerts are muted on
        // this interface, or that its thresholds differ from the default.
        const nameCell = () => {
            const c = cell(e.name);
            const b = ifRuleBadge(e);
            if (b) c.append(' ', b);
            return c;
        };
        const tr = rowEl(e.tracked ? [
            nameCell(),
            cell(e.alias || e.descr, 'muted'),
            speedCell(e),
            stale ? stalePill()
                : pill(state, `badge ${state === 'up' ? 'ok' : state === 'down' ? 'fail' : ''}`),
            cell(stale ? '' : fmtBps(e.lv_v0), 'num'),
            cell(stale ? '' : fmtBps(e.lv_v1), 'num'),
            stale ? cell('', 'num') : errCell,
            stale ? cell('', 'num') : discCell,
            stale
                ? cell(`no reading since ${fmtAgo(e.lv_stale_since)}`, 'muted')
                : cell(fmtAgo(e.lv_ts)),
        ] : [
            nameCell(),
            cell(e.alias || e.descr, 'muted'),
            speedCell(e),
            // An untracked STALE row wears the stale pill too: "untracked"
            // is already the whole row's rendering (dim, no readings, the
            // not-watched note restates it), so the pill slot carries the
            // rarer fact - this row is a ghost - which is what makes the
            // untracked clones from an index re-deal pinpointable among
            // the live untracked rows they hide between.
            stale ? stalePill() : pill('untracked', 'badge'),
            cell('', 'num'), cell('', 'num'), cell('', 'num'), cell('', 'num'),
            stale
                ? cell(`not watched - no reading since ${fmtAgo(e.lv_stale_since)}, cleanup removes it after a week if a live duplicate exists`, 'muted')
                : cell('not watched - no alerts, no charts', 'muted'),
        ]);
        tr.appendChild(trackTd);
        // The rule gear beside untrack, admin-only like the sensor gear
        // (alertrule.write is an admin permission). Offered on tracked rows
        // only - an untracked interface raises nothing to mute - while an
        // unmute stays reachable on any row that carries a mute.
        if (can('alertrule.write') && e.code) {
            if (e.tracked) {
                const g = ifRuleControl(e, tr);
                trackTd.appendChild(g);
            }
            if (IF_RULES.some(([k]) => e.ifRules?.[k]?.muted)) {
                const un = document.createElement('button');
                un.type = 'button';
                un.className = 'btn-track';
                un.textContent = 'unmute';
                un.title = 'Remove the mutes on this interface; the next tier or the default applies on the next scan';
                un.addEventListener('click', (ev) => { ev.stopPropagation(); unmuteInterface(e); });
                trackTd.appendChild(un);
            }
        }
        // Slice 28: an interface on the 32-bit fallback says so where the
        // numbers are read - the reader of a rate deserves to know it came
        // through wrap arithmetic with a plausibility cap, and that this
        // agent cannot show sustained rates past what Counter32 can carry
        // between polls.
        if (e.hc_missing) {
            tr.title = 'this agent serves no 64-bit (ifHC) counters for this interface - '
                + 'rates use 32-bit counters with wrap correction, capped at plausibility'
                + (e.tracked ? '; click for history' : '');
        }
        if (e.tracked) {
            tr.className = 'clickable';
            if (!e.hc_missing) tr.title = 'click for history';
            tr.addEventListener('click', () => openChart(e));
        } else {
            tr.className = 'untracked';
        }
        tbody.appendChild(tr);
    }

    // Counts split the same way the render does: interfaces against
    // interfaces, sensors named separately - "25 of 29 interface(s)" when 4
    // of the 29 are sensors was the count lying by category.
    const ifTotal = lastEntities.filter((e) => !e.kind || e.kind === 'if').length;
    const sensorTotal = lastEntities.length - ifTotal;
    // Untracked entities are IN the totals now (the page shows them), so the
    // count says so - "29 interface(s)" where 4 alert on nothing is the count
    // lying by omission.
    const untracked = lastEntities.filter((e) => !e.tracked).length;
    const plus = lastEntitiesCapped ? '+' : '';
    const ifText = rows.length === ifTotal
        ? `${ifTotal}${plus} interface(s)` : `${rows.length} of ${ifTotal}${plus} interface(s)`;
    $('device-sub').textContent = (sensorTotal > 0
        ? `${ifText}, ${sensorTotal} sensor(s)` : ifText)
        + (untracked > 0 ? ` (${untracked} untracked)` : '');

    // THE DEVICE'S STATE, RENDERED HERE so the poll loop maintains it: refresh()
    // calls renderDevices BEFORE re-rendering the open device, so lastDevices
    // is current by the time this runs and the banner ages without its own
    // fetch.
    //
    // The gap this closes: the roster said down and this panel said nothing,
    // so a device whose agent had been dead for 43 minutes looked entirely
    // healthy - the interface rows keep their last known values, and only a
    // muted "43m ago" in a column nobody reads disagreed. Stale data that
    // still looks like data is the worst failure an instrument has, and this
    // page had it.
    //
    // SNMP AND PING ARE SHOWN SEPARATELY, never merged, for the same reason
    // the roster keeps two columns: "answers ping, agent dead" is a diagnosis
    // and a merged verdict erases it.
    const dev = currentDevice === null ? null : lastDevices.find((d) => d.name === currentDevice);
    const state = $('device-state');
    state.replaceChildren();
    const notes = [];
    if (dev) {
        // OFF is a state, not a fault (slice 25): declared transient AND dark
        // on both instruments. One line replaces the SNMP DOWN and not-pinging
        // pair because "off" is the diagnosis that subsumes them - but ONLY
        // when ping is dark too: a transient device that answers ping while
        // its agent is dead is a machine that is ON with a broken agent, and
        // that is a fault on any device, transient or not.
        const isOff = dev.transient === true && dev.status === 'down'
            && dev.reach_state !== 'up' && dev.reach_state !== 'degraded';
        // PING-ONLY (slice 35): reach is the whole story, so the SNMP
        // vocabulary is not just unhelpful here, it is false - "the agent has
        // not answered" about a device that was never asked would be the page
        // inventing a fault.
        if (dev.snmp_enabled === false) {
            if (dev.reach_state === 'down') {
                notes.push(['not answering', `no ICMP response since ${fmtAgo(dev.reach_since_ts) || 'the last transition'}`
                    + ' - this device is watched by ping only, so this is everything there is to know']);
            } else if (dev.reach_state === 'degraded') {
                notes.push(['ping degraded', `intermittent ICMP since ${fmtAgo(dev.reach_since_ts) || 'the last transition'}`]);
            } else if (dev.reach_state === 'unknown') {
                notes.push(['not probed yet', 'added, and the next ping sweep will say - within one sweep interval']);
            }
        } else if (!dev.last_poll_ts) {
            notes.push(['pending', 'added, not yet polled - the first poll is due within one interval']);
        } else if (isOff) {
            notes.push(['off', `transient device, not answering since ${fmtAgo(dev.last_seen_ts) || 'the last successful poll'}`
                + ' - off is a state for this device, not a fault. Polling continues;'
                + ' stats resume on the poll after power-on. Readings below are the'
                + ' last values received, not current']);
        } else if (dev.status === 'down') {
            notes.push(['SNMP DOWN', `the agent has not answered since ${fmtAgo(dev.last_seen_ts) || 'the last successful poll'}`
                + ' - readings below are the last values received, not current']);
        } else if (dev.last_poll_ts
            && Date.now() - Date.parse(dev.last_poll_ts) > (dev.poll_interval_s || 30) * 3000) {
            // The third blank-reason (slice 25): nobody has LOOKED lately, so
            // what is below might be about anything - a different claim from
            // "we looked and it did not answer", and the same rule the wall
            // and the scan share: three times the device's own interval.
            notes.push(['stale', `no poll since ${fmtAgo(dev.last_poll_ts)} - the collector has not looked lately,`
                + ' so readings below may be out of date']);
        }
        if (isOff || dev.snmp_enabled === false) {
            // Both cases already said everything true about reachability
            // above; repeating it as a second line would be the page
            // describing one fact twice in two vocabularies.
        } else if (dev.reach_state === 'down') {
            notes.push(['not pinging', `no ICMP response since ${fmtAgo(dev.reach_since_ts) || 'the last transition'}`]);
        } else if (dev.reach_state === 'degraded') {
            notes.push(['ping degraded', `intermittent ICMP since ${fmtAgo(dev.reach_since_ts) || 'the last transition'}`]);
        } else if (dev.status === 'down') {
            // The diagnosis worth naming: the box is up and its agent is not.
            notes.push(['but pinging', `the host answers ICMP, so this is the SNMP agent or its credential (${dev.credential_ref || 'fleet default'}), not the device`]);
        }
        if ((dev.open_alerts ?? 0) > 0) {
            notes.push([`${dev.open_alerts} open alert(s)`, `worst severity ${dev.worst ?? 'unknown'}`]);
        }

        // RESPONSIVENESS. Three numbers the collector already had and never
        // showed: SNMP round-trip (median over the last hour, from
        // samples.rtt_ms), live ping RTT, and poll lag - how late this
        // device's poll started against when it was due. Slow SNMP agents
        // were a hidden killer in the parent suite precisely because nothing
        // said WHICH device was slow. The slot share is the number that says
        // what a slow one costs: its RTT as a fraction of the fleet's whole
        // poll budget for one interval.
        //
        // Always shown when there is anything to show, muted, because "is it
        // fine" is a question too. It becomes a NOTE - amber, in the banner
        // proper - only past a threshold, so the healthy case stays quiet.
        const parts = [];
        if (lastSnmpRtt && lastSnmpRtt.samples > 0) {
            const med = Math.round(lastSnmpRtt.medianMs);
            parts.push(`SNMP ${med} ms median over the last hour (worst ${Math.round(lastSnmpRtt.maxMs)} ms)`);
            // Slot share only when the server told us its slot count; a
            // typed 24 here would be a constant that drifts.
            const share = lastPollSlots ? (lastSnmpRtt.medianMs / 1000) / ((dev.poll_interval_s || 30) * lastPollSlots) * 100 : null;
            if (med >= 2000) {
                notes.push(['slow agent', `answers SNMP in ${(med / 1000).toFixed(1)}s median - it holds a poll slot for that long every interval`
                    + (share !== null ? `, about ${share.toFixed(1)}% of the fleet's poll budget on its own` : '')
                    + '. Not starvation (slots are parallel), but the number that says how close it is.']);
            }
        }
        if (dev.ping_rtt_ms !== null && dev.ping_rtt_ms !== undefined) {
            parts.push(`ping ${dev.ping_rtt_ms < 1 ? '<1' : Math.round(dev.ping_rtt_ms)} ms`);
        }
        if (dev.poll_lag_ms !== null && dev.poll_lag_ms !== undefined) {
            const lag = Math.round(dev.poll_lag_ms);
            parts.push(`poll lag ${lag < 1000 ? `${lag} ms` : `${(lag / 1000).toFixed(1)}s`}`);
            // Lag past a third of the interval means the scheduler is not
            // reaching this device on time - either it is being starved or the
            // fleet has outgrown its slots. Either way it is a finding.
            if (lag > (dev.poll_interval_s || 30) * 1000 / 3) {
                notes.push(['polled late', `the last poll started ${(lag / 1000).toFixed(1)}s after it was due - the scheduler is not keeping up with this device`]);
            }
        }
        // A ping-only device HAS no credential (slice 36) - naming one it
        // never uses is the page describing a machine it is not looking at.
        if (dev.credential_ref && dev.snmp_enabled !== false) parts.push(`credential ${dev.credential_ref}`);
        if (parts.length > 0) {
            const line = factLine('responsiveness', parts.join('  -  '));
            line.classList.add('muted');
            // The line is the summary; the CHART is the investigation. Two
            // instruments can fill it now, so the gate is "is there ANY
            // history" - gating on SNMP samples alone left a ping-only
            // device with no way to reach the latency chart this slice
            // exists to draw, which is the feature hiding behind its own
            // precondition.
            const hasSnmp = lastSnmpRtt && lastSnmpRtt.samples > 0;
            const hasPing = dev.snmp_enabled === false || dev.reach_state !== 'unknown';
            if (hasSnmp || hasPing) {
                line.classList.add('clickable');
                line.title = hasSnmp
                    ? 'click for round-trip history - SNMP and ping'
                    : 'click for ping latency history';
                line.addEventListener('click', () => openRttChart(currentDevice));
            }
            state.appendChild(line);
        }
        // Availability (easy-win E4), from the misses ping_samples already
        // distinguishes from absence: probed-and-unanswered is a NULL-rtt
        // row, not-probed is no row, and the fraction only exists because
        // that line was drawn at the schema. Absent history says nothing -
        // a device with no probes must not read as 100%.
        if (lastAvailability && lastAvailability.probes > 0) {
            const a = lastAvailability;
            const pct = (100 * (a.probes - a.misses)) / a.probes;
            const line = factLine('availability (24h)',
                `${pct.toFixed(pct === 100 ? 0 : 1)}% - answered ${a.probes - a.misses} of ${a.probes} probes`);
            line.classList.add('muted');
            if (a.misses > 0) line.classList.add('cell-warn');
            state.appendChild(line);
        }
    }
    for (const [k, v] of notes) state.appendChild(factLine(k, v));
    state.classList.toggle('hidden', notes.length === 0 && state.childElementCount === 0);
    const msg = shown.length < rows.length
        ? `showing ${shown.length} of ${rows.length} - narrow the filter to see the rest`
        : rows.length === 0 ? 'nothing matches that filter' : '';
    const el = $('device-msg');
    el.textContent = msg;
    el.classList.toggle('hidden', msg === '');
}

/**
 * The device's declarations and grouping ON the name line (2026-09-25,
 * operator): transient and muted as badges beside the name, location and
 * application after the counts. The controls that set them fold away behind
 * Modify, so the line is where an operator reads them. Blank parts are left
 * out, not shown as placeholders - the roster's rule.
 */
function renderDeviceHeader() {
    if (currentDevice === null) return;
    const d = lastDevices.find((x) => x.name === currentDevice);
    const badges = $('device-badges');
    badges.replaceChildren();
    if (d?.transient === true) {
        const t = badge('transient', 'badge maint');
        t.title = 'declared transient: off is a state, not a fault - device-down never raises';
        badges.appendChild(t);
    }
    if (d?.alerts_muted === true) {
        if (badges.childElementCount > 0) badges.appendChild(document.createTextNode(' '));
        const m = badge('muted', 'badge maint');
        m.title = 'alerts muted: nothing on this device raises - down, interfaces, sensors';
        badges.appendChild(m);
    }
    const grp = $('device-grouping');
    grp.replaceChildren();
    for (const [label, value] of [['location', d?.location], ['application', d?.application]]) {
        if (!value) continue;
        const part = document.createElement('span');
        const k = document.createElement('span');
        k.className = 'muted';
        k.textContent = `${label} `;
        part.append(k, document.createTextNode(value));
        grp.appendChild(part);
    }
}

// MODIFY (2026-09-25): the edit block is folded by default and remembers the
// choice per browser, so an operator doing a round of edits is not re-opening
// it on every device. Browser storage can be absent (private windows), and
// the page works the same without it - folded.
const EDIT_OPEN_KEY = 'rscanvas.deviceEditOpen';
function setDeviceEditOpen(open) {
    $('device-edit').classList.toggle('hidden', !open);
    $('device-modify').setAttribute('aria-expanded', String(open));
    $('device-modify').textContent = open ? 'Done' : 'Modify';
}
$('device-modify').addEventListener('click', () => {
    const open = $('device-edit').classList.contains('hidden');
    setDeviceEditOpen(open);
    try { localStorage.setItem(EDIT_OPEN_KEY, open ? '1' : '0'); } catch { /* per-browser nicety only */ }
});
function deviceEditRemembered() {
    try { return localStorage.getItem(EDIT_OPEN_KEY) === '1'; } catch { return false; }
}

async function showDevice(name) {
    // currentDevice is set NOW and re-checked after the fetch: two quick row
    // clicks are two of these in flight, and the first response landing
    // SECOND would otherwise render the wrong device's entities under the
    // right title - the openChart guard's rule, which this function
    // documented for charts and did not apply to itself (2026-09-01 review).
    // A different device (or the first one) starts without the last page's
    // chart; the same device re-shown after an edit keeps it open.
    const arriving = currentDevice !== name;
    if (arriving) closeChart();
    currentDevice = name;
    $('roster-panel').classList.add('hidden');
    $('device-panel').classList.remove('hidden');
    syncDeviceToolbar();
    $('device-title').textContent = name;
    $('device-sub').textContent = 'loading...';
    $('entity-filter').value = '';
    // Filled from the ROSTER row already in hand rather than from a second
    // fetch: /api/device is the entity drill-down and has a pinned query
    // budget, and adding two columns to it to save a lookup the client can do
    // for free is the wrong trade.
    const known = lastDevices.find((d) => d.name === name);
    $('dev-location').value = known?.location ?? '';
    $('dev-application').value = known?.application ?? '';
    $('dev-transient').checked = known?.transient === true;
    $('transient-msg').textContent = '';
    $('dev-muted').checked = known?.alerts_muted === true;
    $('mute-msg').textContent = '';
    if (arriving) setDeviceEditOpen(deviceEditRemembered());
    renderDeviceHeader();
    $('grouping-msg').textContent = '';
    $('rename-msg').textContent = '';
    // The move form starts from where the device IS, so an operator sees
    // the current address before typing over it.
    $('dev-newhost').value = known?.host ?? '';
    $('dev-newport').value = known?.snmp_port ?? '';
    $('address-msg').textContent = '';
    $('dev-newname').value = '';
    $('maint-dev-msg').textContent = '';
    // NAVIGATION ABANDONS EDITORS (2026-08-27). The editor guard in
    // renderEntities protects a live edit from the 10s refresh - but on a
    // page CHANGE the editor belongs to the device being LEFT, and the
    // guard turned it into a deadlock: an orphaned threshold form blocked
    // the very render that would have removed it, freezing every later
    // device page at "loading..." wearing the previous device's body.
    // Found on DC-2, dressed in FW-1's interfaces, with the day-old gear
    // form visible in the operator's own screenshot. Clearing both
    // containers drops the orphaned editors AND the stale content in one
    // move - a loading page shows loading, never the last device's
    // numbers as if they were this one's.
    $('sensor-cards').replaceChildren();
    $('entities').querySelector('tbody').replaceChildren();
    renderDeviceMaint();
    renderDeviceAlerts();
    freshenShown();
    const r = await api(`/api/device?name=${encodeURIComponent(name)}`);
    if (r.status === 401) { showLogin(); return; }
    if (currentDevice !== name) return;
    if (!r.ok) {
        $('device-sub').textContent = r.detail || `could not load (${r.status})`;
        return;
    }
    renderEntities(r);
    // PING-ONLY DEVICES OPEN ON THEIR CHART (2026-09-25, operator). Latency
    // is the only history such a device has, and it sat behind a click on
    // the responsiveness line that nothing marked as clickable enough. Once
    // per arrival: a chart the operator closes stays closed until they come
    // back, and the 10s refresh never reopens it.
    if (arriving && known?.snmp_enabled === false && currentDevice === name && chartEntity === null) {
        openRttChart(name);
    }
}

function showRoster() {
    currentDevice = null;
    closeChart();
    $('device-panel').classList.add('hidden');
    $('roster-panel').classList.remove('hidden');
    syncDeviceToolbar();
}

/**
 * The Devices toolbar: "Back to devices" while a device is open, "+ Add
 * device" for an admin. The panel carrying them is shown to every role so the
 * Back button is everyone's, and hidden when it would be empty - a viewer on
 * the device list has neither button to see (2026-09-24).
 */
function syncDeviceToolbar() {
    const open = currentDevice !== null;
    $('device-back').classList.toggle('hidden', !open);
    if (section === 'devices') $('onboard-panel').classList.toggle('hidden', !can('device.create') && !open);
}

// Rename: the server carries the name across alerts and overrides; the
// client's job is to follow it - the open page, the roster, the refresh -
// without a reload, and to say what moved, because "3 alerts carried"
// is the reassurance that the outage on the old name did not just vanish.
$('rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentDevice === null) return;
    const to = $('dev-newname').value.trim();
    const msg = $('rename-msg');
    if (to === '') { msg.textContent = 'type the new name'; return; }
    const r = await api('/api/device/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: currentDevice, newName: to }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { msg.textContent = r.detail || `refused (${r.status})`; return; }
    const from = currentDevice;
    currentDevice = r.name;
    $('device-title').textContent = r.name;
    $('dev-newname').value = '';
    // Every name-keyed row the server carried is named here, because the
    // point of saying "3 alerts carried" is that nothing quietly vanished -
    // and windows, policies and board tiles used to vanish (review 7).
    const carried = [
        [r.alerts, 'alert'], [r.overrides, 'override'], [r.windows, 'maintenance window'],
        [r.policies, 'notify policy'], [r.boards, 'board'],
    ].filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`);
    msg.textContent = `renamed from ${from}${carried.length ? `, carried: ${carried.join(', ')}` : ''}`;
    await refresh();
});

// Move: the server changes where the device is polled and probed from the
// next tick and keeps everything else - entities, history, alerts, boards.
$('address-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentDevice === null) return;
    const host = $('dev-newhost').value.trim();
    const portRaw = $('dev-newport').value.trim();
    const msg = $('address-msg');
    if (host === '') { msg.textContent = 'type the new address'; return; }
    const body = { name: currentDevice, host };
    if (portRaw !== '') body.snmp_port = Number(portRaw);
    const r = await api('/api/device/address', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { msg.textContent = r.detail || `refused (${r.status})`; return; }
    msg.textContent = `moved to ${r.host}:${r.snmp_port} - polled there on the next tick`;
    await refresh();
});

$('grouping-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentDevice === null) return;
    const r = await api('/api/device/grouping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: currentDevice,
            location: $('dev-location').value,
            application: $('dev-application').value,
        }),
    });
    if (r.status === 401) { showLogin(); return; }
    // The server's answer, not the form's - it trims, caps at 120 characters
    // and turns blank into null, so echoing what was typed would show the
    // operator a value the database does not hold.
    $('grouping-msg').textContent = r.ok
        ? `saved: ${r.location ?? '(no location)'} / ${r.application ?? '(no application)'}`
        : (r.detail || `refused (${r.status})`);
    if (r.ok) {
        $('dev-location').value = r.location ?? '';
        $('dev-application').value = r.application ?? '';
        // The roster is stale the instant this succeeds, and it is one panel
        // away. Refetch rather than patch the cached row: a client-side edit
        // that diverges from the server is the bug this avoids for free.
        const d = await api('/api/devices');
        if (d.ok) renderDevices(d);
    }
});

// Slice 25 quiet 2: the transient declaration, saved the moment it is made.
// A checkbox with a separate Save button invites the half-saved state; the
// change event IS the declaration. Flipping it on an alerting device is the
// recovery path - the next scan emits severity null and the alert clears
// through the ordinary counters.
$('dev-transient').addEventListener('change', async () => {
    if (currentDevice === null) return;
    const want = $('dev-transient').checked;
    const r = await api('/api/device/transient', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: currentDevice, transient: want }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) {
        $('dev-transient').checked = !want;   // the declaration did not take
        $('transient-msg').textContent = r.detail || `refused (${r.status})`;
        return;
    }
    // State-labelled, both ways (operator finding: the first wording read
    // strangely against the opposite checkbox state).
    $('transient-msg').textContent = want
        ? 'SET - an open device-down clears on the next scan'
        : 'UNSET - device-down raises normally again';
    const d = await api('/api/devices');
    if (d.ok) renderDevices(d);
});

// Slice 54: mute the whole device, saved on toggle for the same reason as
// transient above - the change IS the decision, and a separate Save button
// invites the half-saved state.
$('dev-muted').addEventListener('change', async () => {
    if (currentDevice === null) return;
    const want = $('dev-muted').checked;
    const r = await api('/api/devices/mute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names: [currentDevice], muted: want }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) {
        $('dev-muted').checked = !want;   // the mute did not take
        $('mute-msg').textContent = r.detail || `refused (${r.status})`;
        return;
    }
    $('mute-msg').textContent = want
        ? 'MUTED - nothing new raises, and anything open clears within a few scans'
        : 'UNMUTED - anything still true raises again on the next scan';
    const d = await api('/api/devices');
    if (d.ok) renderDevices(d);
});

$('device-back').addEventListener('click', showRoster);
$('device-filter').addEventListener('input', () => renderDevices(null));
$('device-scope').addEventListener('change', () => { deviceSort = null; renderDevices(null); });
$('entity-filter').addEventListener('input', () => renderEntities(null));

// Only the identity header is static; the rest wire their sort when
// renderRosterHeader creates them.
for (const th of $('devices').querySelectorAll('thead th[data-sort]')) {
    th.className = 'clickable';
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (DEVICE_SORTS[key]) { deviceSort = key; renderDevices(null); }
    });
}

// --- health -------------------------------------------------------------------
//
// The instrument the fork was built around, made the operators' own: per-
// thread worst gaps (rule 6 says "visible in the UI" - this is that), lane
// occupancy, and the database's self-checks. Problems render VERBATIM: they
// were written as operator sentences on the server and rewording them here
// would be a second place for the words to rot.

// --- maintenance windows (slice 22) ---------------------------------------------
//
// A window is OPERATIONAL STATE, not configuration: it lives on System next
// to health, shows on the device page it covers, and marks every alert it
// suppresses. The UI is load-bearing here in one specific way: a suppressed
// alert must be VISIBLE - if the markers ever go missing, the feature has
// quietly become the silent all-quiet it was designed to refuse.

function windowMatches(w, d) {
    return w.scope === 'all'
        || (w.scope === 'device' && w.target === d.name)
        || (w.scope === 'location' && w.target === (d.location ?? ''))
        || (w.scope === 'application' && w.target === (d.application ?? ''));
}

function fmtWhen(ts) {
    return new Date(ts).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

function renderMaint() {
    const tbody = $('maint-table').querySelector('tbody');
    tbody.replaceChildren();
    for (const w of maintData) {
        const c = cell('');
        // Everyone reads the windows; only alert.suppress may end one.
        if (can('alert.suppress')) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', async () => {
                const r = await api(`/api/maintenance?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' });
                $('maint-msg').textContent = r.ok
                    ? 'window cancelled - suppressed alerts still active are delivered on the next pass'
                    : (r.detail || `refused (${r.status})`);
                refresh();
            });
            c.appendChild(cancel);
        }
        tbody.appendChild(rowEl([
            pill(w.active ? 'active' : 'upcoming', w.active ? 'badge maint' : 'badge'),
            cell(w.scope === 'all' ? 'everything' : `${w.scope}: ${w.target}`),
            cell(fmtWhen(w.starts_ts)),
            cell(fmtWhen(w.ends_ts)),
            cell(w.note ?? '', 'muted'),
            cell(w.created_by ?? '', 'muted'),
            c,
        ]));
    }
    $('no-maint').classList.toggle('hidden', maintData.length > 0);
    $('maint-table').classList.toggle('hidden', maintData.length === 0);
    renderDeviceMaint();
}

function renderDeviceMaint() {
    if (currentDevice === null) return;
    const box = $('dev-maint');
    const d = lastDevices.find((x) => x.name === currentDevice);
    const mine = d ? maintData.filter((w) => windowMatches(w, d)) : [];
    box.replaceChildren();
    for (const w of mine) {
        const line = document.createElement('div');
        const what = w.scope === 'all' ? 'everything' : `${w.scope} ${w.target}`;
        line.textContent = `${w.active ? 'IN MAINTENANCE' : 'maintenance scheduled'}`
            + ` (${what}) until ${fmtWhen(w.ends_ts)}${w.note ? ` - ${w.note}` : ''}`;
        box.appendChild(line);
    }
    box.classList.toggle('hidden', mine.length === 0);
}

// The verbatim-typing complaint (2026-08-27): group fields now SUGGEST the
// values that exist, through the endpoint the axis summary already had.
// Datalists rather than selects on purpose - typing a new value stays legal
// (a window for a group you are about to create is a plan, not an error);
// the suggestions just make the existing ones one keystroke away.
async function fillGroupSuggestions(axis, listId) {
    const r = await api(`/api/device/groups?axis=${encodeURIComponent(axis)}`);
    if (!r.ok) return;
    const dl = $(listId);
    dl.replaceChildren();
    for (const g of r.groups || []) {
        if (g.value === null || g.value === undefined) continue;
        const o = document.createElement('option');
        o.value = g.value;
        dl.appendChild(o);
    }
}
$('inv-axis').addEventListener('change', () => fillGroupSuggestions($('inv-axis').value, 'group-values'));
function fillMaintTargets() {
    const scope = $('maint-scope').value;
    if (scope === 'location' || scope === 'application') {
        fillGroupSuggestions(scope, 'maint-targets');
    } else if (scope === 'device') {
        const dl = $('maint-targets');
        dl.replaceChildren();
        for (const d of lastDevices) {
            const o = document.createElement('option');
            o.value = d.name;
            dl.appendChild(o);
        }
    } else {
        $('maint-targets').replaceChildren();
    }
}
$('maint-scope').addEventListener('change', fillMaintTargets);
$('maint-scope').addEventListener('focus', fillMaintTargets);

// --- notify policies (slice 25, quiet 1) --------------------------------------
//
// The standing sibling of the windows above: raises but never pages, for the
// Dev/Test class the operator named. Same visibility discipline - a policy
// marks every alert it covers, lives on System where anyone may read why the
// pager is quiet, and the audit trail records who declared it.

let policyData = [];

function renderPolicies() {
    const tbody = $('policy-table').querySelector('tbody');
    tbody.replaceChildren();
    for (const p of policyData) {
        const c = cell('');
        // Everyone reads the policies; only alert.suppress may drop one.
        if (can('alert.suppress')) {
            const drop = document.createElement('button');
            drop.type = 'button';
            drop.textContent = 'Drop';
            drop.addEventListener('click', async () => {
                const r = await api(`/api/policy?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
                $('policy-msg').textContent = r.ok
                    ? 'policy dropped - anything it was withholding is delivered on the next pass'
                    : (r.detail || `refused (${r.status})`);
                refresh();
            });
            c.appendChild(drop);
        }
        tbody.appendChild(rowEl([
            cell(`${p.scope}: ${p.target}`),
            cell(p.note ?? '', 'muted'),
            cell(p.created_by ?? '', 'muted'),
            cell(fmtWhen(p.created_ts), 'muted'),
            c,
        ]));
    }
    $('no-policy').classList.toggle('hidden', policyData.length > 0);
    $('policy-table').classList.toggle('hidden', policyData.length === 0);
}

function fillPolicyTargets() {
    const scope = $('policy-scope').value;
    if (scope === 'location' || scope === 'application') {
        fillGroupSuggestions(scope, 'policy-targets');
    } else {
        const dl = $('policy-targets');
        dl.replaceChildren();
        for (const d of lastDevices) {
            const o = document.createElement('option');
            o.value = d.name;
            dl.appendChild(o);
        }
    }
}
$('policy-scope').addEventListener('change', fillPolicyTargets);
$('policy-scope').addEventListener('focus', fillPolicyTargets);

$('policy-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = $('policy-scope').value;
    const target = $('policy-target').value.trim();
    const note = $('policy-note').value.trim();
    const r = await api('/api/policy', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, target, note: note === '' ? undefined : note }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('policy-msg').textContent = r.ok
        ? (r.detail || 'policy standing - covered alerts raise and show, and never page')
        : (r.detail || `refused (${r.status})`);
    if (r.ok) { $('policy-target').value = ''; $('policy-note').value = ''; refresh(); }
});

$('maint-dev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentDevice === null) return;
    const minutes = Number($('dev-maint-min').value);
    const note = $('dev-maint-note').value.trim();
    const r = await api('/api/maintenance', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'device', target: currentDevice, minutes,
            note: note === '' ? undefined : note }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('maint-dev-msg').textContent = r.ok
        ? `window open until ${fmtWhen(r.ends)} - alerts raise but do not page`
        : (r.detail || `refused (${r.status})`);
    if (r.ok) { $('dev-maint-note').value = ''; refresh(); }
});

$('maint-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = $('maint-scope').value;
    const target = $('maint-target').value.trim();
    const minutes = Number($('maint-min').value);
    const note = $('maint-note').value.trim();
    const r = await api('/api/maintenance', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, target: scope === 'all' ? undefined : target,
            minutes, note: note === '' ? undefined : note }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('maint-msg').textContent = r.ok
        ? `window open until ${fmtWhen(r.ends)}`
        : (r.detail || `refused (${r.status})`);
    if (r.ok) { $('maint-target').value = ''; $('maint-note').value = ''; refresh(); }
});

// The last health payload, kept for panels OUTSIDE the health page that need
// a worker's verdict on their own rows - the rules table reads the ingest
// worker's disarmed set from here (easy-win E7).
let lastHealth = null;

function renderHealth(h) {
    lastHealth = h;
    $('health-verdict').textContent = h.ok
        ? `ok, up ${Math.round((h.uptimeS ?? 0) / 3600)}h`
        : `${(h.problems || []).length} problem(s)`;
    $('health-verdict').className = h.ok ? 'muted' : 'error-text';

    const probs = $('health-problems');
    probs.replaceChildren();
    for (const p of h.problems || []) {
        const d = document.createElement('div');
        d.textContent = p;
        probs.appendChild(d);
    }
    probs.classList.toggle('hidden', (h.problems || []).length === 0);

    const ttbody = $('hb-threads').querySelector('tbody');
    ttbody.replaceChildren();
    for (const t of h.heartbeat?.threads || []) {
        const worst = cell(`${t.worstGapMs}ms`, 'num');
        if (t.worstGapMs > (t.thresholdMs ?? 50)) worst.classList.add('cell-warn');
        ttbody.appendChild(rowEl([
            cell(t.thread),
            worst,
            cell(`${t.p99GapMs}ms`, 'num'),
            cell(t.overThresholdCount > 0 ? String(t.overThresholdCount) : '', 'num'),
        ]));
    }

    const ltbody = $('lanes').querySelector('tbody');
    ltbody.replaceChildren();
    for (const l of h.lanes || []) {
        const inf = cell(String(l.inFlight), 'num');
        if (l.inFlight >= l.capacity) inf.classList.add('cell-warn');
        ltbody.appendChild(rowEl([
            cell(l.lane),
            inf,
            cell(String(l.capacity), 'num'),
            cell(l.queued > 0 ? String(l.queued) : '', 'num'),
        ]));
    }

    const db = h.db || {};
    if (db.status) {
        $('db-health').textContent = `db: ${db.status}`;
    } else {
        const disks = (db.disks || [])
            .map((d) => d.error ? `${d.path} unmeasured` : `${d.path} ${d.availPct}% free`)
            .join(', ');
        const bloat = (db.bloat || [])
            .map((t) => `${t.rel} ${t.dead}/${t.live}`)
            .join(', ');
        $('db-health').textContent =
            `db: wraparound age ${(db.oldestDatAge ?? 0).toLocaleString()}`
            + ` | dead/live ${bloat} | ${disks}`;
    }

    // Notify channel health (easy-win E6). "Configured and dead" was the
    // review's phrase: a channel can fail every attempt for a week and the
    // only witness is a log line per miss. trailing_failures counts failures
    // since the last delivery, so 0 reads as healthy and anything else says
    // exactly how long the silence has been.
    const nh = $('notify-health');
    nh.replaceChildren();
    const channels = h.jobs?.notifyChannels ?? [];
    if (channels.length > 0) {
        const head = document.createElement('h3');
        head.textContent = 'Notification channels';
        nh.appendChild(head);
    }
    for (const c of channels) {
        const d = document.createElement('div');
        if (c.trailingFailures === 0) {
            d.textContent = `${c.channel}: ok`
                + (c.lastDeliveredTs ? ` - last delivered ${fmtAgo(c.lastDeliveredTs)}` : '');
            d.className = 'muted';
        } else {
            d.textContent = `${c.channel}: ${c.trailingFailures} failure(s) since last delivery - `
                + (c.lastDeliveredTs ? `last delivered ${fmtAgo(c.lastDeliveredTs)}` : 'NEVER delivered')
                + (c.lastAttemptTs ? `, last tried ${fmtAgo(c.lastAttemptTs)}` : '');
            d.className = 'error-text';
        }
        nh.appendChild(d);
    }
    nh.classList.toggle('hidden', channels.length === 0);

    // Slowest agents (easy-win E9), from the roster already fetched - no new
    // endpoint, no new query. snmp_rtt_ms is blanked server-side unless the
    // device is up, so nothing here is a stale reading. Five rows because the
    // question this answers is "which agents should I look at", not a ranking
    // of the fleet.
    const sa = $('slow-agents');
    sa.replaceChildren();
    const slow = lastDevices
        .filter((d) => typeof d.snmp_rtt_ms === 'number')
        .sort((a, b) => b.snmp_rtt_ms - a.snmp_rtt_ms)
        .slice(0, 5);
    if (slow.length > 0) {
        const head = document.createElement('h3');
        head.textContent = 'Slowest agents';
        const sub = document.createElement('span');
        sub.className = 'muted small';
        sub.textContent = ' snmp round-trip, up devices only';
        head.appendChild(sub);
        sa.appendChild(head);
    }
    for (const d of slow) {
        const row = document.createElement('div');
        row.textContent = `${d.name} - ${Math.round(d.snmp_rtt_ms)}ms`;
        if (d.snmp_rtt_ms >= 1000) row.className = 'error-text';
        else row.className = 'muted';
        sa.appendChild(row);
    }
    sa.classList.toggle('hidden', slow.length === 0);
}

// --- search -------------------------------------------------------------------
//
// User-driven, deliberately outside the 10s refresh: a page that re-ran your
// query every ten seconds would move rows under you while you read them.

/** Syslog severity 0-7 -> the suite's three severity treatments. */
function sevPill(n) {
    if (n === null || n === undefined) return pill('', 'sev pending');
    const label = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'][n] ?? String(n);
    return pill(label, n <= 3 ? 'sev crit' : n === 4 ? 'sev warn' : 'sev pending');
}

function showSearchMessage(text, cls) {
    const el = $('search-msg');
    el.className = cls;
    el.textContent = text;
    el.classList.toggle('hidden', text === '');
}

function renderHints(hints) {
    const el = $('search-hints');
    el.replaceChildren();
    if (!hints || hints.length === 0) { el.classList.add('hidden'); return; }
    // THE ZERO-RESULT GUIDANCE, and the reason the panel has a place for it:
    // exact-by-default fails silently wrong. "No results" reads as "no logs
    // from that device"; this says which operator would have found them.
    for (const h of hints) {
        const d = document.createElement('div');
        d.textContent = h;
        el.appendChild(d);
    }
    el.classList.remove('hidden');
}

// THE WINDOW IS THE OPTIMISATION, not a UI nicety - it drives partition
// pruning, which is what makes a bounded search cheap. So it is not
// dismissible, and it is REMEMBERED: an investigation re-runs the same window
// a dozen times, and retyping "Tuesday 03:00 to 05:00" on every attempt is
// how an operator ends up widening it out of irritation.
const WINDOW_KEY = 'rscanvas.searchWindow';

function windowParams() {
    const sel = $('hours').value;
    if (sel !== 'custom') return { hours: sel };
    const from = $('from').value;
    const to = $('to').value;
    if (from === '' || to === '') return { error: 'pick both a from and a to, or choose a preset' };
    // datetime-local is LOCAL wall time with no zone; the API wants absolute.
    // Converting here rather than sending the naive string is what stops a
    // search meaning something different in a different timezone.
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function saveWindow() {
    try {
        localStorage.setItem(WINDOW_KEY, JSON.stringify({
            hours: $('hours').value, from: $('from').value, to: $('to').value,
        }));
    } catch { /* private mode: the window just stops being remembered */ }
}

function restoreWindow() {
    try {
        const w = JSON.parse(localStorage.getItem(WINDOW_KEY) || '{}');
        if (w.hours) $('hours').value = w.hours;
        if (w.from) $('from').value = w.from;
        if (w.to) $('to').value = w.to;
    } catch { /* ignore a corrupt entry rather than breaking the page */ }
    $('custom-window').classList.toggle('hidden', $('hours').value !== 'custom');
}

// The operators, discoverable rather than folded into a placeholder nobody
// reads to the end. Every line is a thing the grammar actually accepts - the
// parse is pinned by tools/test-grammar.ts, so this list cannot drift into
// describing operators that do not exist without that test failing first.
const GRAMMAR_HELP = [
    'host:core-sw   exact host        host~core   host contains',
    'app:sshd       exact app         app~ssh     app contains (needs a host: or ip: too)',
    'ip:10.0.0.     subnet, 10.0.0.0/24 - a trailing dot widens the mask',
    'sev:<=3        severity by number or name (emerg alert crit err warn notice info debug)',
    'fac:daemon     facility by name or number      proto:trap    syslog or trap',
    'after:2026-08-01  before:2026-08-02   tighten the window, never widen it',
    '-noise         exclude a term      "link down"   quote a phrase',
    'anything else is free text; an unknown key is treated as text, not an error',
];

$('grammar-toggle').addEventListener('click', () => {
    const el = $('grammar-help');
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
    el.replaceChildren();
    for (const line of GRAMMAR_HELP) {
        const d = document.createElement('div');
        d.textContent = line;
        el.appendChild(d);
    }
    el.classList.remove('hidden');
});

$('hours').addEventListener('change', () => {
    $('custom-window').classList.toggle('hidden', $('hours').value !== 'custom');
    saveWindow();
});
for (const id of ['from', 'to']) $(id).addEventListener('change', saveWindow);

// --- fielded filters ----------------------------------------------------------
//
// THE SYNTAX IS FOR PEOPLE WHO KNOW IT; THE FIELDS ARE FOR EVERYONE ELSE.
// A grammar is a wonderful thing for the third search of the day and a wall
// for the first, and the parent suite's own operators are not guessable -
// nobody types host~ without being told it exists.
//
// But the reason this earns its place is sharper than discoverability. The
// coverage rule REFUSES free text over a window wider than the trigram index
// unless a host or ip narrows it, and today an operator learns that by being
// refused. A panel with a host box teaches the requirement BEFORE the refusal:
// the thing you must supply to search far back is sitting right there, named,
// with a note saying why. A rule you can see is not the same rule as one that
// only appears when you break it.
//
// These map to the API's DISCRETE parameters, not to generated query text.
// The route already accepts host/sourceIp/app/facility/severityAtMost/
// fragment, so nothing is being parsed twice and the panel cannot express a
// query the box could not - `fragment` is the plain-substring parameter,
// deliberately not `q`, so a message containing a colon stays text.

const FIELDS = [
    ['f-host', 'host'],
    ['f-ip', 'sourceIp'],
    ['f-app', 'app'],
    ['f-sev', 'severityAtMost'],
    ['f-fac', 'facility'],
    ['f-msg', 'fragment'],
];

function fieldParams() {
    const out = {};
    for (const [id, param] of FIELDS) {
        const v = $(id).value.trim();
        if (v !== '') out[param] = v;
    }
    return out;
}

/** A short summary so a COLLAPSED panel cannot hide an active filter. */
function fieldsNote() {
    const active = Object.entries(fieldParams());
    const hidden = $('fields').classList.contains('hidden');
    $('fields-note').textContent = active.length === 0 ? ''
        : hidden
            ? `${active.length} field filter(s) active: ${active.map(([k, v]) => `${k}=${v}`).join(', ')}`
            : '';
}

$('fields-toggle').addEventListener('click', () => {
    $('fields').classList.toggle('hidden');
    fieldsNote();
});
$('fields-clear').addEventListener('click', () => {
    for (const [id] of FIELDS) $(id).value = '';
    fieldsNote();
});
for (const [id] of FIELDS) $(id).addEventListener('input', fieldsNote);

/** The filters currently on screen, shared by search and export. */
let lastSearchParams = null;
/** Set by the first search the operator runs; until then Logs shows the
 *  most recent messages each time it is opened. */
let searchedByUser = false;

function renderResultRows(rows) {
    const tbody = $('results').querySelector('tbody');
    tbody.replaceChildren();
    for (const row of rows) {
        const ts = new Date(row.ts);
        tbody.appendChild(rowEl([
            cell(ts.toLocaleString(), 'ts'),
            sevPill(row.severity),
            cell(row.host),
            cell(row.app),
            cell(row.msg, 'msg'),
        ]));
    }
}

/**
 * THE LOGS PAGE OPENS ON SOMETHING (operator, 2026-09-24). It used to open
 * empty until a search ran, which says nothing about whether messages are
 * arriving at all. So until the operator searches, opening Logs lists the
 * 50 newest messages of the last 24 hours: no filter and no text, so it needs
 * no trigram index and admission passes it; count=0 skips the total, which is
 * the one expensive half of a search.
 */
async function showRecent() {
    const table = $('results');
    renderHints(null);
    $('export-row').classList.add('hidden');
    showSearchMessage('loading the most recent messages...', 'allquiet');
    const r = await api('/api/syslog/search?hours=24&limit=50&count=0');
    if (r.status === 401) { showLogin(); return; }
    // The operator searched while this was in flight: their results win.
    if (searchedByUser) return;
    if (!r.ok) {
        table.classList.add('hidden');
        showSearchMessage(r.detail || `could not load recent messages (${r.status})`, 'refusal');
        return;
    }
    const rows = r.rows || [];
    renderResultRows(rows);
    table.classList.toggle('hidden', rows.length === 0);
    showSearchMessage(rows.length === 0
        ? 'no messages in the last 24 hours - nothing has sent syslog or traps to this server, or it is not reaching it'
        : `the ${rows.length} most recent message(s) from the last 24 hours - search to narrow them or reach further back`,
        'allquiet');
}

async function runSearch(ev) {
    if (ev) ev.preventDefault();
    searchedByUser = true;
    const q = $('q').value.trim();
    const table = $('results');
    renderHints(null);
    $('export-row').classList.add('hidden');

    const win = windowParams();
    if (win.error) {
        table.classList.add('hidden');
        showSearchMessage(win.error, 'refusal');
        return;
    }
    saveWindow();
    showSearchMessage('searching...', 'allquiet');

    const fields = fieldParams();
    const params = new URLSearchParams({ ...win, ...fields, limit: '200' });
    if (q !== '') params.set('q', q);
    // Export gets the SAME filters, which is the point of building one object:
    // an export must never be able to express a query the search rules would
    // refuse, and the surest way is for both to carry identical parameters.
    lastSearchParams = { ...win, ...fields, ...(q !== '' ? { q } : {}) };
    fieldsNote();
    const r = await api(`/api/syslog/search?${params}`);

    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) {
        // A refusal NAMES WHAT TO CHANGE - window too wide, dates outside it,
        // a substring with nothing to run on. Showing the detail verbatim is
        // the whole point of having written them that way.
        table.classList.add('hidden');
        showSearchMessage(r.detail || `search failed (${r.status})`, 'refusal');
        return;
    }

    renderResultRows(r.rows || []);
    table.classList.toggle('hidden', r.returned === 0);
    renderHints(r.hints);

    const took = Math.round((r.timing?.execMs ?? 0) + (r.timing?.waitMs ?? 0));
    const span = $('hours').value === 'custom' ? 'that window' : `the last ${$('hours').value}h`;
    if (r.returned === 0) {
        showSearchMessage(`no messages matched in ${span} (${took}ms)`, 'allquiet');
    } else {
        // COUNT BEFORE FETCH made visible: the total is what says whether the
        // 200 rows on screen are the answer or the first page of it, and it
        // is the number that decides whether an export is worth starting.
        const of = r.total !== null && Number(r.total) > r.returned
            ? ` of ${Number(r.total).toLocaleString()}` : '';
        showSearchMessage(`${r.returned}${of} message(s), ${took}ms`, 'allquiet');
        // Offered only to a role that may export (syslog.export): a viewer
        // was shown the button and refused on click.
        $('export-row').classList.toggle('hidden', !can('syslog.export'));
        $('export-msg').textContent = r.total !== null && Number(r.total) > r.returned
            ? `the export would carry all ${Number(r.total).toLocaleString()}, not just these ${r.returned}`
            : '';
    }
}

$('search-form').addEventListener('submit', runSearch);

// --- export -------------------------------------------------------------------
//
// An export is a JOB, not a download: 400,000 rows is minutes, and the lane
// design gives it its own capacity precisely so one export cannot hold a
// quarter of the heavy lane for its whole duration. The UI therefore has to
// show a lifecycle rather than a spinner - and has to show the ESTIMATE
// before committing, because "confirmation-required" is a real answer the
// server gives for a big one.

let exportTimer = null;

function renderExports(jobs) {
    const tbody = $('exports').querySelector('tbody');
    tbody.replaceChildren();
    for (const j of jobs) {
        const act = document.createElement('td');
        if (j.state === 'done') {
            const a = document.createElement('a');
            a.href = `/api/exports/${encodeURIComponent(j.id)}/download`;
            a.textContent = 'download';
            act.appendChild(a);
        } else if (j.state === 'running' || j.state === 'queued') {
            const b = document.createElement('button');
            b.textContent = 'cancel';
            b.addEventListener('click', async () => {
                await api(`/api/exports/${encodeURIComponent(j.id)}`, { method: 'DELETE' });
                refreshExports();
            });
            act.appendChild(b);
        }
        const badge = j.state === 'done' ? 'ok' : j.state === 'failed' ? 'fail' : '';
        const tr = rowEl([
            cell(j.id),
            pill(j.state, `badge ${badge}`),
            cell((j.actual?.rows ?? j.estimate?.rows ?? '').toLocaleString?.() ?? '', 'num'),
            cell(j.actual?.size ?? j.estimate?.size ?? '', 'num'),
            cell(fmtAgo(j.startedAt || j.createdAt)),
        ]);
        tr.appendChild(act);
        tbody.appendChild(tr);
    }
    $('exports').classList.toggle('hidden', jobs.length === 0);

    // Poll only while something is moving. A page that polls forever is the
    // same waste as a refresh loop nobody watches.
    const busy = jobs.some((j) => j.state === 'queued' || j.state === 'running');
    clearInterval(exportTimer);
    exportTimer = busy ? setInterval(refreshExports, 3000) : null;
}

async function refreshExports() {
    if (!can('syslog.export')) return;
    const r = await api('/api/syslog/export');
    if (r.ok) renderExports(r.jobs || []);
}

async function submitExport(confirm) {
    if (lastSearchParams === null) return;
    $('export-msg').textContent = confirm ? 'submitting...' : 'estimating...';
    const r = await api('/api/syslog/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...lastSearchParams, ...(confirm ? { confirm: true } : {}) }),
    });

    if (r.status === 401) { showLogin(); return; }

    // THE CONFIRMATION GATE, shown rather than auto-accepted. The server
    // refuses a large export until asked twice, and the estimate is the whole
    // point of the first refusal - an operator who sees "1.2 million rows,
    // about 4 minutes, 180 MB" often wanted a narrower window instead.
    if (r.reason === 'confirmation-required') {
        // The server's own sentence, verbatim - it already reads "359,736
        // rows, about 91 MB and 40s. Resubmit with confirm to proceed." The
        // first version of this reached for a nested `estimate` object that
        // the REFUSAL does not carry (only the accepted job does), and
        // rendered "? rows, about ?, ?" - a confirmation prompt with no
        // information in it, which is worse than no prompt at all because it
        // trains the operator to click through.
        $('export-msg').textContent = r.detail || 'press again to confirm';
        $('export-btn').textContent = 'Confirm export';
        $('export-btn').dataset.confirm = '1';
        return;
    }

    $('export-btn').textContent = 'Export these results to CSV';
    delete $('export-btn').dataset.confirm;

    if (!r.ok) {
        // Lane refusals name what to do: busy, queue-wait-too-long,
        // too-many-for-user. Shown verbatim for the same reason search
        // refusals are.
        $('export-msg').textContent = r.detail
            || (r.reason ? `${r.reason}` : `export failed (${r.status})`);
        return;
    }
    $('export-msg').textContent = `queued as ${r.job?.id ?? ''}`;
    refreshExports();
}

$('export-btn').addEventListener('click', () => {
    submitExport($('export-btn').dataset.confirm === '1');
});

// --- onboarding ---------------------------------------------------------------
//
// Paste, test, review, add. The REVIEW step is the feature: an operator who
// sees 187 answered and 13 refused makes a decision, where one told "imported
// 187" learns nothing about the 13.
//
// Nothing is written until the second button. The probe result lives on the
// server against a token, so what gets added is the list that was reviewed -
// not whatever the network says a minute later.

let probeToken = null;
let probed = [];

// parseHosts moved to ./parse.js so tools/test-onboarding.ts can assert the
// SHIPPED parser rather than a copy of it - the same argument dom.js makes,
// and the same reason: this file touches `document` at import time and cannot
// be loaded outside a browser at all.

// SINGLE FIRST, BULK BEHIND A BUTTON (the parent's shape, operator's call).
// One mode flag, and the probe reads whichever input is live - a single
// address goes through parseHosts exactly like a one-line paste, so the two
// modes share every line of machinery after this point.
let obBulk = false;

// Scan a subnet and drop the responders into the bulk list. Already-known
// hosts are left OUT of the list and counted in the message, so a rescan of a
// subnet you have mostly onboarded offers what is NEW rather than the roster
// again. The operator then reviews the list and hits Test & discover like any
// other bulk add - the scan writes nothing and probes nothing.
$('ob-scan').addEventListener('click', async () => {
    const cidr = $('ob-scan-cidr').value.trim();
    const msg = $('ob-scan-msg');
    if (cidr === '') { msg.textContent = 'enter a subnet, e.g. 192.0.2.0/24'; return; }
    msg.textContent = 'scanning...';
    $('ob-scan').disabled = true;
    const r = await api('/api/devices/scan', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cidr }),
    });
    $('ob-scan').disabled = false;
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { msg.textContent = r.detail || `refused (${r.status})`; return; }
    const fresh = r.hosts.filter((h) => !h.known);
    const known = r.hosts.length - fresh.length;
    const existing = $('ob-hosts').value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const merged = [...new Set([...existing, ...fresh.map((h) => h.host)])];
    $('ob-hosts').value = merged.join('\n');
    msg.textContent = `${r.swept} addresses swept, ${r.hosts.length} answered`
        + (known ? `, ${known} already in the roster (not listed)` : '')
        + ` - ${fresh.length} added to the list below. Review, then Test & discover.`;
    if (!obBulk) obSetMode(true);
});

function obSetMode(bulk) {
    obBulk = bulk;
    $('ob-single-row').classList.toggle('hidden', bulk);
    $('ob-bulk-row').classList.toggle('hidden', !bulk);
    $('ob-title').textContent = bulk ? 'Add devices' : 'Add device';
    $('ob-bulk-toggle').textContent = bulk ? 'Single device' : 'Bulk add...';
}

$('ob-open').addEventListener('click', () => {
    $('ob-form').classList.toggle('hidden');
    if (!$('ob-form').classList.contains('hidden')) {
        $('ob-host').focus();
        // The picker is filled from the same call the System tab uses, so an
        // operator who opens Add Device first still gets a populated list.
        // Admin-only route: for a role that cannot read it the field stays a
        // free-text box, which is what it was.
        if (lastCredentials === null) api('/api/credentials').then((d) => { if (d.ok) renderCredentials(d); });
    }
});
$('ob-bulk-toggle').addEventListener('click', () => obSetMode(!obBulk));
$('ob-cancel').addEventListener('click', () => {
    $('ob-form').classList.add('hidden');
    $('ob-results').classList.add('hidden');
    $('ob-msg').textContent = '';
});
// Enter in the single address box probes, because that is what the finger
// expects from a one-field form.
$('ob-host').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); $('ob-probe').click(); }
});

// Slice 35: ping-only mode swaps the whole SNMP apparatus - probe, version,
// credential, interval - for two text boxes, because none of it applies to a
// host with no agent. Hiding rather than disabling: a greyed SNMP version on
// a device that will never speak SNMP is a control pretending to be relevant.
function syncMonitorMode() {
    const ping = $('ob-monitor').value === 'icmp';
    $('ob-ping').classList.toggle('hidden', !ping);
    $('ob-single-row').classList.toggle('hidden', ping);
    $('ob-snmp-row').classList.toggle('hidden', ping);
    if (ping) $('ob-bulk-row').classList.add('hidden');
}
$('ob-monitor').addEventListener('change', syncMonitorMode);

$('ob-ping-add').addEventListener('click', async () => {
    // "address name" per line, because that is how somebody writes a list of
    // external services on paper. The name is everything after the first
    // space, so "198.51.100.1 ISP-A handoff" keeps its spaces.
    const devices = [];
    for (const raw of $('ob-ping-hosts').value.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') continue;
        const sp = line.indexOf(' ');
        devices.push(sp === -1
            ? { host: line, name: line }
            : { host: line.slice(0, sp), name: line.slice(sp + 1).trim() });
    }
    if (devices.length === 0) { $('ob-ping-msg').textContent = 'nothing to add'; return; }
    const r = await api('/api/devices/ping', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            devices,
            location: $('ob-ping-location').value.trim() || undefined,
            application: $('ob-ping-application').value.trim() || undefined,
        }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('ob-ping-msg').textContent = r.detail || `refused (${r.status})`; return; }
    const skipped = (r.skipped || []).map((s) => `${s.host} (${s.why})`);
    $('ob-ping-msg').textContent = `added ${r.added.length}`
        + (skipped.length ? ` - skipped ${skipped.join('; ')}` : ' - watched by ping within one sweep');
    if (r.added.length > 0) {
        $('ob-ping-hosts').value = '';
        const d = await api('/api/devices');
        if (d.ok) renderDevices(d);
    }
});

$('ob-probe').addEventListener('click', async () => {
    const hosts = parseHosts(obBulk ? $('ob-hosts').value : $('ob-host').value);
    if (hosts.length === 0) {
        $('ob-msg').textContent = 'nothing that looks like an address in there';
        return;
    }
    $('ob-msg').textContent = `testing ${hosts.length} host(s) - this contacts each one, so it takes a moment...`;
    $('ob-results').classList.add('hidden');
    const r = await api('/api/devices/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            hosts,
            version: $('ob-version').value,
            port: Number($('ob-port').value) || 161,
            credentialRef: $('ob-cred').value.trim() || 'SNMP_COMMUNITY',
            pollIntervalS: Number($('ob-interval').value) || 30,
        }),
    });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('ob-msg').textContent = r.detail || `refused (${r.status})`; return; }

    probeToken = r.probeToken;
    probed = r.devices || [];
    renderProbe(r);
});

function renderProbe(r) {
    const ok = probed.filter((d) => d.ok && !d.known && !d.nameTaken);
    const known = probed.filter((d) => d.known);
    const taken = probed.filter((d) => d.ok && !d.known && d.nameTaken);
    const failed = probed.filter((d) => !d.ok);
    $('ob-counts').textContent =
        `${ok.length} new, ${known.length} already known, `
        + (taken.length ? `${taken.length} name${taken.length === 1 ? '' : 's'} taken, ` : '')
        + `${failed.length} did not answer`;
    $('ob-msg').textContent = '';

    const tbody = $('ob-table').querySelector('tbody');
    tbody.replaceChildren();
    for (const d of probed) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.host = d.host;
        // A device that answered and is not already here is pre-ticked. One
        // that did NOT answer is tickable but starts UNTICKED - that is the
        // Force Add arm (the LibreNMS comparison, 2026-09-01): ticking it
        // says "add anyway, pending first contact", the ordinary poller
        // discovers everything the first time the host answers, and until
        // then it reads as pending, never down. Refusal stays the default;
        // forcing is a stated act. Only already-known rows are inert -
        // visible rather than filtered out, because "why is my device not
        // in the list" is a worse question than "why is that row greyed".
        box.disabled = d.known === true;
        // A taken name starts unticked: added as it stands it is refused, so
        // the tick comes with the name typed beside it.
        box.checked = d.ok && !d.known && !d.nameTaken;
        if (!d.ok) box.dataset.force = '1';
        const boxCell = document.createElement('td');
        boxCell.appendChild(box);

        const outcome = !d.ok ? pill(d.errorKind ?? 'no answer', 'badge owed')
            : d.known ? pill('already known', 'badge')
            : d.nameTaken ? pill('name taken', 'badge owed')
            : pill('will be added', 'badge ok');
        if (!d.ok) {
            outcome.title = 'tick the box to add it anyway - it polls as PENDING and '
                + 'discovers itself the first time it answers. A promise has an expiry: '
                + 'if it never answers it reads DOWN after about a day (PENDING_CONTACT_H) '
                + 'and pages once, so a wrong community string cannot hide as pending.';
        }
        const row = rowEl([
            cell(''), cell(d.host), cell(d.name), cell(String(d.entities), 'num'),
            cell(String(d.tracked), 'num'),
            // Sensors separately from interfaces: "25 interfaces, 9 sensors"
            // is checkable against the box an operator knows; a merged count
            // is not. Blank when none, per the blank-not-placeholder rule.
            cell(d.sensors > 0 ? String(d.sensors) : '', 'num'),
            cell(d.sysLocation ?? '', 'muted'), cell(''),
        ]);
        row.replaceChild(boxCell, row.children[0]);
        const oc = document.createElement('td');
        oc.appendChild(outcome);
        // WHY, NOT JUST WHAT. The probe has always sent `error` and this cell
        // has always dropped it, so a failed bulk add showed a two-word badge
        // and nothing else - an operator staring at forty rows reading "auth"
        // with no way to learn that the credential name was never set on the
        // server. The message is written to say what to CHANGE; printing the
        // badge without it wastes the only sentence that helps.
        if (!d.ok && d.error) {
            const why = document.createElement('div');
            why.className = 'muted small';
            why.textContent = d.error;
            oc.appendChild(why);
        }
        // A TAKEN NAME IS NOT "ALREADY KNOWN": another address, or another
        // port on this one, already uses the name this device reports. The
        // way out is a name of its own, typed here and sent as the add's
        // `names` map; nothing is ever renamed for the operator.
        if (!d.known && d.nameTaken) {
            const why = document.createElement('div');
            why.className = 'muted small';
            why.textContent = d.nameTaken;
            oc.appendChild(why);
            const own = document.createElement('input');
            own.type = 'text';
            own.placeholder = 'a name of its own';
            own.dataset.nameFor = d.host;
            own.addEventListener('input', () => { box.checked = own.value.trim() !== ''; });
            const nameCell = document.createElement('td');
            nameCell.append(document.createTextNode(d.name), document.createElement('br'), own);
            row.replaceChild(nameCell, row.children[2]);
        }
        // INDEX 7, THE RESULT COLUMN. This wrote to children[6] - the location
        // column - so every outcome badge landed one cell left of its header
        // and RESULT rendered empty. The header row is
        // [box, host, name, interfaces, tracked, sensors, location, result].
        row.replaceChild(oc, row.children[7]);
        tbody.appendChild(row);
    }

    renderLocationSuggestion(r.locationSuggestion);
    $('ob-results').classList.remove('hidden');
}

/**
 * THE TWO NUMBERS, and they are the whole design.
 *
 * "405 of 450 devices reported 4 distinct locations" is an obvious yes.
 * "38 of 450 reported 31" is an obvious no. The operator decides at a glance
 * and the product never has to guess whether this shop keeps sysLocation tidy.
 *
 * It degrades to a shrug rather than to a mess: a fleet with no locations
 * shows nothing at all here.
 */
function renderLocationSuggestion(sug) {
    const box = $('ob-locations');
    if (!sug || sug.distinct === 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');

    const sum = $('ob-loc-summary');
    sum.replaceChildren();
    sum.appendChild(factLine('what the devices say',
        `${sug.reported} of ${sug.answered} that answered reported a location, `
        + `across ${sug.distinct} distinct value(s)`));
    sum.appendChild(factLine('what this is',
        'a starting point, not a decision - sysLocation is reported BY the device, so '
        + 'nothing here is applied unless you tick it'));
    // NAMED PAIRS, not a count. Past a dozen devices one typo makes two values
    // that read as one, and "18 locations" hides it while "these two differ by
    // a letter" ends the hunt.
    for (const nm of sug.nearMisses ?? []) {
        sum.appendChild(factLine('these look like the same place',
            `"${nm.a}" and "${nm.b}" - similarity ${nm.sim}. If one is a typo, save both as the same name.`));
    }

    const tbody = $('ob-loc-table').querySelector('tbody');
    tbody.replaceChildren();
    for (const g of sug.groups ?? []) {
        const use = document.createElement('input');
        use.type = 'checkbox';
        use.checked = true;
        use.dataset.reported = g.value;
        const useCell = document.createElement('td');
        useCell.appendChild(use);

        const as = document.createElement('input');
        as.type = 'text';
        as.value = g.value;
        as.dataset.reported = g.value;
        as.className = 'grow';
        const asCell = document.createElement('td');
        asCell.appendChild(as);

        const row = rowEl([cell(''), cell(g.value), cell(String(g.devices.length), 'num'), cell('')]);
        row.replaceChild(useCell, row.children[0]);
        row.replaceChild(asCell, row.children[3]);
        tbody.appendChild(row);
    }
}

$('ob-add').addEventListener('click', async () => {
    if (probeToken === null) return;
    // Two lists from one set of ticks: an answered row goes to accept, a
    // no-answer row the operator ticked anyway goes to force - added as
    // pending, discovered on first contact.
    const ticked = [...$('ob-table').querySelectorAll('input[type=checkbox]')]
        .filter((b) => b.checked && !b.disabled);
    const accept = ticked.filter((b) => b.dataset.force !== '1').map((b) => b.dataset.host);
    const force = ticked.filter((b) => b.dataset.force === '1').map((b) => b.dataset.host);
    if (accept.length === 0 && force.length === 0) { $('ob-add-msg').textContent = 'nothing selected'; return; }

    // Accepting is a tick; renaming is the same tick with a different string;
    // rejecting is leaving it out. No separate reject verb - absence says it.
    const locations = {};
    for (const box of $('ob-loc-table').querySelectorAll('input[type=checkbox]')) {
        if (!box.checked) continue;
        const field = $('ob-loc-table')
            .querySelector(`input[type=text][data-reported="${CSS.escape(box.dataset.reported)}"]`);
        const chosen = (field?.value ?? '').trim();
        if (chosen !== '') locations[box.dataset.reported] = chosen;
    }
    // Names of their own, for rows whose reported name another device owns.
    const names = {};
    for (const f of $('ob-table').querySelectorAll('input[type=text][data-name-for]')) {
        if (f.value.trim() !== '') names[f.dataset.nameFor] = f.value.trim();
    }

    $('ob-add-msg').textContent = 'adding...';
    // Slice 30: APPLICATION is typed once for the batch. Locations arrive
    // suggested by the devices; nothing on a box knows it serves Exchange,
    // so this is the one grouping the operator must simply state - and
    // stating it here beats tagging six machines one page at a time
    // afterwards, which is what they had to do for the guest PCs.
    const application = $('ob-application').value.trim();
    const r = await api('/api/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            probeToken, accept, locations,
            ...(Object.keys(names).length > 0 ? { names } : {}),
            ...(force.length > 0 ? { force } : {}),
            ...(application !== '' ? { application } : {}),
        }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('ob-add-msg').textContent = r.ok
        ? `added ${r.added.length}${r.tagged ? `, tagged ${r.tagged} with a location` : ''}`
          // Forced rows are counted apart from added, because "pending
          // first contact" must never read as "probed and discovered".
          + (r.forced?.length ? `, ${r.forced.length} forced (pending first contact)` : '')
          + (r.taggedApp ? `, ${r.taggedApp} into "${application}"` : '')
          + (r.skipped?.length ? `, skipped ${r.skipped.length}` : '')
          // A dropped duplicate means one sensor is invisible on that device.
          // Counted here and named in the gate, never silent.
          + (r.collisions?.length ? `, dropped ${r.collisions.length} duplicate entit(y/ies)` : '')
        : (r.detail || `refused (${r.status})`);
    // EVERY REFUSAL NAMED, in the panel the operator is already looking at.
    // "skipped 5" is what made a per-device database refusal indistinguishable
    // from "already known" for two rounds of testing.
    if (r.ok && ((r.collisions?.length ?? 0) > 0 || (r.skipped?.length ?? 0) > 0)) {
        const gate = $('roster-gate');
        gate.replaceChildren();
        for (const s of r.skipped || []) gate.appendChild(factLine(s.host, s.why));
        for (const c of r.collisions || []) {
            gate.appendChild(factLine(c.device, `duplicate identity, not added: ${c.dropped}`));
        }
        gate.classList.remove('hidden');
    }
    if (r.ok) {
        probeToken = null;
        $('ob-results').classList.add('hidden');
        $('ob-hosts').value = '';
        $('ob-host').value = '';
        // The job is done; the form folds away rather than inviting a
        // second add nobody planned.
        $('ob-form').classList.add('hidden');
        const d = await api('/api/devices');
        if (d.ok) renderDevices(d);
    }
});

// --- navigation ---------------------------------------------------------------
//
// One section on screen at a time, chosen by the nav row. Not a router: there
// is no history integration and no URL, because a section is a VIEW of one
// live page rather than a destination, and the poll loop keeps every section
// current whether it is displayed or not. A back button that unwound section
// changes would be answering a question nobody asked while losing the one
// people do ask, which is "why did my search box empty".
let section = 'dashboard';

function showSection(name) {
    section = name;
    for (const el of document.querySelectorAll('[data-section]')) {
        // The drill-down panels carry their own hidden state, so a section
        // change must not un-hide them. They are shown by their own code.
        const belongs = el.dataset.section === name;
        if (el.classList.contains('panel')) {
            const isDrill = el.id === 'device-panel' || el.id === 'alert-panel';
            const drillOpen = (el.id === 'device-panel' && currentDevice !== null)
                || (el.id === 'alert-panel' && currentAlert !== null);
            // The admin panels share the System section with Health, which
            // every role may read. They stay hidden for anyone who cannot
            // use them, so a viewer opening System sees a page that is
            // entirely theirs rather than one mostly full of refusals.
            const gated = (el.classList.contains('admin-only') && !isAdmin)
                || (el.dataset.can !== undefined && !canAny(el.dataset.can));
            el.classList.toggle('hidden', !belongs || gated || (isDrill && !drillOpen));
        }
    }
    for (const b of document.querySelectorAll('.navbtn')) {
        b.classList.toggle('active', b.dataset.section === name);
    }
    // The list panel and its drill-down are the same section, so hide the
    // list when its drill-down is open rather than stacking both.
    if (name === 'devices') {
        $('roster-panel').classList.toggle('hidden', currentDevice !== null);
        syncDeviceToolbar();
    }
    // Logs opens on the newest messages until the operator searches, so the
    // page says at a glance that syslog and traps are arriving (2026-09-24).
    if (name === 'search' && !searchedByUser) showRecent().catch(() => {});
    if (name === 'alerts') $('alerts-panel').classList.toggle('hidden', currentAlert !== null);
    // The Dashboard's lists are fetched on arrival unless a minute-fresh
    // copy is on screen; its alert list comes from data already in hand.
    if (name === 'dashboard') {
        renderDashAlerts();
        loadDashGroups();
        fillReportDevices();
        syncReportControls();
        if (Date.now() - dashLoadedAt > 60_000) loadDashboard();
    }
    // The rules live on System now; re-read them on each visit so an edit
    // made in another tab, or a rule the ingest worker disarmed, shows up.
    if (name === 'system' && can('alertrule.read')) { loadEventRules(); loadGroupAlerts(); }
    if (name === 'system' && isAdmin) {
        refreshAdmin();
        fillGroupSuggestions($('inv-axis').value, 'group-values');
    }
    freshenShown();
}

for (const b of document.querySelectorAll('.navbtn')) {
    b.addEventListener('click', () => showSection(b.dataset.section));
}

// --- System: folding panels (2026-09-25, operator) ---------------------------
//
// "At its full length the page is intimidating." Each System panel folds to
// its header, and the header keeps its summary - the health verdict, the
// retention line - so a folded page still reads as a status board. First
// visit: everything but Health folded, so the tab opens on the verdict.
// After that the choice is remembered per browser; storage can be absent
// (private windows) and the page then simply starts from the default.
//
// A real <button> carries the fold for keyboards and screen readers, and a
// click anywhere on the header does the same for a mouse - except on a
// control that happens to live in a header, which keeps its own click.
const SYS_FOLD_KEY = 'rscanvas.systemFolded';
/** id -> unfold(), so a link elsewhere (your name, for My account) can open
 *  a folded panel rather than land the operator on a closed header. */
const systemUnfold = new Map();
function setupSystemFolds() {
    let saved = null;
    try {
        const v = JSON.parse(localStorage.getItem(SYS_FOLD_KEY) || 'null');
        if (Array.isArray(v)) saved = new Set(v);
    } catch { /* default fold */ }
    const panels = [...document.querySelectorAll('.panel[data-section="system"]')];
    const persist = () => {
        const folded = panels.filter((p) => p.classList.contains('folded')).map((p) => p.id);
        try { localStorage.setItem(SYS_FOLD_KEY, JSON.stringify(folded)); } catch { /* per-browser nicety */ }
    };
    for (const panel of panels) {
        const h = panel.querySelector(':scope > h2');
        if (h === null || !panel.id) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fold-btn';
        btn.setAttribute('aria-label', 'fold or unfold this section');
        h.prepend(btn);
        h.classList.add('fold-head');
        const set = (folded) => {
            panel.classList.toggle('folded', folded);
            btn.setAttribute('aria-expanded', String(!folded));
        };
        set(saved === null ? panel.id !== 'health-panel' : saved.has(panel.id));
        systemUnfold.set(panel.id, () => { set(false); persist(); });
        h.addEventListener('click', (ev) => {
            const ctl = ev.target instanceof Element ? ev.target.closest('button, a, input, select, label') : null;
            if (ctl !== null && ctl !== btn) return;
            set(!panel.classList.contains('folded'));
            persist();
        });
    }
}
setupSystemFolds();

// --- My account: change your own password (2026-09-25, operator) -------------

$('whoami').addEventListener('click', () => {
    showSection('system');
    systemUnfold.get('account-panel')?.();
    $('account-panel').scrollIntoView({ block: 'start' });
    $('pw-current').focus();
});

$('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('pw-msg');
    const current = $('pw-current').value;
    const next = $('pw-new').value;
    // Checked here for a quick answer; the server checks the length again
    // and is the one that decides.
    if (next !== $('pw-confirm').value) { msg.textContent = 'the new password and its repeat differ'; return; }
    if (next.length < 8) { msg.textContent = 'the new password needs at least 8 characters'; return; }
    if (next === current) { msg.textContent = 'that is the current password'; return; }
    msg.textContent = 'changing...';
    const r = await api(`/api/users/${encodeURIComponent(myUsername)}/password`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    // Whatever happened, the typed passwords leave the page: a form that
    // keeps them is one more place for them to sit.
    for (const id of ['pw-current', 'pw-new', 'pw-confirm']) $(id).value = '';
    if (r.status === 401) { showLogin(); return; }
    // api() folds a 403 into {ok:false} without the body; for this route a
    // 403 is the server's "Current password is incorrect."
    if (r.status === 403) { msg.textContent = 'the current password is not right - nothing changed'; return; }
    if (!r.ok) { msg.textContent = r.detail || `refused (${r.status})`; return; }
    const others = Number(r.sessionsRevoked) || 0;
    msg.textContent = `password changed${others > 0 ? ` - ${others} other session(s) signed out` : ''}`;
});

// --- the Dashboard (2026-09-25, operator) --------------------------------------
//
// Open alerts first, from the same list the Alerts page renders (no second
// query); then the top 10 lists from /api/dashboard, which the server caches
// per window for a minute. The lists are refetched on arrival, on a window
// change, and at most once a minute while the Dashboard is on screen - they
// can only move when the hourly rollup does.

function fmtCount(n) {
    if (n === null || n === undefined) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    return String(Math.round(n));
}

/** "vs before": the change against the previous window, or nothing to say. */
function trendCell(t) {
    const c = cell('', 'num muted small');
    if (t === null || t === undefined) { c.title = 'nothing in the window before this one to compare with'; return c; }
    const pct = Math.round(t * 100);
    c.textContent = pct === 0 ? 'same' : `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
    c.title = `${pct > 0 ? '+' : ''}${pct}% against the previous window of the same length`;
    return c;
}

/** Interface name with its description beside it, and the coverage when short. */
function dashIfCell(r) {
    const c = cell(r.name || r.code);
    if (r.alias) {
        const a = document.createElement('span');
        a.className = 'muted small';
        a.textContent = ` ${r.alias}`;
        c.appendChild(a);
    }
    if (r.coverage < 0.95) {
        const b = badge(`saw ${Math.round(r.coverage * 100)}%`, 'badge warn');
        b.title = 'the samples covered only this share of the window - the device did not answer, or rebooted, for the rest';
        c.append(document.createTextNode(' '), b);
    }
    return c;
}

let dashLoadedAt = 0;
let dashGen = 0;

/** Open the device page on this interface's or sensor's chart. */
async function openEntityChart(device, code) {
    showSection('devices');
    await showDevice(device);
    const e = lastEntities.find((x) => x.code === code);
    if (e && currentDevice === device) openChart(e);
}

function renderDashList(tableId, rows, cells, empty) {
    const tbody = $(tableId).querySelector('tbody');
    tbody.replaceChildren();
    if (rows.length === 0) {
        const tr = rowEl([cell(empty, 'muted small')]);
        tr.firstChild.colSpan = 5;
        tbody.appendChild(tr);
        return;
    }
    for (const r of rows) {
        const tr = rowEl(cells(r));
        tr.className = 'clickable';
        tr.title = `open ${r.device} on this chart`;
        tr.addEventListener('click', () => openEntityChart(r.device, r.code));
        tbody.appendChild(tr);
    }
}

async function loadDashboard() {
    const gen = ++dashGen;
    const hours = Number($('dash-window').value) || 24;
    $('dash-msg').textContent = dashLoadedAt === 0 ? 'loading...' : '';
    const r = await api(`/api/dashboard?window=${hours}`);
    if (gen !== dashGen) return;
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('dash-msg').textContent = r.detail || `could not load (${r.status})`; return; }
    dashLoadedAt = Date.now();
    if (r.window === null) {
        $('dash-window-sub').textContent = '';
        $('dash-msg').textContent = r.detail || 'nothing rolled up yet';
    } else {
        const to = new Date(r.window.to);
        const label = hours === 168 ? '7 days' : `${hours} hours`;
        $('dash-window-sub').textContent = `the ${label} to ${to.toLocaleString([], {
            weekday: hours === 168 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' })}`;
        $('dash-msg').textContent = '';
    }
    const traffic = (key, peakKey, trendKey) => (x) => [
        cell(x.device), dashIfCell(x), cell(fmtBytes(x[key]), 'num'),
        cell(fmtBps(x[peakKey]), 'num'), trendCell(x[trendKey]),
    ];
    renderDashList('dash-rx', r.rx || [], traffic('inBytes', 'peakInBps', 'trendIn'), 'no traffic recorded in this window');
    renderDashList('dash-tx', r.tx || [], traffic('outBytes', 'peakOutBps', 'trendOut'), 'no traffic recorded in this window');
    renderDashList('dash-errs', r.errs || [], (x) => [
        cell(x.device), dashIfCell(x), cell(fmtCount(x.errors), 'num'),
        cell(fmtCount(x.discards), 'num'), trendCell(x.trendErrs),
    ], 'no errors or discards on any interface - a clean window');
    const pctRow = (x) => [
        cell(x.device), cell(x.name || x.code, 'muted'),
        cell(x.meanPct === null ? '' : `${Math.round(x.meanPct)}%`, 'num'),
        cell(x.peakPct === null ? '' : `${Math.round(x.peakPct)}%`, 'num'), trendCell(x.trend),
    ];
    renderDashList('dash-cpu', r.cpu || [], pctRow, 'no CPU readings in this window');
    renderDashList('dash-mem', r.mem || [], pctRow, 'no memory readings in this window');
}
$('dash-window').addEventListener('change', () => { dashLoadedAt = 0; loadDashboard(); });

/** The Dashboard's alert list: active, pending and clearing, worst first. */
function renderDashAlerts() {
    const all = (alertData.open || []).filter((a) => a.state !== 'cleared');
    const sev = { crit: 0, warn: 1 };
    const order = { active: 0, clearing: 1, pending: 2 };
    const sorted = [...all].sort((x, y) => (order[x.state] ?? 3) - (order[y.state] ?? 3)
        || (sev[x.severity] ?? 2) - (sev[y.severity] ?? 2)
        || Date.parse(x.raised_ts ?? x.first_breach_ts ?? 0) - Date.parse(y.raised_ts ?? y.first_breach_ts ?? 0));
    const SHOWN = 10;
    const tbody = $('dash-alerts').querySelector('tbody');
    tbody.replaceChildren();
    for (const a of sorted.slice(0, SHOWN)) {
        const tr = rowEl([
            pill(a.severity, `sev ${a.severity}`),
            a.state === 'active' ? cell('') : pill(a.state, `sev ${a.state}`),
            cell(a.label),
            cell(fmtValue(a.value, a.unit), 'num'),
            cell(a.raised_ts ? fmtAgo(a.raised_ts) : `breach ${fmtAgo(a.first_breach_ts)}`),
        ]);
        tr.className = 'clickable';
        if (a.in_maintenance || a.under_policy || a.in_group) tr.classList.add('maint-row');
        tr.addEventListener('click', () => { showSection('alerts'); showAlert(a.id); });
        tbody.appendChild(tr);
    }
    const count = (s) => all.filter((a) => a.state === s).length;
    // "Pending" is breaching and not yet past the raise count - the state the
    // operator calls soaking; the tooltip says so rather than a second name.
    const total = alertData.capped === true && typeof alertData.openTotal === 'number' ? alertData.openTotal : all.length;
    $('dash-alert-counts').textContent = total === 0 ? ''
        : `${count('active')} active, ${count('pending')} pending, ${count('clearing')} clearing`;
    $('dash-alert-counts').title = 'pending: breaching, not yet raised (soaking); clearing: back to normal, not yet cleared';
    $('dash-alerts').classList.toggle('hidden', all.length === 0);
    $('dash-no-alerts').classList.toggle('hidden', all.length > 0);
    const more = total - Math.min(SHOWN, sorted.length);
    $('dash-alerts-more').textContent = more > 0 ? `and ${more} more on the Alerts page` : '';
    $('dash-alerts-more').classList.toggle('hidden', more <= 0);
}

// --- device health by group (2026-09-28, operator) --------------------------------
//
// Below the alerts: every location and application with its devices up and
// down, so the Dashboard says how the whole environment stands. Counted on
// the server (/api/dashboard/groups) with the device list's own status and
// without transient devices; fetched on arrival and with the 10 s refresh
// while the Dashboard is on screen. Zero is shown, because zero down is a
// measurement; the pending column appears only when some group has one.

let dashGroupsGen = 0;

/**
 * Open the device list on one group, problems first or down only. The filter
 * says location:<name> or application:<name>, an exact match: as a plain
 * word "Lab" also matched every device named lab-node-... (parse.js).
 */
function openGroup(axis, value, scope) {
    $('device-filter').value = `${axis}:${value ?? ''}`;
    $('device-scope').value = scope;
    showSection('devices');
    showRoster();
    renderDevices(null);
}

function renderDashGroup(tableId, groups, noneLabel) {
    const table = $(tableId);
    const tbody = table.querySelector('tbody');
    tbody.replaceChildren();
    const anyOther = groups.some((g) => g.other > 0);
    table.querySelector('th.dash-other').classList.toggle('hidden', !anyOther);
    if (groups.length === 0) {
        const tr = rowEl([cell('no devices yet', 'muted small')]);
        tr.firstChild.colSpan = 4;
        tbody.appendChild(tr);
        return;
    }
    for (const g of groups) {
        const down = cell(String(g.down), g.down > 0 ? 'num cell-crit' : 'num muted');
        const other = cell(String(g.other), g.other > 0 ? 'num cell-warn' : 'num muted');
        if (!anyOther) other.classList.add('hidden');
        const tr = rowEl([
            // No location or application is a group of its own, last: leaving
            // the untagged out would report better coverage than exists.
            g.value === null ? cell(noneLabel, 'muted') : cell(g.value),
            cell(String(g.up), g.up > 0 ? 'num cell-ok' : 'num muted'), down, other,
        ]);
        const axis = tableId === 'dash-loc' ? 'location' : 'application';
        const what = g.value === null ? `with no ${axis}` : `in "${g.value}"`;
        tr.className = 'clickable';
        tr.title = `open the devices ${what}${g.value === null ? ' - set one on the device page, under Modify' : ''}`;
        tr.addEventListener('click', () => openGroup(axis, g.value, 'problems'));
        if (g.down > 0) {
            down.title = `open only the ${g.down} down ${what}`;
            down.addEventListener('click', (ev) => { ev.stopPropagation(); openGroup(axis, g.value, 'down'); });
        }
        tbody.appendChild(tr);
    }
}

async function loadDashGroups() {
    const gen = ++dashGroupsGen;
    const r = await api('/api/dashboard/groups');
    if (gen !== dashGroupsGen) return;
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('dash-groups-msg').textContent = r.detail || `could not load (${r.status})`; return; }
    $('dash-groups-msg').textContent = '';
    const locations = r.locations || [];
    renderDashGroup('dash-loc', locations, 'no location');
    renderDashGroup('dash-app', r.applications || [], 'no application');
    // Every device sits in exactly one location group, so those rows sum to
    // the whole.
    const sum = (k) => locations.reduce((n, g) => n + (Number(g[k]) || 0), 0);
    const up = sum('up'), down = sum('down'), other = sum('other');
    $('dash-groups-sub').textContent = up + down + other === 0 ? ''
        : `${up} up, ${down} down${other > 0 ? `, ${other} pending/unknown` : ''} - transient devices not counted`;
}

// --- group alerts (slice 55, 2026-09-29) ------------------------------------------
//
// Every location and application, a box to watch it, and its rule: the
// percent of its known devices down and the minimum count. Each change saves
// that one group at once - there is no form to forget to submit. Operators
// read it; changing it needs alertrule.write, like the syslog and trap rules.

async function loadGroupAlerts() {
    const r = await api('/api/group-alerts');
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('group-alerts-msg').textContent = r.detail || `could not load (${r.status})`; return; }
    $('group-alerts-msg').textContent = '';
    renderGroupAlerts(r.groups || []);
}

function numberInput(value, min, max, title) {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = String(min);
    if (max !== null) i.max = String(max);
    i.step = '1';
    i.value = String(value);
    i.title = title;
    return i;
}

function renderGroupAlerts(groups) {
    const tbody = $('group-alerts-table').querySelector('tbody');
    tbody.replaceChildren();
    const writable = can('alertrule.write');
    const watched = groups.filter((g) => g.enabled).length;
    $('group-alerts-sub').textContent = groups.length === 0 ? '' : `${watched} of ${groups.length} watched`;
    if (groups.length === 0) {
        const tr = rowEl([cell('no locations or applications yet - set them on the device page, under Modify', 'muted small')]);
        tr.firstChild.colSpan = 7;
        tbody.appendChild(tr);
        return;
    }
    for (const g of groups) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = g.enabled === true;
        box.disabled = !writable;
        box.title = `watch ${g.axis} "${g.value}"`;
        const pct = numberInput(g.thresholdPct, 1, 100, 'percent of the devices whose status is known');
        const min = numberInput(g.minDown, 1, null, 'devices down, at least');
        pct.disabled = !writable;
        min.disabled = !writable;
        const state = cell('', 'muted small');
        const save = async () => {
            state.textContent = 'saving...';
            const r = await api('/api/group-alerts', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    axis: g.axis, value: g.value, enabled: box.checked,
                    thresholdPct: Number(pct.value), minDown: Number(min.value),
                }),
            });
            if (r.status === 401) { showLogin(); return; }
            state.textContent = r.ok ? (box.checked ? 'watched' : 'not watched') : (r.detail || `refused (${r.status})`);
            if (r.ok) g.enabled = box.checked;
            $('group-alerts-sub').textContent = `${groups.filter((x) => x.enabled).length} of ${groups.length} watched`;
        };
        box.addEventListener('change', save);
        pct.addEventListener('change', save);
        min.addEventListener('change', save);

        const name = cell(g.value);
        const axis = document.createElement('span');
        axis.className = 'muted small';
        axis.textContent = ` ${g.axis}`;
        name.appendChild(axis);
        if (g.gone) {
            name.append(document.createTextNode(' '), badge('no devices now', 'badge'));
        }
        const boxCell = document.createElement('td');
        boxCell.appendChild(box);
        const pctCell = document.createElement('td');
        pctCell.className = 'num';
        pctCell.append(pct, document.createTextNode(' %'));
        const minCell = document.createElement('td');
        minCell.className = 'num';
        minCell.append(min, document.createTextNode(' down'));
        const tr = rowEl([
            cell(''), name,
            cell(String(g.up), g.up > 0 ? 'num cell-ok' : 'num muted'),
            cell(String(g.down), g.down > 0 ? 'num cell-crit' : 'num muted'),
            cell(''), cell(''), state,
        ]);
        tr.replaceChild(boxCell, tr.children[0]);
        tr.replaceChild(pctCell, tr.children[4]);
        tr.replaceChild(minCell, tr.children[5]);
        tbody.appendChild(tr);
    }
}

// --- the interface traffic report ----------------------------------------------

/** code -> { device, name, alias }, across devices: an ISP link on one
 *  router and a backup on another belong in the same report. */
const reportChosen = new Map();
let reportPickDevice = null;
let reportPickEntities = [];

function localDay(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The period as [from, to] local dates, or null when a custom one is incomplete. */
function reportRange() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    switch ($('report-period').value) {
        case 'this-month': return [localDay(new Date(y, m, 1)), localDay(now)];
        case 'last-month': return [localDay(new Date(y, m - 1, 1)), localDay(new Date(y, m, 0))];
        case 'last-7': return [localDay(new Date(y, m, now.getDate() - 6)), localDay(now)];
        case 'last-30': return [localDay(new Date(y, m, now.getDate() - 29)), localDay(now)];
        default: {
            const f = $('report-from').value, t = $('report-to').value;
            return f && t ? [f, t] : null;
        }
    }
}

function reportQuery(format) {
    const range = reportRange();
    if (range === null || reportChosen.size === 0) return null;
    const q = new URLSearchParams({
        codes: [...reportChosen.keys()].join(','),
        from: range[0], to: range[1],
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    if (format) q.set('format', format);
    return q.toString();
}

function syncReportControls() {
    const chosen = $('report-chosen');
    chosen.replaceChildren();
    for (const [code, x] of reportChosen) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = `${x.device} ${x.name || code}`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'chip-x';
        rm.textContent = 'x';
        rm.title = 'remove from the report';
        rm.addEventListener('click', () => { reportChosen.delete(code); syncReportControls(); renderReportPick(); });
        chip.appendChild(rm);
        chosen.appendChild(chip);
    }
    $('report-none').classList.toggle('hidden', reportChosen.size > 0);
    const custom = $('report-period').value === 'custom';
    $('report-from').classList.toggle('hidden', !custom);
    $('report-to').classList.toggle('hidden', !custom);
    const q = reportQuery('csv');
    const link = $('report-csv');
    link.classList.toggle('hidden', q === null);
    if (q !== null) {
        link.href = `/api/report/traffic?${q}`;
        const range = reportRange();
        link.download = `rscanvas-traffic-${range[0]}-to-${range[1]}.csv`;
    }
}

function renderReportPick() {
    const box = $('report-pick');
    box.replaceChildren();
    const needle = $('report-filter').value.trim().toLowerCase();
    const ifs = reportPickEntities.filter((e) => (!e.kind || e.kind === 'if')
        && (needle === '' || `${e.name ?? ''} ${e.alias ?? ''}`.toLowerCase().includes(needle)));
    for (const e of ifs.slice(0, 200)) {
        const label = document.createElement('label');
        label.className = 'small';
        const box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.checked = reportChosen.has(e.code);
        box2.addEventListener('change', () => {
            if (box2.checked) reportChosen.set(e.code, { device: reportPickDevice, name: e.name, alias: e.alias });
            else reportChosen.delete(e.code);
            syncReportControls();
        });
        label.append(box2, document.createTextNode(` ${e.name || e.code}${e.alias ? ` - ${e.alias}` : ''}`
            + `${e.tracked ? '' : ' (not tracked - no history)'}`));
        box.appendChild(label);
    }
    $('report-pick-msg').textContent = reportPickDevice === null ? ''
        : ifs.length > 200 ? `showing 200 of ${ifs.length} - narrow the filter` : `${ifs.length} interface(s)`;
    box.classList.toggle('hidden', reportPickDevice === null);
    $('report-filter').classList.toggle('hidden', reportPickDevice === null);
}

async function pickReportDevice() {
    const name = $('report-device').value.trim();
    if (name === '' || name === reportPickDevice) return;
    if (!lastDevices.some((d) => d.name === name)) {
        $('report-pick-msg').textContent = 'no device by that name';
        return;
    }
    $('report-pick-msg').textContent = 'loading...';
    const r = await api(`/api/device?name=${encodeURIComponent(name)}`);
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { $('report-pick-msg').textContent = r.detail || `could not load (${r.status})`; return; }
    reportPickDevice = name;
    reportPickEntities = r.entities || [];
    $('report-filter').value = '';
    renderReportPick();
}
$('report-device').addEventListener('change', pickReportDevice);
$('report-filter').addEventListener('input', renderReportPick);
for (const id of ['report-period', 'report-from', 'report-to']) {
    $(id).addEventListener('change', syncReportControls);
}

$('report-run').addEventListener('click', async () => {
    const q = reportQuery(null);
    const msg = $('report-msg');
    if (q === null) {
        msg.textContent = reportChosen.size === 0 ? 'choose at least one interface' : 'choose both dates';
        return;
    }
    msg.textContent = 'running...';
    const r = await api(`/api/report/traffic?${q}`);
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { msg.textContent = r.detail || `refused (${r.status})`; return; }
    const tbody = $('report-table').querySelector('tbody');
    tbody.replaceChildren();
    const gb = (v) => (v === null ? '' : `${v.toLocaleString()} GB`);
    const mbps = (v) => (v === null ? '' : `${v.toLocaleString()} Mb/s`);
    for (const l of r.lines || []) {
        // A total row says "total" here, with the range in its title; the
        // CSV keeps the full "total <from> to <to>", where there is no hover.
        const isTotal = l.day.startsWith('total');
        const dayCell = cell(isTotal ? 'total' : l.day);
        if (isTotal) dayCell.title = l.day;
        const tr = rowEl([
            dayCell, cell(l.device), cell(l.iface), cell(l.description, 'muted'),
            cell(gb(l.inGB), 'num'), cell(gb(l.outGB), 'num'), cell(gb(l.totalGB), 'num'),
            cell(mbps(l.peakInMbps), 'num'), cell(mbps(l.peakOutMbps), 'num'),
            cell(`${l.coveragePct}%`, l.coveragePct < 95 ? 'num cell-warn' : 'num'),
        ]);
        if (isTotal) tr.className = 'total-row';
        tbody.appendChild(tr);
    }
    $('report-table').classList.toggle('hidden', (r.lines || []).length === 0);
    const through = r.through ? new Date(r.through).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
    msg.textContent = (r.lines || []).length === 0 ? 'nothing recorded for these interfaces in this period'
        : `${r.from} to ${r.to} (${r.tz})${through ? `, complete hours through ${through}` : ''}`
            + `${(r.missing || []).length ? ` - ${r.missing.length} interface(s) had nothing in range` : ''}`;
});

function fillReportDevices() {
    const dl = $('report-devices');
    if (dl.childElementCount === lastDevices.length) return;
    dl.replaceChildren();
    for (const d of lastDevices) {
        const o = document.createElement('option');
        o.value = d.name;
        dl.appendChild(o);
    }
}

// --- admin: retention, users, audit --------------------------------------------
//
// THE RETENTION PAGE EXISTS BECAUSE OF A SPECIFIC MISTAKE, AND IT IS BUILT SO
// THE PAGE CANNOT REPEAT IT.
//
// "What will retention drop tonight" looks like arithmetic - take the date,
// subtract the keep days - and it is not. A partition is kept until its UPPER
// bound clears the cutoff, so a day-partition dated D survives to D + keep + 1.
// I published a staircase of drop dates in SOAK-CRITERIA that was a day early
// on every row, from reasoning about the phrase "8-day retention" instead of
// reading the installed predicate. A page doing that arithmetic would hand the
// same off-by-one to an operator, who would have no way to see it was wrong.
//
// So the page does not compute the answer. It ASKS the guarded function, in
// dry run, and renders what comes back - which also means the guards report
// themselves: a partition held back by the rollup frontier, or by the per-run
// cap, or by the minimum-partitions floor appears as that refusal rather than
// silently missing from a list of "old" partitions.
//
// The preview is a BUTTON, never part of the refresh loop. The function takes
// a transaction-scoped advisory lock that the real hourly run also wants, and
// a page polling it could make retention skip hour after hour - an admin
// dashboard quietly disabling the thing it exists to report on.

let adminData = null;
let isAdmin = false;
let myRole = 'viewer';
let myUsername = '';

/** Show each data-can control to a role that holds its action (see can()). */
function applyCanGates() {
    for (const el of document.querySelectorAll('[data-can]:not(.panel)')) {
        el.classList.toggle('hidden', !canAny(el.dataset.can));
    }
    // The roster's selection column exists for the bulk actions; a role with
    // none of them gets no checkboxes rather than a column that selects
    // nothing it can act on.
    const bulk = canAny('device.disable device.group device.mute device.create device.delete');
    $('devices').classList.toggle('no-select', !bulk);
}
let lastBoards = [];
let lastGridFields = [];
let lastGridDefaults = [];

/** Decimal units, as the traffic report's CSV and every carrier bill use them.
 *  Missing is blank, never "0 B" - null is "not measured", not zero. */
function fmtBytes(n) {
    if (n === null || n === undefined) return '';
    const b = Number(n);
    if (!Number.isFinite(b)) return '';
    if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(0)} kB`;
    return `${b} B`;
}

function renderRetention(d) {
    if (d !== null) adminData = d;
    if (adminData === null) return;
    const parts = adminData.partitions || [];
    const needle = $('part-filter').value.trim().toLowerCase();
    const shown = parts.filter((x) => needle === '' || x.partition_name.toLowerCase().includes(needle));

    const total = parts.reduce((a, x) => a + Number(x.bytes || 0), 0);
    $('retention-sub').textContent =
        `${parts.length} partitions, ${fmtBytes(total)} on disk`;

    const tbody = $('partitions').querySelector('tbody');
    tbody.replaceChildren();
    for (const x of shown.slice(0, RENDER_CAP)) {
        // Trigram coverage is on this table because it is the same fact as
        // "how far back can free text reach" - the search page refuses a wide
        // window for exactly the partitions that read `no` here, and an
        // operator who has met that refusal deserves to see why in one place.
        const idx = x.parent !== 'messages' ? cell('', 'muted')
            : x.has_trgm && x.has_host_trgm ? pill('indexed', 'badge ok')
            : x.has_trgm || x.has_host_trgm ? pill('partial', 'badge owed')
            : cell('no', 'muted');
        tbody.appendChild(rowEl([
            cell(x.partition_name),
            cell(x.parent, 'muted'),
            cell(Number(x.est_rows).toLocaleString(), 'num'),
            cell(x.pretty, 'num'),
            idx,
        ]));
    }
    $('part-sub').textContent = shown.length > RENDER_CAP
        ? `showing ${RENDER_CAP} of ${shown.length}`
        : shown.length < parts.length ? `${shown.length} of ${parts.length} match` : '';

    const jt = $('jobs-table').querySelector('tbody');
    jt.replaceChildren();
    const jobs = adminData.jobs || [];
    for (const j of jobs) {
        // `detail.last` is the job's own summary sentence, shown verbatim for
        // the same reason the health problems are: it was written where the
        // facts are, and rewording it here would be a second place for the
        // words to rot.
        const last = j.detail && typeof j.detail === 'object' ? (j.detail.last ?? '') : '';
        const failed = Number(j.failures) > 0 && j.last_ok_ts !== j.last_run_ts;
        jt.appendChild(rowEl([
            cell(j.job),
            failed ? pill(last || 'failed', 'badge owed') : cell(last, 'muted'),
            cell(fmtAgo(j.last_run_ts)),
            cell(fmtAgo(j.last_ok_ts)),
            cell(Number(j.runs).toLocaleString(), 'num'),
            cell(Number(j.failures).toLocaleString(), 'num'),
        ]));
    }
    const noJobs = jobs.length === 0;
    $('jobs-table').classList.toggle('hidden', noJobs);
    $('no-jobs').classList.toggle('hidden', !noJobs);
    // An empty table here means the app has not completed a slow job since it
    // started, which is a different thing from retention being broken. Say so,
    // rather than showing a blank that reads as the latter.
    $('no-jobs').textContent = noJobs
        ? 'no job has recorded a run yet - the durable record starts at the first '
          + 'completed run of a job slower than a minute (retention, rollup, trigram sync)'
        : '';

    const st = $('settings').querySelector('tbody');
    st.replaceChildren();
    for (const c of adminData.config || []) {
        st.appendChild(rowEl([
            cell(c.name),
            cell(String(c.value), 'num'),
            cell(c.means, 'muted'),
        ]));
    }
}

async function previewRetention(table) {
    $('preview-note').textContent = `asking the retention function what it would drop from ${table}...`;
    const r = await api(`/api/admin/retention/preview?table=${encodeURIComponent(table)}`,
        { method: 'POST' });
    if (r.status === 401) { showLogin(); return; }
    const out = $('preview-out');
    out.replaceChildren();
    out.classList.remove('hidden');
    if (!r.ok) {
        $('preview-note').textContent = r.detail || `could not preview (${r.status})`;
        return;
    }
    $('preview-note').textContent =
        `${table}, keeping ${r.keepDays} days - answered by drop_partitions_guarded itself, in dry run`;

    const rows = r.rows || [];
    if (rows.length === 0) {
        out.appendChild(factLine('result',
            'nothing is eligible: no partition has an upper bound older than the cutoff yet'));
        return;
    }
    // Grouped by the function's own action word. Every outcome is named,
    // including the ones that drop nothing - a deferral nobody reports is a
    // leak nobody notices, which is the rule the job caller already follows.
    const by = new Map();
    for (const x of rows) {
        const list = by.get(x.action) ?? [];
        list.push(x.partition_name);
        by.set(x.action, list);
    }
    const MEANS = {
        'would-drop': 'WOULD BE DROPPED by the next run',
        'skipped-locked': 'a retention run is in progress, so this preview could not look',
        'deferred-unrolled': 'held back: the rollup has not consumed these raw samples yet (guard 5)',
        'kept-min-partitions': 'kept: dropping would leave fewer than RETENTION_MIN_PARTITIONS (guard 3)',
        'kept-max-drop': 'kept this run: RETENTION_MAX_DROP_PER_RUN reached (guard 2)',
        'kept-wide-span': 'kept: wider than RETENTION_MAX_SPAN_DAYS (guard 4)',
    };
    for (const [action, list] of by) {
        out.appendChild(factLine(action,
            `${list.length} - ${MEANS[action] ?? 'reported by the retention function'}`));
        // The names go on their own unlabelled line: factLine always prints
        // "label: ", so borrowing it with a blank label rendered a stray
        // leading colon in front of the partition list.
        const names = document.createElement('div');
        names.className = 'muted small';
        names.textContent = list.join(', ');
        out.appendChild(names);
    }
}

$('preview-messages').addEventListener('click', () => previewRetention('messages'));
$('preview-samples').addEventListener('click', () => previewRetention('samples'));
$('part-filter').addEventListener('input', () => renderRetention(null));

function renderUsers(users) {
    const tbody = $('users').querySelector('tbody');
    tbody.replaceChildren();
    for (const u of users) {
        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.addEventListener('click', () => deleteUser(u.username));
        const roleSel = document.createElement('select');
        for (const r of ['viewer', 'operator', 'admin']) {
            const o = document.createElement('option');
            o.value = r; o.textContent = r;
            if (u.role === r) o.selected = true;
            roleSel.appendChild(o);
        }
        roleSel.addEventListener('change', () => setRole(u.username, roleSel.value));
        const roleCell = document.createElement('td');
        roleCell.appendChild(roleSel);
        const delCell = document.createElement('td');
        delCell.appendChild(del);
        const nameCell = u.disabled
            ? cell(`${u.username} (disabled)`, 'muted') : cell(u.username);
        const tr = rowEl([nameCell, cell(''), cell(fmtAgo(u.createdTs)),
            cell(u.lastLoginTs ? fmtAgo(u.lastLoginTs) : 'never signed in', 'muted'), cell('')]);
        tr.replaceChild(roleCell, tr.children[1]);
        tr.replaceChild(delCell, tr.children[4]);
        tbody.appendChild(tr);
    }
    $('users-sub').textContent = `${users.length} user(s)`;
}

/** Whatever the server said, verbatim - it knows why, and this does not. */
function adminSay(id, r, okText) {
    const el = $(id);
    el.textContent = r.ok ? okText : (r.detail || `refused (${r.status})`);
    el.classList.remove('hidden');
}

async function setRole(username, role) {
    const r = await api(`/api/users/${encodeURIComponent(username)}/role`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
    });
    // The last-admin guard lives in the STATEMENT, server-side, and its
    // refusal is the sentence shown here. The page deliberately does not
    // predict it: a client-side "is this the last admin" check would be a
    // second implementation of a rule that must hold under concurrency, and
    // the two would disagree exactly when it mattered.
    adminSay('users-msg', r, `${username} is now ${role}`);
    refreshAdmin();
}

async function deleteUser(username) {
    const r = await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    adminSay('users-msg', r, `deleted ${username}`);
    refreshAdmin();
}

$('new-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            username: $('nu-name').value.trim(),
            password: $('nu-pass').value,
            role: $('nu-role').value,
        }),
    });
    adminSay('new-user-msg', r, `created ${$('nu-name').value.trim()}`);
    if (r.ok) { $('nu-name').value = ''; $('nu-pass').value = ''; }
    refreshAdmin();
});

function renderAudit(rows) {
    const tbody = $('audit').querySelector('tbody');
    tbody.replaceChildren();
    for (const a of rows) {
        tbody.appendChild(rowEl([
            cell(fmtAgo(a.ts)),
            cell(a.actor),
            cell(a.action),
            cell(a.target || '', 'muted'),
            cell(a.sourceIp || '', 'muted'),
            cell(a.detail ? JSON.stringify(a.detail) : '', 'muted'),
        ]));
    }
    const sub = $('audit-sub');
    sub.replaceChildren(document.createTextNode(`${rows.length} most recent `));
    // Show more (easy-win E10): the server has always taken a limit and the
    // client typed 50 - so the fiftieth row was a cliff with no path down,
    // on the one table whose whole job is answering "and what happened
    // before that". Doubles per click, capped where curiosity becomes an
    // export job.
    if (rows.length >= auditLimit && auditLimit < 1600) {
        const more = document.createElement('button');
        more.textContent = 'show more';
        more.addEventListener('click', async () => {
            auditLimit *= 2;
            const r = await api(`/api/audit?limit=${auditLimit}`);
            if (r.ok) renderAudit(r.entries || []);
        });
        sub.appendChild(more);
    }
    $('audit').classList.toggle('hidden', rows.length === 0);
    $('no-audit').classList.toggle('hidden', rows.length > 0);
    $('no-audit').textContent = rows.length === 0 ? 'no audited actions yet' : '';
}
let auditLimit = 50;

// --- boards and display tokens ------------------------------------------------
//
// The recorded requirement is that "revocation is a first-class action in the
// UI rather than a config edit" (ARCHITECTURE). That is the whole reason this
// panel exists: a capability URL leaks through history, referrers, screenshots
// and the sticky note somebody put on the display, so it WILL leak, and the
// mitigation was never secrecy - it is narrow scope plus a revoke button
// somebody can actually find at 2am.

let currentBoard = null;

/** Whether the hand-placed layout controls are offered (BOARDS_MANUAL_LAYOUT). */
let manualLayout = false;

function renderBoards(boards, gridFields, gridDefaults, manual) {
    manualLayout = manual === true;
    for (const el of document.querySelectorAll('.manual-layout')) el.classList.toggle('hidden', !manualLayout);
    if (!manualLayout) $('inv-board').value = '';
    lastBoards = boards;
    if (Array.isArray(gridFields)) lastGridFields = gridFields;
    if (Array.isArray(gridDefaults)) lastGridDefaults = gridDefaults;
    const tbody = $('boards').querySelector('tbody');
    tbody.replaceChildren();
    for (const b of boards) {
        const addrCell = document.createElement('td');
        const addrBtn = document.createElement('button');
        // The label says what the state IS, and the title says what pressing
        // it does. A button labelled with its action ("Show addresses") is
        // ambiguous about the current state, which is the wrong ambiguity for
        // a control that widens what a corridor screen can display.
        addrBtn.textContent = b.show_addresses ? 'addresses shown' : 'addresses hidden';
        addrBtn.title = b.show_addresses
            ? 'Click to stop serving IP addresses to displays of this board'
            : 'Click to serve IP addresses to displays of this board';
        if (b.show_addresses) addrBtn.className = 'badge owed';
        addrBtn.addEventListener('click', () => setBoardAddresses(b.id, !b.show_addresses));
        addrCell.appendChild(addrBtn);

        const actCell = document.createElement('td');
        // Slice 45: OPEN YOUR OWN BOARD WITHOUT MINTING ANYTHING. A display
        // token is stored hashed, so its URL is unrecoverable by construction
        // and losing it means revoke-and-re-mint - correct for a credential
        // handed to a lobby TV, and an absurd tax on the admin who just wants
        // to look at the board they are configuring. This opens the same wall
        // page authorised by the session already in this browser.
        //
        // It mints NOTHING, so there is no new secret to leak or lose, and
        // nothing here to revoke afterwards. Tokens remain the answer for
        // screens and for other people; this is the answer for the person
        // standing at the keyboard.
        const viewBtn = document.createElement('button');
        viewBtn.textContent = 'View';
        viewBtn.title = 'Open this board as a wall in a new tab, signed in as you - no token needed';
        viewBtn.addEventListener('click', () => {
            window.open(`/wall.html?board=${encodeURIComponent(b.id)}`, '_blank', 'noopener');
        });
        actCell.appendChild(viewBtn);
        const manage = document.createElement('button');
        manage.textContent = 'Displays';
        manage.addEventListener('click', () => showTokens(b));
        actCell.appendChild(manage);
        // Slice 26: the grid declaration, state-labelled like the addresses
        // button - "grid: 5 cols" or "grid: off" says what IS, the click
        // opens the editor to change it.
        const gridBtn = document.createElement('button');
        gridBtn.textContent = b.grid_cols === null || b.grid_cols === undefined ? 'grid: off'
            : b.grid_cols === 0 ? 'grid: auto' : `grid: ${b.grid_cols} cols`;
        if (b.grid_cols !== null && b.grid_cols !== undefined) gridBtn.className = 'badge ok';
        gridBtn.title = 'Render this board as a glance grid - tiles in name order, fields by checkbox';
        gridBtn.addEventListener('click', () => showGridEditor(b));
        actCell.appendChild(gridBtn);
        // Slice 30: DELETE, which the route has always had and the page never
        // offered - so a board created by a typo ("Guest PCs (location)" when
        // the operator meant application) was permanent. Confirmed because
        // deleting a board revokes its displays by cascade, which is a
        // consequence worth stating before it happens rather than after.
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.title = 'Delete this board - its display tokens are revoked with it';
        delBtn.addEventListener('click', async () => {
            const live = Number(b.live_tokens) || 0;
            const warn = live > 0
                ? `\n\nThis revokes ${live} live display token(s) - any screen showing this board goes dark.`
                : '';
            if (!window.confirm(`Delete the board "${b.name}"?${warn}`)) return;
            const r = await api(`/api/boards/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
            adminSay('boards-msg', r, `deleted "${b.name}"`);
            refreshAdmin();
        });
        actCell.appendChild(delBtn);

        // Drift, rendered only where it MEANS something. A board with no
        // declared group is not "0 drift" - it is a board the question does
        // not apply to, and printing a reassuring zero would invite reading
        // it as "checked, fine".
        const missing = Number(b.missing);
        const extra = Number(b.extra);
        // BROKEN is reported on every board, including hand-drawn ones: a
        // shape pointing at a deleted device can never light up, and that is
        // true whether or not the board declares a group. It outranks the
        // group counts in the cell because it is the one that is simply wrong.
        const broken = Number(b.broken);
        const driftCell = broken > 0
            ? pill(`${broken} shape(s) point at nothing`, 'badge owed')
            : b.source_axis === null ? cell('not a group board', 'muted')
            : missing === 0 && extra === 0 ? pill('current', 'badge ok')
            : pill([
                missing > 0 ? `${missing} missing` : '',
                extra > 0 ? `${extra} moved away` : '',
            ].filter(Boolean).join(', '), 'badge owed');

        const row = rowEl([
            cell(b.name),
            cell(b.collection, 'muted'),
            cell(b.source_axis === null ? ''
                : Array.isArray(b.source_values) && b.source_values.length > 1
                    ? `${b.source_axis}: ${b.source_values.slice(0, 2).join(', ')}${b.source_values.length > 2 ? ` +${b.source_values.length - 2}` : ''}`
                    : `${b.source_axis}: ${b.source_value ?? 'all'}`, 'muted'),
            cell(''),
            cell(''),
            cell(`${b.live_tokens} of ${b.tokens}`, 'num'),
            cell(''),
        ]);
        const dCell = document.createElement('td');
        dCell.appendChild(driftCell);
        // THE VERBS beside the number (ruling 8). Offered only where they can
        // act - slice 39's rule - so a current board shows its pill alone, a
        // hand-drawn board gets no group verbs (the question does not apply,
        // and its broken-binding count stays a report until a verb for it is
        // ruled on), and each button names the count it will act on.
        if (b.source_axis !== null && (missing > 0 || extra > 0 || broken > 0)) {
            const rec = async (action, extra2) => {
                // A POST with a JSON body. This passed { action } as api()'s
                // fetch OPTIONS, so every verb went out as a bodiless GET, met
                // the router's catch-all and read "not found" - add, drop and
                // rebuild never worked from the page (operator, 2026-09-28,
                // "add 3" for three new ping-only devices).
                // tools/check-api-calls.mjs now refuses that shape.
                const r = await api(`/api/boards/${encodeURIComponent(b.id)}/reconcile`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action, ...(extra2 || {}) }),
                });
                adminSay('boards-msg', r, `${b.name}: ${action} - now ${r.shapes} shape(s)`);
                refreshAdmin();
            };
            if (missing > 0) {
                const addBtn = document.createElement('button');
                addBtn.textContent = `add ${missing}`;
                addBtn.title = 'Append shapes for the devices in this group that are not on the board. '
                    + 'Existing placement is untouched; new arrivals land below it, unarranged.';
                addBtn.addEventListener('click', () => rec('add-missing'));
                dCell.appendChild(document.createTextNode(' '));
                dCell.appendChild(addBtn);
            }
            if (extra > 0 || broken > 0) {
                const dropBtn = document.createElement('button');
                dropBtn.textContent = `drop ${Math.max(extra, broken)}`;
                dropBtn.title = 'Remove the shapes bound to devices that left this group or no longer '
                    + 'exist. Everything else - placement, annotations - is untouched.';
                dropBtn.addEventListener('click', () => rec('drop-moved'));
                dCell.appendChild(document.createTextNode(' '));
                dCell.appendChild(dropBtn);
            }
            const rbBtn = document.createElement('button');
            rbBtn.textContent = 'rebuild';
            rbBtn.title = 'Regenerate this board from its group, discarding every hand placement. '
                + 'The board id and its display tokens survive - that is the point of this '
                + 'over delete-and-recreate.';
            rbBtn.addEventListener('click', () => {
                if (!window.confirm(`Rebuild "${b.name}" from its group?\n\nThis discards every `
                    + 'hand placement on it. The board id and its display tokens survive.')) return;
                void rec('rebuild', { confirm: true });
            });
            dCell.appendChild(document.createTextNode(' '));
            dCell.appendChild(rbBtn);
        }
        row.replaceChild(dCell, row.children[3]);
        row.replaceChild(addrCell, row.children[4]);
        row.replaceChild(actCell, row.children[6]);
        tbody.appendChild(row);
    }
    $('boards-sub').textContent = boards.length === 0 ? 'none yet'
        : `${boards.length} board(s)`;

    // The board picker on the export control. Choosing one carries the
    // existing x/y back into the CSV, so re-importing preserves whatever
    // arrangement a human already made and only new devices get placed.
    const sel = $('inv-board');
    const keep = sel.value;
    sel.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'first generation (auto-place everything)';
    sel.appendChild(none);
    for (const b of boards) {
        const o = document.createElement('option');
        o.value = b.id;
        o.textContent = `regenerate ${b.name} (keep placed positions)`;
        sel.appendChild(o);
    }
    sel.value = keep;
    syncInventoryControls();

    const isel = $('imp-board');
    const ikeep = isel.value;
    isel.replaceChildren();
    for (const b of boards) {
        const o = document.createElement('option');
        o.value = b.id;
        o.textContent = b.name;
        isel.appendChild(o);
    }
    isel.value = ikeep;
}

// --- the glance grid editor (slice 26) ----------------------------------------
//
// Checkboxes from the SERVER'S registry (it rides the /api/boards payload),
// never a client list - one registry, one place to rot. Identity fields are
// visually set apart because ticking one widens what a display token can
// see: "top usage" is a number, "top interface NAME" tells a stranger which
// port to go look at.

let gridBoard = null;

function showGridEditor(b) {
    gridBoard = b;
    $('grid-editor').classList.remove('hidden');
    $('grid-title').textContent = b.name;
    $('grid-auto').checked = b.grid_cols === 0;
    $('grid-cols').value = b.grid_cols === 0 ? '' : (b.grid_cols ?? '');
    $('grid-cols').disabled = b.grid_cols === 0;
    $('grid-msg').textContent = '';
    const checks = $('grid-checks');
    checks.replaceChildren();
    // FIRST TIME ONLY (slice 34): a board that has never had a grid opens
    // with the sensible value fields ticked, so switching grid mode on does
    // not produce a wall of bare names. It is a SUGGESTION, not a stored
    // default - the ticks are visible before Save, so nothing is applied
    // that the operator did not look at. A board that has been configured
    // and had every field unticked keeps that answer, which is why the test
    // is on grid_cols rather than on the field list being empty.
    const neverConfigured = b.grid_cols === null || b.grid_cols === undefined;
    const stored = Array.isArray(b.grid_fields) ? b.grid_fields : [];
    const chosen = new Set(
        neverConfigured && stored.length === 0 ? lastGridDefaults : stored,
    );
    for (const f of lastGridFields) {
        const lab = document.createElement('label');
        lab.className = 'small';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.key = f.key;
        box.checked = chosen.has(f.key);
        lab.appendChild(box);
        lab.appendChild(document.createTextNode(` ${f.label}`));
        if (f.identity) {
            const tag = document.createElement('span');
            tag.className = 'muted';
            tag.textContent = ' (identity)';
            tag.title = 'Names a thing rather than measuring it - showing it widens what a display can reveal';
            lab.appendChild(tag);
        }
        checks.appendChild(lab);
    }
}

$('grid-close').addEventListener('click', () => {
    gridBoard = null;
    $('grid-editor').classList.add('hidden');
});

$('grid-auto').addEventListener('change', () => {
    $('grid-cols').disabled = $('grid-auto').checked;
    if ($('grid-auto').checked) $('grid-cols').value = '';
});

$('grid-save').addEventListener('click', async () => {
    if (gridBoard === null) return;
    const raw = $('grid-cols').value.trim();
    // Blank is "drawn from coordinates" only where manual layout is offered;
    // otherwise a board always lays itself out, and blank means auto.
    const cols = $('grid-auto').checked ? 0 : raw === '' ? (manualLayout ? null : 0) : Number(raw);
    const fields = [...$('grid-checks').querySelectorAll('input:checked')].map((x) => x.dataset.key);
    const r = await api(`/api/boards/${encodeURIComponent(gridBoard.id)}/grid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols, fields }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('grid-msg').textContent = r.ok
        ? (cols === null
            ? 'grid off - displays draw the board from its coordinates again'
            : cols === 0
                ? `displays now fit their own screens automatically, ${fields.length} field(s) - live within one refresh`
                : `displays now render ${cols} columns with ${fields.length} field(s) - live within one refresh`)
        : (r.detail || `refused (${r.status})`);
    if (r.ok) refreshAdmin();
});

async function setBoardAddresses(id, show) {
    const r = await api(`/api/boards/${encodeURIComponent(id)}/addresses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ show }),
    });
    adminSay('boards-msg', r, show
        ? 'displays of this board will now show IP addresses'
        : 'addresses withheld from displays of this board');
    refreshAdmin();
}

/**
 * Choosing an existing board hands it authority over the group.
 *
 * The board already recorded what it is a picture of, so the axis and value
 * inputs stop being a question and start being a way to contradict it. They
 * are disabled and filled with the board's own answer - the server prefers
 * the board regardless, and a control whose value the server ignores is a
 * small lie told every time somebody looks at it.
 */
function syncInventoryControls() {
    const id = $('inv-board').value;
    const board = id === '' ? null : lastBoards.find((b) => b.id === id);
    const owned = board?.source_axis ?? null;
    $('inv-axis').disabled = owned !== null;
    $('inv-value').disabled = owned !== null;
    if (owned !== null) {
        const vals = Array.isArray(board.source_values) && board.source_values.length > 0
            ? board.source_values : (board.source_value !== null ? [board.source_value] : []);
        $('inv-axis').value = board.source_axis;
        $('inv-value').value = vals.join(', ');
        $('inv-msg').textContent =
            `${board.name} is the ${board.source_axis} board for "${vals.join(', ') || 'everything'}" - `
            + 'regenerating exports that set again, and CrossCanvas will lay it out '
            + 'fresh inside drawn zones. It does not preserve positions: coordinates '
            + 'and zones are mutually exclusive on import.';
    } else if (id !== '') {
        $('inv-msg').textContent =
            'that board has no declared group, so this export uses the axis and value chosen here';
    } else {
        $('inv-msg').textContent = '';
    }
}
$('inv-board').addEventListener('change', syncInventoryControls);

$('inv-export').addEventListener('click', async () => {
    const boardId = $('inv-board').value;
    const axis = $('inv-axis').value;
    const value = $('inv-value').value.trim();

    // FIRST GENERATION CREATES THE BOARD, and that is the point of doing it
    // here: "generate a board for HQ / Floor 3" is the moment the group is
    // chosen, so it is the moment to record it. Waiting until somebody
    // remembers to set the source afterwards is how a board ends up
    // undriftable forever - the check exists but nothing it can check.
    //
    // The board is created by a POST before the download, rather than the
    // download creating it: a GET that makes a resource is a surprise for
    // every cache, prefetcher and reload button in the world.
    // Slice 30: blank + "every group" ticked is the ALL-FLEET board, the one
    // the operator went looking for and could not make. Blank alone still
    // means "just export the CSV", because a blank field is not a request.
    const wantAll = $('inv-all').checked;
    if (!manualLayout && value === '' && !wantAll) {
        $('inv-msg').textContent = 'name a group (or several, with commas), or tick "every group"';
        return;
    }
    if (boardId === '' && (value !== '' || wantAll)) {
        // Slice 27: commas declare a TEAM board - "PAM, Exchange, VOIP" makes
        // one board sectioned by those groups, in that order. One value stays
        // exactly what it was.
        const values = value.split(',').map((v) => v.trim()).filter((v) => v !== '');
        const boardName = wantAll ? `All devices (by ${axis})`
            : values.length > 1 ? `${values[0]} +${values.length - 1} (${axis})`
                : `${value} (${axis})`;
        const made = await api('/api/boards', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: boardName,
                collection: 'wall',
                sourceAxis: axis,
                ...(wantAll ? { allValues: true } : { sourceValues: values }),
            }),
        });
        if (made.status === 401) { showLogin(); return; }
        if (!made.ok) {
            // A duplicate name is the common case - the board already exists,
            // which means somebody generated this group before. Say that
            // rather than the raw refusal, and leave the download to them.
            $('inv-msg').textContent = `${made.detail || 'could not create the board'}`
                + (manualLayout ? ' - if it already exists, pick it above to regenerate.'
                    : ' - if a board for this group already exists, "rebuild" in the table above regenerates it.');
            return;
        }
        await refreshAdmin();
        // Selecting the new board hands the picker to it - the CrossCanvas
        // path's next step. Without manual layout the picker is hidden and the
        // next Generate must make the next board, not export this one.
        if (manualLayout) {
            $('inv-board').value = made.id;
            syncInventoryControls();
        }
        // NO AUTOMATIC DOWNLOAD (slice 30). It made sense while boards were
        // born empty and the ferry was the only way to fill one; now the
        // board arrives populated and the CSV is one path of two, so pushing
        // a file into Downloads on every Generate was the tool assuming an
        // answer. The button below asks.
        $('inv-msg').textContent = `created "${boardName}" with ${made.placed ?? 0} device(s), laid out to fit `
            + 'each screen - open Displays beside it in the table above to put it on a wall.'
            + (manualLayout ? ' Want a drawn, polished layout instead? Pick it above and export the CSV for CrossCanvas.' : '');
        return;
    }

    const params = new URLSearchParams({ axis });
    if (value !== '') params.set('value', value);
    if (boardId !== '') params.set('board', boardId);
    download(`/api/inventory.csv?${params}`);
    if (boardId === '' && value === '') {
        $('inv-msg').textContent = 'exported the whole fleet - no board was created, because '
            + '"everything" is not a group a board can drift from.';
    }
});

/**
 * A plain navigation, not fetch-and-blob: the response carries
 * content-disposition, so the browser saves it under the server's filename -
 * which encodes the axis and the group, because two exports in one session
 * otherwise land as "inventory.csv" and "inventory (1).csv".
 */
function download(url) {
    // DOM-SINK-OK: every caller builds this from a literal /api/ path plus
    // encodeURIComponent'd parameters - see the export callers below. No
    // device string reaches it, and nothing user-typed chooses the scheme.
    window.location.href = url;
}

$('imp-go').addEventListener('click', async () => {
    const file = $('imp-file').files[0];
    const board = $('imp-board').value;
    if (!file || board === '') {
        $('imp-msg').textContent = 'pick a board and a CSV exported from CrossCanvas';
        return;
    }
    $('imp-msg').textContent = 'importing...';
    $('imp-unmatched').classList.add('hidden');
    // Sent as text rather than multipart: it is one file and the server wants
    // its bytes, so a form-data envelope would be packaging with nothing to
    // package. The route bounds the body before reading it.
    const r = await api(`/api/boards/${encodeURIComponent(board)}/import`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: await file.text(),
    });
    if (r.status === 401) { showLogin(); return; }
    $('imp-msg').textContent = r.ok
        ? `placed ${r.placed} device(s)` + (r.unmatched?.length ? `, ${r.unmatched.length} unmatched` : '')
        : (r.detail || `refused (${r.status})`);

    // UNMATCHED ROWS ARE NAMED, not counted. A count sends somebody hunting
    // through a spreadsheet; the names usually make the cause obvious at a
    // glance - a device renamed on one side, or a zone label that was never a
    // device at all.
    const un = r.unmatched ?? [];
    const box = $('imp-unmatched');
    box.replaceChildren();
    if (un.length > 0) {
        box.classList.remove('hidden');
        box.appendChild(factLine('not matched to a device',
            'tried the label against the device name, then IP-Address, then Hostname'));
        const names = document.createElement('div');
        names.className = 'muted small';
        names.textContent = un.join(', ');
        box.appendChild(names);
    }
    if (r.ok) refreshAdmin();
});

$('new-board-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/boards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: $('nb-name').value.trim(),
            collection: $('nb-collection').value,
        }),
    });
    adminSay('boards-msg', r, `created ${$('nb-name').value.trim()}`);
    if (r.ok) $('nb-name').value = '';
    refreshAdmin();
});

async function showTokens(board) {
    currentBoard = board;
    $('tokens-for').classList.remove('hidden');
    $('token-board-name').textContent = board.name;
    $('token-once').classList.add('hidden');
    const r = await api(`/api/boards/${encodeURIComponent(board.id)}/tokens`);
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { adminSay('boards-msg', r, ''); return; }
    const tbody = $('tokens').querySelector('tbody');
    tbody.replaceChildren();
    for (const t of r.tokens || []) {
        const live = t.revoked_ts === null;
        const actCell = document.createElement('td');
        if (live) {
            const rev = document.createElement('button');
            rev.textContent = 'Revoke';
            rev.addEventListener('click', () => revokeToken(t.id, t.label));
            actCell.appendChild(rev);
        }
        const row = rowEl([
            cell(t.label),
            cell(fmtAgo(t.created_ts) + (t.created_by ? ` by ${t.created_by}` : ''), 'muted'),
            // "never" is load-bearing: it is what makes revoking safe to do.
            // The counter is only accurate to the hour by design (see
            // ops.touchToken) - a write per display per poll is the write
            // amplification this codebase has removed three times.
            cell(t.last_used_ts ? fmtAgo(t.last_used_ts) : 'never used', 'muted'),
            live ? pill('live', 'badge ok')
                 : pill(`revoked ${fmtAgo(t.revoked_ts)}`, 'badge owed'),
            cell(''),
        ]);
        row.replaceChild(actCell, row.children[4]);
        tbody.appendChild(row);
    }
    // Slice 30: an EMPTY tokens table is four column headers describing
    // nothing, sitting directly on the mint field - which is what the
    // operator read twice as "the column names are inside the textbox".
    // The headers were never in the box; there was simply nothing between
    // them. Same idiom as the maintenance and policy tables: hide the
    // table, say the state in a sentence.
    const none = (r.tokens || []).length === 0;
    $('tokens').classList.toggle('hidden', none);
    $('no-tokens').classList.toggle('hidden', !none);
}

async function revokeToken(id, label) {
    const r = await api(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
    adminSay('boards-msg', r, r.already
        ? `${label} was already revoked`
        : `${label} revoked - that display stops rendering on its next poll`);
    if (currentBoard !== null) showTokens(currentBoard);
    refreshAdmin();
}

$('new-token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentBoard === null) return;
    const r = await api(`/api/boards/${encodeURIComponent(currentBoard.id)}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: $('nt-label').value.trim() }),
    });
    if (!r.ok) { adminSay('boards-msg', r, ''); return; }
    $('nt-label').value = '';
    // Refresh the ledger FIRST: showTokens hides the one-time reveal as its
    // opening move (rightly - switching boards must never leave a stale
    // secret on screen), and this handler used to call it AFTER building
    // the reveal. The URL lived for less than a frame, every time - the
    // operator minted three tokens hunting for it (2026-08-27) before the
    // audit trail proved the mints were working and the screen was not.
    await showTokens(currentBoard);
    refreshAdmin();
    // THE SECRET EXISTS HERE AND NOWHERE ELSE, EVER AGAIN. Only its hash was
    // stored, so "copy this now" is literally true rather than the usual
    // security theatre - and the panel says which it is, because an operator
    // who has been lied to once about that will screenshot the next one.
    // The reveal is THE DOOR to the wall, and the first operator to walk
    // this path could not find it (2026-08-27: "is there a way to actually
    // view the board?", asked while the URL sat on screen dressed as three
    // fact lines). So: a real link that opens the display, and a real input
    // that selects itself for copying - controls that look like what they do.
    const out = $('token-once');
    out.replaceChildren();
    out.classList.remove('hidden');
    const url = `${location.origin}/wall.html?token=${r.secret}`;
    const open = document.createElement('a');
    // DOM-SINK-OK: `url` is the template two lines above - location.origin
    // plus a server-minted token. Same-origin by construction; the token is
    // the server's own string, not anything a device supplied.
    open.href = url; open.target = '_blank'; open.rel = 'noopener';
    open.className = 'btn-primary';
    open.textContent = 'Open this display now';
    const copy = document.createElement('input');
    copy.type = 'text'; copy.readOnly = true; copy.value = url;
    copy.className = 'grow';
    copy.title = 'the display URL - click to select it all';
    copy.addEventListener('click', () => copy.select());
    const row = document.createElement('div');
    row.className = 'row';
    row.append(open, copy);
    out.appendChild(row);
    out.appendChild(factLine('copy it now',
        'only a hash was stored, so this URL cannot be shown again. If it is '
        + 'lost, revoke this token and mint another - that is cheaper than it sounds.'));
    out.appendChild(factLine('treat it as a password',
        'anyone with this URL can render this board. It is scoped to this one '
        + 'board and can read nothing else, which is why revoking is safe.'));
});

/**
 * Admin data is fetched when the section is OPENED, not on the poll loop.
 * Partition sizes come from pg_total_relation_size over every child of every
 * partitioned table - cheap once, wasteful every ten seconds, and nothing on
 * this page changes on a ten-second timescale anyway. The retention preview
 * is not fetched at all here; see the note above about its lock.
 */
// --- threshold overrides (SLICE-THRESHOLDS-PLAN) ------------------------------
//
// Two surfaces over one route. The thresholds panel under System is the
// fleet-wide list. The per-card control on a device page is where the
// decision is actually made - looking at the 97% RAM-cache card and saying
// "this is fine" - so it is the one that matters, and the panel exists so the
// operator can see every such decision in one place later.
let lastThresholds = null;

function thScopeLabel(o) {
    return o.scope === 'code' ? 'sensor' : o.scope === 'host-kind' ? 'device' : 'everywhere';
}

function renderThresholds(data) {
    lastThresholds = data;
    const tbody = $('thresholds').querySelector('tbody');
    tbody.replaceChildren();
    const rows = data.overrides || [];
    $('th-sub').textContent = `${rows.length} override(s)`;
    for (const o of rows) {
        const state = o.enabled ? pill('active', 'badge ok') : pill('muted', 'badge warn');
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = 'remove';
        del.title = 'Remove this override. The next tier, or the default, applies on the next scan.';
        del.addEventListener('click', () => deleteThreshold(o.id, o));
        const tr = rowEl([
            cell(thScopeLabel(o)), cell(o.kind),
            // A code is a key, not an answer. Eleven mem mutes listed as
            // bare codes left "is FW-1 muted?" unanswerable from the page
            // that knew (2026-08-27) - so code rows now name their sensor,
            // and a row whose sensor is gone says so instead of hiding it.
            cell(o.code
                ? (o.deviceName
                    ? `${o.deviceName}: ${o.entityName} (${o.code})`
                    : `code ${o.code} (sensor no longer exists)`)
                : o.host ? o.host : 'all devices'),
            cell(o.warn === null ? '' : String(o.warn), 'num'), cell(o.crit === null ? '' : String(o.crit), 'num'),
            cell(''), cell(o.note ?? '', 'muted'), cell(''),
        ]);
        const sc = document.createElement('td'); sc.appendChild(state); tr.replaceChild(sc, tr.children[5]);
        const ac = document.createElement('td'); ac.appendChild(del); tr.replaceChild(ac, tr.children[7]);
        tbody.appendChild(tr);
    }
    const d = $('th-defaults');
    d.replaceChildren();
    for (const [kind, lv] of Object.entries(data.defaults || {})) {
        if (!lv || (lv.warn == null && lv.crit == null)) continue;
        d.appendChild(factLine(kind, `warn ${lv.warn ?? '-'} / crit ${lv.crit ?? '-'}`));
    }
}

async function saveThreshold(body) {
    const r = await api('/api/thresholds', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(); return r; }
    return r;
}

async function deleteThreshold(id, o) {
    const what = o.code ? `the override on sensor ${o.code}` : o.host ? `the ${o.kind} override on ${o.host}` : `the ${o.kind} override for every device`;
    if (!window.confirm(`Remove ${what}? The next tier or the default applies on the next scan.`)) return;
    const r = await api('/api/thresholds/delete', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (r.status === 401) { showLogin(); return; }
    const msg = $('th-msg'); msg.textContent = r.detail || `(${r.status})`; msg.classList.remove('hidden');
    const d = await api('/api/thresholds'); if (d.ok) renderThresholds(d);
}

/**
 * The per-card control: a small form that opens INSIDE the sensor card on
 * the device page. Offers the three scopes for this sensor's kind, prefilled
 * with whatever currently applies (override or default), and a mute toggle.
 * Built once per card; the submit writes and closes.
 */
function thresholdControl(s, dev) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'card-gear'; btn.textContent = '⚙';
    btn.title = 'Set the alert threshold for this sensor, this kind on this device, or this kind everywhere - or mute it';
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();   // the card itself opens the history chart
        const card = btn.closest('.card');
        const old = card.querySelector('.th-form');
        if (old) { old.remove(); return; }
        const f = document.createElement('form');
        f.className = 'th-form row';
        f.addEventListener('click', (e) => e.stopPropagation());
        const scope = document.createElement('select');
        for (const [v, l] of [['code', 'this sensor'], ['host-kind', `all ${engineKind(s.kind)} on ${dev?.name ?? 'this device'}`], ['kind', `all ${engineKind(s.kind)} everywhere`]]) {
            const o = document.createElement('option'); o.value = v; o.textContent = l; scope.appendChild(o);
        }
        const warn = document.createElement('input'); warn.type = 'number'; warn.step = 'any'; warn.placeholder = 'warn'; warn.size = 6;
        const crit = document.createElement('input'); crit.type = 'number'; crit.step = 'any'; crit.placeholder = 'crit'; crit.size = 6;
        const note = document.createElement('input'); note.type = 'text'; note.placeholder = 'why (optional)'; note.size = 18;
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn-primary'; save.textContent = 'Set';
        const mute = document.createElement('button'); mute.type = 'button'; mute.textContent = 'Mute';
        mute.title = 'Suspend the rule at the chosen scope. Polling and history continue.';
        const msg = document.createElement('span'); msg.className = 'muted small';
        // Prefill with what CURRENTLY applies - the doc comment above
        // always promised this; the threshold payload finally delivers it.
        if (s.threshold && !s.threshold.muted) {
            if (s.threshold.warn !== null && s.threshold.warn !== undefined) warn.value = String(s.threshold.warn);
            if (s.threshold.crit !== null && s.threshold.crit !== undefined) crit.value = String(s.threshold.crit);
        }
        const body = (enabled) => ({
            kind: engineKind(s.kind),
            host: scope.value === 'host-kind' ? dev?.name : null,
            code: scope.value === 'code' ? s.code : null,
            warn: enabled && warn.value !== '' ? Number(warn.value) : null,
            crit: enabled && crit.value !== '' ? Number(crit.value) : null,
            enabled, note: note.value,
        });
        const done = async (r) => {
            msg.textContent = r.ok ? r.detail : (r.detail || `refused (${r.status})`);
            if (r.ok) {
                setTimeout(() => f.remove(), 2500);
                if (lastThresholds !== null) { const d = await api('/api/thresholds'); if (d.ok) renderThresholds(d); }
            }
        };
        f.addEventListener('submit', async (e) => { e.preventDefault(); done(await saveThreshold(body(true))); });
        mute.addEventListener('click', async () => { done(await saveThreshold(body(false))); });
        f.append(scope, warn, crit, note, save, mute, msg);
        card.appendChild(f);
        warn.focus();
    });
    return btn;
}

// --- credential profiles (SLICE-CREDENTIALS-PLAN) -----------------------------
//
// The page shows NAMES and whether each secret is set and decryptable. It never
// shows a secret and never asks the server for one - the server has no route
// that returns one. Rotation is a password field that goes one way.
let lastCredentials = null;

function renderCredentials(data) {
    lastCredentials = data;
    const tbody = $('credentials').querySelector('tbody');
    tbody.replaceChildren();
    const msg = $('cred-msg');
    if (!data.storeReady) {
        // The one state that needs a sentence rather than a table: no key,
        // so no profiles can exist yet. Env-named refs still work and the
        // form below is left visible so the message and the fix sit together.
        msg.textContent = 'RSCANVAS_SECRET is not set on this server, so profiles cannot be stored yet. '
            + 'Set it in /etc/rscanvas/rscanvas.env and restart (the installer generates one). '
            + 'Environment-named references (SNMP_COMMUNITY_*) keep working without it.';
        msg.classList.remove('hidden');
    } else {
        msg.classList.add('hidden');
    }
    const profiles = data.profiles || [];
    $('cred-sub').textContent = `${profiles.length} profile(s)`
        + (data.envRefs?.length ? `, ${data.envRefs.length} env-named` : '');
    for (const p of profiles) {
        const secret = !p.decryptable
            ? pill('UNDECRYPTABLE', 'badge fail')
            : p.version === '3' ? pill(`v3 ${p.v3Level ?? ''}`.trim(), 'badge')
                : pill(p.hasCommunity ? 'set' : 'missing', p.hasCommunity ? 'badge ok' : 'badge fail');
        if (!p.decryptable) {
            secret.title = 'The stored secret does not decrypt under the current RSCANVAS_SECRET. '
                + 'Either the key changed - restore it - or re-enter this secret below. '
                + 'Devices naming this profile refuse to poll until one of those happens.';
        }
        const actions = document.createElement('td');
        const rot = document.createElement('button');
        rot.type = 'button'; rot.textContent = 're-enter secret';
        rot.addEventListener('click', () => rotateCredential(p.name));
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = 'delete';
        del.addEventListener('click', () => deleteCredential(p.name, p.devices));
        actions.append(rot, document.createTextNode(' '), del);
        const tr = rowEl([
            cell(p.name), cell(`v${p.version}`), cell(''),
            cell(String(p.devices), 'num'), cell(fmtAgo(p.updatedTs)), cell(''),
        ]);
        const sc = document.createElement('td'); sc.appendChild(secret);
        tr.replaceChild(sc, tr.children[2]);
        tr.replaceChild(actions, tr.children[5]);
        tbody.appendChild(tr);
    }
    // Env-named references, listed so an operator can see both kinds in one
    // place and so the picker on the add form has one source of truth.
    for (const name of data.envRefs || []) {
        const tr = rowEl([
            cell(name), cell(''), cell(''), cell('', 'num'), cell(''), cell(''),
        ]);
        const kind = document.createElement('td');
        const k = badge('env var', 'badge'); k.title = 'A name in the service environment, not a stored profile. Edit /etc/rscanvas/rscanvas.env to change it.';
        kind.appendChild(k);
        tr.replaceChild(kind, tr.children[2]);
        tr.className = 'muted';
        tbody.appendChild(tr);
    }
    renderCredentialPicker();
}

/**
 * The add-device form's credential field offers what actually exists - the
 * profiles and the env names - and says which kind each is. This is the
 * change that would have saved the 2026-08-16 onboarding, where the field was
 * a blank box and the community string got typed into it.
 */
function renderCredentialPicker() {
    const list = $('ob-cred-list');
    if (!list) return;
    list.replaceChildren();
    const d = lastCredentials;
    if (!d) return;
    for (const p of d.profiles || []) {
        const o = document.createElement('option');
        o.value = p.name; o.label = `${p.name} (profile, v${p.version}${p.decryptable ? '' : ', UNDECRYPTABLE'})`;
        list.appendChild(o);
    }
    for (const n of d.envRefs || []) {
        const o = document.createElement('option');
        o.value = n; o.label = `${n} (environment variable)`;
        list.appendChild(o);
    }
}

// SNMPv3 (slice 29): the six extra fields appear only for v3, and the
// community field stops being required - a v3 profile has no community, and
// leaving a required empty box on screen is how a form refuses to submit
// with no visible reason.
function syncCredVersion() {
    const v3 = $('nc-version').value === '3';
    $('nc-v3').classList.toggle('hidden', !v3);
    $('nc-community').classList.toggle('hidden', v3);
    $('nc-community').required = !v3;
    $('nc-v3user').required = v3;
    // authPriv needs both keys, authNoPriv only the auth one, noAuthNoPriv
    // neither - required-ness follows the level so the browser enforces what
    // the server would refuse.
    const level = $('nc-v3level').value;
    const needAuth = v3 && level !== 'noAuthNoPriv';
    const needPriv = v3 && level === 'authPriv';
    $('nc-v3authkey').required = needAuth;
    $('nc-v3privkey').required = needPriv;
    $('nc-v3auth').disabled = !needAuth;
    $('nc-v3authkey').disabled = !needAuth;
    $('nc-v3priv').disabled = !needPriv;
    $('nc-v3privkey').disabled = !needPriv;
}
$('nc-version').addEventListener('change', syncCredVersion);
$('nc-v3level').addEventListener('change', syncCredVersion);
syncCredVersion();

$('new-cred-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('nc-name').value.trim();
    const version = $('nc-version').value;
    const body = version === '3'
        ? {
            name, version,
            v3User: $('nc-v3user').value.trim(),
            v3Level: $('nc-v3level').value,
            v3AuthProto: $('nc-v3auth').value,
            v3AuthKey: $('nc-v3authkey').value,
            v3PrivProto: $('nc-v3priv').value,
            v3PrivKey: $('nc-v3privkey').value,
        }
        : { name, version, community: $('nc-community').value };
    const r = await api('/api/credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(); return; }
    // The server's weak-algorithm warning is shown VERBATIM when it comes -
    // it is the one sentence explaining why a profile that saved fine is
    // still worth revisiting.
    $('new-cred-msg').textContent = r.ok
        ? `created ${r.name}${r.warning ? ` - ${r.warning}` : ''}`
        : (r.detail || `refused (${r.status})`);
    if (r.ok) {
        $('nc-name').value = ''; $('nc-community').value = '';
        $('nc-v3user').value = ''; $('nc-v3authkey').value = ''; $('nc-v3privkey').value = '';
        const d = await api('/api/credentials'); if (d.ok) renderCredentials(d);
    }
});

async function rotateCredential(name) {
    const community = window.prompt(`New community for "${name}" (read-only, please). It is encrypted before it is stored and never shown again.`);
    if (community === null || community === '') return;
    const r = await api('/api/credentials/secret', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, community }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('new-cred-msg').textContent = r.ok ? `re-entered the secret for ${name} - devices pick it up within 30s` : (r.detail || `refused (${r.status})`);
    const d = await api('/api/credentials'); if (d.ok) renderCredentials(d);
}

async function deleteCredential(name, devices) {
    // The consequence NAMED before the click, not after. Deleting is how a
    // credential is revoked, so it is never blocked - but the operator should
    // know how many devices go dark.
    const q = devices > 0
        ? `Delete "${name}"? ${devices} device(s) name it and will refuse to poll until re-pointed. This is how a credential is revoked.`
        : `Delete "${name}"?`;
    if (!window.confirm(q)) return;
    const r = await api('/api/credentials/delete', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (r.status === 401) { showLogin(); return; }
    $('new-cred-msg').textContent = r.ok ? r.detail : (r.detail || `refused (${r.status})`);
    const d = await api('/api/credentials'); if (d.ok) renderCredentials(d);
}

async function refreshAdmin() {
    const [ret, users, audit, creds, ths] = await Promise.all([
        api('/api/admin/retention'), api('/api/users'), api(`/api/audit?limit=${auditLimit}`),
        api('/api/credentials'), api('/api/thresholds'),
    ]);
    if (ret.status === 401) { showLogin(); return; }
    if (ret.ok) renderRetention(ret);
    else {
        const el = $('retention-msg');
        el.textContent = ret.detail || `could not load retention (${ret.status})`;
        el.classList.remove('hidden');
    }
    if (users.ok) renderUsers(users.users || []);
    if (audit.ok) renderAudit(audit.entries || []);
    if (creds.ok) renderCredentials(creds);
    if (ths.ok) renderThresholds(ths);
    const boards = await api('/api/boards');
    if (boards.ok) renderBoards(boards.boards || [], boards.gridFields, boards.gridDefaults, boards.manualLayout);
}

let timer = null;

// NEWEST WINS. refresh() is called by the 10s timer AND by a dozen action
// handlers, so two can be in flight - and a set of responses slower than
// the interval would otherwise apply OVER a newer set, stamping the
// "refreshed" clock as if the older data were current. A generation
// counter rather than a skip-while-busy guard, deliberately: a skip would
// swallow the immediate refresh an action handler asked for, and the
// jobs worker's own header records where guard-as-scheduler leads
// (2026-09-01 review).
let refreshGen = 0;

// WHAT THE OPEN TAB SHOWS DECIDES WHAT THE TIMER FETCHES (2026-09-29). The
// alert list and the device roster are the two big answers - about 1.4 MB
// each at 30,000 entities - and each costs the server's page thread 50-60 ms
// to build. Fetched every 10 s by every open tab whatever it showed, one tab
// left on System paused that thread for 40-90 ms every ten seconds (measured
// on the lab box with a CPU profile and the thread's own CPU time). Now each
// is fetched every 10 s only while a view that shows it is open, and once a
// minute otherwise, because other views read them too (the device pickers,
// the slowest agents on Health). A hidden tab fetches nothing, and catches up
// the moment it is looked at. Any other refresh - an action's, sign-in's -
// still fetches everything.
const QUIET_MS = 60_000;
let alertsFetchedAt = 0;
let devicesFetchedAt = 0;
function showsAlerts() {
    return section === 'alerts' || section === 'dashboard' || (section === 'devices' && currentDevice !== null);
}
function showsDevices() { return section === 'devices'; }
// Called when the view changes: a list the quiet cadence let go stale is
// fetched now rather than at the next tick. Not before the first full
// refresh has landed - sign-in runs that one itself.
function freshenShown() {
    if (devicesFetchedAt === 0) return;
    const stale = (at) => Date.now() - at > 10_000;
    if ((showsAlerts() && stale(alertsFetchedAt)) || (showsDevices() && stale(devicesFetchedAt))) {
        refresh({ onlyShown: true });
    }
}

async function refresh(opts = {}) {
    const onlyShown = opts.onlyShown === true;
    if (onlyShown && document.hidden) return;
    const gen = ++refreshGen;
    const now = Date.now();
    const wantAlerts = !onlyShown || showsAlerts() || now - alertsFetchedAt >= QUIET_MS;
    const wantDevices = !onlyShown || showsDevices() || now - devicesFetchedAt >= QUIET_MS;
    const [alerts, devices, health, reachEv, maint, pol] = await Promise.all([
        wantAlerts ? api('/api/alerts') : null, wantDevices ? api('/api/devices') : null, api('/api/health'),
        api('/api/reachability/events'), api('/api/maintenance'), api('/api/policy'),
    ]);
    if ([alerts, devices, reachEv].some((r) => r !== null && r.status === 401)) { showLogin(); return; }
    if (gen !== refreshGen) return;
    if (alerts?.ok) { alertsFetchedAt = now; renderAlerts(alerts); }
    if (section === 'dashboard') {
        renderDashAlerts();
        loadDashGroups();
        if (Date.now() - dashLoadedAt > 60_000) loadDashboard();
    }
    if (devices?.ok) { devicesFetchedAt = now; renderDevices(devices); }
    if (reachEv.ok) renderReachEvents(reachEv);
    if (maint.ok) { maintData = maint.windows || []; renderMaint(); }
    if (pol.ok) { policyData = pol.policies || []; renderPolicies(); }
    // A drill-down that stops updating while you read it is a screenshot. The
    // roster keeps its data current underneath, and the open device refetches
    // its own entities.
    if (currentDevice !== null) {
        // The transient checkbox tracks SERVER truth on every refresh (unless
        // the operator is mid-click on it), so "did it stick?" is answered by
        // looking at it - the operator finding was exactly that doubt.
        const box = $('dev-transient');
        const known = lastDevices.find((x) => x.name === currentDevice);
        if (document.activeElement !== box && known) box.checked = known.transient === true;
        // The mute box follows server truth the same way.
        const mbox = $('dev-muted');
        if (document.activeElement !== mbox && known) mbox.checked = known.alerts_muted === true;
        // Captured, then re-checked: navigating to another device while this
        // fetch is in flight must not render the old device's interfaces
        // under the new device's title - the same rule showDevice and
        // openChart now hold.
        const name = currentDevice;
        const d = await api(`/api/device?name=${encodeURIComponent(name)}`);
        if (d.ok && gen === refreshGen && currentDevice === name) renderEntities(d);
    }
    // The same for an open alert - and it matters more here, because the
    // whole point of the counters is watching them move. An alert bouncing
    // out of `clearing` changes nothing an operator can see except that
    // number, and only if it is being refetched.
    if (currentAlert !== null) {
        const id = currentAlert;
        const a = await api(`/api/alert?id=${encodeURIComponent(id)}`);
        if (a.ok && gen === refreshGen && currentAlert === id) renderAlertDetail(a.alert, a.history || []);
    }
    if (gen !== refreshGen) return;
    // Health answers on 503 too - an unhealthy report IS the content, and
    // hiding the panel on the bad day would be the instrument failing at the
    // moment it exists for. Only auth failures suppress it.
    if (health.status === 200 || health.status === 503) renderHealth(health);
    $('refreshed').textContent = `refreshed ${new Date().toLocaleTimeString()}`;
}

/**
 * The wall's click-through target (slice 45): #device=<name>.
 *
 * A hash rather than a query string because it is a VIEW selector, not a
 * request parameter - nothing server-side needs it, and a hash never reaches
 * an access log, which matters when the value is a device name.
 *
 * This is the app's first URL routing of any kind, so it is deliberately one
 * shape and not a router. A wall tile needs to open a device; it does not
 * need a scheme every future panel has to honour.
 */
function deepLinkDevice() {
    const m = /^#device=(.+)$/.exec(location.hash);
    if (m === null) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
}

async function openDeepLink() {
    const name = deepLinkDevice();
    if (name === null) return false;
    showSection('devices');
    await showDevice(name);
    return true;
}

// Back and forward, and a second tile clicked into a tab that is already open.
// Guarded on lastDevices so it cannot run before the roster has landed - the
// same reason showApp awaits refresh below.
window.addEventListener('hashchange', () => {
    if (lastDevices.length > 0) openDeepLink();
});

async function showApp(me) {
    restoreWindow();
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('logout').classList.remove('hidden');
    $('whoami').textContent = `${me.username} (${me.role})`;
    $('whoami').classList.remove('hidden');
    myUsername = me.username;
    $('pw-username').value = me.username;
    $('account-sub').textContent = `signed in as ${me.username}, ${me.role}`;
    // The admin tab appears only for a role that can open it. This is NOT
    // the access control - every admin route calls enforce() and would
    // refuse a viewer who typed the URL. It is the difference between a
    // door that is locked and a door that is not advertised, and only the
    // second one avoids teaching people to click things that fail.
    isAdmin = me.role === 'admin';
    myRole = me.role;
    // The role's actions, as the server states them. An empty list (a server
    // older than this page) shows no write control at all - the safe side.
    myCan = new Set(Array.isArray(me.can) ? me.can : []);
    applyCanGates();
    refreshExports();
    // The delete button is a control rather than a panel, so it is hidden here
    // rather than by showSection's panel sweep. The rules editor is the same
    // shape: a block INSIDE a panel everyone sees. :not(.panel) matters -
    // admin-only PANELS (onboarding) belong to showSection's sweep, and a
    // second toggler fighting it would show them on the wrong section.
    //
    // EVERY TAG, not a list of them (2026-09-23): the selector named button
    // and div, so the rename and move FORMS on the device page and the
    // roster's credential INPUT were shown to viewers and operators, whose
    // submits the server then refused - the advertised-but-locked door this
    // loop exists to avoid.
    for (const el of document.querySelectorAll('.admin-only:not(.panel)')) {
        el.classList.toggle('hidden', !isAdmin);
    }
    // A deep link opens the DEVICES section, not alerts, and only after the
    // roster has landed: showDevice fills location, application and transient
    // from the row already in hand rather than a second fetch, so a cold link
    // that raced refresh() would open a device page with three blank fields
    // and no sign that they were merely early.
    const deep = deepLinkDevice();
    showSection(deep === null ? 'dashboard' : 'devices');
    await refresh();
    if (deep !== null) await openDeepLink();
    if (can('alertrule.read')) loadEventRules();
    clearInterval(timer);
    timer = setInterval(() => refresh({ onlyShown: true }), 10_000);
}

// Back to a tab that stopped refreshing while hidden: everything, now.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('app').classList.contains('hidden')) refresh();
});

function showLogin() {
    clearInterval(timer);
    $('app').classList.add('hidden');
    $('logout').classList.add('hidden');
    $('whoami').textContent = '';
    $('whoami').classList.add('hidden');
    for (const id of ['pw-current', 'pw-new', 'pw-confirm']) $(id).value = '';
    $('pw-msg').textContent = '';
    $('login').classList.remove('hidden');
    $('username').focus();
}

$('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('login-error').textContent = '';
    const r = await api('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    });
    if (r.ok && r.user) {
        $('password').value = '';
        showApp(r.user);
    } else {
        $('login-error').textContent = r.detail || (r.status === 401
            ? 'wrong username or password' : `login failed (${r.status})`);
    }
});

$('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    showLogin();
});

// The suite theme picker: themes.js owns the palettes, the grouped options
// and the saved choice (under RSCanvas's own key, not the suite's - see the
// header of themes.js).
window.Themes.wirePicker($('theme-select'));

// Session first: a reload with a live cookie must not bounce through login.
api('/api/me').then((me) => {
    if (me.ok && me.user) showApp(me.user);
    else showLogin();
});
