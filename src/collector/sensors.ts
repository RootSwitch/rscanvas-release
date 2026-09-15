// Sensors: the pure half of the port from SNMPCanvas (discover.js, oids.js,
// poller.js, read in full 2026-08-14). The operator's porting rule governs
// this file: THE CHOICES, NOT JUST THE OIDS. Every selection rule below was
// earned against real hardware in the parent, and the comments travelled
// with the code because they are the part that cannot be re-derived from a
// MIB. tools/test-sensors.ts holds the rules; the walk orchestration lives
// with the prober and poller, which execute what discovery decided.
//
// The structural contract (SLICE-SENSORS-PLAN.md): discovery writes a
// polling INSTRUCTION onto each entity (`extra`), the poller executes it
// verbatim, and the value semantics into samples are fixed per kind:
// used/total BYTES for mem and fs, degrees C for temp, rpm for fan,
// 0/1/null for state.

// --- OIDs beyond src/collector/oids.ts's poll set ----------------------------

export const HR_SENSORS = {
    hrStorageType: '1.3.6.1.2.1.25.2.3.1.2',
    hrStorageDescr: '1.3.6.1.2.1.25.2.3.1.3',
    hrStorageAllocationUnits: '1.3.6.1.2.1.25.2.3.1.4',
    hrStorageSize: '1.3.6.1.2.1.25.2.3.1.5',
    hrStorageUsed: '1.3.6.1.2.1.25.2.3.1.6',
};
export const HR_STORAGE_RAM = '1.3.6.1.2.1.25.2.1.2';
export const HR_STORAGE_FIXEDDISK = '1.3.6.1.2.1.25.2.1.4';

// LM-SENSORS-MIB (net-snmp with lmsensors - Linux hosts, Proxmox,
// FreeBSD/TrueNAS drive temps). Values are milli-degrees C in practice.
export const LM_TEMP = {
    device: '1.3.6.1.4.1.2021.13.16.2.1.2',
    value: '1.3.6.1.4.1.2021.13.16.2.1.3',
};

// ENTITY-SENSOR-MIB (RFC 3433) - the standard sensor table on network gear.
export const ENT_SENSOR = {
    type: '1.3.6.1.2.1.99.1.1.1.1',        // 8 = celsius
    scale: '1.3.6.1.2.1.99.1.1.1.2',       // enum: 9 = units, 8 = milli, ...
    value: '1.3.6.1.2.1.99.1.1.1.4',
    physicalName: '1.3.6.1.2.1.47.1.1.1.1.7',
};

// NET-SNMP-EXTEND-MIB: anything the agent owner can print with a one-liner
// becomes a sensor (extend temp-GPU /usr/bin/nvidia-smi ...). The name
// prefix picks the kind; the FULL output column is read because some tools
// print banners before the number - NUT's upsc leads with an SSL notice.
export const NSEXTEND_OUTPUT = '1.3.6.1.4.1.8072.1.3.2.3.1.2';

// ASRock Rack BMC sensor table (AMI MegaRAC-based IPMI firmware): named
// hardware sensors with formatted string readings ("600.00rpm",
// "32.00&deg;C", "Not Available"). Fans finally get real tachometers this
// way - the BMC owns the sensor bus the host OS cannot read.
export const ASROCK_BMC = {
    name: '1.3.6.1.4.1.49622.2.1.3',
    value: '1.3.6.1.4.1.49622.2.1.4',
};

// UPS-MIB (RFC 1628) power source: any network-managed UPS answers this,
// vendor entry or not (Eaton, Schneider, ...). 3 = normal, 5 = battery,
// 1 = other/unknown.
export const UPS_OUTPUT_SOURCE = '1.3.6.1.2.1.33.1.4.1.0';

