// Device identity (src/collector/identity.ts) and the change alert
// (src/alerts/changes.ts), offline.
//
//   node tools/test-identity.ts
//
// The OS words over every sysDescr production's agents sent on 2026-10-19,
// the operator's shelf walks (snmpwalks: APC, Cisco IOS-XE under CML, Dell,
// FS, Netgear), and SNMPCanvas's own identity checks - each rule traced to
// a real string, and the strings no rule knows left as the agent wrote them.
// Then the model helpers, and the change alert at its edges.

import {
    summarizeOS, osText, familyOf, firstLine, routerosBoardFromDescr, unifiModelFromDescr, apcModel,
    pickEntityModel, firmwareLags, wantsEntityModel, cleanModel, wantsIdentityRead,
} from '../src/collector/identity.ts';
import { deviceChangeConditions, deviceChangeKey, DEVICE_CHANGE_KIND } from '../src/alerts/changes.ts';
import {
    buildOverrideIndex, resolveRuleInfo, evaluate, BOOL_RULE_KINDS, DEVICE_CHANGE_DEFAULT, CHANGE_HOLD_S,
    type Override, type RulesConfig, type ScanDevice,
} from '../src/alerts/rules.ts';
import { DEFAULT_RULES } from '../src/alerts/scan.ts';
import { varsFor } from '../src/alerts/templates.ts';

process.exitCode = 1;
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

const E = '1.3.6.1.4.1.';
console.log('device identity');

// --- production's agents, 2026-10-19 (sysObjectID not yet stored there: the words must not need it) ----
console.log('\nproduction\'s own descriptions, without a sysObjectID:');
const prod: Array<[string, string]> = [
    ['Hardware: AMD64 Family 26 Model 68 Stepping 0 AT/AT COMPATIBLE - Software: Windows Version 6.3 (Build 20348 Multiprocessor Free)',
        'Windows Server 2022 (build 20348)'],
    ['Hardware: Intel64 Family 15 Model 107 Stepping 1 AT/AT COMPATIBLE - Software: Windows Version 6.3 (Build 20348 Multiprocessor Free)',
        'Windows Server 2022 (build 20348)'],
    ['Linux pve-a 7.0.14-17-pve #1 SMP PREEMPT_DYNAMIC PMX 7.0.14-17 (2026-09-10T10:16Z) x86_64', 'Linux 7.0.14-17-pve (Proxmox)'],
    ['Linux rocky-a 6.12.0-211.66.1.el10_2.x86_64 #1 SMP PREEMPT_DYNAMIC Thu Oct 15 11:25:08 UTC 2026 x86_64',
        'Linux 6.12.0-211.66.1.el10_2.x86_64'],
    ['Linux ml-box 6.8.0-142-generic #142-Ubuntu SMP PREEMPT_DYNAMIC Wed Sep  2 14:24:27 UTC 2026 x86_64', 'Linux 6.8.0-142-generic'],
    ['Linux bench-a 7.0.0-38-generic #38-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 09:10:14 UTC 2026 x86_64', 'Linux 7.0.0-38-generic'],
    ['Linux raspberrypi 6.18.34+rpt-rpi-v8 #1 SMP PREEMPT Debian 1:6.18.34-1+rpt1 (2026-06-09) aarch64', 'Linux 6.18.34+rpt-rpi-v8'],
    ['RouterOS CRS326-24G-2S+ 7.24.5 (stable)', 'RouterOS 7.24.5 (stable)'],
    ['RouterOS CRS354-48G-4S+2Q+', 'RouterOS'],
    ['RouterOS CRS312-4C+8XG', 'RouterOS'],
    ['TrueNAS-13.0-U6.8 (0a1b2c3d4e). Hardware: amd64 AMD EPYC 4464P 12-Core Processor           running at 3700 MHz. Software: FreeBSD 13.1-RELEASE-p9 (revision 199506)',
        'TrueNAS 13.0-U6.8'],
    ['Windows 11 Home Build 26200.9711 x64; rsnmpagent 0.1', 'Windows 11 Home (build 26200.9711)'],
    ['Windows 11 Pro Build 26200.9711 x64; rsnmpagent 0.1', 'Windows 11 Pro (build 26200.9711)'],
    ['pfSense fw.example.lan 2.9.0-RELEASE FreeBSD 16.0-CURRENT amd64', 'pfSense 2.9.0 (FreeBSD 16.0-CURRENT)'],
];
for (const [d, want] of prod) eq(`${d.slice(0, 54)}... -> ${want}`, summarizeOS(null, d), want);
eq('UniFi without its family: no rule - the agent\'s own words stand', [summarizeOS(null, 'U6-Lite 6.6.77.15402'),
    osText(null, 'U6-Lite 6.6.77.15402')], [null, 'U6-Lite 6.6.77.15402']);

