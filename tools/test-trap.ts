// Traps as message rows (src/syslog/trap.ts), offline. The PDUs are the
// shapes the 2026-09-28 real-agent drill captured: net-snmp's snmptrap on
// rs-test-1 sending v1 and v2c traps to an installed RSCanvas.
//
//   node tools/test-trap.ts

import dgram from 'node:dgram';
import {
    renderTrap, deviceForAddress, hostForMessage, v1TrapOid, renderValue,
    keptVarbinds, TRAP_VALUE_CHARS, TRAP_VARBINDS_MAX,
} from '../src/syslog/trap.ts';
import { snmpVersion, guardTrapReceiver, logSafe } from '../src/syslog/trap-guard.ts';
import { parse } from '../src/syslog/parse.ts';
import { explainCommunityTimeout } from '../src/credentials/v3.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const has = (label: string, text: string, part: string): void => eq(label, text.includes(part), true);

console.log('v2c - the standard traps are named, and the varbinds follow unchanged:');
{
    const linkDown = {
        varbinds: [
            { oid: '1.3.6.1.2.1.1.3.0', value: 1024174 },
            { oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.6.3.1.1.5.3' },
            { oid: '1.3.6.1.2.1.2.2.1.1.2', value: 2 },
        ],
    };
    const t = renderTrap(linkDown);
    eq('it reads as linkDown, with its trap OID written out',
        t.startsWith('linkDown trap=1.3.6.1.6.3.1.1.5.3 '), true);
    has('the old text is still there, so a rule written against it still matches', t,
        '1.3.6.1.2.1.1.3.0=1024174 1.3.6.1.6.3.1.1.4.1.0=1.3.6.1.6.3.1.1.5.3 1.3.6.1.2.1.2.2.1.1.2=2');
    const vendor = renderTrap({ varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.4.1.318.0.5' }] });
    eq('an unnamed vendor trap still leads with its OID', vendor.startsWith('trap trap=1.3.6.1.4.1.318.0.5'), true);
    eq('no snmpTrapOID: the varbinds alone, as before', renderTrap({ varbinds: [{ oid: '1.2.3', value: 4 }] }), '1.2.3=4');
    eq('nothing at all says so', renderTrap({ varbinds: [] }), 'trap with no varbinds');
}

console.log('\nv1 - the identity in the PDU header is kept, and maps to the v2 trap OID:');
{
    // NET-SNMP-EXAMPLES enterprise trap 6/17 - stored as "...2.1=123" alone before.
    const ups = {
        enterprise: '1.3.6.1.4.1.8072.2.3', agentAddr: '198.18.50.51', generic: 6, specific: 17,
        varbinds: [{ oid: '1.3.6.1.4.1.8072.2.3.2.1', value: 123 }],
    };
    const t = renderTrap(ups);
    eq('enterprise-specific, with enterprise, generic, specific and agent',
        t, 'enterpriseSpecific trap=1.3.6.1.4.1.8072.2.3.0.17 v1 enterprise=1.3.6.1.4.1.8072.2.3 '
        + 'generic=6 specific=17 agent=198.18.50.51 1.3.6.1.4.1.8072.2.3.2.1=123');
    const other = renderTrap({ ...ups, specific: 18 });
    eq('two different traps from one enterprise now read differently', t === other, false);
    const v1LinkDown = renderTrap({ enterprise: '1.3.6.1.4.1.9', agentAddr: '10.0.0.1', generic: 2, specific: 0, varbinds: [] });
    eq('a v1 linkDown is named, and carries the SAME trap OID as a v2c one (RFC 3584)',
        v1LinkDown.startsWith('linkDown trap=1.3.6.1.6.3.1.1.5.3 '), true);
    eq('the mapping, generic', v1TrapOid('1.3.6.1.4.1.9', 0, 0), '1.3.6.1.6.3.1.1.5.1');
    eq('the mapping, enterprise-specific', v1TrapOid('1.3.6.1.4.1.318', 6, 5), '1.3.6.1.4.1.318.0.5');
    eq('an out-of-range generic is named by number, not lost',
        renderTrap({ enterprise: '1.2.3', generic: 9, specific: 1, varbinds: [] }).startsWith('generic-9 '), true);
}

console.log('\ndeviceForAddress - a trap belongs to a device only when the address is unambiguous:');
{
    const map = new Map<string, string[]>([
        ['198.18.50.51', ['rs-test-1']],
        ['198.18.50.1', ['lab-node-16100', 'lab-node-16101']],
    ]);
    eq('the one device at that address', deviceForAddress('198.18.50.51', map), 'rs-test-1');
    eq('an IPv4-mapped IPv6 source is the same address', deviceForAddress('::ffff:198.18.50.51', map), 'rs-test-1');
    eq('several devices on one address: none, rather than a guess', deviceForAddress('198.18.50.1', map), null);
    eq('an unknown address: none', deviceForAddress('192.0.2.9', map), null);
    eq('no address: none', deviceForAddress(null, map), null);
}

console.log('\nhostForMessage - a syslog line with no hostname belongs to the device at its address:');
{
    const map = new Map<string, string[]>([
        ['192.0.2.250', ['CRS317-Core']],
        ['192.0.2.3', ['TrueNASMain']],
        ['198.18.50.1', ['lab-node-16100', 'lab-node-16101']],
    ]);
    // The shape production stored on 2026-09-28 from a MikroTik whose remote
    // logging action sends no syslog header: no PRI, no timestamp, no host.
    const bare = parse('system,info,account user admin logged out from 192.0.2.10 via winbox', '192.0.2.250');
    eq('a bare RouterOS line parses with no host', bare.host, null);
    eq('and no severity (there is no PRI to read one from)', bare.severity, null);
    eq('so it takes the device at its address', hostForMessage(bare.host, bare.sourceIp, map), 'CRS317-Core');
    const named = parse('<78>Sep 28 20:05:00 TrueNASMain cron[42]: job ran', '192.0.2.3');
    eq('a line that names its host keeps it', hostForMessage(named.host, named.sourceIp, map), 'TrueNASMain');
    eq('even when the device at that address is called something else (a relay names each origin)',
        hostForMessage('edge-7', '192.0.2.250', map), 'edge-7');
    eq('an empty name is no name', hostForMessage('', '192.0.2.250', map), 'CRS317-Core');
    eq('no name from an address no device has: none, as before', hostForMessage(null, '192.0.2.99', map), null);
    eq('no name from an address several devices share: none, rather than a guess',
        hostForMessage(null, '198.18.50.1', map), null);
    const v5424 = parse('<14>1 2026-09-28T20:05:00Z - app 1 - - text', '192.0.2.250');
    eq('an RFC 5424 nil hostname falls back the same way', hostForMessage(v5424.host, v5424.sourceIp, map), 'CRS317-Core');
}

console.log('\nrenderValue and the v2c timeout hint:');
{
    eq('a printable buffer is text', renderValue(Buffer.from('eth0')), 'eth0');
    eq('a binary buffer is hex', renderValue(Buffer.from([0, 1, 255])), '0x0001ff');
    const h = explainCommunityTimeout();
    eq('the v2c timeout hint names the community and the ping test',
        h.includes('community') && h.includes('ping'), true);
}

console.log('\nthe size of a trap is bounded like a syslog line (review F15):');
{
    const long = renderValue(Buffer.from('x'.repeat(5000)));
    eq('a long value keeps its first characters and says how many it lost',
        long, `${'x'.repeat(TRAP_VALUE_CHARS)}...(+${5000 - TRAP_VALUE_CHARS} chars)`);
    const many = { varbinds: Array.from({ length: TRAP_VARBINDS_MAX + 8 }, (_, i) => ({ oid: `1.3.6.1.4.1.1.${i}`, value: i })) };
    const t = renderTrap(many);
    eq('only the first varbinds are listed', t.includes(`1.3.6.1.4.1.1.${TRAP_VARBINDS_MAX - 1}=`) && !t.includes(`1.3.6.1.4.1.1.${TRAP_VARBINDS_MAX}=`), true);
    has('and the line says how many it left out', t, '(+8 more varbinds)');
    eq('keptVarbinds agrees', keptVarbinds(many.varbinds).more, 8);
}

console.log('\nthe SNMP version is read from the first bytes:');
// The review's two Inform packets (REVIEW-2026-09-30 F1): v2c, community
// "anything", an InformRequest whose third varbind is a BIT STRING / an
// INTEGER of 2^32. Both decode, and both threw when net-snmp re-encoded them
// as the acknowledgement.
const INFORM_BITSTRING = Buffer.from('30500201010408616e797468696e67a6410201010201000201003036300d06082b0601020101030043'
    + '01003016060a2b06010603010104010006082b06010401010001300d06072b060104010101030200ff', 'hex');
const INFORM_INT2_32 = Buffer.from('30530201010408616e797468696e67a6440201010201000201003039300d06082b0601020101030043'
    + '01003016060a2b06010603010104010006082b06010401010001301006072b06010401010102050100000000', 'hex');
{
    eq('a v2c message is version 1', snmpVersion(INFORM_BITSTRING), 1);
    eq('a long-form length is stepped over', snmpVersion(Buffer.from('30820005020103', 'hex')), 3);
    eq('a version-3 header reads 3', snmpVersion(Buffer.from('3005020103', 'hex')), 3);
    eq('text is not SNMP', snmpVersion(Buffer.from('<14>hello there')), null);
    eq('a truncated header is not SNMP', snmpVersion(Buffer.from('300502', 'hex')), null);
    eq('an empty datagram is not SNMP', snmpVersion(Buffer.alloc(0)), null);
    const s = logSafe('u2\r\n2026-10-01T00:00:00Z [ingest] forged');
    eq('a CR LF in logged text cannot start a new line', s.includes('\n') || s.includes('\r'), false);
}

console.log('\none datagram cannot stop the receiver (review F1, F10) - loopback, the app\'s receiver options:');
{
    // Without the guard, either Inform below is an uncaught exception and this
    // process exits before the verdict - the test fails by not finishing.
    const snmp = await import('net-snmp');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const delivered: string[] = [];
    const drops: string[] = [];
    const receiver = snmp.createReceiver(
        { port, address: '127.0.0.1', disableAuthorization: true, includeAuthentication: true },
        (error, n) => {
            if (error) { drops.push(`error: ${error.message}`); return; }
            const pdu = (n as { pdu: { type: number; varbinds?: Array<{ oid: string }> } }).pdu;
            delivered.push(`${pdu.type}:${pdu.varbinds?.at(-1)?.oid ?? ''}`);
        },
    );
    eq('the receiver is guarded', guardTrapReceiver(receiver, (why) => drops.push(why)), 1);
    const sock = dgram.createSocket('udp4');
    const send = (b: Buffer): Promise<void> => new Promise((ok) => sock.send(b, port, '127.0.0.1', () => ok()));
    await new Promise((ok) => setTimeout(ok, 200));
    await send(INFORM_BITSTRING);
    await send(INFORM_INT2_32);
    // A v3 noAuthNoPriv trap under an invented user name, which net-snmp
    // delivered with authorization disabled, and a CR LF in the name.
    const v3 = (snmp as unknown as {
        createV3Session: (t: string, u: object, o: object) => { trap: (t: number, vb: unknown[], cb: (e: Error | null) => void) => void; close: () => void };
    }).createV3Session('127.0.0.1', { name: 'anyone\r\nforged', level: 1 }, { trapPort: port, version: snmp.Version3 });
    await new Promise<void>((ok) => v3.trap(2, [], () => ok()));
    // And an ordinary v2c trap, which must still arrive.
    const v2 = snmp.createSession('127.0.0.1', 'public', { trapPort: port, version: snmp.Version2c });
    await new Promise<void>((ok) => v2.trap('1.3.6.1.6.3.1.1.5.3', [], () => ok()));
    await new Promise((ok) => setTimeout(ok, 500));
    v3.close(); v2.close(); sock.close(); receiver.close();

    eq('both Informs are still recorded - only their acknowledgement failed',
        delivered.filter((d) => d.startsWith('166:')).length, 2);
    eq('and each failed acknowledgement is counted', drops.filter((d) => d === 'ack').length, 2);
    eq('the v3 trap is refused before the library parses it', drops.filter((d) => d === 'v3').length, 1);
    eq('so no error text carrying its user name is produced', drops.some((d) => d.includes('forged')), false);
    eq('an ordinary v2c trap still arrives', delivered.filter((d) => d.startsWith('167:')).length, 1);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
