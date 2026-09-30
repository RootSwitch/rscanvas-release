// The screenshot fixture's dressing, applied as it is loaded (2026-09-30).
//
// fixture/ is the 30,000-entity lab as it answered, trimmed and scrubbed. The
// lab's devices are all one mock - every one a two-core Linux box with 52
// ports and five of them dead - so its pictures were a wall of forty
// identical amber tiles and a device page listing five dead links. The
// operator asked for the next pictures to show what a network looks like:
// most devices clean, a mix of kinds, and GPU readings. This does that, in
// code, so the snapshot stays the lab's and every change to it is here to
// read. The traffic, histories and report are still the lab's own.
//
// What it composes:
//   - 45 devices as eight kinds (router, firewall, switches, servers, NAS,
//     storage, virtual machines, UPSes) across locations and applications.
//   - Most clean. Three carry one alert each: a GPU running warm, a floor
//     switch with a port down, a server short of memory. Two are down.
//   - lab-node-16100 as a render workstation: sixteen cores, two GPUs (heat,
//     load, power each), two network ports renamed eth0 and eth1 in every
//     answer that names them.
//   - The transient and muted declarations on lab virtual machines, one
//     transient one away, where those declarations belong.
//   - The answers this snapshot predates: the Dashboard's device health and
//     the System tab's group alerts, computed from the dressed devices.

const UP_PLAN = [
    // stencil, location, application, interfaces, sensors
    ['server', 'HQ / Render room', 'Render farm', 2, 10],
    ['router', 'HQ / Server room', 'Core network', 8, 2],
    ['firewall', 'HQ / Server room', 'Core network', 6, 3],
    ['switch', 'HQ / Server room', 'Core network', 48, 2],
    ['switch', 'HQ / Floor 1', 'Core network', 24, 2],
    ['switch', 'HQ / Floor 2', 'Core network', 24, 2],
    ['switch', 'HQ / Floor 3', 'Core network', 24, 2],
    ['switch', 'HQ / Floor 3', 'Core network', 24, 2],
    ['server', 'HQ / Server room', 'PAM Prod', 4, 4],
    ['server', 'HQ / Server room', 'PAM Prod', 4, 4],
    ['server', 'HQ / Server room', 'PAM Dev', 2, 4],
    ['server', 'HQ / Server room', 'PAM Dev', 2, 4],
    ['server', 'HQ / Server room', 'Backups', 4, 5],
    ['server', 'HQ / Server room', 'Monitoring', 2, 4],
    ['nas', 'HQ / Server room', 'Storage', 2, 3],
    ['nas', 'HQ / Server room', 'Storage', 2, 3],
    ['nas', 'HQ / Floor 2', 'Storage', 2, 3],
    ['nas', 'Branch', 'Storage', 2, 3],
    ['storage', 'Colo', 'Backups', 4, 4],
    ['storage', 'Colo', 'Backups', 4, 4],
    ['server', 'HQ / Render room', 'Render farm', 2, 10],
    ['server', 'HQ / Render room', 'Render farm', 2, 10],
    ['server', 'HQ / Render room', 'Render farm', 2, 10],
    ['server', 'HQ / Render room', 'Render farm', 2, 10],
    ['vm', 'Colo', 'PAM Prod', 1, 3],
    ['vm', 'Colo', 'PAM Prod', 1, 3],
    ['vm', 'Lab', 'Test VMs', 1, 3],
    ['vm', 'Lab', 'Test VMs', 1, 3],
    ['ups', 'HQ / Server room', 'Power', 1, 3],
    ['ups', 'Branch', 'Power', 1, 3],
    ['switch', 'Branch', 'Core network', 24, 2],
    ['switch', 'Branch', 'Core network', 8, 2],
    ['router', 'Branch', 'Core network', 4, 2],
    ['firewall', 'Branch', 'Core network', 4, 3],
    ['switch', 'Colo', 'Core network', 48, 2],
    ['server', 'Branch', 'Branch services', 2, 4],
    ['server', 'Branch', 'Branch services', 2, 4],
    ['server', 'Branch', 'Branch services', 2, 4],
    ['server', 'Colo', 'Monitoring', 2, 4],
    ['server', 'Colo', 'PAM Prod', 4, 4],
];
// The lab's dead devices: two stay down, one is a transient VM that is
// away, and two are dressed up (their rows had no readings, so they get some).
const DEAD_PLAN = {
    'lab-node-17970': ['vm', 'Lab', 'Test VMs', 1, 3, 'transient-away'],
    'lab-node-17971': ['server', 'Branch', 'Branch services', 2, 4, 'down'],
    'lab-node-17972': ['switch', 'Branch', 'Core network', 24, 2, 'down'],
    'lab-node-17973': ['nas', 'Colo', 'Storage', 2, 3, 'up'],
    'lab-node-17974': ['storage', 'Colo', 'Backups', 4, 4, 'up'],
};
const GPU_NODE = 'lab-node-16100';
const TRANSIENT_PRESENT = 'lab-node-16126';
const MUTED = 'lab-node-16127';
// One alert each, on devices that are up.
const WARM_GPU = GPU_NODE;
const PORT_DOWN = 'lab-node-16105';
const SHORT_MEMORY = 'lab-node-16110';
// lab-node-16100's two kept ports, by code, and what they are called now.
const PORT_NAMES = { '99NE': 'eth0', '8ERV': 'eth1' };
const REPORT_NAMES = { 'Gi0/1': 'eth0', 'Gi0/16': 'eth1' };
// Their aliases: the report's picker labels a port "name - alias".
const PORT_ALIASES = { eth0: 'uplink A', eth1: 'uplink B' };

