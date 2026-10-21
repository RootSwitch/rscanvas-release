// A stopped fan (2026-10-18): a tracked fan reading 0.
//
// THE GAP IT CLOSES, found writing docs/WHAT-IT-WATCHES.md. A fan's levels
// alarm on a HIGH reading - fan is not in LOWER_IS_BAD, and it ships no
// levels at all - so a fan that died raised nothing, while sensors.ts said a
// tracked fan that drops to 0 "can raise an alarm". A rule stated in one
// place and enforced nowhere. Discovery tracks a vendor's fan only while it
// spins (fanTracked), so a tracked one reading 0 turned and stopped, and
// that needs no level chosen first. An extend fan is tracked spinning or
// not, because somebody wrote that line on purpose (probe.ts step 7) - which
// is how a graphics card's parked fan arrives tracked at 0.
//
// Pure, beside tempchange.ts and for its reason: emitted from the scan, not
// from evaluate(), which is held against the parent suite's rules.js and has
// no parent for this. tools/test-fanstop.ts holds it.
//
// FANS THAT STOP ON PURPOSE. Production's one graphics-card fan (an extend
// from the card's driver) read 0 rpm in 34,344 of 41,982 polls over two
// weeks: cards park their fans while idle. Judged by its reading it would
// have raised on its first quiet minute and stayed raised. The two fans of
// the one switch there that reports them never read 0 once in those two
// weeks. So a fan whose name says GPU takes no part unless included on its
// card, every other fan does, and the same card button leaves out any other
// fan built to stop - a router whose fan switches on above a temperature,
// say.

import {
    resolveBool, FAN_STOPPED_DEFAULT,
    type Condition, type OverrideIndex, type RulesConfig, type ScanDevice, type ScanDoc, type Severity,
} from './rules.ts';

export const FAN_STOPPED_KIND = 'fan-stopped';

/** A graphics card's fan, by its name: the kind that parks while the card is idle. */
const PARKS_WHEN_IDLE = /gpu|graphics|vga/i;

export function parksWhenIdle(name: string | null | undefined): boolean {
    return PARKS_WHEN_IDLE.test(String(name ?? ''));
}

/** Whether one fan is watched, and what said so. */
export interface FanStopState {
    on: boolean;
    /**
     *   default       every fan is, unless something says otherwise
     *   parks         its name says a graphics card's, which stops when idle
     *   this sensor   its own row, either way
     *   this device   its device's row, turned off
     *   every device  the rule is off for the fleet (a row, or the config)
     */
    why: 'default' | 'parks' | 'this sensor' | 'this device' | 'every device';
    severity: Severity | null;
}

/**
 * ONE ANSWER for the scan and the card, so the two cannot disagree. The
 * fan's own row decides first, either way; then its device's row, but only
 * when it is OFF - "on for this device" must not sweep a graphics card's
 * fan in, the rule change from normal keeps for CPUs; then the name; then
 * the fleet's own switch.
 */
export function fanStopState(
    idx: OverrideIndex, config: RulesConfig, code: string, host: string | null, name: string | null | undefined,
): FanStopState {
    const own = idx.byCode.get(`${code}|${FAN_STOPPED_KIND}`);
    let why: FanStopState['why'];
    if (own) {
        if (own.enabled !== true) return { on: false, why: 'this sensor', severity: null };
        why = 'this sensor';
    } else {
        const dev = idx.byHostKind.get(`${host}|${FAN_STOPPED_KIND}`);
        if (dev && dev.enabled !== true) return { on: false, why: 'this device', severity: null };
        if (parksWhenIdle(name)) return { on: false, why: 'parks', severity: null };
        why = 'default';
    }
    const rule = resolveBool(idx, config.fanStopped ?? FAN_STOPPED_DEFAULT, code, host, FAN_STOPPED_KIND);
    if (rule === null) return { on: false, why: 'every device', severity: null };
    return { on: true, why, severity: rule.severity };
}

export function fanStopKey(code: string): string {
    return `fanstop:${code}`;
}

/**
 * One condition per watched fan. The device's state governs it as it
 * governs every sensor rule in evaluate(): a MUTED device emits nothing, a
 * DOWN one freezes it (device-down speaks, and a fan nobody can read has
 * not stopped), and a down device DECLARED TRANSIENT quiets it (ruling 4: its
 * absence is not a fault). A stale or unreadable reading freezes too, and a
 * negative one is the agent's nonsense, not a reading of stopped.
 */
export function fanStopConditions(doc: ScanDoc, config: RulesConfig, idx: OverrideIndex): Condition[] {
    const devices = new Map<string, ScanDevice>();
    for (const d of doc.devices ?? []) if (d && d.name) devices.set(d.name, d);
    const out: Condition[] = [];
    for (const m of doc.metrics ?? []) {
        if (!m || m.kind !== 'fan' || !m.code) continue;
        const host = m.host ?? null;
        const dev = host === null ? undefined : devices.get(host);
        if (dev?.muted === true) continue;
        const state = fanStopState(idx, config, m.code, host, m.display);
        if (!state.on || state.severity === null) continue;
        const base = {
            key: fanStopKey(m.code), kind: FAN_STOPPED_KIND, host, code: m.code,
            label: `${host} ${m.display ?? 'fan'} stopped`, threshold: null, unit: m.unit || 'rpm',
        };
        if (dev?.status === 'down') {
            out.push({ ...base, severity: null, frozen: dev.transient !== true, value: null });
            continue;
        }
        const v = m.value;
        const judged = typeof v === 'number' && Number.isFinite(v) && v >= 0;
        out.push({
            ...base,
            severity: judged && v === 0 ? state.severity : null,
            frozen: !judged,
            value: judged ? Math.round(v * 100) / 100 : null,
        });
    }
    return out;
}
