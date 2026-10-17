// The availability report's arithmetic (IDEAS-2026-10-15 item 8): pure
// functions over the store's per-device sums, pinned by an offline test
// (tools/test-availability-report.ts) - traffic.ts's rule for the other
// reports.
//
// BY PING ALONE (the operator's ruling, 2026-10-16): a host that answers
// ping while its SNMP agent is dead is not an outage for the people using it.
//
// TWO MEASUREMENTS, each from where it is exact, and named on the page:
//
//   availability   the share of the minute probes it answered (ping_hourly,
//                  sql/slice63.sql) - the device page's "availability 24h"
//                  definition, over any period. Probes inside maintenance
//                  are left out of it, and counted.
//   outages        from the ten-second sweep's transitions, which are kept
//                  for good: a stretch "down" of a minute or more is an
//                  OUTAGE, shorter is a BLIP (one missed sweep is down, so a
//                  target that drops the odd ping would otherwise read as
//                  hundreds of outages). One that began inside maintenance
//                  is planned and kept apart.
//
// MEASURED says how much of the period anyone was looking - hours with any
// probe, of the hours since the device was first probed - so 100% over the
// half of a month RSCanvas was running cannot pass for a whole month.
//
// Groups pool, never average: a location's availability is its devices'
// probes answered over its devices' probes, so a device probed for a day
// does not weigh as much as one probed all month. Devices with no location
// or application are a group of their own, said, not dropped. Transient
// devices are left out, and named (leftOutTransient).

import { csvRow } from '../export/csv.ts';

/** One device's sums over the period, as OPS.availabilityReport returns them. */
export interface AvailabilityRow {
    device: string; location: string | null; application: string | null; address: string | null;
    /** Declared transient (slice 25): off is its state, so it is left out. */
    transient?: boolean | null;
    probes: number | string; misses: number | string;
    planned_probes: number | string; planned_misses: number | string;
    hours_measured: number; hours_total: number;
    outages: number; blips: number;
    longest_s: number; down_s: number; planned_down_s: number;
}

export type AvailabilityGroup = 'device' | 'location' | 'application';

export function parseAvailabilityGroup(raw: string | null): AvailabilityGroup | null {
    return raw === null || raw === '' || raw === 'device' ? 'device'
        : raw === 'location' || raw === 'application' ? raw : null;
}

/** The name a device with no group of that kind is reported under. */
export const UNASSIGNED = '(unassigned)';

export interface AvailabilityLine {
    /** The device, or the location or application. */
    name: string;
    /** For a device line, its address and groups; null on a group line. */
    address: string | null; location: string | null; application: string | null;
    devices: number;
    /** Probes answered over probes, maintenance left out; null with none. */
    pct: number | null;
    probes: number; misses: number; plannedProbes: number;
    /** Hours with any probe over hours since first probed; null with none. */
    measuredPct: number | null;
    outages: number; blips: number;
    longestS: number; downS: number; plannedDownS: number;
}

const num = (v: number | string | null | undefined): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
};

interface Acc {
    devices: number; probes: number; misses: number; plannedProbes: number; plannedMisses: number;
    hoursMeasured: number; hoursTotal: number;
    outages: number; blips: number; longestS: number; downS: number; plannedDownS: number;
}

function add(a: Acc, r: AvailabilityRow): void {
    a.devices += 1;
    a.probes += num(r.probes);
    a.misses += num(r.misses);
    a.plannedProbes += num(r.planned_probes);
    a.plannedMisses += num(r.planned_misses);
    a.hoursMeasured += num(r.hours_measured);
    a.hoursTotal += num(r.hours_total);
    a.outages += num(r.outages);
    a.blips += num(r.blips);
    a.longestS = Math.max(a.longestS, num(r.longest_s));
    a.downS += num(r.down_s);
    a.plannedDownS += num(r.planned_down_s);
}

function line(name: string, a: Acc, who: AvailabilityRow | null): AvailabilityLine {
    const probes = a.probes - a.plannedProbes;
    const misses = a.misses - a.plannedMisses;
    return {
        name,
        address: who?.address ?? null, location: who?.location ?? null, application: who?.application ?? null,
        devices: a.devices,
        pct: probes > 0 ? (100 * (probes - misses)) / probes : null,
        probes: a.probes, misses: a.misses, plannedProbes: a.plannedProbes,
        measuredPct: a.hoursTotal > 0 ? Math.min(100, (100 * a.hoursMeasured) / a.hoursTotal) : null,
        outages: a.outages, blips: a.blips,
        longestS: a.longestS, downS: a.downS, plannedDownS: a.plannedDownS,
    };
}

const empty = (): Acc => ({
    devices: 0, probes: 0, misses: 0, plannedProbes: 0, plannedMisses: 0, hoursMeasured: 0, hoursTotal: 0,
    outages: 0, blips: 0, longestS: 0, downS: 0, plannedDownS: 0,
});

/**
 * The report's lines, worst first: lowest availability, then most time
 * down, then by name. A line with no probes outside maintenance has no
 * availability and goes last - there is nothing to rank it by.
 */
export function availabilityLines(all: AvailabilityRow[], group: AvailabilityGroup): AvailabilityLine[] {
    const rows = all.filter((r) => r.transient !== true);
    let lines: AvailabilityLine[];
    if (group === 'device') {
        lines = rows.map((r) => { const a = empty(); add(a, r); return line(r.device, a, r); });
    } else {
        const by = new Map<string, Acc>();
        for (const r of rows) {
            const key = (group === 'location' ? r.location : r.application)?.trim() || UNASSIGNED;
            let a = by.get(key);
            if (a === undefined) { a = empty(); by.set(key, a); }
            add(a, r);
        }
        lines = [...by].map(([k, a]) => line(k, a, null));
    }
    return lines.sort((x, y) =>
        (x.pct === null ? 1 : 0) - (y.pct === null ? 1 : 0)
        || (x.pct ?? 0) - (y.pct ?? 0)
        || y.downS - x.downS
        || x.name.localeCompare(y.name));
}

/**
 * The devices left out because they are declared TRANSIENT (slice 25): a
 * laptop or a guest PC is off most of the time by design, and its share
 * would read as the worst on the list while meaning nothing - the same
 * reason the flap report and restart alerts leave them out. Named, so the
 * page can say who.
 */
export function leftOutTransient(rows: AvailabilityRow[]): string[] {
    return rows.filter((r) => r.transient === true).map((r) => r.device).sort();
}

/** The CSV, one line per device or group, figures unrounded but for the shares. */
export function availabilityCsv(lines: AvailabilityLine[], group: AvailabilityGroup): string {
    const head = group === 'device'
        ? ['device', 'address', 'location', 'application']
        : [group, 'devices'];
    let out = csvRow([...head, 'availability_pct', 'probes', 'missed', 'probes_in_maintenance', 'measured_pct',
        'outages', 'blips', 'longest_outage_s', 'down_s', 'down_in_maintenance_s']);
    for (const l of lines) {
        const id = group === 'device'
            ? [l.name, l.address ?? '', l.location ?? '', l.application ?? '']
            : [l.name, l.devices];
        out += csvRow([...id,
            l.pct === null ? '' : l.pct.toFixed(3), l.probes, l.misses, l.plannedProbes,
            l.measuredPct === null ? '' : l.measuredPct.toFixed(1),
            l.outages, l.blips, Math.round(l.longestS), Math.round(l.downS), Math.round(l.plannedDownS)]);
    }
    return out;
}