// Deterministic spread: the same name always gets the same numbers.
function hash(s) {
    let h = 2166136261;
    for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
}
const spread = (name, salt, lo, hi) => lo + Math.round(hash(`${name}:${salt}`) * (hi - lo));

function planFor(name, index) {
    if (DEAD_PLAN[name]) return DEAD_PLAN[name];
    return [...(UP_PLAN[index] ?? UP_PLAN[UP_PLAN.length - 1]), 'up'];
}

let cachedPlan = null;
/** name -> the dressed facts, from the fixture's own device list. */
function dressPlan(devices) {
    if (cachedPlan) return cachedPlan;
    const plan = new Map();
    const live = devices.filter((d) => !DEAD_PLAN[d.name]).map((d) => d.name).sort();
    for (const d of devices) {
        const [stencil, location, application, ifs, sensors, state] = planFor(d.name, live.indexOf(d.name));
        const gpu = application === 'Render farm';
        const alerts = d.name === WARM_GPU ? { n: 1, worst: 'warn' }
            : d.name === PORT_DOWN ? { n: 1, worst: 'crit' }
            : d.name === SHORT_MEMORY ? { n: 1, worst: 'warn' }
            : state === 'down' ? { n: 1, worst: 'crit' } : { n: 0, worst: null };
        const trafficScale = { switch: 1, router: 0.6, firewall: 0.4, server: 0.08, nas: 0.15,
            storage: 0.2, vm: 0.02, ups: 0 }[stencil];
        plan.set(d.name, {
            stencil, location, application, ifs, sensors, state, gpu, alerts, trafficScale,
            cpu: stencil === 'ups' ? null : gpu ? spread(d.name, 'cpu', 55, 92) : spread(d.name, 'cpu', 2, 38),
            mem: stencil === 'ups' ? null : d.name === SHORT_MEMORY ? 91 : spread(d.name, 'mem', 18, 74),
            temp: gpu ? (d.name === WARM_GPU ? 84 : spread(d.name, 'temp', 58, 76)) : null,
        });
    }
    cachedPlan = plan;
    return plan;
}

function dressDevices(data) {
    const plan = dressPlan(data.devices);
    const devices = data.devices.map((d) => {
        const p = plan.get(d.name);
        const up = p.state !== 'down' && p.state !== 'transient-away';
        return {
            ...d,
            status: up ? 'up' : 'down',
            reach_state: up ? 'up' : 'down',
            location: p.location, application: p.application,
            transient: d.name === TRANSIENT_PRESENT || p.state === 'transient-away',
            alerts_muted: d.name === MUTED,
            open_alerts: p.alerts.n, worst: p.alerts.worst,
            entities: p.ifs + p.sensors, tracked_ifs: p.ifs, tracked_sensors: p.sensors, if_count: p.ifs,
            down_ports: d.name === PORT_DOWN ? 1 : 0,
            if_errs: 0,
            cpu_pct: up ? p.cpu : null, mem_pct: up ? p.mem : null, temp_c: up ? p.temp : null,
            fs_pct: up && p.stencil !== 'ups' && p.stencil !== 'switch' && p.stencil !== 'router' ? d.fs_pct : null,
            top_bps: up && d.top_bps != null && p.trafficScale > 0 ? d.top_bps * p.trafficScale : null,
            top_if: p.gpu ? 'eth0' : d.top_if,
        };
    });
    return { ...data, devices };
}