/**
 * NET-SNMP-EXTEND row index -> the extend's NAME.
 *
 * The index is the name as a LENGTH-PREFIXED ASCII string: `extend
 * temp-GPU` indexes as 8.116.101.109.112.45.71.80.85 - a leading count then
 * one component per character. Decoded here rather than at the call site
 * because it is exactly the kind of arithmetic that is wrong in a way
 * nobody notices: an off-by-one truncates or over-reads the name, the
 * prefix regex below then fails to match, and the sensor simply never
 * appears with no error anywhere.
 */
export function decodeExtendName(idx: string): string | null {
    const parts = idx.split('.').map(Number);
    const len = parts[0];
    if (len === undefined || !Number.isFinite(len) || len <= 0) return null;
    const chars = parts.slice(1, 1 + len);
    if (chars.length !== len || chars.some((c) => !Number.isFinite(c) || c < 32 || c > 126)) return null;
    return String.fromCharCode(...chars);
}

/**
 * The extend NAMING CONVENTION, which is the whole interface: the agent
 * owner picks the kind by prefixing the extend's name. `extend
 * batt-UPS1 /usr/bin/upsc ...` becomes a battery sensor called "Batt: UPS1".
 *
 * This is the doorway for everything SNMP cannot see natively - nvidia-smi
 * GPU stats, NUT's UPS readings, anything a shell one-liner can print - and
 * it is why the extend style's value parsing takes the FIRST NUMERIC LINE
 * rather than the whole output: upsc leads with an SSL notice on stdout.
 */
const EXTEND_KINDS: Record<string, { kind: string; label: string }> = {
    temp: { kind: 'temp', label: 'Temp' },
    fan: { kind: 'fan', label: 'Fan' },
    power: { kind: 'power', label: 'Power' },
    util: { kind: 'gauge', label: 'Util' },
    batt: { kind: 'battery', label: 'Batt' },
    runtime: { kind: 'runtime', label: 'Runtime' },
};

/**
 * AND THE CONSTRAINT THIS PUTS ON THE AGENT, recorded 2026-08-25 from a
 * mainline handoff because it is invisible from inside this file: **an
 * entity's identity must never depend on its current value.**
 *
 * The extend NAME becomes the OID, and this function turns that name into a
 * kind. So an agent that picks the name from a reading - "serve GPU fan as
 * RPM above 100, as a percentage at or below" - emits util-fan-GPU0 at idle
 * and fan-GPU0 under load. That is not one sensor changing units. It is TWO
 * ENTITIES, each full of gaps, neither graphing, and nothing on this side can
 * repair it because the name is the only identity the protocol carries.
 *
 * Anything deriving a name, code or OID from a reading splits one series in
 * two the first time the reading crosses the boundary. This fork mints its
 * own identifiers from names and table indices, never from values; the rule
 * is written here for whoever writes the next agent.
 */
export function extendKind(name: string): { kind: string; name: string } | null {
    const m = /^(temp|fan|power|util|batt|runtime)-(.+)$/i.exec(name);
    if (m === null) return null;
    const spec = EXTEND_KINDS[(m[1] as string).toLowerCase()];
    if (spec === undefined) return null;
    return { kind: spec.kind, name: `${spec.label}: ${m[2] as string}` };
}

// --- the vendor map, ported verbatim -----------------------------------------
//
// Matched by longest dotted prefix of sysObjectID, sysDescr regex as the
// fallback for agents with broken sysObjectIDs. Styles are executed by the
// discovery walker and sensorSample below.

export interface VendorTempScalar { name: string; oid: string; div: number }
export interface VendorMetric {
    kind: string; name: string; oid: string; div: number;
    unit?: string; max?: number;
    ok?: number[]; unknown?: number[]; okText?: string; alarmText?: string;
}
export interface Vendor {
    key: string;
    label: string;
    prefix?: string;
    descr?: RegExp;
    cpu?: { style: 'walk-gauge-pct' | 'scalar-gauge-pct'; oid: string; fallback?: string };
    mem?: { style: 'used-free-pools'; nameOid: string; usedOid: string; freeOid: string };
    temp?: { style: 'scalars'; sensors: VendorTempScalar[] }
        | { style: 'walk-tenthF'; oid: string }
        | { style: 'walk-descr-value'; descrOid: string; valueOid: string; div: number };
    fan?: { style: 'walk-rpm'; rpmOid: string };
    metrics?: VendorMetric[];
}

