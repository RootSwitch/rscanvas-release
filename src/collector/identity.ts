// Device identity (2026-10-19): what a device is and what it runs, in words
// a person reads, and the vendor numbers behind them.
//
// PORTED FROM SNMPCanvas (server/identity.js, and collectIdentity in
// server/discover.js), both read in full first - the porting rule: THE
// CHOICES, NOT JUST THE OIDS. Every rule here traces to a string a real
// agent sent; tools/test-identity.ts holds them (production's 33 agents on
// 2026-10-19, the operator's shelf walks, and the parent's own checks). When
// no rule matches, the answer is the agent's own first line, never a guess.
//
// Pure: the reads are in poll.ts's inventory, which calls these.
//
// --- what differs from the parent ----------------------------------------------
//
//   1. LED BY THE DESCRIPTION where it is unmistakable (Linux, the Microsoft
//      agent, pfSense, TrueNAS, RouterOS, APC, Cisco), by the family only
//      where it is not (UniFi). The poll re-reads sysDescr every time and
//      sysObjectID only with the inventory, so the words must not wait on it.
//   2. ROUTEROS. From 7.2x its sysDescr carries the version itself
//      ("RouterOS CRS326-24G-2S+ 7.24.5 (stable)"), read every poll, so an
//      upgrade shows at once; MIKROTIK-MIB's version only fills in for the
//      older form ("RouterOS CRS354-48G-4S+2Q+"). And that version is
//      mtxrLicVersion (.4.4) - the parent read mtxrFirmwareUpgradeVersion
//      (.7.7), the RouterBOOT the installed RouterOS offers, which equals the
//      RouterOS version only because the two ship together.
//   3. WINDOWS BUILDS are named only where the build says one thing. 17763 and
//      14393 are a Windows 10 and a Server each, 26100 is Windows 11 24H2 and
//      Server 2025, and the Microsoft agent's string cannot tell them apart;
//      the parent named all three Server.
//   4. THE OPERATOR'S OWN WINDOWS AGENT (rsnmpagent) says "Windows 11 Pro
//      Build 26200.9711", which the parent's build map made "Windows (build
//      26200)" - the edition and the update both lost.
//   5. CISCO: IOS-XE, NX-OS and ASA named as themselves, not all "IOS".
//   6. HARDWARE IS A DEVICE MODEL ONLY. The processor stays in cpu_model and
//      the page shows it when there is no model; the parent folded both into
//      one field, so "hardware" meant a switch model on one row and a CPU on
//      the next.

export type Family = 'windows' | 'pfsense' | 'truenas' | 'routeros' | 'unifi' | 'netsnmp' | 'apc' | 'cisco';

const ENT = (oid: string): string => `1.3.6.1.4.1.${oid}`;

/** sysObjectID prefixes, observed values in comments. */
const FAMILY: Array<[Family, string]> = [
    ['windows', ENT('311.')],       // 311.1.1.3.1.3
    ['pfsense', ENT('12325.')],     // 12325.1.1.2.1.1
    ['truenas', ENT('50536.')],     // 50536.3.1
    ['routeros', ENT('14988.')],    // 14988.1
    ['unifi', ENT('41112')],        // 41112
    ['netsnmp', ENT('8072.')],      // 8072.3.2.10
    ['apc', ENT('318.')],           // 318.1.3.27 (UPS), 318.1.3.4.8 (rack PDU)
    ['cisco', ENT('9.')],           // 9.1.1537
];

export function familyOf(sysObjectID: string | null | undefined): Family | null {
    const oid = String(sysObjectID ?? '').replace(/^\./, '');
    for (const [fam, prefix] of FAMILY) if (oid.startsWith(prefix)) return fam;
    return null;
}

/** Vendor-private identity, read with the inventory (poll.ts). */
export const IDENT_OIDS = {
    // MIKROTIK-MIB, at the OIDs the operator's shelf walk of a CRS answered them on.
    mikrotikVersion: ENT('14988.1.1.4.4.0'),         // mtxrLicVersion "7.20.1" - RouterOS
    mikrotikFirmware: ENT('14988.1.1.7.4.0'),        // mtxrFirmwareVersion "7.7" - RouterBOOT installed
    mikrotikFirmwareUpgrade: ENT('14988.1.1.7.7.0'), // mtxrFirmwareUpgradeVersion "7.20.1" - RouterBOOT on offer
    mikrotikBoard: ENT('14988.1.1.7.9.0'),           // "CRS354-48G-4S+2Q+"
    mikrotikBoardAlt: ENT('14988.1.1.7.8.0'),        // "CRS354-48G-4S+2Q+" too, on the same walk
    apcUpsModel: ENT('318.1.1.1.1.1.1.0'),
    apcUpsSku: ENT('318.1.1.1.1.2.5.0'),
    apcPduModel: ENT('318.1.1.12.1.5.0'),
    unifiModel: ENT('41112.1.6.3.3.0'),
    qnapModel: ENT('2076.81.1.1.0'),
    entPhysicalModelName: '1.3.6.1.2.1.47.1.1.1.1.13',
    entPhysicalName: '1.3.6.1.2.1.47.1.1.1.1.7',
};

