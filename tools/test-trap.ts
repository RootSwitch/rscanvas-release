// Traps as message rows (src/syslog/trap.ts), offline. The PDUs are the
// shapes the 2026-09-28 real-agent drill captured: net-snmp's snmptrap on
// rs-test-1 sending v1 and v2c traps to an installed RSCanvas.
//
//   node tools/test-trap.ts

import { renderTrap, deviceForAddress, v1TrapOid, renderValue } from '../src/syslog/trap.ts';
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

console.log('\nrenderValue and the v2c timeout hint:');
{
    eq('a printable buffer is text', renderValue(Buffer.from('eth0')), 'eth0');
    eq('a binary buffer is hex', renderValue(Buffer.from([0, 1, 255])), '0x0001ff');
    const h = explainCommunityTimeout();
    eq('the v2c timeout hint names the community and the ping test',
        h.includes('community') && h.includes('ping'), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
