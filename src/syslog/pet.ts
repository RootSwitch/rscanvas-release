// IPMI Platform Event Traps (PET v1.0), decoded into the words an operator
// reads and an event rule matches.
//
// A BMC reports a hardware event - a fan below its critical threshold, a
// power supply failing, a chassis opened - as an SNMP v1 trap whose meaning
// is packed into two places: the specific-trap number (sensor type, event
// type, direction and offset) and one 47-byte varbind (severity, sensor,
// entity, event data, the BMC's timestamp, the maker). Stored as received it
// was a hex string: the operator's three BMCs sent 400 of them on
// 2026-09-27 and not one could be read or matched by a rule.
//
// The layout is the PET v1.0 specification's, checked field by field
// against FreeIPMI's ipmi-pet (its record format and parser); the names are
// the IPMI v2.0 tables' meanings in this project's own words. Two BMCs on
// the operator's network depart from the specification, and each departure
// is handled where it shows and said in the text rather than hidden:
//
//   * A Supermicro sends its manufacturer ID low byte first (7c 2a 00 00 is
//     10876, Supermicro, read backwards). Big-endian is tried first, then
//     little-endian, against the short list of makers named here.
//   * Another BMC writes its timestamp as Unix time, not seconds since 1998:
//     read by the specification it lands in 2054. A reading more than a day
//     in the future is read again as Unix time, and the text says so.

import type { TrapPduLike } from './trap.ts';

/** The PET enterprise, wired-for-management's platform event trap. */
export const PET_ENTERPRISE = '1.3.6.1.4.1.3183.1.1';
const PET_DATA_OID = `${PET_ENTERPRISE}.1`;
const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
/** The specification's minimum variable-bindings length. */
const PET_MIN_BYTES = 47;
/** PET timestamps count seconds from 1998-01-01 00:00. */
const PET_EPOCH_S = Date.UTC(1998, 0, 1) / 1000;
const DAY_MS = 86_400_000;

/** IPMI sensor type codes (IPMI v2.0 table 42-3). */
const SENSOR_TYPES: Readonly<Record<number, string>> = {
    0x01: 'Temperature', 0x02: 'Voltage', 0x03: 'Current', 0x04: 'Fan',
    0x05: 'Physical security', 0x06: 'Platform security violation', 0x07: 'Processor',
    0x08: 'Power supply', 0x09: 'Power unit', 0x0a: 'Cooling device', 0x0b: 'Other units sensor',
    0x0c: 'Memory', 0x0d: 'Drive slot', 0x0e: 'POST memory resize', 0x0f: 'System firmware progress',
    0x10: 'Event logging disabled', 0x11: 'Watchdog 1', 0x12: 'System event', 0x13: 'Critical interrupt',
    0x14: 'Button/switch', 0x15: 'Module/board', 0x16: 'Microcontroller/coprocessor', 0x17: 'Add-in card',
    0x18: 'Chassis', 0x19: 'Chip set', 0x1a: 'Other FRU', 0x1b: 'Cable/interconnect', 0x1c: 'Terminator',
    0x1d: 'System boot/restart', 0x1e: 'Boot error', 0x1f: 'OS boot', 0x20: 'OS stop/shutdown',
    0x21: 'Slot/connector', 0x22: 'System ACPI power state', 0x23: 'Watchdog 2', 0x24: 'Platform alert',
    0x25: 'Entity presence', 0x26: 'Monitor ASIC/IC', 0x27: 'LAN', 0x28: 'Management subsystem health',
    0x29: 'Battery', 0x2a: 'Session audit', 0x2b: 'Version change', 0x2c: 'FRU state',
};

/** Event/reading type 01h, threshold (IPMI v2.0 table 42-2). */
const THRESHOLD: readonly string[] = [
    'Lower Non-critical going low', 'Lower Non-critical going high',
    'Lower Critical going low', 'Lower Critical going high',
    'Lower Non-recoverable going low', 'Lower Non-recoverable going high',
    'Upper Non-critical going low', 'Upper Non-critical going high',
    'Upper Critical going low', 'Upper Critical going high',
    'Upper Non-recoverable going low', 'Upper Non-recoverable going high',
];