console.log('\nwith the family and the vendor\'s version, as the identity read supplies them:');
eq('RouterOS 7.20 has no version in its description: MIKROTIK-MIB\'s fills it in',
    summarizeOS(E + '14988.1', 'RouterOS CRS354-48G-4S+2Q+', '7.20.6'), 'RouterOS 7.20.6');
eq('RouterOS 7.24 carries its own, read every poll, and it wins over a stale MIB read',
    summarizeOS(E + '14988.1', 'RouterOS CRS326-24G-2S+ 7.24.5 (stable)', '7.20.4'), 'RouterOS 7.24.5 (stable)');
eq('UniFi with its family', summarizeOS(E + '41112', 'U6-Mesh 6.6.65.15248'), 'UniFi 6.6.65.15248');
eq('Windows by family alone', summarizeOS(E + '311.1.1.3.1.3', 'Hardware: x86 - Software: Windows Version 6.3 (Build 22631 Multiprocessor Free)'),
    'Windows 11 23H2 (build 22631)');

console.log('\nWindows builds named only where the build says one thing:');
for (const [b, want] of [[20348, 'Windows Server 2022 (build 20348)'], [26100, 'Windows (build 26100)'], [17763, 'Windows (build 17763)'],
    [14393, 'Windows (build 14393)'], [19045, 'Windows 10 22H2 (build 19045)']] as Array<[number, string]>) {
    eq(`build ${b}`, summarizeOS(null, `Hardware: x - Software: Windows Version 6.3 (Build ${b} Multiprocessor Free)`), want);
}

// --- the operator's shelf walks ------------------------------------------------------
console.log('\nthe shelf walks:');
eq('APC AP9641 (UPS card)', summarizeOS(E + '318.1.3.27',
    'APC Web/SNMP Management Card (MB:v4.2.9 PF:v2.5.3.2 PN:apc_hw21_aos_2.5.3.2.bin AF1:v2.5.3.3 AN1:apc_hw21_su_2.5.3.3.bin MN:AP9641 HR:5 SN: SanitizedSerial MD:01/11/2026) (Embedded PowerNet SNMP Agent SW v2.2 compatible)'),
'APC AOS v2.5.3.2');
eq('APC AP7811B (rack PDU), no family needed', summarizeOS(null,
    'APC Web/SNMP Management Card (MB:v4.2.9 PF:v3.0.0.12 PN:apc_hw21_aos_3.0.0.12.bin AF1:v3.0.0.5 AN1:apc_hw21_rpdu2g_3.0.0.5.bin MN:AP7811B HR:B3 SN: SanitizedSerial MD:07/18/2024) '),
'APC AOS v3.0.0.12');
eq('Cisco CSR1000v under CML: IOS-XE', summarizeOS(E + '9.1.1537',
    'Cisco IOS Software [Amsterdam], Virtual XE Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.3.8a, RELEASE SOFTWARE (fc3)'),
'IOS-XE 17.3.8a');
eq('...and its multi-line form, as a real agent sends it', summarizeOS(E + '9.1.1537',
    'Cisco IOS Software [Amsterdam], Virtual XE Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.3.8a, RELEASE SOFTWARE (fc3)\r\nTechnical Support: http://www.cisco.com/techsupport\r\nCopyright (c) 1986-2023 by Cisco Systems, Inc.'),
'IOS-XE 17.3.8a');
eq('classic IOS, the form Cisco documents', summarizeOS(null,
    'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE11, RELEASE SOFTWARE (fc3)'), 'IOS 15.0(2)SE11');
eq('NX-OS', summarizeOS(null, 'Cisco NX-OS(tm) n9000, Software (n9000-dk9), Version 9.3(8), RELEASE SOFTWARE'), 'NX-OS 9.3(8)');
eq('ASA', summarizeOS(null, 'Cisco Adaptive Security Appliance Version 9.16(3)'), 'ASA 9.16(3)');
for (const d of ['16-port 10/100/1000 Gigabit Switch', 'Dell Networking X1008 1Gb Switch', 'FS Campus Switch (S5860-20SQ) By FS.COM Inc',
    'GS108Tv2', 'SNMPCanvas fleet mock - Linux lab-node-16100 6.8.0 x86_64']) {
    eq(`no rule for "${d}": its own words`, [summarizeOS(null, d), osText(null, d)], [null, d]);
}

