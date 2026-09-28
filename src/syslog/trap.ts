// How a received SNMP trap becomes a message row: the text an operator reads
// and an event rule matches, and which device it is from. The pure half of
// the trap receiver in workers/ingest.ts, so tools/test-trap.ts can hold it.
//
// FOUND BY THE REAL-AGENT DRILL (2026-09-28): net-snmp's snmptrap on one test
// box, sending to an installed RSCanvas on the other.
//
//   * A v1 trap was stored as its varbinds alone. A v1 trap's IDENTITY is not
//     in its varbinds - it is the enterprise OID and the generic and specific
//     numbers in the PDU header - so a UPS's "on battery" and its "battery
//     restored" arrived as the same shapeless text, and no event rule could
//     tell them apart. Older gear (UPSes, PDUs, printers) speaks v1.
//   * A v2c linkDown read as a row of numbers. The six standard traps are
//     named, and the v2 trap OID is written out as trap=<oid>; a v1 trap
//     carries the SAME trap=<oid> by RFC 3584's mapping, so one rule matching
//     "1.3.6.1.6.3.1.1.5.3" catches a linkDown from either version.
//   * A trap has no hostname, so its alert was attached to the bare source
//     address - outside the device's maintenance window, mute and notify
//     policy, all of which are keyed by device name. It now takes the name of
//     the device at that address, when exactly one device has it.
//
// The varbinds follow unchanged, so a rule written against the old text
// still matches.

const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
const SNMP_TRAPS = '1.3.6.1.6.3.1.1.5';

/** RFC 3418 snmpTraps, by their v2 OID. */
export const STANDARD_TRAPS: Readonly<Record<string, string>> = {
    [`${SNMP_TRAPS}.1`]: 'coldStart',
    [`${SNMP_TRAPS}.2`]: 'warmStart',
    [`${SNMP_TRAPS}.3`]: 'linkDown',
    [`${SNMP_TRAPS}.4`]: 'linkUp',
    [`${SNMP_TRAPS}.5`]: 'authenticationFailure',
    [`${SNMP_TRAPS}.6`]: 'egpNeighborLoss',
};

/** A v1 trap's generic-trap numbers, 0..6. */
export const GENERIC_TRAPS: readonly string[] = [
    'coldStart', 'warmStart', 'linkDown', 'linkUp', 'authenticationFailure', 'egpNeighborLoss', 'enterpriseSpecific',
];

export interface TrapPduLike {
    enterprise?: unknown;
    agentAddr?: unknown;
    generic?: unknown;
    specific?: unknown;
    varbinds?: Array<{ oid: string; value: unknown }>;
}

/** A varbind value as text: printable buffers as text, the rest as hex. */
export function renderValue(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (Buffer.isBuffer(v)) {
        let printable = true;
        for (const b of v) if ((b < 0x20 && b !== 0x09) || b === 0x7f) { printable = false; break; }
        return printable ? v.toString('utf8') : '0x' + v.toString('hex');
    }
    return String(v);
}

/**
 * The v2 trap OID a v1 trap corresponds to (RFC 3584 section 3.1): a generic
 * trap 0-5 is snmpTraps.(generic+1); an enterprise-specific one is
 * enterprise.0.specific.
 */
export function v1TrapOid(enterprise: string, generic: number, specific: number): string {
    return generic >= 0 && generic <= 5 ? `${SNMP_TRAPS}.${generic + 1}` : `${enterprise}.0.${specific}`;
}

export function renderTrap(pdu: TrapPduLike): string {
    const varbinds = pdu.varbinds ?? [];
    const listed = varbinds.map((vb) => `${vb.oid}=${renderValue(vb.value)}`).join(' ');
    if (typeof pdu.enterprise === 'string' && typeof pdu.generic === 'number') {
        const generic = pdu.generic;
        const specific = typeof pdu.specific === 'number' ? pdu.specific : 0;
        const name = GENERIC_TRAPS[generic] ?? `generic-${generic}`;
        const agent = typeof pdu.agentAddr === 'string' && pdu.agentAddr !== '' ? ` agent=${pdu.agentAddr}` : '';
        const head = `${name} trap=${v1TrapOid(pdu.enterprise, generic, specific)} v1 enterprise=${pdu.enterprise} `
            + `generic=${generic} specific=${specific}${agent}`;
        return listed === '' ? head : `${head} ${listed}`;
    }
    const trapOid = varbinds.find((vb) => vb.oid === SNMP_TRAP_OID);
    if (trapOid === undefined) return listed || 'trap with no varbinds';
    const oid = renderValue(trapOid.value);
    return `${STANDARD_TRAPS[oid] ?? 'trap'} trap=${oid} ${listed}`;
}

/**
 * The device a trap came from, by its source address: the name when exactly
 * one device has that address, null otherwise. Several devices on one
 * address (agents behind NAT, or a lab's fleet on one host with many ports)
 * leave it null rather than guess - a trap attached to the wrong device
 * would be muted, windowed and routed as that device.
 */
export function deviceForAddress(address: string | null, byAddress: ReadonlyMap<string, readonly string[]>): string | null {
    if (address === null) return null;
    const names = byAddress.get(address.replace(/^::ffff:/, ''));
    return names !== undefined && names.length === 1 ? (names[0] as string) : null;
}