/** Event/reading types 02h-0Ch, the generic discrete states. */
const GENERIC: Readonly<Record<number, readonly string[]>> = {
    0x02: ['transition to idle', 'transition to active', 'transition to busy'],
    0x03: ['state deasserted', 'state asserted'],
    0x04: ['predictive failure deasserted', 'predictive failure asserted'],
    0x05: ['limit not exceeded', 'limit exceeded'],
    0x06: ['performance met', 'performance lags'],
    0x07: ['transition to OK', 'transition to non-critical from OK', 'transition to critical from less severe',
        'transition to non-recoverable from less severe', 'transition to non-critical from more severe',
        'transition to critical from non-recoverable', 'transition to non-recoverable', 'monitor', 'informational'],
    0x08: ['device removed or absent', 'device inserted or present'],
    0x09: ['device disabled', 'device enabled'],
    0x0a: ['transition to running', 'transition to in test', 'transition to power off', 'transition to on line',
        'transition to off line', 'transition to off duty', 'transition to degraded', 'transition to power save',
        'install error'],
    0x0b: ['fully redundant', 'redundancy lost', 'redundancy degraded',
        'non-redundant, sufficient resources from redundant', 'non-redundant, sufficient resources from insufficient',
        'non-redundant, insufficient resources', 'redundancy degraded from fully redundant',
        'redundancy degraded from non-redundant'],
    0x0c: ['D0 power state', 'D1 power state', 'D2 power state', 'D3 power state'],
};

/** Event/reading type 6Fh, sensor-specific offsets, for the types a BMC most often reports. */
const SENSOR_SPECIFIC: Readonly<Record<number, readonly string[]>> = {
    0x05: ['general chassis intrusion', 'drive bay intrusion', 'I/O card area intrusion', 'processor area intrusion',
        'LAN leash lost', 'unauthorized dock', 'fan area intrusion'],
    0x07: ['IERR', 'thermal trip', 'FRB1/BIST failure', 'FRB2/hang in POST', 'FRB3/processor startup failure',
        'configuration error', 'uncorrectable CPU-complex error', 'processor present', 'processor disabled',
        'terminator present', 'processor automatically throttled', 'machine check exception',
        'correctable machine check error'],
    0x08: ['presence detected', 'power supply failure', 'predictive failure', 'input lost (AC/DC)',
        'input lost or out of range', 'input out of range but present', 'configuration error',
        'inactive (standby)'],
    0x09: ['power off/down', 'power cycle', '240VA power down', 'interlock power down', 'AC lost',
        'soft power control failure', 'power unit failure', 'predictive failure'],
    0x0c: ['correctable ECC', 'uncorrectable ECC', 'parity', 'memory scrub failed', 'memory device disabled',
        'correctable ECC logging limit reached', 'presence detected', 'configuration error', 'spare',
        'memory automatically throttled', 'critical overtemperature'],
    0x0d: ['drive present', 'drive fault', 'predictive failure', 'hot spare', 'consistency/parity check in progress',
        'in critical array', 'in failed array', 'rebuild/remap in progress', 'rebuild/remap aborted'],
    0x0f: ['system firmware error (POST error)', 'system firmware hang', 'system firmware progress'],
    0x10: ['correctable memory error logging disabled', 'event type logging disabled', 'log area reset/cleared',
        'all event logging disabled', 'SEL full', 'SEL almost full',
        'correctable machine check error logging disabled'],
    0x11: ['BIOS watchdog reset', 'OS watchdog reset', 'OS watchdog shut down', 'OS watchdog power down',
        'OS watchdog power cycle', 'OS watchdog NMI', 'OS watchdog expired', 'OS watchdog pre-timeout interrupt'],
    0x12: ['system reconfigured', 'OEM system boot event', 'undetermined system hardware failure',
        'entry added to auxiliary log', 'PEF action', 'timestamp clock sync'],
    0x13: ['front panel NMI', 'bus timeout', 'I/O channel check NMI', 'software NMI', 'PCI PERR', 'PCI SERR',
        'EISA fail-safe timeout', 'bus correctable error', 'bus uncorrectable error', 'fatal NMI',
        'bus fatal error', 'bus degraded'],
    0x14: ['power button pressed', 'sleep button pressed', 'reset button pressed', 'FRU latch open',
        'FRU service request button pressed'],
    0x19: ['soft power control failure', 'thermal trip'],
    0x1d: ['initiated by power up', 'initiated by hard reset', 'initiated by warm reset', 'user requested PXE boot',
        'automatic boot to diagnostic', 'OS initiated hard reset', 'OS initiated warm reset', 'system restart'],
    0x1e: ['no bootable media', 'non-bootable diskette left in drive', 'PXE server not found', 'invalid boot sector',
        'timeout waiting for boot source selection'],
    0x20: ['critical stop during OS load', 'run-time critical stop', 'OS graceful stop', 'OS graceful shutdown',
        'soft shutdown initiated by PEF', 'agent not responding'],
    0x23: ['timer expired', 'hard reset', 'power down', 'power cycle', '', '', '', '', 'timer interrupt'],
    0x25: ['entity present', 'entity absent', 'entity disabled'],
    0x27: ['LAN heartbeat lost', 'LAN heartbeat'],
    0x28: ['sensor access degraded or unavailable', 'controller access degraded or unavailable',
        'management controller off-line', 'management controller unavailable', 'sensor failure', 'FRU failure'],
    0x29: ['battery low', 'battery failed', 'battery present'],
    0x2a: ['session activated', 'session deactivated', 'invalid username or password', 'invalid password disable'],
};