export const VENDORS: Vendor[] = [
    {
        key: 'cisco',
        label: 'Cisco (IOS / IOS-XE / NX-OS)',
        prefix: '1.3.6.1.4.1.9.',
        cpu: {
            style: 'walk-gauge-pct',
            oid: '1.3.6.1.4.1.9.9.109.1.1.1.1.8',        // cpmCPUTotal5minRev
            fallback: '1.3.6.1.4.1.9.9.109.1.1.1.1.5',   // cpmCPUTotal5min (older)
        },
        mem: {
            style: 'used-free-pools',
            nameOid: '1.3.6.1.4.1.9.9.48.1.1.1.2',       // ciscoMemoryPoolName
            usedOid: '1.3.6.1.4.1.9.9.48.1.1.1.5',
            freeOid: '1.3.6.1.4.1.9.9.48.1.1.1.6',
        },
        temp: {   // CISCO-ENVMON-MIB (already degrees C)
            style: 'walk-descr-value',
            descrOid: '1.3.6.1.4.1.9.9.13.1.3.1.2',
            valueOid: '1.3.6.1.4.1.9.9.13.1.3.1.3',
            div: 1,
        },
    },
    {
        key: 'mikrotik',
        label: 'MikroTik RouterOS',
        prefix: '1.3.6.1.4.1.14988.',
        // CPU/memory come from HOST-RESOURCES; only health sensors are
        // vendor-specific. Values in tenths of a degree; not all models have
        // them. Fan tachs are present on fanned models and simply absent
        // (GET returns nothing, no sensor created) on fanless boards -
        // verified in the parent against CRS317 (3990/3960 rpm, no board
        // sensor) and the fanless CRS309 (neither).
        //
        // The mtxrHealth table at .3.100 also carries sfp-temperature,
        // fan-state, psu1-state and psu2-state, and all are DELIBERATELY NOT
        // MAPPED: the states read 0 on every unit walked and nothing
        // establishes whether 0 is healthy or faulted - a state entity
        // alarms by default, so guessing the polarity would either cry wolf
        // on healthy hardware or stay silent on a dead PSU. Settling it
        // needs a unit with a genuinely failed supply. sfp-temperature only
        // exists as row 50 with no scalar equivalent and no evidence the
        // index is stable across models.
        temp: {
            style: 'scalars',
            sensors: [
                { name: 'Board temperature', oid: '1.3.6.1.4.1.14988.1.1.3.10.0', div: 10 },
                { name: 'CPU temperature', oid: '1.3.6.1.4.1.14988.1.1.3.11.0', div: 10 },
            ],
        },
        metrics: [
            { kind: 'fan', name: 'Fan 1', oid: '1.3.6.1.4.1.14988.1.1.3.17.0', div: 1 },
            { kind: 'fan', name: 'Fan 2', oid: '1.3.6.1.4.1.14988.1.1.3.18.0', div: 1 },
        ],
    },
    {
        // FS.COM S-series / Ruijie FSOS whitelabel switches (Broadcom-based).
        // No HOST-RESOURCES health tree; sensors live in the device-info
        // entity table. Absent slots are padded with "dev:invalid" rows
        // reading 0, which the walk-descr-value style skips by name.
        key: 'fs-ruijie',
        label: 'FS.COM / Ruijie (FSOS)',
        prefix: '1.3.6.1.4.1.52642.',
        temp: {
            style: 'walk-descr-value',
            descrOid: '1.3.6.1.4.1.52642.1.1.10.2.1.1.44.1.4',
            valueOid: '1.3.6.1.4.1.52642.1.1.10.2.1.1.44.1.5',
            div: 1,
        },
        fan: { style: 'walk-rpm', rpmOid: '1.3.6.1.4.1.52642.1.1.10.2.1.1.43.1.6' },
    },
    {
        // APC Smart-UPS via PowerNet-MIB (AP9xxx NMC). Health scalars live
        // under upsAdvBattery/upsAdvOutput on every Smart-UPS regardless of
        // chassis (verified in the parent on an SRT2200 and an SMX3000).
        // Runtime is TimeTicks, div 100 to seconds.
        key: 'apc-smartups',
        label: 'APC Smart-UPS (PowerNet)',
        prefix: '1.3.6.1.4.1.318.1.3.27',
        metrics: [
            { kind: 'battery', name: 'Battery charge', oid: '1.3.6.1.4.1.318.1.1.1.2.2.1.0', div: 1 },
            { kind: 'runtime', name: 'Runtime remaining', oid: '1.3.6.1.4.1.318.1.1.1.2.2.3.0', div: 100 },
            { kind: 'temp', name: 'Temp: Battery', oid: '1.3.6.1.4.1.318.1.1.1.2.2.2.0', div: 1 },
            { kind: 'gauge', name: 'Output load', oid: '1.3.6.1.4.1.318.1.1.1.4.2.3.0', div: 1 },
            { kind: 'meter', name: 'Input voltage', oid: '1.3.6.1.4.1.318.1.1.1.3.2.1.0', div: 1, unit: 'V', max: 260 },
            { kind: 'meter', name: 'Output voltage', oid: '1.3.6.1.4.1.318.1.1.1.4.2.1.0', div: 1, unit: 'V', max: 260 },
            // upsBasicOutputStatus: 2 = onLine, 3 = onBattery; boost/trim/
            // bypass also read as the alarm state (any not-online source is
            // worth an eyebrow); 1 = unknown reads as no data.
            {
                kind: 'state', name: 'Power', oid: '1.3.6.1.4.1.318.1.1.1.4.1.1.0', div: 1,
                ok: [2], unknown: [1], okText: 'Online', alarmText: 'On battery',
            },
        ],
        temp: {   // AP9641 universal I/O temp probes (already degrees C)
            style: 'walk-descr-value',
            descrOid: '1.3.6.1.4.1.318.1.1.25.1.2.1.3',
            valueOid: '1.3.6.1.4.1.318.1.1.25.1.2.1.6',
            div: 1,
        },
    },
    {
        // APC Rack PDU via PowerNet-MIB (rPDUIdent group) - a different
        // device type from the Smart-UPS, so its own sysObjectID branch.
        // rPDUIdentDevicePower was corroborated in the parent as
        // line-voltage x phase-current. Per-phase amps exist but have no
        // amps-native kind yet; left for a units pass, as the parent left it.
        key: 'apc-rpdu',
        label: 'APC Rack PDU (PowerNet)',
        prefix: '1.3.6.1.4.1.318.1.3.4.',
        metrics: [
            { kind: 'power', name: 'PDU power', oid: '1.3.6.1.4.1.318.1.1.12.1.16.0', div: 1 },
            { kind: 'meter', name: 'Line voltage', oid: '1.3.6.1.4.1.318.1.1.12.1.15.0', div: 1, unit: 'V', max: 260 },
        ],
    },
];

