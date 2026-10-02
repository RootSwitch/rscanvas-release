// IPMI Platform Event Traps decoded (src/syslog/pet.ts), offline. The
// buffers are built field by field to the PET v1.0 layout; the two quirks
// are the ones the operator's own BMCs showed on 2026-09-27: a Supermicro's
// manufacturer ID low byte first, and a timestamp written as Unix time.
//
//   node tools/test-pet.ts

import { decodePet, petText, petSyslogSeverity, PET_ENTERPRISE } from '../src/syslog/pet.ts';
import { renderTrap } from '../src/syslog/trap.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const has = (label: string, text: string, part: string): void => {
    if (text.includes(part)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       "${part}" not in\n       ${text}`);
    }
};

const DATA_OID = `${PET_ENTERPRISE}.1`;
const PET_EPOCH_S = Date.UTC(1998, 0, 1) / 1000;
// 2026-09-28 02:07 UTC, when the operator's BMCs sent theirs.
const NOW = Date.UTC(2026, 8, 28, 2, 7, 15);

interface Fields {
    seq?: number; ts?: number; utc?: number; severity?: number; owner?: number; sensor?: number;
    entity?: number; instance?: number; data?: number[]; maker?: number; makerLE?: boolean; length?: number;
}
function petBuf(f: Fields = {}): Buffer {
    const b = Buffer.alloc(f.length ?? 47);
    b.write('0123456789abcdef', 0, 'latin1');            // GUID, 16 bytes
    b.writeUInt16BE(f.seq ?? 102, 16);
    b.writeUInt32BE(f.ts ?? 0x343a617d, 18);              // 2025-10-07 16:21:17, PET epoch
    b.writeUInt16BE(f.utc ?? 0xffff, 22);
    b[24] = 0x20; b[25] = 0x20;                            // trap and event source: IPMI
    b[26] = f.severity ?? 0x02;
    b[27] = f.owner ?? 0x20;
    b[28] = f.sensor ?? 0x41;
    b[29] = f.entity ?? 0x1d;
    b[30] = f.instance ?? 0;
    (f.data ?? [0x52, 0x0a, 0x02, 0, 0, 0, 0, 0]).forEach((v, i) => { b[31 + i] = v; });
    b[39] = 0x19;                                          // English
    if (f.makerLE) b.writeUInt32LE(f.maker ?? 10876, 40); else b.writeUInt32BE(f.maker ?? 10876, 40);
    if (b.length > 46) b[46] = 0xc1;
    return b;
}
const specific = (sensorType: number, eventType: number, offset: number, deassert = false): number =>
    (sensorType << 16) | (eventType << 8) | (deassert ? 0x80 : 0) | offset;
const v1 = (spec: number, buf: Buffer) => ({
    enterprise: PET_ENTERPRISE, generic: 6, specific: spec, agentAddr: '192.0.2.29',
    varbinds: [{ oid: DATA_OID, value: buf }],
});

console.log('a fan below its lower critical threshold, as a Supermicro sends it:');
{
    const pdu = v1(specific(0x04, 0x01, 0x02), petBuf({ makerLE: true }));
    const e = decodePet(pdu, NOW);
    eq('the header decodes: fan, threshold, asserted, offset 2',
        e && [e.sensorType, e.eventType, e.asserted, e.offset], [0x04, 0x01, true, 2]);
    eq('a low-byte-first manufacturer ID still names Supermicro', e?.maker, { id: 10876, name: 'Supermicro' });
    const t = e === null ? '' : petText(e);
    has('it reads as what happened', t, 'IPMI Fan: Lower Critical going low, asserted - severity information');
    has('where: sensor, entity and owner', t, 'sensor 0x41 on fan owner 0x20');
    has('the raw reading and threshold from event data 2 and 3', t, 'raw reading 10, raw threshold 2');
    has('when, by the spec epoch of 1998', t, 'logged 2025-10-07 16:21:17 by the BMC clock');
    eq('and not flagged as Unix time', t.includes('Unix'), false);
    has('the sequence number and maker close it', t, 'seq 102; Supermicro');
    const msg = renderTrap(pdu, NOW);
    eq('renderTrap leads with the meaning', msg.startsWith('IPMI Fan: Lower Critical going low'), true);
    has('and keeps the trap OID a rule may match', msg, `trap=${PET_ENTERPRISE}.0.${specific(0x04, 0x01, 0x02)}`);
    has('and the hex varbind a rule may already match', msg, `${DATA_OID}=0x30313233`);
}

console.log('\ndirection, severity and the sensor-specific tables:');
{
    const back = decodePet(v1(specific(0x04, 0x01, 0x02, true), petBuf()), NOW);
    has('the deassertion bit reads as deasserted', back === null ? '' : petText(back), 'going low, deasserted');
    const psu = decodePet(v1(specific(0x08, 0x6f, 0x01), petBuf({ severity: 0x10, entity: 0x0a, instance: 2, data: [0x01, 0xff, 0xff, 0, 0, 0, 0, 0] })), NOW);
    has('a power supply failure is named from the sensor-specific table', psu === null ? '' : petText(psu),
        'IPMI Power supply: power supply failure, asserted - severity critical');
    has('with its entity instance', psu === null ? '' : petText(psu), 'on power supply 2');
    eq('discrete data carries no raw reading', (psu === null ? '' : petText(psu)).includes('raw reading'), false);
    eq('critical is syslog crit (2)', petSyslogSeverity(psu), 2);
    const worst = decodePet(v1(specific(0x01, 0x01, 0x09), petBuf({ severity: 0x18 })), NOW);
    eq('several severity bits: the worst wins', petSyslogSeverity(worst), 2);
    eq('non-recoverable is syslog alert (1)', petSyslogSeverity(decodePet(v1(specific(0x01, 0x01, 0x0b), petBuf({ severity: 0x20 })), NOW)), 1);
    eq('non-critical is warning (4)', petSyslogSeverity(decodePet(v1(specific(0x01, 0x01, 0x07), petBuf({ severity: 0x08 })), NOW)), 4);
    eq('unspecified severity stays null', petSyslogSeverity(decodePet(v1(specific(0x01, 0x01, 0x07), petBuf({ severity: 0 })), NOW)), null);
    eq('not a PET: no severity at all', petSyslogSeverity(null), null);
    const intr = decodePet(v1(specific(0x05, 0x6f, 0x00), petBuf({ severity: 0x10, sensor: 0x51, entity: 0x17 })), NOW);
    has('a chassis intrusion', intr === null ? '' : petText(intr), 'IPMI Physical security: general chassis intrusion');
    const oem = decodePet(v1(specific(0xc3, 0x72, 0x04), petBuf({ data: [0x04, 0xff, 0xff, 0, 0, 0, 0, 0] })), NOW);
    has('an OEM sensor type and event type are shown as codes, not guessed',
        oem === null ? '' : petText(oem), 'IPMI OEM sensor type 0xc3: OEM event type 0x72 offset 4');
    const redundancy = decodePet(v1(specific(0x08, 0x0b, 0x01), petBuf({ data: [0x01, 0xff, 0xff, 0, 0, 0, 0, 0] })), NOW);
    has('a generic event type uses the generic table', redundancy === null ? '' : petText(redundancy), 'redundancy lost');
}

console.log('\nthe timestamp, as the spec says and as one BMC writes it:');
{
    const unixBmc = decodePet(v1(specific(0x07, 0x6f, 0x0a), petBuf({ ts: NOW / 1000 + 3600, maker: 0 })), NOW);
    eq('a spec reading in 2054 is read again as Unix time', unixBmc?.time?.basis, 'unix');
    has('and the text says so', unixBmc === null ? '' : petText(unixBmc),
        'logged 2026-09-28 03:07:15 by the BMC clock (read as Unix time)');
    eq('maker 0 is left out', (unixBmc === null ? '' : petText(unixBmc)).endsWith('seq 102'), true);
    const zoned = decodePet(v1(specific(0x01, 0x01, 0x09), petBuf({ utc: 0xfed4 })), NOW);   // -300 min
    has('a stated UTC offset is shown', zoned === null ? '' : petText(zoned), '16:21:17 UTC-05:00 by the BMC clock');
    const none = decodePet(v1(specific(0x01, 0x01, 0x09), petBuf({ ts: 0 })), NOW);
    eq('timestamp 0 is unspecified: no time', none?.time, null);
    const recent = decodePet(v1(specific(0x01, 0x01, 0x09), petBuf({ ts: NOW / 1000 - PET_EPOCH_S - 60 })), NOW);
    eq('a spec reading a minute ago stays the spec reading', recent?.time, { at: '2026-09-28 02:06:15', basis: 'pet', utcOffsetMin: null });
}

console.log('\nmakers, and what is not a PET:');
{
    const dell = decodePet(v1(specific(0x01, 0x01, 0x09), petBuf({ maker: 674 })), NOW);
    eq('a big-endian maker is read as the spec says', dell?.maker, { id: 674, name: 'Dell' });
    const other = decodePet(v1(specific(0x01, 0x01, 0x09), petBuf({ maker: 7244 })), NOW);
    has('an unlisted maker is its number', other === null ? '' : petText(other), 'maker 7244');
    eq('a PET varbind shorter than 47 bytes (46 here) is not decoded',
        decodePet(v1(specific(0x01, 0x01, 0x09), petBuf().subarray(0, 46)), NOW), null);
    const plain = { enterprise: '1.3.6.1.4.1.318', generic: 6, specific: 5, varbinds: [{ oid: '1.3.6.1.4.1.318.2.3.1.0', value: Buffer.from('on battery') }] };
    eq('another enterprise\'s trap is not a PET', decodePet(plain, NOW), null);
    eq('and renders exactly as before', renderTrap(plain, NOW).startsWith('enterpriseSpecific trap=1.3.6.1.4.1.318.0.5 v1'), true);
    eq('a string value where the PET bytes belong is not decoded',
        decodePet({ varbinds: [{ oid: DATA_OID, value: 'x'.repeat(60) }] }, NOW), null);
}

console.log('\nwithout the v1 header (v2c, or a relay that dropped it):');
{
    const v2 = decodePet({ varbinds: [
        { oid: '1.3.6.1.6.3.1.1.4.1.0', value: `${PET_ENTERPRISE}.0.${specific(0x04, 0x01, 0x02)}` },
        { oid: DATA_OID, value: petBuf() },
    ] }, NOW);
    eq('a v2c PET takes its specific number from snmpTrapOID', v2 && [v2.sensorType, v2.eventType, v2.offset], [4, 1, 2]);
    const bare = decodePet({ varbinds: [{ oid: DATA_OID, value: petBuf() }] }, NOW);
    eq('with no header at all the sensor type is unknown', bare?.sensorType, null);
    has('but event data 1 still says threshold, and which one', bare === null ? '' : petText(bare),
        'IPMI platform event: Lower Critical going low - severity information');
    eq('and direction is not claimed', (bare === null ? '' : petText(bare)).includes('asserted'), false);
}

console.log('\nthe BMC\'s own words (a Supermicro power cycle, 2026-09-30; system GUID zeroed):');
{
    const TEXT_OID = `${PET_ENTERPRISE}.4`;
    // OEM sensor type 0xc8, sensor-specific, offset 0, on entity 0x18.
    const oem = {
        enterprise: PET_ENTERPRISE, generic: 6, specific: 0xc86f00, agentAddr: '192.0.2.31',
        varbinds: [
            { oid: DATA_OID, value: petBuf({ severity: 0x08, sensor: 0xff, entity: 0x18 }) },
            { oid: TEXT_OID, value: '[PWR-0020] First AC Power on' },
        ],
    };
    const e = decodePet(oem, NOW);
    eq('the text varbind is read', e?.text, '[PWR-0020] First AC Power on');
    has('an OEM event leads with it', e === null ? '' : petText(e), 'IPMI: [PWR-0020] First AC Power on, asserted - severity non-critical');
    has('then the codes it stands for', e === null ? '' : petText(e), 'OEM sensor type 0xc8 offset 0');
    has('on a sub-chassis, which the table now names', e === null ? '' : petText(e), 'on sub-chassis');
    // A standard fan event keeps its decoded meaning first; the text adds the sensor's name.
    const fan = { ...v1(specific(0x04, 0x01, 0x02), petBuf()), varbinds: [
        { oid: DATA_OID, value: petBuf() },
        { oid: TEXT_OID, value: Buffer.from('[IPMI-2002] CPU_FAN1, Lower Critical - going low') },
    ] };
    const f = decodePet(fan, NOW);
    has('a standard event keeps its meaning first', f === null ? '' : petText(f), 'IPMI Fan: Lower Critical going low, asserted');
    has('and quotes the BMC, sent as bytes, for the name', f === null ? '' : petText(f), '"[IPMI-2002] CPU_FAN1, Lower Critical - going low"');
    const none = decodePet(v1(specific(0x04, 0x01, 0x02), petBuf()), NOW);
    eq('no text varbind, no text', none?.text, null);
    const junk = decodePet({ ...v1(specific(0x04, 0x01, 0x02), petBuf()), varbinds: [
        { oid: DATA_OID, value: petBuf() }, { oid: TEXT_OID, value: Buffer.from([0x00, 0x01, 0xff]) },
    ] }, NOW);
    eq('binary in the text slot is not text', junk?.text, null);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
