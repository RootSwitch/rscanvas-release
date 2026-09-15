// The per-device roster summary, computed from one poll's readings.
//
// WHY THIS EXISTS AT POLL TIME. The roster wanted CPU, memory, fullest
// filesystem, temperature, down ports, errors, the busiest interface, health
// and UPS per device - SNMPCanvas's columns. The first cut aggregated them in
// the roster query itself and failed its pre-registered budget by 2-3x at
// 450 devices (SLICE-ROSTER-COLUMNS-PLAN, the measurement section), because
// the sorts and the freshness join multiply by the fleet and by every viewer
// refreshing every ten seconds. So the computation moves to the one place
// that already holds every reading for one device once per poll: here. The
// roster then reads plain columns at any fleet size, and freshness is
// inherent - a column is as fresh as the poll that wrote it, and the
// device's status says when that was.
//
// Pure, and tested as such: readings in, summary out, no store, no clock.

export interface IfReading {
    name: string;
    tracked: boolean;
    operStatus: number | null;    // 1 up, 2 down
    adminStatus: number | null;   // 2 = administratively down
    inBps: number | null;
    outBps: number | null;
    inErrs: number | null;
    outErrs: number | null;
    /** The speed the measurement trusts: override, else advertised, else null when convicted. */
    trustedSpeedBps: number | null;
}

export interface SensorReading {
    kind: string;                 // cpu | mem | fs | temp | state | battery | runtime | ...
    name: string;
    v0: number | null;
    v1: number | null;
    status: number | null;        // state kinds: 1 ok, 2 alarm
}

export interface DeviceSummary {
    cpu_pct: number | null;
    mem_pct: number | null;
    fs_pct: number | null;
    fs_name: string | null;
    temp_c: number | null;
    down_ports: number;
    if_count: number;
    if_errs: number | null;
    top_if: string | null;
    top_bps: number | null;
    top_speed: number | null;
    alarms: number;
    state_sensors: number;
    batt_pct: number | null;
    runtime_s: number | null;
}

const maxOf = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);

/**
 * Fold one poll's readings into the roster summary. Untracked interfaces are
 * polled (their counters keep history warm for re-tracking) but they must no
 * more drive a roster number than an alert, so they are skipped here. A
 * port somebody shut on purpose (admin down) is not a down port. Fullest
 * filesystem and busiest interface are PICKS, never sums.
 */
export function summarizeReadings(ifs: IfReading[], sensors: SensorReading[]): DeviceSummary {
    const s: DeviceSummary = {
        cpu_pct: null, mem_pct: null, fs_pct: null, fs_name: null, temp_c: null,
        down_ports: 0, if_count: 0, if_errs: null,
        top_if: null, top_bps: null, top_speed: null,
        alarms: 0, state_sensors: 0, batt_pct: null, runtime_s: null,
    };
    for (const i of ifs) {
        if (!i.tracked) continue;
        s.if_count++;
        if (i.operStatus === 2 && i.adminStatus !== 2) s.down_ports++;
        const errs = maxOf(i.inErrs, i.outErrs);
        if (errs !== null) s.if_errs = maxOf(s.if_errs, errs);
        const bps = maxOf(i.inBps, i.outBps);
        if (bps !== null && (s.top_bps === null || bps > s.top_bps)) {
            s.top_bps = bps;
            s.top_if = i.name;
            s.top_speed = i.trustedSpeedBps !== null && i.trustedSpeedBps > 0 ? i.trustedSpeedBps : null;
        }
    }
    for (const r of sensors) {
        switch (r.kind) {
            case 'cpu':
                if (r.v0 !== null) s.cpu_pct = maxOf(s.cpu_pct, r.v0);
                break;
            case 'mem':
                if (r.v0 !== null && r.v1 !== null && r.v1 > 0) s.mem_pct = maxOf(s.mem_pct, (100 * r.v0) / r.v1);
                break;
            case 'fs':
                if (r.v0 !== null && r.v1 !== null && r.v1 > 0) {
                    const pct = (100 * r.v0) / r.v1;
                    if (s.fs_pct === null || pct > s.fs_pct) { s.fs_pct = pct; s.fs_name = r.name; }
                }
                break;
            case 'temp':
                if (r.v0 !== null) s.temp_c = maxOf(s.temp_c, r.v0);
                break;
            case 'state':
                s.state_sensors++;
                if (r.status === 2) s.alarms++;
                break;
            case 'battery':
                if (r.v0 !== null) s.batt_pct = maxOf(s.batt_pct, r.v0);
                break;
            case 'runtime':
                if (r.v0 !== null) s.runtime_s = maxOf(s.runtime_s, r.v0);
                break;
            default:
                break;
        }
    }
    const r1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);
    s.cpu_pct = r1(s.cpu_pct); s.mem_pct = r1(s.mem_pct); s.fs_pct = r1(s.fs_pct);
    s.temp_c = r1(s.temp_c); s.if_errs = r1(s.if_errs);
    return s;
}
