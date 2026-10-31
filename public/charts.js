// Hand-rolled SVG time-series charts - no chart library. Colours come from
// CSS classes bound to the --se-* theme variables, so a chart re-themes with
// everything else.
//
// PORTED FROM SNMPCanvas/public/charts.js, and the port is DELIBERATELY not
// a copy. The parent assembles its SVG as an innerHTML string with a
// hand-called esc() at each interpolation - and this fork bans that outright
// (tools/check-dom-sinks.mjs), because series labels here are entity names:
// ifAlias, ifName, hrStorageDescr, an extend name somebody chose. Those are
// DEVICE-CONTROLLED, which is the exact class of string the hostile-render
// invariant exists for, and "escaped at every call site" is a convention
// that holds until one call site forgets. So:
//
//   * the ARITHMETIC is ported verbatim - niceMax's 1/2/5 gridlines, the tick
//     ladder, the SI formatters, the gap-breaking rule, the nearest-point
//     tolerance. That is the part earned against real charts.
//   * the RENDERING is rebuilt with createElementNS and textContent, so a
//     label cannot become markup by construction rather than by discipline.
//
// Charts.render(container, {
//   series: [{ label, cls: 'a'|'b', area, data: [[tsSec, value|null], ...] }],
//   from, to,        // seconds
//   unit,            // 'bps' | 'pct' | 'bytes' | 'degc' | 'rpm' | 'dur' | ...
//   bucketSec,
//   stepSec,         // optional: how often the series is MEANT to have a reading
// })

const NS = 'http://www.w3.org/2000/svg';
const W = 860;
const H = 220;
const PAD = { l: 62, r: 12, t: 10, b: 22 };

function fmtSI(v, base, units) {
    let i = 0;
    let x = v;
    while (Math.abs(x) >= base && i < units.length - 1) { x /= base; i++; }
    const d = Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2;
    return `${x.toFixed(d)} ${units[i]}`;
}

export function fmtValue(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    if (unit === 'pct') return `${v.toFixed(1)}%`;
    if (unit === 'degc') return `${v.toFixed(1)} C`;
    if (unit === 'rpm') return `${Math.round(v)} rpm`;
    if (unit === 'w') return fmtSI(v, 1000, ['W', 'kW', 'MW']);
    if (unit === 'dur') {
        if (v >= 86400) return `${Math.floor(v / 86400)}d ${Math.floor((v % 86400) / 3600)}h`;
        if (v >= 3600) return `${Math.floor(v / 3600)}h ${Math.round((v % 3600) / 60)}m`;
        return `${Math.round(v / 60)}m`;
    }
    if (unit === 'bytes') return fmtSI(v, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB']);
    if (unit === 'bps') return fmtSI(v, 1000, ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s']);
    if (unit === 'pps') {
        // Error and discard rates stay FRACTIONAL - the handoff's one-way
        // door, same thresholds as the roster's fmtRate. fmtSI's two decimals
        // label one CRC per five minutes (0.0033/s) as "0.00 /s" on the axis
        // and tooltip, which is a failing port reading as clean - the
        // specific bug the rule was written about.
        if (v !== 0 && Math.abs(v) < 0.01) return `${v.toFixed(4)} /s`;
        if (v !== 0 && Math.abs(v) < 1) return `${v.toFixed(3)} /s`;
        return fmtSI(v, 1000, ['/s', 'k/s', 'M/s', 'G/s']);
    }
    if (unit) {
        const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
        return `${v.toFixed(d)} ${unit}`;
    }
    return v.toFixed(0);
}

function fmtTime(tsSec, rangeSec) {
    const d = new Date(tsSec * 1000);
    const hm = d.toTimeString().slice(0, 5);
    if (rangeSec <= 26 * 3600) return hm;
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return rangeSec <= 8 * 86400 ? `${md} ${hm}` : md;
}

/** Round the y max up to 1/2/5 x 10^n so gridlines land on clean numbers. */
function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (v <= m * pow) return m * pow;
    return 10 * pow;
}

function xTicks(from, to) {
    const range = to - from;
    const steps = [300, 900, 1800, 3600, 7200, 14400, 43200, 86400,
        2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400];
    const step = steps.find((s) => range / s <= 8) || 30 * 86400;
    const ticks = [];
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
    return ticks;
}

function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    // DOM-SINK-OK: `attrs` is chart GEOMETRY built in this module - numbers
    // and fixed class names, never a device string. The attribute NAME is
    // also ours: no caller passes a name from data, so 'onload' cannot
    // appear here. Keep it that way if this ever takes an outside caller.
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
}