// --- parity with SNMPCanvas's own checks -------------------------------------------------
console.log('\nSNMPCanvas\'s own cases, where the rule carried over:');
eq('Proxmox host', summarizeOS(E + '8072.3.2.10', 'Linux pve-1 6.17.2-1-pve #1 SMP PREEMPT_DYNAMIC PMX 6.17.2-1 (2025-10-21T11:55Z) x86_64'),
    'Linux 6.17.2-1-pve (Proxmox)');
eq('AMI BMC (hostname "(none)")', summarizeOS(E + '8072.3.2.10', 'Linux (none) 3.18.0 #1 Thu Mar 7 09:57:34 CST 2024 armv6l'), 'Linux 3.18.0');
eq('UniFi', summarizeOS(E + '41112', 'U6-LR 6.6.65.15248'), 'UniFi 6.6.65.15248');
eq('RouterOS with nothing to go on', summarizeOS(E + '14988.1', 'RouterOS CRS312-4C+8XG'), 'RouterOS');
eq('an unknown appliance: the parent clipped at 48, here the first line up to 120',
    osText(E + '99999.1', 'Some Appliance OS 4.2 build 7 with a very long tail that goes on and on and on'),
    'Some Appliance OS 4.2 build 7 with a very long tail that goes on and on and on');

console.log('\nthe smaller rules:');
eq('families', ['1.3.6.1.4.1.14988.1', '.1.3.6.1.4.1.9.1.1537', '1.3.6.1.4.1.8072.3.2.10', '1.3.6.1.4.1.674.10895.3027', null]
    .map((o) => familyOf(o)), ['routeros', 'cisco', 'netsnmp', null, null]);
eq('empty is nothing, not an empty string', [summarizeOS(null, ''), osText(null, '   '), firstLine(null)], [null, null, null]);
eq('a first line is one line, collapsed and clipped', [firstLine('a  b\r\nc'), firstLine('x'.repeat(200), 10)],
    ['a b', `${'x'.repeat(9)}…`]);
eq('RouterOS board from its description, not a version', [routerosBoardFromDescr('RouterOS CRS354-48G-4S+2Q+'),
    routerosBoardFromDescr('RouterOS 7.24.5'), routerosBoardFromDescr('Linux x')], ['CRS354-48G-4S+2Q+', null, null]);
eq('UniFi model from its description', [unifiModelFromDescr('U6-LR 6.6.77.15402'), unifiModelFromDescr('U6-Mesh 6.6.65.15248'),
    unifiModelFromDescr('Linux x 1.2')], ['U6-LR', 'U6-Mesh', null]);
eq('APC model, with its SKU when it says more', [apcModel('Smart-UPS SRT 2200', 'SRT2200XLA', null), apcModel('SMX3000', 'SMX3000', null),
    apcModel(null, null, 'AP7811B'), apcModel('', '', '')], ['Smart-UPS SRT 2200 (SRT2200XLA)', 'SMX3000', 'AP7811B', null]);
eq('ENTITY-MIB: model names first, then names, the first non-empty', [
    pickEntityModel(new Map([['1', ''], ['2', 'C9300-48P']]), new Map([['1', 'Switch 1']])),
    pickEntityModel(new Map(), new Map([['1', 'Dell Networking X1008']])),
    pickEntityModel(new Map([['1', '  ']]), null)], ['C9300-48P', 'Dell Networking X1008', null]);
eq('a model is one line of at most 80', cleanModel(`${'M'.repeat(100)}\nsecond`)?.length, 80);
eq('boot firmware behind its RouterOS', [firmwareLags('7.7', '7.20.1'), firmwareLags('7.24.5', '7.24.5'), firmwareLags(null, '7.20.1')],
    [true, false, false]);
eq('only gear with no rule (and Cisco) is walked for ENTITY-MIB',
    [wantsEntityModel(null), wantsEntityModel('cisco'), wantsEntityModel('netsnmp'), wantsEntityModel('routeros')], [true, true, false, false]);

