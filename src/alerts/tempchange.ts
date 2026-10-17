// Change from normal (slice 65): a temperature against its own last week,
// and a room's temperatures together. IDEAS-ANOMALY.md has the replay the
// numbers come from; sql/slice65.sql has the baselines.
//
// The operator's incidents, and what a fixed threshold made of them: a
// closet's AC failed and every switch stayed inside its own limits while the
// room went from 80 F to 100 F; a NIC's 40 mm fan died and the card ran
// 20 C hotter, under any number anyone would set for a NIC. Neither is a
// level. Both are a change.
//
// Pure, like groups.ts and for the same reason: emitted from the scan, not
// from evaluate(), which is held against the parent suite's rules.js and has
// no parent for this. tools/test-tempchange.ts holds it.
//
// --- the two rules, measured on production's raw readings (10-02 to 10-16) ---
//
//   one sensor   the median of its last 20 minutes more than
//                max(3 x its week's spread, 8 C) above its week's median.
//                A dead NIC fan (+20 C over ten minutes) in 14 minutes.
//   a room       in one location with n >= 2 devices taking part, min(3, n)
//                of them each with a sensor whose last 10 minutes are more
//                than max(3 x spread, 3 C) above its week. A closet's AC
//                failing (+11 C) in 14 minutes over a 30-minute rise, 38
//                over a two-hour one.
//
// Neither raised anything false in eight judged days. The floors differ on
// purpose: one warm case is one busy host, so one sensor alone must clear a
// high bar; three devices in one room at once is evidence by itself.
//
// UPWARD ONLY. A room cooling is not the failure either story was about.
//
// --- which sensors take part ----------------------------------------------------
//
// Sensors split cleanly by what moves them, and the replay was quiet only
// with the work-driven ones left out:
//
//   follows the ROOM   motherboard (SYSTIN, AUXTIN, a bare temp1), NIC
//                      (mlx5), spinning disks, DIMMs, a switch's chip, and
//                      air itself (inlet and ambient sensors, a UPS's probes)
//   follows WORK       CPU packages, GPUs, NVMe drives, the chipset
//
// A switch's "CPU temperature" is the case that shows why: named like a CPU,
// the chip of a CRS does little but sit in the room, and behaves like a
// thermometer. So the device's stencil is read beside the name.
//
// A name can suggest the class and never decide it alone (names are the
// device's, not ours), so the operator includes or excludes any one sensor
// on its card - a 'temp-change' override on its code - and a device's own
// row turned off takes every sensor of it out of both rules.

import {
    resolveBool, TEMP_CHANGE_DEFAULT, TEMP_ROOM_DEFAULT,
    type Condition, type OverrideIndex, type RulesConfig,
} from './rules.ts';

export const TEMP_CHANGE_KIND = 'temp-change';
export const TEMP_ROOM_KIND = 'temp-room';

/** The baseline: seven days of hourly means, judged once 72 hours of it exist. */
export const BASELINE_DAYS = 7;
export const BASELINE_MIN_HOURS = 72;
/** How many spreads (the interquartile range of the week) a rise must clear. */
export const SPREAD_TIMES = 3;
export const SINGLE_WINDOW_S = 20 * 60;
export const SINGLE_FLOOR_C = 8;
export const ROOM_WINDOW_S = 10 * 60;
export const ROOM_FLOOR_C = 3;
/** A room raises on this many devices, or every device when it has fewer. */
export const ROOM_DEVICES = 3;

export type TempClass = 'board' | 'nic' | 'disk' | 'dimm' | 'switch' | 'ambient';

/** What the card says each class is. */
export const CLASS_WORDS: Readonly<Record<TempClass, string>> = {
    board: 'a motherboard sensor', nic: 'a network card', disk: 'a spinning disk', dimm: 'a memory module',
    switch: "a switch's chip", ambient: 'an air sensor',
};

// Work-driven by name: CPU (package, Tctl/Tdie/Tccd, a core, CPUTIN), GPU
// (and its edge, junction, memory), NVMe (Composite, nvd, "Sensor 1"), the
// chipset (PCH) - one production host's read +10 to +12 C under its VMs' load and
// caused nearly every false alarm the replay saw before it was left out.
const WORK = /package|tctl|tdie|tccd|\bcore\b|cputin|\bcpu\b|gpu|\bedge\b|junction|hot ?spot|\bmem\b|vram|nvme|composite|\bnvd\d|\bsensor [0-9]+\b|pch|chipset/;
// Parts of a switch that follow its load, not the room: the power supply
// warms with PoE draw, and optics are many and individually noisy.
const SWITCH_LOAD = /psu|power|poe|sfp|xcvr|transceiver|optic|laser/;