/**
 * Builds the Microsoft agent's string can name. 26100, 17763 and 14393 are
 * left out on purpose (the header, point 3); extend as builds appear.
 */
export const WINDOWS_BUILDS: Readonly<Record<number, string>> = {
    25398: 'Server 23H2', 20348: 'Server 2022',
    22631: '11 23H2', 22621: '11 22H2', 22000: '11 21H2',
    19045: '10 22H2', 19044: '10 21H2',
};

/** One line of an agent's text, whitespace collapsed, clipped; null when empty. */
export function firstLine(s: string | null | undefined, max = 160): string | null {
    const line = String(s ?? '').split(/\r?\n/)[0]!.replace(/\s+/g, ' ').trim();
    if (line === '') return null;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * sysDescr (plus the family, and MIKROTIK-MIB's version when the inventory
 * has read one) -> a short OS summary, or null when no rule knows the agent.
 */
export function summarizeOS(
    sysObjectID: string | null | undefined, sysDescr: string | null | undefined, osVersion?: string | null,
): string | null {
    const d = String(sysDescr ?? '').replace(/\s+/g, ' ').trim();
    if (d === '') return null;
    const fam = familyOf(sysObjectID);
    let m: RegExpExecArray | null;

    // net-snmp on Linux: "Linux <host> <kernel> #1 SMP ..." - the kernel is the
    // fact; "-pve" kernels are Proxmox hosts.
    if ((m = /^Linux\s+\S+\s+(\S+)/.exec(d)) !== null) {
        return `Linux ${m[1]}${/-pve\b/.test(m[1]!) ? ' (Proxmox)' : ''}`;
    }
    // rsnmpagent: "Windows 11 Pro Build 26200.9711 x64; rsnmpagent 0.1".
    if ((m = /^Windows (.+?) Build (\d+(?:\.\d+)?)/.exec(d)) !== null) {
        return `Windows ${m[1]} (build ${m[2]})`;
    }
    // The Microsoft agent: "Hardware: ... - Software: Windows Version 6.3
    // (Build 20348 Multiprocessor Free)" - "Version 6.3" forever, the build is
    // the truth.
    if (fam === 'windows' || /Software: Windows\b/.test(d)) {
        const b = /Build\s+(\d+)/i.exec(d);
        if (b === null) return 'Windows';
        const name = WINDOWS_BUILDS[Number(b[1])];
        return name !== undefined ? `Windows ${name} (build ${b[1]})` : `Windows (build ${b[1]})`;
    }
    if ((m = /^pfSense\s+\S+\s+(\S+?)-RELEASE\s+FreeBSD\s+(\S+)/.exec(d)) !== null) {
        return `pfSense ${m[1]} (FreeBSD ${m[2]})`;
    }
    if ((m = /^TrueNAS-(\S+)/.exec(d)) !== null) return `TrueNAS ${m[1]}`;
    if (fam === 'routeros' || /^RouterOS\b/.test(d)) {
        // "RouterOS CRS326-24G-2S+ 7.24.5 (stable)": the version is the
        // trailing dotted number, with its channel when there is one.
        if ((m = /\s(\d+\.\d+(?:\.\d+)?)(?:\s+\((\w+)\))?$/.exec(d)) !== null) {
            return `RouterOS ${m[1]}${m[2] !== undefined ? ` (${m[2]})` : ''}`;
        }
        const v = String(osVersion ?? '').trim();
        return v !== '' ? `RouterOS ${v}` : 'RouterOS';
    }
    if (fam === 'unifi') {
        m = /\s(\d[\d.]+)$/.exec(d);
        return m !== null ? `UniFi ${m[1]}` : 'UniFi';
    }
    if (fam === 'apc' || /^APC Web\/SNMP Management Card/.test(d)) {
        m = /PF:v([\d.]+)/.exec(d);
        return m !== null ? `APC AOS v${m[1]}` : null;
    }
    if (fam === 'cisco' || /^Cisco\b/.test(d)) {
        const v = /Version\s+([^,\s]+)/.exec(d)?.[1];
        if (v === undefined) return null;
        if (/NX-OS/.test(d)) return `NX-OS ${v}`;
        if (/Adaptive Security Appliance/.test(d)) return `ASA ${v}`;
        // IOS-XE does not always say so (2026-10-21, found on the demo's
        // ISR4331): an ISR4000 or ASR1000 says "Cisco IOS Software [...], ISR
        // Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.9.4a", and a
        // Catalyst 3850 on 16.x names only its image. The IOSD image is
        // IOS-XE's, and so is every version from 16 on - classic IOS ended
        // at 15.
        if (/IOS[- ]?XE|Virtual XE|IOSXE|_IOSD\b|LINUX_IOSD/.test(d) || Number(/^(\d+)\./.exec(v)?.[1] ?? 0) >= 16) {
            return `IOS-XE ${v}`;
        }
        return `IOS ${v}`;
    }
    return null;
}

/** What the page and the change record call the OS: the summary, else the agent's own first line. */
export function osText(
    sysObjectID: string | null | undefined, sysDescr: string | null | undefined, osVersion?: string | null,
): string | null {
    return summarizeOS(sysObjectID, sysDescr, osVersion) ?? firstLine(sysDescr, 120);
}

/** A model string as stored: one line, trimmed, at most 80 characters; null when empty. */
export function cleanModel(s: unknown): string | null {
    if (s === null || s === undefined) return null;
    return firstLine(String(s), 80);
}

/** "RouterOS CRS354-48G-4S+2Q+" -> "CRS354-48G-4S+2Q+", for an agent whose private tree did not answer. */
export function routerosBoardFromDescr(sysDescr: string | null | undefined): string | null {
    const m = /^RouterOS\s+(\S+)/.exec(String(sysDescr ?? '').trim());
    return m !== null && !/^\d+\.\d+/.test(m[1]!) ? m[1]! : null;
}

/** "U6-LR 6.6.77.15402" -> "U6-LR", when the UniFi model OID is absent. */
export function unifiModelFromDescr(sysDescr: string | null | undefined): string | null {
    const m = /^(\S+)\s+\d[\d.]+\s*$/.exec(String(sysDescr ?? '').trim());
    return m !== null ? m[1]! : null;
}

/** APC: "Smart-UPS SRT 2200 (SRT2200XLA)", the SKU when it says more. */
export function apcModel(model: unknown, sku: unknown, pduModel: unknown): string | null {
    const mo = cleanModel(model);
    const sk = cleanModel(sku);
    if (mo !== null) return sk !== null && sk !== mo ? cleanModel(`${mo} (${sk})`) : mo;
    return cleanModel(pduModel);
}

/**
 * ENTITY-MIB: the model name beats the name; first non-empty wins (chassis
 * rows come first on gear that fills the table properly, and on gear that
 * repeats one string - the parent's Dells - any row is the right row).
 */
export function pickEntityModel(...maps: Array<Map<string, unknown> | null | undefined>): string | null {
    for (const map of maps) {
        if (!map) continue;
        for (const v of map.values()) {
            const s = cleanModel(v);
            if (s !== null) return s;
        }
    }
    return null;
}

/** Whether a MikroTik's installed RouterBOOT is behind the one its RouterOS offers. */
export function firmwareLags(installed: string | null | undefined, offered: string | null | undefined): boolean {
    const a = String(installed ?? '').trim();
    const b = String(offered ?? '').trim();
    return a !== '' && b !== '' && a !== b;
}

/** The families whose model, if any, is only in ENTITY-MIB - network gear
 *  RSCanvas has no private rule for, and Cisco. Hosts and the families above
 *  are not walked: their tables are empty or absent, and an unserved
 *  subtree can hang a walk until its deadline. */
export function wantsEntityModel(fam: Family | null): boolean {
    return fam === null || fam === 'cisco';
}

/**
 * Whether this poll reads the identity (slice 66): with the daily
 * inventory; once for a device never read; after a restart, since an
 * upgrade always is one; and when the OS words this poll's sysDescr gives
 * differ from the stored ones - an upgrade whose restart the uptime could
 * not show (a device up under the restart judgement's two minutes, found by
 * the lab drill) still says so in its description, and its boot firmware
 * should not wait a day for the next inventory to be read.
 */
export function wantsIdentityRead(o: {
    inventory: boolean; neverRead: boolean; restarted: boolean;
    storedOs: string | null | undefined; osNow: string | null;
}): boolean {
    if (o.inventory || o.neverRead || o.restarted) return true;
    return o.storedOs != null && o.osNow !== null && o.osNow !== o.storedOs;
}

/** How a recorded change names its field. */
export const CHANGE_FIELD_WORDS: Readonly<Record<string, string>> = {
    os: 'OS', hardware: 'hardware', firmware: 'boot firmware',
};