/** Longest sysObjectID prefix wins; sysDescr regex is the fallback for
 *  agents with broken sysObjectIDs. The trailing-dot compare lets a
 *  sysObjectID that IS the bare enterprise root (some budget devices) still
 *  match its "1.3.6.1.4.1.NNNN." prefix. */
export function matchVendor(sysObjectID: string | null, sysDescr: string | null): Vendor | null {
    if (sysObjectID !== null && sysObjectID !== '') {
        const candidate = sysObjectID + '.';
        let best: Vendor | null = null;
        for (const v of VENDORS) {
            if (v.prefix !== undefined && candidate.startsWith(v.prefix)
                && (best === null || v.prefix.length > (best.prefix as string).length)) {
                best = v;
            }
        }
        if (best !== null) return best;
    }
    if (sysDescr !== null && sysDescr !== '') {
        for (const v of VENDORS) {
            if (v.descr !== undefined && v.descr.test(sysDescr)) return v;
        }
    }
    return null;
}

// --- the selection rules -----------------------------------------------------

/** Filesystem mounts discovered UNTRACKED, not hidden: container/loop
 *  plumbing and pseudo-filesystems nobody wants graphed by default. */
export const FS_NOISE = /^\/(run|dev|proc|sys|snap|tmp)(\/|$)|^\/var\/db\/system(\/|$)|\/\.zfs(\/|$)/;

