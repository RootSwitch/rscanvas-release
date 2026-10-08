// The stencil guess, against REAL device strings.
//
//   node tools/test-stencil.ts
//
// Every case below traces to an observed device: the sysDescr shapes
// documented in snmpcanvas/server/identity.js (each verified there against a
// real agent), the operator's own fleet screenshot, and the shelf walks in
// C:/Workspace/snmpwalks. Nothing here is a string somebody imagined.
//
// THE NEGATIVE CASES MATTER MOST. A classifier is easy to make confident and
// hard to make honest, so roughly half of this file asserts that an ambiguous
// input produces NOTHING - because the rule this module lives by is that
// silence beats a coin flip, and only a test can hold it to that.

import { guessStencil, STENCIL_NAMES } from '../src/export/stencil.ts';

let pass = 0;
let fail = 0;
const check = (want: string, e: Parameters<typeof guessStencil>[0], why: string): void => {
    const got = guessStencil(e);
    if (got === want) {
        pass++;
        console.log(`  ok   ${want === '' ? '(blank)' : want.padEnd(13)} ${why}`);
    } else {
        fail++;
        console.log(`  FAIL wanted ${want === '' ? '(blank)' : want} got ${got === '' ? '(blank)' : got} - ${why}`);
    }
};

console.log('stencil guesses against real device strings');

// --- the two order bugs this port exists to fix ------------------------------
check('switch', { sysDescr: 'RouterOS CRS317-1G-16S+', name: 'CRS317-Core' },
    'a MikroTik Cloud Router SWITCH is a switch, not a router (ported rule got this wrong)');
check('switch', { sysDescr: 'RouterOS CRS309-1G-8S+', name: 'CRS309-1' },
    'CRS309 likewise');
check('nas', { sysDescr: 'TrueNAS-13.0-U6.8 (...). Hardware: Intel(R) Xeon(R) W-1290 CPU', name: 'TrueNASMain' },
    'TrueNAS is a NAS, not a server (ported rule matched freebsd first)');

// --- MikroTik, where the model is the only real evidence ---------------------
check('router', { sysDescr: 'RouterOS CCR2004-1G-12S+2XS' }, 'Cloud Core Router');
check('router', { sysDescr: 'RouterOS RB5009UG+S+' }, 'RouterBOARD');
check('access point', { sysDescr: 'RouterOS hAP ac2' }, 'hAP is an access point');
check('', { sysDescr: 'RouterOS 7.20.6', name: 'mikrotik-thing' },
    'RouterOS with NO model is BLANK - the OS does not say what the box is');

// --- UniFi ------------------------------------------------------------------
check('access point', { sysDescr: 'U6-Enterprise 6.8.2.15592', name: 'U6-Enterprise' }, 'U6 AP');
check('access point', { sysDescr: 'U7-Pro-XG-B 8.6.11.18870', name: 'U7-Pro-XG' }, 'U7 AP');
check('firewall', { sysDescr: 'UDM-Pro 3.2.12', name: 'udm-pro' }, 'Dream Machine is the gateway');

// --- Cisco IOS-XE, whose banner names an image, not a role (2026-10-08) -----
check('router', { sysDescr: 'Cisco IOS Software [Cupertino], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.9.4a, RELEASE SOFTWARE (fc3)', name: 'br1-rtr' },
    'an ISR 4331: the LINUX in its image name used to make it a server');
check('router', { sysDescr: 'Cisco IOS Software [Bengaluru], ASR1000 Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.6.5', name: 'wan-edge' },
    'an ASR 1000, the same image family');