/**
 * Which room-following class a temperature sensor's name says it is, or
 * null: work-driven, or a name this does not know. Only a suggestion - the
 * operator's per-sensor include or exclude outranks it (participation()).
 */
export function classifyTempSensor(name: string | null | undefined, stencil: string | null | undefined): TempClass | null {
    const n = String(name ?? '').trim().replace(/^temp(?:erature)?\s*:\s*/i, '').toLowerCase();
    if (n === '') return null;
    if (stencil === 'switch') return SWITCH_LOAD.test(n) ? null : 'switch';
    // A UPS's temperature probes (APC's universal I/O) exist to measure air,
    // under whatever name the operator gave them; its battery warms with
    // charging, so it stays out.
    if (stencil === 'ups') return /battery/.test(n) ? null : 'ambient';
    if (WORK.test(n)) return null;
    if (/ambient|inlet|intake|\broom\b|outside air|\bair in/.test(n)) return 'ambient';
    if (/mlx\d|(?:^|:)sensor0$|\bnic\b|ethernet/.test(n)) return 'nic';
    if (/^(?:da|ada|sd[a-z]+|hd[a-z]+)\d*$|drivetemp|\bhdd\d*\b|\bdisk\b/.test(n)) return 'disk';
    if (/^module\s?\d+$|dimm|jc42/.test(n)) return 'dimm';
    if (/systin|auxtin|^temp\d+$|acpitz|motherboard|\bboard\b|\bsystem\b|chassis/.test(n)) return 'board';
    return null;
}

/** Whether one sensor takes part, and what said so. */
export interface Participation {
    on: boolean;
    /** 'name' and 'not by name' are the classifier's; the others are rows. */
    why: 'name' | 'not by name' | 'this sensor' | 'this device';
}

/**
 * THE SENSOR'S OWN ROW decides first, either way: an include on a name this
 * module does not know, or an exclude on one it does. Then the device's row,
 * but only when it is OFF - a device turned on adds nothing a name did not,
 * because "on for this device" must not sweep its CPU and GPUs in. Then the
 * name.
 */
export function participation(idx: OverrideIndex, code: string, host: string | null, cls: TempClass | null): Participation {
    const own = idx.byCode.get(`${code}|${TEMP_CHANGE_KIND}`);
    if (own) return { on: own.enabled === true, why: 'this sensor' };
    const dev = idx.byHostKind.get(`${host}|${TEMP_CHANGE_KIND}`);
    if (dev && dev.enabled !== true) return { on: false, why: 'this device' };
    return { on: cls !== null, why: cls !== null ? 'name' : 'not by name' };
}

/** One temperature sensor with a baseline, as the scan reads it. */
export interface ChangeSensor {
    code: string;
    /** The sensor's name, as its card shows it. */
    name: string;
    /** The device's name. */
    host: string;
    location: string | null;
    stencil: string | null;
    status: string | null;
    transient: boolean;
    muted: boolean;
    /** The device's poll interval: how many readings a window should hold. */
    pollS: number;
    /** The week: hours with a reading, median, quartiles. */
    hours: number;
    med: number;
    q1: number;
    q3: number;
    /** Median and count of the last ROOM_WINDOW_S and SINGLE_WINDOW_S of
     *  readings; null and 0 until OPS.tempChangeRecent fills them. */
    r10: number | null;
    n10: number;
    r20: number | null;
    n20: number;
}

/** The sensors whose recent readings the scan should fetch: taking part, on
 *  a device that can raise, with a week behind them. */
export function takingPart(rows: ChangeSensor[], idx: OverrideIndex): ChangeSensor[] {
    return rows.filter((s) => !s.muted && !s.transient && s.hours >= BASELINE_MIN_HOURS
        && participation(idx, s.code, s.host, classifyTempSensor(s.name, s.stencil)).on);
}

/** Half a window's readings at the device's poll rate, and never fewer than two. */
export function minReadings(windowS: number, pollS: number): number {
    return Math.max(2, Math.floor(windowS / Math.max(1, pollS) / 2));
}