export const fsTracked = (descr: string): boolean => !FS_NOISE.test(descr);

/** lmsensors exposes plenty of junk - unconnected headers reading 0,
 *  wrapped negatives. Implausible readings discover UNTRACKED rather than
 *  hidden, so a human can still opt one in. */
export const plausibleC = (c: number | null): boolean => c !== null && c > 0 && c < 110;

/** Absent fan bays and stopped fans read 0: only spinning fans are tracked
 *  at discovery, and a TRACKED fan that later drops to 0 still polls and
 *  can raise an alarm - the order of those two facts is the design. */
export const fanTracked = (rpm: number | null): boolean =>
    rpm !== null && rpm > 0 && rpm < 60000;

export interface RamRow { idx: string; descr: string; alloc: number; bytes: number }

/**
 * Agents can report MANY hrStorageRam rows - bsnmpd/pfSense lists every UMA
 * allocator zone. Only the real one is wanted: prefer "Physical memory"
 * (net-snmp), then "Real memory" (BSD), else the largest row.
 */
export function pickRamRow(rows: RamRow[]): RamRow | null {
    if (rows.length === 0) return null;
    return rows.find((r) => /^physical memory/i.test(r.descr))
        ?? rows.find((r) => /^real memory/i.test(r.descr))
        ?? rows.reduce((a, b) => (b.bytes > a.bytes ? b : a));
}

/** FS/Ruijie pad their sensor table with placeholder rows for absent slots
 *  ("dev:invalid" reading 0). An empty or invalid name is no sensor. */
export const tempNameValid = (name: string): boolean =>
    name.trim() !== '' && !/invalid/i.test(name);

// --- per-style value computation (the parent poller's table, pure) -----------

export interface SensorExtra {
    style: string;
    oids?: string[];
    valueOid?: string;
    usedOid?: string;
    freeOid?: string;
    sizeOid?: string;
    allocUnits?: number;
    div?: number;
    okValues?: number[];
    unknownValues?: number[];
    /** Display texts for state kinds - the card says "On battery", not ALARM. */
    okText?: string;
    alarmText?: string;
    /** Meter kinds: unit label and bar scale for the card. */
    unit?: string;
    max?: number;
}

const numOrNull = (x: unknown): number | null => {
    if (x === null || x === undefined) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
};

/**
 * Raw reading for string-flavoured styles. `extend` output can be multiline
 * with banners before the number (upsc's SSL notice) - the first numeric
 * line wins. BMC strings ("600.00rpm", "Not Available") parse leniently;
 * "Not Available" becomes null, never zero.
 */
export function sensorRaw(extra: SensorExtra, value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (extra.style === 'extend') {
        for (const line of String(value).split(/\r?\n/)) {
            const n = parseFloat(line);
            if (Number.isFinite(n)) return n;
        }
        return null;
    }
    if (extra.style === 'asrock-str') {
        const n = parseFloat(String(value));
        return Number.isFinite(n) ? n : null;
    }
    return numOrNull(value);
}

export interface SensorSample {
    v0: number | null;
    v1: number | null;
    /** Only state-like kinds set this; it reuses the up/down badge ints. */
    status: number | null;
}