console.log('\nwhen the poll reads the identity:');
const want = (o: Partial<Parameters<typeof wantsIdentityRead>[0]>) => wantsIdentityRead({
    inventory: false, neverRead: false, restarted: false, storedOs: 'RouterOS 7.20.6', osNow: 'RouterOS 7.20.6', ...o });
eq('an ordinary poll: no', want({}), false);
eq('the inventory, a device never read, a restart: yes', [want({ inventory: true }), want({ neverRead: true }), want({ restarted: true })],
    [true, true, true]);
eq('a description that moved, with no restart the uptime could show (the lab drill): yes',
    want({ osNow: 'RouterOS 7.24.5 (stable)' }), true);
eq('no stored words yet, or none now: no (the never-read rule covers the first)', [want({ storedOs: null, osNow: 'X' }),
    want({ osNow: null })], [false, false]);

// --- the change alert -----------------------------------------------------------------
console.log('\nthe change alert (alerts/changes.ts):');
eq('ships off, warn, a yes/no rule, held half an hour', [DEVICE_CHANGE_DEFAULT, DEFAULT_RULES.deviceChange, BOOL_RULE_KINDS.has(DEVICE_CHANGE_KIND),
    CHANGE_HOLD_S], [{ enabled: false, severity: 'warn' }, { enabled: false, severity: 'warn' }, true, 1800]);
const dev = (o: Partial<ScanDevice> = {}): ScanDevice => ({
    name: 'R1', host: '10.0.0.1', status: 'up', changeAgeS: 60, changeText: 'OS RouterOS 7.20.6 -> RouterOS 7.24.5 (stable)',
    changePlanned: false, ...o,
});
const on: Override = { scope: 'kind', kind: DEVICE_CHANGE_KIND, enabled: true };
const run = (d: ScanDevice[], overrides: Override[] = [on], extra: Partial<RulesConfig> = {}) =>
    deviceChangeConditions({ devices: d }, { ...DEFAULT_RULES, ...extra, overrides });
eq('off by default: no condition at all', run([dev()], []).length, 0);
const c = run([dev()])[0];
eq('on for every device: a recent change raises its warn, the label says what changed',
    c && [c.key, c.severity, c.label, c.kind], [deviceChangeKey('R1'), 'warn',
        'R1 (10.0.0.1) changed: OS RouterOS 7.20.6 -> RouterOS 7.24.5 (stable)', 'device-change']);
eq('past the hold: severity null, so it clears - with the same words', (() => {
    const x = run([dev({ changeAgeS: CHANGE_HOLD_S })])[0];
    return x && [x.severity, x.label.endsWith('(stable)')];
})(), [null, true]);
eq('inside a maintenance window: recorded, raises nothing', run([dev({ changePlanned: true })])[0]?.severity, null);
eq('no change on record: a condition, severity null', run([dev({ changeAgeS: null, changeText: null })])[0]?.severity, null);
eq('transient or muted: nothing', [run([dev({ transient: true })]).length, run([dev({ muted: true })]).length], [0, 0]);
eq('one device on, the rest off', run([dev(), dev({ name: 'R2' })], [{ scope: 'host-kind', host: 'R2', kind: DEVICE_CHANGE_KIND, enabled: true }])
    .map((x) => x.host), ['R2']);
eq('on for every device, one turned off', run([dev(), dev({ name: 'R2' })], [on, { scope: 'host-kind', host: 'R1', kind: DEVICE_CHANGE_KIND, enabled: false }])
    .map((x) => x.host), ['R2']);
eq('the config can turn it on, at crit', run([dev()], [], { deviceChange: { enabled: true, severity: 'crit' } })[0]?.severity, 'crit');
eq('resolveRuleInfo knows it (off: no rule)', resolveRuleInfo(buildOverrideIndex([]), DEFAULT_RULES, DEVICE_CHANGE_KIND, null, 'R1'),
    { source: 'none', muted: false, levels: null });
eq('evaluate() is untouched by it', evaluate({ devices: [dev()] }, { ...DEFAULT_RULES, overrides: [on] })
    .some((x) => x.kind === DEVICE_CHANGE_KIND), false);
eq('the detail a notification carries', varsFor({ kind: DEVICE_CHANGE_KIND, severity: 'warn', value: null, unit: '' } as never, 'raise').detail,
    'what the device runs or is changed - an upgrade, a downgrade, or a part swapped');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