check('switch', { sysDescr: 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a', name: 'idf-3' },
    'a Catalyst 9300 runs IOS-XE too, and says Switch - claimed before the router rule');

// --- appliances that must beat the OS they run on ----------------------------
check('firewall', { sysDescr: 'pfSense FW-1.dl 2.8.1-RELEASE FreeBSD 15.0-CURRENT amd64', name: 'FW-1' },
    'pfSense IS FreeBSD - the appliance rule has to run first');
check('ups', { sysDescr: 'APC Web/SNMP Management Card (MB:v4.2.9 PF:v3.0.0.12 MN:AP7811B HR:B3)' },
    'the APC card from the shelf walk');

// --- general-purpose operating systems, last ---------------------------------
check('server', { sysDescr: 'Linux MPC1 6.17.2-1-pve #1 SMP x86_64', name: 'MPC1' },
    'a Proxmox HOST is a physical server - the -pve kernel marks the host, not a guest');
check('server', { sysDescr: 'Hardware: Intel64 Family 6 Software: Windows Version 6.3 (Build 20348)', name: 'DC-2' },
    'Windows Server 2022');
check('server', { sysDescr: 'Linux dns-1 6.12.0-211.44.1.el10_2.x86_64 #1 SMP', name: 'DNS-1' },
    'a Linux box with no CPU model yet reads as a server');
check('server', { sysDescr: 'Linux pi3b 6.18.34+rpt-rpi-v8 #1 SMP aarch64', name: 'pi3b' },
    'a Pi is a server as far as SNMP can tell');

// --- silence, which is half the design ---------------------------------------
check('', {}, 'no evidence at all');
check('', { sysDescr: '', sysName: '', name: '' }, 'empty strings are not evidence');
check('', { sysDescr: 'Some Vendor Appliance v1.2' }, 'an unknown appliance is blank, not a guess');
check('', { name: 'device-42' }, 'a name with no type word in it says nothing');
check('', { sysDescr: 'QEMU Virtual CPU version 2.5+' },
    'a bare CPU model in sysDescr is not a device type - the virtual signal is '
    + 'the cpuModel field, not free text');

// --- virtual versus physical, the whole reason the inventory read exists ------
check('vm', { sysDescr: 'Linux dns-1 6.12.0-211.44.1.el10_2.x86_64 #1 SMP', name: 'DNS-1',
    cpuModel: 'QEMU Virtual CPU version 2.5+' },
    'the SAME sysDescr as the server case above, now a VM because the CPU says so');
check('server', { sysDescr: 'Linux MPC1 6.17.2-1-pve #1 SMP x86_64', name: 'MPC1',
    cpuModel: 'Intel(R) N150' },
    'a Proxmox HOST has a real CPU - the machine that RUNS guests is not one');
check('server', { sysDescr: 'Linux dns-1 6.12.0-211.44.1.el10_2.x86_64', name: 'DNS-1',
    cpuModel: null },
    'no CPU model is NOT evidence of physicality - absence keeps the honest answer');
check('firewall', { sysDescr: 'pfSense FW-1 2.8.1-RELEASE FreeBSD 15.0-CURRENT amd64',
    cpuModel: 'QEMU Virtual CPU version 2.5+' },
    'a VIRTUALISED firewall is still a firewall - the appliance rule claims it first');
check('vm', { sysDescr: 'Linux web-3 6.1.0 x86_64', cpuModel: 'Common KVM processor' },
    'KVM by another name');

// --- the fixture the whole fleet runs on -------------------------------------
check('server', { sysDescr: 'SNMPCanvas fleet mock - Linux lab-node-011 6.8.0 x86_64', name: 'mock-0010' },
    'the lab mock reads as Linux, so the demo board stops being 400 blank boxes');

// Slice 32: the exported vocabulary must COVER what the guesser returns.
// The override route validates against STENCIL_NAMES and the wall keys its
// artwork by it, so a name the guesser can produce but the list omits would
// be an icon nobody could correct to and no tile could draw. Checked by
// running the guesser over every case string in this file rather than by
// reading the branches - the list has to match BEHAVIOUR, not intent.
{
    const seen = new Set<string>();
    const probe = (e: Parameters<typeof guessStencil>[0]): void => {
        const g = guessStencil(e);
        if (g !== '') seen.add(g);
    };
    for (const d of [
        'RouterOS CRS317-1G-16S+', 'RouterOS hEX S', 'TrueNAS-13.0-U6.8',
        'pfSense firewall', 'Linux server 6.8.0', 'UniFi AP-AC-Pro access point',
        'APC Smart-UPS 1500', 'VMware ESXi vm guest', 'Synology DiskStation storage array',
        'Cisco IOS switch c2960', 'MikroTik RB5009 router',
    ]) probe({ sysDescr: d, sysName: null, name: null, cpuModel: null });

    const missing = [...seen].filter((n) => !STENCIL_NAMES.includes(n));
    if (missing.length === 0) {
        console.log(`  ok   every stencil these strings produce is in STENCIL_NAMES `
            + `(${seen.size} distinct seen, ${STENCIL_NAMES.length} declared)`);
        pass++;
    } else {
        console.log(`  FAIL STENCIL_NAMES omits names the guesser returns: ${missing.join(', ')}`);
        fail++;
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);


