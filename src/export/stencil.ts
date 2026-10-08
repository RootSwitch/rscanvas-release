// Guess a CrossCanvas stencil from what SNMP already told us.
//
// PORTED FROM snmpcanvas/server/inventory.js guessStencil(), 2026-08-13, with
// its ordering corrected - see the two order bugs below, both found by
// checking its rules against real devices rather than by reading them.
//
// WHY GUESS AT ALL. The first version of the inventory export sent nothing
// here, and a board of forty devices imported as forty identical blank boxes.
// The operator's point stands: something to work with beats a wall of blanks,
// and a wrong icon costs one click of CrossCanvas's Icon dropdown.
//
// SO THE RULE IS: ONLY GUESS WHEN THE EVIDENCE IS UNAMBIGUOUS. Silence is a
// legitimate answer and is the default. This is the same posture as every
// other inference in this codebase - the near-miss location suggestion, the
// ambiguous import key - and for the same reason: a confident wrong answer is
// worse than no answer, because nobody re-checks the one that looked fine.
//
// A NOTE ON PROVENANCE, since it was a running theme the day this landed.
// sysDescr is DEVICE-CONTROLLED, and this file feeds it into a decision. That
// is acceptable here and would not be elsewhere: an icon is PRESENTATION, not
// control flow. A compromised switch can make itself draw as a printer; it
// cannot make itself into a different alert group or suppress its own outage.
// The line is whether the machine's claim changes what the system DOES. And
// the value still leaves through csvCell, which asks nothing about origin.
//
// VOCABULARY VERIFIED BY IMPORTING IT, not assumed. Every name below was
// pasted into a real CrossCanvas and its resolved stencil read back out:
//   firewall -> Firewall      access point -> WifiAP    router -> Router
//   switch -> Switch          server -> Server          nas -> NAS
//   ups -> UPS                vm -> VM                  storage -> Storage
// Two that were NOT used because they resolved somewhere else:
//   'Cloud Router' -> Cloud          (a cloud icon, not a router)
//   'ServerCluster' -> Server        (collapses to the plain server)
// And 'accesspoint' with no space resolves to Blank, so the space matters.
//
// THOSE TWO WERE A BUG IN THE RESOLVER, NOT A FACT ABOUT THE VOCABULARY, and
// this comment had it as a fact for a day. CrossCanvas resolved names by a
// FUZZY SUBSTRING pass with no exact-name pass in front of it, so a stencil
// whose own name was a substring of another lost to whichever the roster
// listed first - 'Cloud Router' and 'ServerCluster' were unreachable BY THEIR
// OWN NAMES. Fixed upstream in CrossCanvas 3e8c1a6 (exact, space-blind match
// runs before fuzzy, in both resolvers), reported back after this measurement
// went the other way.
//
// Left as-is deliberately: the nine names below are verified by import and
// switching any of them to a newly-reachable one buys nothing. What changes is
// the REASON recorded here, because "avoid these two names" would have
// outlived the defect that motivated it - and an observation about a
// codebase is not a property of it, which is this project's own rule arriving
// from the other direction.

/** The evidence a guess may draw on. All optional; all may be absent. */
export interface StencilEvidence {
    sysDescr?: string | null;
    sysName?: string | null;
    /** The operator-assigned device name - often the clearest signal there is. */
    name?: string | null;
    /**
     * CPU model from HOST-RESOURCES, read on the inventory cadence.
     *
     * THE ONLY THING THAT DISTINGUISHES A GUEST FROM ITS HOST. A Linux VM's
     * sysDescr is indistinguishable from a physical machine's; the difference
     * lives here - "QEMU Virtual CPU version 2.5+" against "Intel(R) N150".
     * Absent on agents that do not expose the subtree, which is most switches,
     * and absent for the first day after a device is discovered.
     */
    cpuModel?: string | null;
}

/**
 * Hypervisor fingerprints as they appear in hrDeviceDescr.
 *
 * QEMU and KVM report a literal "QEMU Virtual CPU"; VMware guests commonly
 * report the HOST's real CPU model instead, which is why this list can never
 * be complete - and why a miss falls back to 'server' rather than guessing.
 */
function isVirtualCpu(cpu: string | null | undefined): boolean {
    if (!cpu) return false;
    return /qemu|kvm|virtual cpu|vmware|hyper-?v|\bxen\b|bhyve/i.test(cpu);
}

/**
 * MikroTik ships routers, switches, firewalls and access points, and every one
 * of them reports the same "RouterOS" software. THE MODEL IS THE ANSWER, and
 * it is right there in sysDescr: "RouterOS CRS317-1G-16S+".
 *
 * This is the order bug in the ported original: its rule list tested
 * /routeros|mikrotik/ under `router` BEFORE the switch rule, so every CRS - a
 * Cloud Router SWITCH, the operator's own core switches among them - came out
 * as a router.
 *
 * Prefixes are MikroTik's own product-line naming:
 *   CRS  Cloud Router Switch      CSS  Cloud Smart Switch
 *   CCR  Cloud Core Router        RB   RouterBOARD
 *   hAP/wAP/cAP  access points    hEX  small ethernet router
 * Anything else returns null and falls through to silence rather than to a
 * coin flip.
 */
function mikrotikModel(hay: string): string | null {
    if (/\bcrs\d/.test(hay) || /\bcss\d/.test(hay)) return 'switch';
    if (/\bccr\d/.test(hay) || /\brb\d/.test(hay) || /\bhex\b/.test(hay)) return 'router';
    if (/\b[hwc]ap\b|\b[hwc]ap[- ]?ac\b/.test(hay)) return 'access point';
    return null;
}

/**
 * UniFi is the same shape of problem with a cleaner answer: the model prefix
 * is the product line, and sysDescr carries it ("U6-Enterprise 6.8.2.15592").
 */