function dressAlerts(data, devices) {
    const plan = dressPlan(devices);
    const template = data.open.find((a) => a.kind === 'if-down') ?? data.open[0];
    const downs = data.open.filter((a) => a.kind === 'device-down' && plan.get(a.host)?.state === 'down');
    const at = (h) => new Date(Date.parse(template.last_seen_ts) - h * 3600_000).toISOString();
    const make = (id, host, kind, code, label, severity, value, threshold, unit, hoursAgo) => ({
        ...template, id, alert_key: `${kind}:${host}:${code}`, host, kind, code, label, severity,
        value, peak_value: value, threshold, unit,
        first_breach_ts: at(hoursAgo), raised_ts: at(hoursAgo - 0.01),
    });
    const open = [
        ...downs,
        make('1931', WARM_GPU, 'temp', 'G1TP', `${WARM_GPU} Temp: GPU1`, 'warn', 84, 80, 'C', 3),
        make('1932', PORT_DOWN, 'if-down', 'P14D', `${PORT_DOWN} Gi0/14 (link 14) link`, 'crit', null, null, '', 20),
        make('1933', SHORT_MEMORY, 'mem', 'M1EM', `${SHORT_MEMORY} Memory: Physical memory`, 'warn', 91, 90, '%', 7),
    ];
    return {
        ...data, open,
        openTotal: open.length,
        openCrits: open.filter((a) => a.severity === 'crit').length,
        openOwed: 0,
    };
}

const extend = (label) => ({
    style: 'extend',
    valueOid: `1.3.6.1.4.1.8072.1.3.2.3.1.2.${label.length}.${[...label].map((c) => c.charCodeAt(0)).join('.')}`,
});
function dressDevice(data, devices) {
    const p = dressPlan(devices).get(GPU_NODE);
    const memSize = 68.7e9;
    const base = data.entities[0];
    const sensor = (kind, code, name, v0, v1 = null, extra = null) => ({
        ...base, kind, code, name, extra, snmp_index: code, tracked: true,
        lv_v0: v0, lv_v1: v1, lv_v2: null, lv_v3: null, lv_v4: null, lv_v5: null,
    });
    const kept = data.entities.filter((e) => e.kind === 'mem' || e.kind === 'fs' || PORT_NAMES[e.code]);
    const entities = [
        sensor('cpu', '992C', 'CPU (16 cores)', p.cpu,
            null, { style: 'gauge-avg', oids: Array.from({ length: 16 }, (_, i) => `1.3.6.1.2.1.25.3.3.1.2.${196608 + i}`) }),
        ...kept.filter((e) => e.kind === 'mem' || e.kind === 'fs').map((e) => (e.kind === 'mem'
            ? { ...e, lv_v0: Math.round(memSize * p.mem / 100), lv_v1: memSize } : e)),
        sensor('temp', 'G0TP', 'Temp: GPU0', 71, null, extend('temp-GPU0')),
        sensor('temp', 'G1TP', 'Temp: GPU1', 84, null, extend('temp-GPU1')),
        sensor('gauge', 'G0UT', 'Util: GPU0', 96, null, extend('util-GPU0')),
        sensor('gauge', 'G1UT', 'Util: GPU1', 93, null, extend('util-GPU1')),
        sensor('power', 'G0PW', 'Power: GPU0', 287, null, extend('power-GPU0')),
        sensor('power', 'G1PW', 'Power: GPU1', 301, null, extend('power-GPU1')),
        ...kept.filter((e) => PORT_NAMES[e.code]).map((e) => ({
            ...e, name: PORT_NAMES[e.code], descr: PORT_NAMES[e.code], alias: PORT_ALIASES[PORT_NAMES[e.code]],
        })),
    ];
    return { ...data, entities };
}

// lab-node-16100's two kept ports, renamed wherever an answer names them -
// by CODE, which is unique, never by name (every lab device has a Gi0/1).
function renamePorts(value) {
    if (Array.isArray(value)) return value.map(renamePorts);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renamePorts(v);
    if (typeof out.code === 'string' && PORT_NAMES[out.code] && typeof out.name === 'string') {
        out.name = PORT_NAMES[out.code];
    }
    // A traffic report's lines name the port by device and interface instead.
    if (out.device === GPU_NODE && typeof out.iface === 'string' && REPORT_NAMES[out.iface]) {
        out.iface = REPORT_NAMES[out.iface];
        out.description = PORT_ALIASES[out.iface];
    }
    return out;
}