/**
 * One sensor's sample from one poll, given a lookup over the values the
 * poller fetched. The value-semantics table in SLICE-SENSORS-PLAN.md is
 * THIS function - every branch is the parent poller's, ported with its
 * bounds (a runtime past 1e7 seconds or a meter past 1e6 is a decode
 * artifact, not a reading).
 */
export function sensorSample(
    kind: string, extra: SensorExtra, get: (oid: string) => unknown,
): SensorSample {
    const out: SensorSample = { v0: null, v1: null, status: null };
    const div = extra.div !== undefined && extra.div > 0 ? extra.div : 1;

    if (extra.style === 'gauge-avg') {
        const vals = (extra.oids ?? [])
            .map((o) => numOrNull(get(o)))
            .filter((v): v is number => v !== null && v >= 0 && v <= 100);
        out.v0 = vals.length > 0
            ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1))
            : null;
        return out;
    }
    if (extra.style === 'used-free') {
        const used = numOrNull(get(extra.usedOid ?? ''));
        const free = numOrNull(get(extra.freeOid ?? ''));
        if (used !== null) {
            out.v0 = used;
            out.v1 = free !== null ? used + free : null;
        }
        return out;
    }
    if (extra.style === 'hr-storage') {
        const alloc = extra.allocUnits !== undefined && extra.allocUnits > 0 ? extra.allocUnits : 1;
        const used = numOrNull(get(extra.usedOid ?? ''));
        const size = numOrNull(get(extra.sizeOid ?? ''));
        if (used !== null) out.v0 = used * alloc;
        if (size !== null) out.v1 = size * alloc;
        return out;
    }
    if (extra.style === 'state') {
        const raw = numOrNull(get(extra.valueOid ?? ''));
        const unknown = extra.unknownValues ?? [];
        if (raw === null || unknown.includes(raw)) { out.v0 = null; return out; }
        out.v0 = (extra.okValues ?? []).includes(raw) ? 0 : 1;
        out.status = out.v0 === 0 ? 1 : 2;
        return out;
    }
    if (extra.style === 'tenthF') {
        // Budget PDU internal sensors: tenths of a degree Fahrenheit.
        const raw = numOrNull(get(extra.valueOid ?? ''));
        out.v0 = raw === null ? null : Number((((raw / 10) - 32) * 5 / 9).toFixed(1));
        return out;
    }
    // The scalar styles: div, extend, asrock-str - one value OID, a divisor,
    // and per-kind plausibility bounds.
    const raw = sensorRaw(extra, get(extra.valueOid ?? ''));
    let v = raw === null ? null : raw / div;
    if (v !== null && kind === 'runtime' && (v < 0 || v >= 1e7)) v = null;
    if (v !== null && kind === 'meter' && (v < 0 || v >= 1e6)) v = null;
    out.v0 = v;
    return out;
}

// --- the re-pin planner (2026-09-01) -----------------------------------------
//
// A sensor row is two things fused: an IDENTITY (kind, index, name, the code
// bound to cards and history) and an INSTRUCTION (extra - the literal OIDs
// the poll GETs). The instruction was written once at discovery and no path
// ever touched it again, while the thing it points at is volatile: Windows
// renumbers hrDeviceIndex and hrStorage indexes across reboots and updates,
// at which point the pinned OIDs answer nothing and the reading dies
// forever. The operator's DCs proved it twice over - prod lost CPU on both
// domain controllers in one patch afternoon, and the demo's DC-3 lost every
// hr sensor at one shared timestamp (INVESTIGATION follow-up, same day).
// The sensor backfill cannot heal it (discover-if-NONE, so it never runs
// again) and rediscover cannot either (ON CONFLICT DO NOTHING, so the stale
// row always wins). This planner is the missing path: at the inventory
// cadence the caller re-discovers and hands both sides here, and the plan
// UPDATES instructions on existing rows - identity, code, history, tracked
// flag and the operator's deletions all untouched.
//
// Two match rules, in order:
//   1. SAME (kind, index) - the symbolically-indexed kinds (cpu is always
//      'cpu'): the row is the same sensor by construction, so a drifted
//      instruction is simply refreshed in place.
//   2. SAME (kind, name), both sides unique - the hr-indexed kinds (fs, mem)
//      whose INDEX is the volatile part: "C:\ Label:..." at a new index is
//      the same disk renumbered, so the row follows it, index and all.
//      Ambiguity refuses (two disks with one label is a guess), and a target
//      index another row still holds refuses too (the SQL guard would refuse
//      anyway; refusing here keeps the daily plan quiet instead of retrying
//      a write that cannot land).
//
// NEVER inserts, never deletes, never touches tracked: the discover-if-NONE
// rule exists so a deleted junk sensor stays deleted, and a repin pass that
// resurrected it every midnight would be that rule's defeat.