/** Entity IDs (IPMI v2.0 table 43-13), the ones a BMC's sensors sit on. */
const ENTITIES: Readonly<Record<number, string>> = {
    0x03: 'processor', 0x04: 'disk or disk bay', 0x06: 'system management module', 0x07: 'system board',
    0x08: 'memory module', 0x0a: 'power supply', 0x0b: 'add-in card', 0x0c: 'front panel board',
    0x0f: 'drive backplane', 0x13: 'power unit', 0x14: 'power module', 0x17: 'system chassis',
    0x1a: 'disk drive bay', 0x1d: 'fan', 0x1e: 'cooling unit', 0x20: 'memory device',
    0x21: 'system management software', 0x22: 'system firmware', 0x23: 'operating system', 0x28: 'battery',
    0x2e: 'management controller firmware', 0x35: 'real-time clock', 0x40: 'air inlet', 0x41: 'processor',
    0x42: 'baseboard',
};

/** IANA enterprise numbers of the makers whose BMCs are common. */
const MAKERS: Readonly<Record<number, string>> = {
    2: 'IBM', 9: 'Cisco', 11: 'HP', 343: 'Intel', 674: 'Dell', 10876: 'Supermicro', 19046: 'Lenovo',
};

/** Event severity, a bit per level; the worst bit set wins. */
const SEVERITIES: ReadonlyArray<[number, string, number]> = [
    // [bit, word, syslog severity]
    [0x20, 'non-recoverable', 1],
    [0x10, 'critical', 2],
    [0x08, 'non-critical', 4],
    [0x04, 'ok', 5],
    [0x02, 'information', 6],
    [0x01, 'monitor', 6],
];