// The Dashboard's CPU and memory lists, from the dressed devices: the lab's
// were every mock at 38% memory, beside an alert saying one was at 91%. The
// traffic lists stay the lab's own.
function dressDash(data, devices) {
    const plan = dressPlan(devices);
    const up = dressDevices({ devices }).devices.filter((d) => d.status === 'up');
    const cores = (name) => (plan.get(name).application === 'Render farm' ? 16
        : ['server', 'storage', 'nas'].includes(plan.get(name).stencil) ? 8 : 4);
    const list = (field, template, name, peakSpread, salt) => up
        .filter((d) => d[field] !== null && d[field] !== undefined)
        .sort((a, b) => b[field] - a[field] || a.name.localeCompare(b.name))
        .slice(0, 10)
        .map((d) => ({
            ...template, device: d.name, code: `${salt}${d.name.slice(-4)}`, name: name(d.name),
            meanPct: d[field], peakPct: Math.min(100, d[field] + spread(d.name, `${salt}pk`, 0, peakSpread)),
            trend: spread(d.name, `${salt}tr`, -8, 8) / 100,
        }));
    return {
        ...renamePorts(data),
        cpu: list('cpu_pct', data.cpu[0], (n) => `CPU (${cores(n)} cores)`, 11, 'C'),
        mem: list('mem_pct', data.mem[0], () => 'Memory: Physical memory', 4, 'M'),
    };
}

function dressWall(data, devices) {
    const plan = dressPlan(devices);
    const byName = new Map(dressDevices({ devices }).devices.map((d) => [d.name, d]));
    const shapes = data.shapes.map((s) => {
        const p = plan.get(s.device);
        const d = byName.get(s.device);
        if (!p || !d) return s;
        const up = d.status === 'up';
        return {
            ...s, status: d.status, alerts: p.alerts.n, transient: d.transient === true,
            fields: {
                ...s.fields, stencil: p.stencil,
                cpu: up ? d.cpu_pct : null, mem: up ? d.mem_pct : null,
                top: up ? d.top_bps : null, ping: up ? (s.fields.ping ?? spread(s.device, 'ping', 1, 9) / 10) : null,
            },
        };
    });
    return { ...data, name: 'All sites', shapes };
}

function groupsFrom(devices) {
    const dressed = dressDevices({ devices }).devices.filter((d) => d.transient !== true);
    const by = (key) => {
        const m = new Map();
        for (const d of dressed) {
            const v = d[key] ?? null;
            const g = m.get(v) ?? { value: v, up: 0, down: 0, other: 0 };
            if (d.status === 'up') g.up++; else if (d.status === 'down') g.down++; else g.other++;
            m.set(v, g);
        }
        return [...m.values()].sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : a.value.localeCompare(b.value)));
    };
    return { locations: by('location'), applications: by('application') };
}

/** The dressed answer for fixture `name`; `load(n)` reads another raw fixture. */
export function dress(name, data, load) {
    const devices = () => load('devices').devices;
    switch (name) {
        case 'devices': return dressDevices(data);
        case 'alerts': return dressAlerts(data, devices());
        case 'device': return dressDevice(data, devices());
        case 'report': return renamePorts(data);
        case 'dash-6': case 'dash-24': case 'dash-168': return dressDash(data, devices());
        case 'wall': return dressWall(data, devices());
        default: return data;
    }
}

/** Answers the snapshot predates, computed from the dressed devices. */
export function extraAnswers(load) {
    const devices = load('devices').devices;
    const g = groupsFrom(devices);
    const watched = new Set(['Render farm', 'HQ / Server room']);
    const groupAlerts = [];
    for (const [axis, rows] of [['location', g.locations], ['application', g.applications]]) {
        for (const r of rows) {
            if (r.value === null) continue;
            groupAlerts.push({
                axis, value: r.value, up: r.up, down: r.down, other: r.other,
                enabled: watched.has(r.value), thresholdPct: 50, minDown: 3, hasRule: watched.has(r.value),
            });
        }
    }
    return {
        '/api/dashboard/groups': { ok: true, ...g },
        '/api/group-alerts': { ok: true, groups: groupAlerts },
    };
}