export interface RepinExisting {
    id: string; kind: string; snmp_index: string | null;
    name: string | null; extra: SensorExtra;
}
export interface RepinDiscovered {
    kind: string; snmpIndex: string; name: string; extra: SensorExtra;
}

/** jsonb normalizes key order, so equality must too - a repin that fired on
 *  key order alone would rewrite every row every midnight. */
function canonical(x: unknown): string {
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
    return `{${Object.keys(x as object).sort().map((k) =>
        `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function planSensorRepin(
    discovered: RepinDiscovered[], existing: RepinExisting[],
): Array<{ id: string; snmpIndex: string; name: string; extra: SensorExtra }> {
    const out: Array<{ id: string; snmpIndex: string; name: string; extra: SensorExtra }> = [];
    const claimedRows = new Set<string>();
    const claimedFinds = new Set<RepinDiscovered>();

    // Rule 1: identity by (kind, index).
    const byKindIdx = new Map(existing
        .filter((e) => e.snmp_index !== null)
        .map((e) => [`${e.kind}\u0000${e.snmp_index}`, e]));
    for (const d of discovered) {
        const row = byKindIdx.get(`${d.kind}\u0000${d.snmpIndex}`);
        if (row === undefined || claimedRows.has(row.id)) continue;
        claimedRows.add(row.id);
        claimedFinds.add(d);
        if (canonical(row.extra) !== canonical(d.extra)) {
            out.push({ id: row.id, snmpIndex: d.snmpIndex, name: d.name, extra: d.extra });
        }
    }

    // Rule 2: identity by (kind, name), strictly unique on both sides.
    const countByKindName = (list: Array<{ kind: string; name: string | null }>): Map<string, number> => {
        const m = new Map<string, number>();
        for (const x of list) {
            if (x.name === null || x.name === '') continue;
            const k = `${x.kind}\u0000${x.name}`;
            m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
    };
    const restRows = existing.filter((e) => !claimedRows.has(e.id));
    const restFinds = discovered.filter((d) => !claimedFinds.has(d));
    const rowCounts = countByKindName(restRows);
    const findCounts = countByKindName(restFinds);
    const takenIdx = new Set(existing
        .filter((e) => !claimedRows.has(e.id) && e.snmp_index !== null)
        .map((e) => `${e.kind}\u0000${e.snmp_index}`));
    for (const d of restFinds) {
        const key = `${d.kind}\u0000${d.name}`;
        if (rowCounts.get(key) !== 1 || findCounts.get(key) !== 1) continue;
        const row = restRows.find((e) => e.kind === d.kind && e.name === d.name);
        if (row === undefined) continue;
        // The renumbered index must be FREE among the rows staying put.
        if (takenIdx.has(`${d.kind}\u0000${d.snmpIndex}`)) continue;
        claimedRows.add(row.id);
        out.push({ id: row.id, snmpIndex: d.snmpIndex, name: d.name, extra: d.extra });
    }
    return out;
}