export interface PetEvent {
    sensorType: number | null;
    eventType: number | null;
    /** true asserted, false deasserted, null when the trap header was not seen. */
    asserted: boolean | null;
    offset: number | null;
    severity: number;
    sensorOwner: number;
    sensorNumber: number;
    entity: number;
    entityInstance: number;
    eventData: number[];
    sequence: number;
    /** The BMC's clock, as it states it; null when unspecified. */
    time: { at: string; basis: 'pet' | 'unix'; utcOffsetMin: number | null } | null;
    maker: { id: number; name: string | null };
}

function specificOf(pdu: TrapPduLike): number | null {
    if (typeof pdu.enterprise === 'string'
        && (pdu.enterprise === PET_ENTERPRISE || pdu.enterprise.startsWith(`${PET_ENTERPRISE}.`))) {
        return typeof pdu.specific === 'number' ? pdu.specific : null;
    }
    // A v2c PET names itself in snmpTrapOID as <enterprise>.0.<specific>.
    const trapOid = (pdu.varbinds ?? []).find((vb) => vb.oid === SNMP_TRAP_OID);
    const v = trapOid === undefined ? '' : String(trapOid.value);
    const m = new RegExp(`^${PET_ENTERPRISE.replace(/\./g, '\\.')}\\.0\\.(\\d+)$`).exec(v);
    return m ? Number(m[1]) : null;
}

/**
 * The PET in this trap, or null when it is not one: a PET is recognised by
 * its data varbind, 47 bytes or more, so a PET arriving without its v1
 * header still decodes (without the sensor type the header carries).
 */
export function decodePet(pdu: TrapPduLike, nowMs: number = Date.now()): PetEvent | null {
    const vb = (pdu.varbinds ?? []).find((v) => v.oid === PET_DATA_OID);
    if (vb === undefined || !Buffer.isBuffer(vb.value) || vb.value.length < PET_MIN_BYTES) return null;
    const b = vb.value;

    const specific = specificOf(pdu);
    const raw = b.readUInt32BE(18);
    const off = b.readUInt16BE(22);
    let time: PetEvent['time'] = null;
    if (raw !== 0) {
        const utcOffsetMin = off === 0xffff ? null : b.readInt16BE(22);
        const petMs = (PET_EPOCH_S + raw) * 1000;
        const unixMs = raw * 1000;
        const future = petMs > nowMs + DAY_MS && unixMs <= nowMs + DAY_MS;
        time = {
            at: new Date(future ? unixMs : petMs).toISOString().slice(0, 19).replace('T', ' '),
            basis: future ? 'unix' : 'pet', utcOffsetMin,
        };
    }
    const be = b.readUInt32BE(40);
    const le = b.readUInt32LE(40);
    const makerId = MAKERS[be] === undefined && MAKERS[le] !== undefined ? le : be;

    return {
        sensorType: specific === null ? null : (specific >>> 16) & 0xff,
        eventType: specific === null ? null : (specific >>> 8) & 0xff,
        asserted: specific === null ? null : (specific & 0x80) === 0,
        offset: specific === null ? (b[31] as number) & 0x0f : specific & 0x0f,
        severity: b[26] as number,
        sensorOwner: b[27] as number,
        sensorNumber: b[28] as number,
        entity: b[29] as number,
        entityInstance: b[30] as number,
        eventData: [...b.subarray(31, 39)],
        sequence: b.readUInt16BE(16),
        time,
        maker: { id: makerId, name: MAKERS[makerId] ?? null },
    };
}

function severityOf(bits: number): [string, number] | null {
    for (const [bit, word, sys] of SEVERITIES) if ((bits & bit) !== 0) return [word, sys];
    return null;
}

const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/**
 * A threshold event, by its type from the header or, when the header was
 * not seen, by event data 1: bits 7:6 = 01b ("byte 2 is the trigger
 * reading") are defined only for threshold sensors.
 */
const isThreshold = (e: PetEvent): boolean =>
    e.eventType === 0x01 || (e.eventType === null && ((e.eventData[0] ?? 0) >> 6) === 1);