/** How far above its week a sensor must be: SPREAD_TIMES spreads, or the floor. */
export function gateOf(s: Pick<ChangeSensor, 'q1' | 'q3'>, floor: number): number {
    return Math.max(SPREAD_TIMES * Math.max(0, s.q3 - s.q1), floor);
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function roomKey(location: string): string {
    return `${TEMP_ROOM_KIND}:location:${location}`;
}

/** The location back out of a room key; a location may itself contain ':'. */
export function parseRoomKey(key: string): string | null {
    const m = /^temp-room:location:(.+)$/s.exec(key);
    return m ? (m[1] as string) : null;
}

/**
 * The conditions for every sensor taking part and every room with two or
 * more devices taking part. `sensors` is takingPart()'s output with the
 * recent readings filled in.
 *
 * A DOWN device, or a sensor short of readings, is NO EVIDENCE: its own
 * condition freezes, and in a room it counts toward n and cannot flag. A
 * room with fewer judged devices than it needs freezes too, rather than
 * reading normal - an AC failure that cooks the room's servers until they
 * shut down must not clear the room's alert by silencing its witnesses.
 */
export function changeConditions(sensors: ChangeSensor[], config: RulesConfig, idx: OverrideIndex): Condition[] {
    const out: Condition[] = [];

    for (const s of sensors) {
        const rule = resolveBool(idx, config.tempChange ?? TEMP_CHANGE_DEFAULT, s.code, s.host, TEMP_CHANGE_KIND);
        if (!rule) continue;
        const judged = s.status !== 'down' && s.r20 !== null && Number.isFinite(s.r20)
            && s.n20 >= minReadings(SINGLE_WINDOW_S, s.pollS);
        const gate = gateOf(s, SINGLE_FLOOR_C);
        const rise = judged ? (s.r20 as number) - s.med : null;
        out.push({
            key: `change:${s.code}`,
            severity: rise !== null && rise > gate ? rule.severity : null,
            frozen: !judged,
            kind: TEMP_CHANGE_KIND, host: s.host, code: s.code,
            label: `${s.host} ${s.name} above its week`,
            value: rise === null ? null : round1(rise), threshold: judged ? round1(gate) : null, unit: 'C',
        });
    }

    const room = resolveBool(idx, config.tempRoom ?? TEMP_ROOM_DEFAULT, null, null, TEMP_ROOM_KIND);
    if (!room) return out;
    // location -> device -> what its sensors say
    const rooms = new Map<string, Map<string, { judged: boolean; flagged: boolean; rise: number }>>();
    for (const s of sensors) {
        const loc = (s.location ?? '').trim();
        if (loc === '') continue;
        let devs = rooms.get(loc);
        if (!devs) { devs = new Map(); rooms.set(loc, devs); }
        let d = devs.get(s.host);
        if (!d) { d = { judged: false, flagged: false, rise: -Infinity }; devs.set(s.host, d); }
        if (s.status === 'down' || s.r10 === null || !Number.isFinite(s.r10)
            || s.n10 < minReadings(ROOM_WINDOW_S, s.pollS)) continue;
        const rise = s.r10 - s.med;
        d.judged = true;
        if (rise > gateOf(s, ROOM_FLOOR_C)) d.flagged = true;
        d.rise = Math.max(d.rise, rise);
    }
    for (const [loc, devs] of rooms) {
        const n = devs.size;
        if (n < 2) continue;   // a one-device room is that device: its own rule speaks
        const need = Math.min(ROOM_DEVICES, n);
        const all = [...devs].map(([name, d]) => ({ name, ...d }));
        const judged = all.filter((d) => d.judged).sort((a, b) => b.rise - a.rise);
        const flagged = judged.filter((d) => d.flagged);
        const tripped = flagged.length >= need;
        const ranked = tripped ? flagged : judged;
        const SHOWN = 5;
        const names = flagged.slice(0, SHOWN).map((d) => d.name).join(', ')
            + (flagged.length > SHOWN ? `, and ${flagged.length - SHOWN} more` : '');
        out.push({
            key: roomKey(loc),
            severity: tripped ? room.severity : null,
            frozen: !tripped && judged.length < need,
            kind: TEMP_ROOM_KIND, host: null, code: null,
            label: `${loc} (location): ${flagged.length} of ${n} devices warmer than their week`
                + (flagged.length > 0 ? ` - ${names}` : ''),
            // The rise at least `need` of them share: "the room is this much warmer".
            value: ranked.length >= need ? round1((ranked[need - 1] as { rise: number }).rise) : null,
            threshold: null, unit: 'C',
        });
    }
    return out;
}