function nearest(data, t, tolerance) {
    let best = null;
    let bestD = Infinity;
    for (const [pt, v] of data) {
        const d = Math.abs(pt - t);
        if (d < bestD) { bestD = d; best = v; }
    }
    return bestD <= tolerance ? best : null;
}

/**
 * The runs a series draws as, split where it must not be joined: at a null,
 * and at a gap wider than 2.5 steps. Pure, for tools/test-charts.ts.
 */
export function lineRuns(data, stepSec) {
    const maxGap = stepSec * 2.5;
    const runs = [];
    let run = [];
    let prevT = null;
    for (const [t, v] of data) {
        if (v === null || v === undefined || (prevT !== null && t - prevT > maxGap)) {
            if (run.length > 0) runs.push(run);
            run = [];
        }
        if (v !== null && v !== undefined) run.push([t, v]);
        prevT = t;
    }
    if (run.length > 0) runs.push(run);
    return runs;
}

/**
 * THE STEP a gap is judged in (2026-10-21): the bucket, or the series' own
 * cadence when that is slower. An hourly bandwidth test drew NOTHING at 3
 * days and under - the bucket there is 14 minutes or less, every hourly
 * reading sat more than 2.5 buckets from the next, so each was a run of one,
 * and a run of one drew no line. The cadence comes from the server (a
 * check's interval, a device's poll interval), not from the data: a poller
 * that answers once an hour because it is failing must still show its gaps.
 */
export function chartStep(bucketSec, stepSec) {
    return Math.max(bucketSec || 300, Number(stepSec) || 0);
}