/** What happened, in the specification's terms, or the codes when unnamed. */
function eventWords(e: PetEvent): string {
    const o = e.offset;
    if (o === null || o === 0x0f) return 'event';
    if (isThreshold(e)) return THRESHOLD[o] ?? `threshold offset ${o}`;
    if (e.eventType !== null && GENERIC[e.eventType] !== undefined) {
        return (GENERIC[e.eventType] as readonly string[])[o] || `offset ${o}`;
    }
    if (e.eventType === 0x6f && e.sensorType !== null) {
        return (SENSOR_SPECIFIC[e.sensorType] ?? [])[o] || `offset ${o}`;
    }
    if (e.eventType === null) return `offset ${o}`;
    return `${e.eventType >= 0x70 && e.eventType <= 0x7f ? 'OEM ' : ''}event type ${hex2(e.eventType)} offset ${o}`;
}

/**
 * The text a PET is stored as, ahead of the trap header and varbinds: what
 * happened first, so the Logs page and a rule both meet it, then where and
 * when. Raw readings stay raw - turning 10 into RPM needs the sensor's SDR,
 * which only the BMC holds.
 */
export function petText(e: PetEvent): string {
    const type = e.sensorType === null ? 'platform event'
        : SENSOR_TYPES[e.sensorType] ?? `${e.sensorType >= 0xc0 ? 'OEM ' : ''}sensor type ${hex2(e.sensorType)}`;
    const parts: string[] = [];
    let head = `IPMI ${type}: ${eventWords(e)}`;
    if (e.asserted !== null) head += e.asserted ? ', asserted' : ', deasserted';
    const sev = severityOf(e.severity);
    if (sev !== null) head += ` - severity ${sev[0]}`;
    parts.push(head);

    const where: string[] = [];
    if (e.sensorNumber !== 0x00 && e.sensorNumber !== 0xff) where.push(`sensor ${hex2(e.sensorNumber)}`);
    if (e.entity !== 0x00) {
        const name = ENTITIES[e.entity] ?? `entity ${hex2(e.entity)}`;
        where.push(`on ${name}${e.entityInstance !== 0 ? ` ${e.entityInstance}` : ''}`);
    }
    if (e.sensorOwner !== 0xff) where.push(`owner ${hex2(e.sensorOwner)}`);
    if (where.length > 0) parts.push(where.join(' '));

    // Threshold events say in event data 1 what bytes 2 and 3 carry: 01b is
    // the trigger reading and the trigger threshold respectively.
    const d1 = e.eventData[0] ?? 0;
    if (isThreshold(e)) {
        const vals: string[] = [];
        if ((d1 >> 6) === 1) vals.push(`raw reading ${e.eventData[1]}`);
        if (((d1 >> 4) & 3) === 1) vals.push(`raw threshold ${e.eventData[2]}`);
        if (vals.length > 0) parts.push(vals.join(', '));
    }

    if (e.time !== null) {
        const zone = e.time.utcOffsetMin === null ? ''
            : ` UTC${e.time.utcOffsetMin < 0 ? '-' : '+'}${String(Math.floor(Math.abs(e.time.utcOffsetMin) / 60)).padStart(2, '0')}`
              + `:${String(Math.abs(e.time.utcOffsetMin) % 60).padStart(2, '0')}`;
        parts.push(`logged ${e.time.at}${zone} by the BMC clock${e.time.basis === 'unix' ? ' (read as Unix time)' : ''}`);
    }
    parts.push(`seq ${e.sequence}`);
    if (e.maker.id !== 0 && e.maker.id !== 0xffffffff) parts.push(e.maker.name ?? `maker ${e.maker.id}`);
    return parts.join('; ');
}

/**
 * A PET's own severity as a syslog severity, so sev: filters and the Logs
 * page's colours meet it. Other traps carry none and stay null.
 */
export function petSyslogSeverity(e: PetEvent | null): number | null {
    if (e === null) return null;
    const sev = severityOf(e.severity);
    return sev === null ? null : sev[1];
}
