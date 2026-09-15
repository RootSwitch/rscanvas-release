// The default-tracked decision for interfaces (src/collector/oids.ts).
//
//   node tools/test-iftracking.ts
//
// Four tests decide it - ifType, the name list (against ifName AND ifDescr),
// the NDIS filter-clone list, and ifConnectorPresent - and the ones that
// matter most here are the NEGATIVES: the cases that must NOT untick. A
// discovery filter is easy to make aggressive and hard to make safe, and
// this ships without a fleet-wide rediscovery plan only because absence of
// the connector object leaves behaviour exactly as it was.
//
// The DC-2 block is real data, pasted from the operator's stock-Microsoft
// SNMP service on 2026-08-27 - the walkthrough that showed the name
// patterns never firing (stock ifName is ethernet_NNNNN; the truth lives in
// ifDescr) and eighteen NDIS filter clones tracked.

import { defaultTracked, IF_NOISE } from '../src/collector/oids.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    got === want ? (pass++, console.log(`  ok   ${l}`))
        : (fail++, console.log(`  FAIL ${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
};

console.log('the ifType gate:');
eq('ethernetCsmacd(6) is tracked', defaultTracked(6, 'Gi0/1', null, null), true);
eq('iso88023Csmacd(7) is tracked', defaultTracked(7, 'eth0', null, null), true);
eq('ieee8023adLag(161) is tracked', defaultTracked(161, 'bond0', null, null), true);
eq('other(1) is not - a Cisco Nu0 never reaches the name list', defaultTracked(1, 'Nu0', null, null), false);
eq('tunnel(131) is not - and Tu0 never reaches it either', defaultTracked(131, 'Tu0', null, null), false);
eq('ieee80211(71) is not - Wi-Fi is opt-in, never pre-ticked', defaultTracked(71, 'Wi-Fi', null, null), false);
eq('an agent that omits ifType tracks nothing', defaultTracked(null, 'eth0', null, null), false);

console.log('\nthe name list, Linux and Proxmox (the original list):');
for (const n of ['veth1234', 'docker0', 'br-0123456789ab', 'virbr0', 'tap100i0', 'fwbr100i0', 'gre0', 'sit0']) {
    eq(`${n} is not tracked`, defaultTracked(6, n, null, null), false);
}

console.log('\nthe name list, Windows names in ifName (rsnmpagent shape):');
for (const n of ['WAN Miniport (IP)', 'WAN Miniport (IPv6)', 'WAN Miniport (PPPOE)',
    'RAS Async Adapter', 'isatap.{9E3C1A44-0000-0000-0000-000000000000}',
    'Teredo Tunneling Pseudo-Interface', 'Local Area Connection* 2', 'Local Area Connection* 11']) {
    eq(`${n} is not tracked`, defaultTracked(6, n, null, null), false);
}

console.log('\nAND THE ONES THAT MUST STAY TRACKED - genuine adapters:');
eq('"Local Area Connection" with NO asterisk is a real adapter', defaultTracked(6, 'Local Area Connection', null, null), true);
eq('the pattern needs the asterisk AND a digit', IF_NOISE.test('Local Area Connection'), false);
eq('"Ethernet" is untouched', defaultTracked(6, 'Ethernet', null, null), true);
eq('"Ethernet 2" is untouched', defaultTracked(6, 'Ethernet 2', null, null), true);

console.log('\nBluetooth PAN - real hardware, wrong default:');
eq('Bluetooth Network Connection is not tracked', defaultTracked(6, 'Bluetooth Network Connection', null, null), false);
eq('bnep0 is not tracked', defaultTracked(6, 'bnep0', null, null), false);
eq('bnep1 too, without an escape', defaultTracked(6, 'bnep1', null, null), false);

console.log('\nifConnectorPresent - and the safety property is the point:');
eq('ABSENT (null) leaves behaviour exactly as before', defaultTracked(6, 'Ethernet 2', null, null), true);
eq('true(1) tracks', defaultTracked(6, 'Ethernet 2', null, 1), true);
eq('EXPLICIT false(2) unticks', defaultTracked(6, 'Ethernet 2', null, 2), false);
eq('a LAG has no connector of its own and is exempt', defaultTracked(161, 'bond0', null, 2), true);
eq('a false(2) LAG stays tracked even though it answered false', defaultTracked(161, 'Port-Channel1', null, 2), true);
eq('an unexpected value (3) is not false(2), so it leaves things alone', defaultTracked(6, 'Ethernet 2', null, 3), true);

console.log('\nthe tests compose, and the name list wins over a true(1):');
eq('a Bluetooth adapter reporting a real connector is still not tracked',
    defaultTracked(6, 'Bluetooth Network Connection', null, 1), false);
eq('a WAN Miniport reporting false(2) is doubly refused',
    defaultTracked(6, 'WAN Miniport (IP)', null, 2), false);

console.log('\nDC-2, stock Microsoft SNMP, real strings (2026-08-27):');
console.log('- the truth is in ifDescr; ifName is ethernet_NNNNN and says nothing');
eq('LAC* 9 by DESCR unticks even though ifName is opaque',
    defaultTracked(6, 'ethernet_32774', 'Local Area Connection* 9', null), false);
eq('LAC* 8 by descr unticks', defaultTracked(6, 'ethernet_32773', 'Local Area Connection* 8', null), false);
eq('LAC* 10 by descr unticks', defaultTracked(6, 'ethernet_32775', 'Local Area Connection* 10', null), false);
console.log('- the NDIS filter clones, the ghosts the handoff warned about');
for (const d of ['Ethernet 3-Microsoft NDIS Capture-0000',
    'Ethernet 3-WFP Native MAC Layer LightWeight Filter-0000',
    'Ethernet 3-Npcap Packet Driver (NPCAP)-0000',
    'Ethernet 3-QoS Packet Scheduler-0000',
    'Local Area Connection* 9-Npcap Packet Driver (NPCAP)-0000']) {
    eq(`clone unticks: ${d.slice(0, 52)}`, defaultTracked(6, 'ethernet_0', d, null), false);
}
eq('the 64-char TRUNCATED clone still unticks (component prefix survives)',
    defaultTracked(6, 'ethernet_15', 'Local Area Connection* 10-WFP 802.3 MAC Layer LightWeight Filte', null), false);
console.log('- and the real interfaces of the same box stay tracked');
for (const [n, d] of [['ethernet_32769', 'LAN'], ['ethernet_32777', 'Ethernet'],
    ['ethernet_32770', 'Management'], ['ethernet_32771', 'example.lan'],
    ['ethernet_32779', 'Ethernet 3'], ['ethernet_32776', 'Mgmt']] as Array<[string, string]>) {
    eq(`${d} stays tracked`, defaultTracked(6, n, d, null), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