export function render(container, opts) {
    const { series, from, to, unit } = opts;
    const bucketSec = opts.bucketSec || 300;
    const step = chartStep(bucketSec, opts.stepSec);
    container.replaceChildren();

    let max = 0;
    for (const s of series) for (const [, v] of s.data) if (v !== null && v > max) max = v;
    const yMax = opts.yMax || niceMax(max * 1.05);

    const x = (t) => PAD.l + ((t - from) / (to - from)) * (W - PAD.l - PAD.r);
    const y = (v) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);

    const svg = svgEl('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });

    for (let i = 0; i <= 4; i++) {
        const v = (yMax * i) / 4;
        const yy = y(v);
        svg.appendChild(svgEl('line', { class: 'chart-grid-line', x1: PAD.l, y1: yy, x2: W - PAD.r, y2: yy }));
        const label = svgEl('text', { class: 'chart-axis-label', x: PAD.l - 6, y: yy + 3, 'text-anchor': 'end' });
        label.textContent = fmtValue(v, unit);
        svg.appendChild(label);
    }
    for (const t of xTicks(from, to)) {
        const xx = x(t);
        svg.appendChild(svgEl('line', { class: 'chart-grid-line', x1: xx, y1: PAD.t, x2: xx, y2: H - PAD.b }));
        const label = svgEl('text', { class: 'chart-axis-label', x: xx, y: H - PAD.b + 14, 'text-anchor': 'middle' });
        label.textContent = fmtTime(t, to - from);
        svg.appendChild(label);
    }

    // Series paths. A null value OR a time gap wider than 2.5 steps BREAKS
    // the line rather than interpolating across it - the parent's rule, and
    // the same doctrine as `stale`: a poller that stopped must not draw as a
    // straight line between the readings on either side of the outage. A
    // reading alone between two gaps is drawn as a dot: a path of one point
    // draws nothing, which hid it.
    for (const s of series) {
        const lineParts = [];
        const areaParts = [];
        const dots = [];
        for (const r of lineRuns(s.data, step)) {
            const run = r.map(([t, v]) => [x(t), y(Math.min(v, yMax))]);
            if (run.length === 1) { dots.push(run[0]); continue; }
            const pts = run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L');
            lineParts.push(`M${pts}`);
            if (s.area) {
                const y0 = y(0);
                areaParts.push(`M${run[0][0].toFixed(1)},${y0}L${pts}L${run[run.length - 1][0].toFixed(1)},${y0}Z`);
            }
        }
        if (areaParts.length) svg.appendChild(svgEl('path', { class: `chart-area-${s.cls}`, d: areaParts.join('') }));
        if (lineParts.length) svg.appendChild(svgEl('path', { class: `chart-line-${s.cls}`, d: lineParts.join('') }));
        for (const [px, py] of dots) {
            svg.appendChild(svgEl('circle', { class: `chart-dot-${s.cls}`, cx: px.toFixed(1), cy: py.toFixed(1), r: 2.4 }));
        }
    }

    // THE TIMELINE ON THE CHART (IDEAS-2026-10-15 item 4). Bands first, so a
    // maintenance window shades behind the lines it explains; markers are a
    // vertical stroke each - a restart, a ping change, an alert - styled by
    // a class this module chooses from a fixed set, never by data. Only what
    // falls inside the chart's window is drawn, and the hover names them.
    const inside = (t) => t >= from && t <= to;
    const bands = (opts.bands || []).filter((b) => b.to >= from && b.from <= to);
    for (const b of bands) {
        const x0 = x(Math.max(from, b.from));
        const x1 = x(Math.min(to, b.to));
        svg.insertBefore(svgEl('rect', {
            class: 'chart-band-maint', x: x0, y: PAD.t, width: Math.max(1, x1 - x0), height: H - PAD.t - PAD.b,
        }), svg.firstChild);
    }
    const MARKER_CLS = new Set(['restart', 'down', 'up', 'raise', 'clear']);
    const markers = (opts.markers || []).filter((m) => inside(m.t) && MARKER_CLS.has(m.cls));
    for (const m of markers) {
        const xx = x(m.t);
        svg.appendChild(svgEl('line', { class: `chart-marker chart-marker-${m.cls}`, x1: xx, y1: PAD.t, x2: xx, y2: H - PAD.b }));
    }

    const cursor = svgEl('line', { class: 'chart-cursor', x1: -10, y1: PAD.t, x2: -10, y2: H - PAD.b });
    svg.appendChild(cursor);
    container.style.position = 'relative';
    container.appendChild(svg);

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    for (const s of series) {
        const item = document.createElement('span');
        const swatch = document.createElement('span');
        swatch.className = `swatch chart-swatch-${s.cls}`;
        item.appendChild(swatch);
        // textContent, not an escaped interpolation: the label is an entity
        // name and entity names are device-controlled.
        item.appendChild(document.createTextNode(s.label));
        legend.appendChild(item);
    }
    container.appendChild(legend);

    let tip = null;
    const hide = () => {
        cursor.setAttribute('x1', -10);
        cursor.setAttribute('x2', -10);
        if (tip) { tip.remove(); tip = null; }
    };
    svg.addEventListener('mousemove', (ev) => {
        const rect = svg.getBoundingClientRect();
        const fx = ((ev.clientX - rect.left) / rect.width) * W;
        if (fx < PAD.l || fx > W - PAD.r) { hide(); return; }
        const t = from + ((fx - PAD.l) / (W - PAD.l - PAD.r)) * (to - from);
        cursor.setAttribute('x1', fx);
        cursor.setAttribute('x2', fx);
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'chart-tip';
            container.appendChild(tip);
        }
        tip.replaceChildren();
        const head = document.createElement('strong');
        head.textContent = `${fmtTime(t, 0)} ${new Date(t * 1000).toLocaleDateString()}`;
        tip.appendChild(head);
        for (const s of series) {
            const pt = nearest(s.data, t, step * 1.5);
            tip.appendChild(document.createElement('br'));
            let line = `${s.label}: ${fmtValue(pt, unit)}`;
            // A series may PLOT one line and EXPLAIN several. The error
            // chart draws max(in, out) because four lines of mostly-zero is
            // clutter, but direction is diagnostic - inbound errors point at
            // the cable or upstream, outbound at local congestion - so the
            // hover carries the breakdown the line collapsed.
            if (Array.isArray(s.parts) && s.parts.length > 0) {
                const bits = s.parts
                    .map((p) => `${p.label} ${fmtValue(nearest(p.data, t, step * 1.5), unit)}`)
                    .join(', ');
                line += ` (${bits})`;
            }
            tip.appendChild(document.createTextNode(line));
        }
        // What the timeline says happened near the cursor: markers within a
        // bucket and a half, and any band the cursor is inside. Text nodes,
        // because labels carry device names and notes.
        const near = Math.max(bucketSec * 1.5, (to - from) / 150);
        const said = [
            ...bands.filter((b) => t >= b.from && t <= b.to).map((b) => b.label),
            ...markers.filter((m) => Math.abs(m.t - t) <= near).map((m) => `${fmtTime(m.t, 0)} ${m.label}`),
        ];
        for (const s of said.slice(0, 6)) {
            tip.appendChild(document.createElement('br'));
            const em = document.createElement('em');
            em.textContent = s;
            tip.appendChild(em);
        }
        const left = ev.clientX - rect.left;
        tip.style.left = `${Math.min(left + 12, rect.width - tip.offsetWidth - 4)}px`;
        tip.style.top = '8px';
    });
    svg.addEventListener('mouseleave', hide);
}
