// How many interfaces and sensors one device may have (beta list S6,
// 2026-10-31).
//
// Every walk was already bounded at SNMP_WALK_MAX_ROWS rows, but nothing
// bounded what discovery made of them: an agent serving 5,000 interfaces
// became 5,000 rows, polled every 30 s for good, and one that served new
// indexes poll after poll grew without end. The cap is per device and per
// class, decided here so discovery (probe.ts), Rediscover (main.ts) and the
// poll's own additions (poll.ts) cannot drift apart.
//
// WHICH ONES ARE KEPT: the ones discovery would watch, then the rest, each in
// the order discovery listed them. Keeping the first N by index would keep a
// switch's VLAN plumbing and refuse its uplinks, if the agent numbered them
// that way round.

import { CONFIG } from '../config.ts';

export interface EntityCaps { interfaces: number; sensors: number }

/** The configured caps (MAX_INTERFACES_PER_DEVICE, MAX_SENSORS_PER_DEVICE). */
export function ENTITY_CAPS(): EntityCaps {
    return { interfaces: CONFIG.maxInterfacesPerDevice, sensors: CONFIG.maxSensorsPerDevice };
}

export interface CapOutcome<T> {
    /** In the input order. */
    kept: T[];
    /** How many of each class were refused. */
    refused: { interfaces: number; sensors: number };
    /** One sentence per class that was cut, for the operator; empty when none. */
    notes: string[];
}

/** Interfaces are kind 'if'; every other kind is a sensor. Rediscover, which
 *  adds to rows a device already has, counts those itself (main.ts). */
export function capEntities<T extends { kind: string; tracked: boolean }>(
    entities: T[], caps: EntityCaps,
): CapOutcome<T> {
    const isIf = (e: T): boolean => e.kind === 'if';
    const keep = new Set<T>();
    const refused = { interfaces: 0, sensors: 0 };
    for (const cls of ['interfaces', 'sensors'] as const) {
        const members = entities.filter((e) => isIf(e) === (cls === 'interfaces'));
        let room = Math.max(0, caps[cls]);
        for (const e of [...members.filter((m) => m.tracked), ...members.filter((m) => !m.tracked)]) {
            if (room > 0) { keep.add(e); room--; } else refused[cls]++;
        }
    }
    const notes: string[] = [];
    const say = (n: number, cls: 'interfaces' | 'sensors', env: string): void => {
        if (n === 0) return;
        const total = entities.filter((e) => isIf(e) === (cls === 'interfaces')).length;
        notes.push(`it serves ${total} ${cls}; a device may have ${caps[cls]} (${env}), so ${n} were left out - `
            + 'the ones discovery would not watch go first');
    };
    say(refused.interfaces, 'interfaces', 'MAX_INTERFACES_PER_DEVICE');
    say(refused.sensors, 'sensors', 'MAX_SENSORS_PER_DEVICE');
    return { kept: entities.filter((e) => keep.has(e)), refused, notes };
}