function unifiModel(hay: string): string | null {
    if (/\bu[67][a-z]*-|\buap[- ]|\buap\b/.test(hay)) return 'access point';
    if (/\busw[- ]|unifi switch/.test(hay)) return 'switch';
    if (/\budm[- ]|\budm\b|\buxg[- ]|\busg[- ]/.test(hay)) return 'firewall';
    if (/\buck[- ]|cloud ?key/.test(hay)) return 'server';
    return null;
}

/**
 * Best-effort stencil, or '' for "no idea, draw it blank".
 *
 * ORDER IS THE WHOLE DESIGN. Rules run most-specific first, because the
 * general ones are traps: pfSense IS FreeBSD, TrueNAS IS FreeBSD, and a
 * Proxmox host IS Linux, so any rule matching the operating system has to run
 * AFTER the rules that recognise the appliance built on it.
 *
 * The second order bug in the original lives exactly there: `truenas` sat
 * inside the server rule, which ran before the nas rule, so every TrueNAS box
 * exported as a server.
 */
/**
 * The vocabulary, as data (slice 32). It was a fact spread across this
 * file's branches and a comment; the icon override route needs to VALIDATE
 * against it, and the wall needs artwork keyed by it, so one exported list
 * is the only way those three stay in step. tools/test-stencil.ts asserts
 * that every name guessStencil can return appears here.
 */
export const STENCIL_NAMES: readonly string[] = [
    'firewall', 'switch', 'router', 'server', 'nas', 'ups', 'vm', 'storage', 'access point',
    // Slice 35: never GUESSED - guessStencil reads sysDescr and a ping-only
    // device has none - but assignable, and the default a ping-only device
    // is created with.
    'globe',
];

export function guessStencil(e: StencilEvidence): string {
    const hay = `${e.sysDescr ?? ''} ${e.sysName ?? ''} ${e.name ?? ''}`.toLowerCase();
    if (hay.trim() === '') return '';

    // 1. Vendor product lines, where the model names the device type outright.
    if (/routeros|mikrotik/.test(hay)) {
        const m = mikrotikModel(hay);
        // No model match means RouterOS on something unidentified. Blank, not
        // "router" - the whole point of this branch is that the OS does not
        // tell you what the box is.
        return m ?? '';
    }
    // UniFi is NOT gated behind a vendor word, and that is not sloppiness -
    // it is what the real strings force. A UniFi sysDescr reads "U6-Enterprise
    // 6.8.2.15592": no "unifi", no "ubiquiti", nothing but the model. The
    // parent identifies the family by sysObjectID prefix 41112 instead, which
    // this application polls and does not store. So the model patterns run on
    // their own, anchored tightly enough (U6-/U7-/UAP/USW/UDM) that a stray
    // hostname is unlikely to trip one - and the cost if it does is an icon.
    const uni = unifiModel(hay);
    if (uni !== null) return uni;

    // 2. Purpose-built appliances, BEFORE the operating systems they run on.
    if (/pfsense|opnsense|fortigate|palo ?alto|\basa\b|\bfirewall\b/.test(hay)) return 'firewall';
    if (/truenas|freenas|synology|qnap|unraid|\bnas\b/.test(hay)) return 'nas';
    if (/smart-?ups|\bups\b|\bpdu\b|apc web\/snmp/.test(hay)) return 'ups';

    // 3. Network gear by role keyword.
    if (/access ?point|\bwifi\b|\bwlan\b|wireless/.test(hay)) return 'access point';
    if (/catalyst|procurve|\bnexus\b|powerconnect|\bswitch\b/.test(hay)) return 'switch';
    // _IOSD- (2026-10-08): IOS-XE runs as a daemon on Linux, and its image
    // name says so - an ISR 4331 reports "ISR Software
    // (X86_64_LINUX_IOSD-UNIVERSALK9-M)" with no role word anywhere, so the
    // LINUX in it fell through to the server rule below. Every _IOSD image
    // is a router platform (ISR, ASR, CSR, Catalyst 8000 Edge); a Catalyst
    // 9000 runs CAT9K_IOSXE and says "Switch Software", claimed one line up.
    // Found by the demo fleet, whose branch routers drew as servers.
    if (/\bios[- ]?xe\b|\bvyos\b|\brouter\b|_iosd-/.test(hay)) return 'router';

    // 4. General-purpose operating systems, last, and only as "server".
    //
    // NOT "vm" for any of these, however tempting. Whether a Linux box is
    // physical or virtual is NOT in sysDescr - it comes from the CPU model in
    // HOST-RESOURCES (hrDeviceDescr: "QEMU Virtual CPU" versus "Intel(R)
    // N150"), which this application does not collect. Guessing would be
    // wrong about half a fleet, and a hypervisor HOST is a server anyway - the
    // -pve kernel that identifies Proxmox marks the physical machine, not a
    // guest. Recorded as needing an inventory-cadence HOST-RESOURCES read.
    if (/linux|windows|ubuntu|debian|freebsd|proxmox|esxi|vmware|\bserver\b/.test(hay)) {
        // VIRTUAL OR PHYSICAL, decided by the CPU model and by nothing else.
        //
        // Checked HERE rather than earlier because it only refines a machine
        // already known to be general-purpose: a virtualised firewall is still
        // a firewall, and the appliance rules above have already claimed it.
        //
        // And absence of a cpuModel is NOT evidence of physicality - it is
        // usually an agent that does not expose HOST-RESOURCES, or a device
        // discovered in the last day. So absence keeps the honest 'server'
        // instead of being read as "confirmed not a VM".
        if (isVirtualCpu(e.cpuModel)) return 'vm';
        return 'server';
    }
    return '';
}
