// Every OID the collector touches, as named numeric constants. No MIB files,
// no MIB parsing - the parent's choice and worth keeping, because a MIB parser
// is a large dependency for a lookup table that changes twice a year.
//
// Ported from snmpcanvas/server/oids.js.
//
// SCOPE. Slice 4 tracks INTERFACES. The parent additionally covers host
// resources, UPS output source, temperature sensors, BMC sensor tables,
// NET-SNMP-EXTEND and a vendor CPU/memory map matched by sysObjectID prefix.
// Those are all the same shape - a table to walk and a rule for interpreting
// the rows - and the structure here is left ready for them, but none is needed
// by slice 4's done-when criteria and each wants its own device walk to verify
// against. Interfaces are what the sample columns encode and what the mock
// fleet serves.

/** SNMPv2-MIB system group. Scalars, so the .0 instance is part of the OID. */
export const SYS = {
    sysDescr: '1.3.6.1.2.1.1.1.0',
    sysObjectID: '1.3.6.1.2.1.1.2.0',
    /** TimeTicks in centiseconds. Wraps at about 497 days. */
    sysUpTime: '1.3.6.1.2.1.1.3.0',
    sysName: '1.3.6.1.2.1.1.5.0',
    /** Free-text site or rack. CrossCanvas nests it into zones on import. */
    sysLocation: '1.3.6.1.2.1.1.6.0',
};

/**
 * HOST-RESOURCES, read on an INVENTORY cadence rather than a poll cadence.
 *
 * hrProcessorLoad is walked only for its INDICES - one row per core - and the
 * matching hrDeviceDescr row carries the CPU model string. That is the whole
 * point: "QEMU Virtual CPU version 2.5+" versus "Intel(R) N150" is the only
 * signal that says whether a Linux box is a guest or the machine hosting
 * them, and sysDescr cannot tell them apart.
 *
 * Walking hrDeviceDescr directly would be simpler and much worse - the table
 * holds every device the agent knows about, printers and disks and network
 * interfaces included, which on a Windows box is dozens of rows to find one
 * string.
 */
export const HR = {
    hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
    // Physical memory in KB (HOST-RESOURCES hrMemorySize) - one GET in the
    // same daily inventory pass that reads the CPU model (slice 21).
    hrMemorySize: '1.3.6.1.2.1.25.2.2.0',
    hrDeviceDescr: '1.3.6.1.2.1.25.3.2.1.3',
} as const;

/** IF-MIB ifTable, indexed by ifIndex. */
export const IF = {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifType: '1.3.6.1.2.1.2.2.1.3',
    /** bps, and it SATURATES at about 4.29G. Prefer ifHighSpeed. */
    ifSpeed: '1.3.6.1.2.1.2.2.1.5',
    /** 1 up, 2 down, 3 testing. */
    ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
    ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
    /** Counter32. Only used when the HC counters are absent. */
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifInDiscards: '1.3.6.1.2.1.2.2.1.13',
    ifInErrors: '1.3.6.1.2.1.2.2.1.14',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    ifOutDiscards: '1.3.6.1.2.1.2.2.1.19',
    ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
} as const;

/** IF-MIB ifXTable. Same ifIndex, 64-bit counters and better names. */
export const IFX = {
    ifName: '1.3.6.1.2.1.31.1.1.1.1',
    /** Counter64. */
    ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
    /** Counter64. */
    ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
    /** Mbps, and the one to trust over ifSpeed above 4.29G. */
    ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
    /**
     * true(1) if the interface sublayer has a physical connector.
     *
     * The standard-MIB way to ask the question the name list below is
     * guessing at, and it answers for every vendor at once instead of
     * accreting patterns. Read at DISCOVERY only - see defaultTracked.
     */
    ifConnectorPresent: '1.3.6.1.2.1.31.1.1.1.17',
    ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
} as const;

/**
 * ifTypes tracked by default at discovery.
 *
 * Everything else starts untracked, deliberately: a switch with a 500-row
 * ifTable of tunnels, loopbacks and VLAN interfaces would otherwise flood the
 * tracked set, and tracked entities are what drive the sample rate.
 */
export const DEFAULT_TRACKED_IFTYPES = new Set([
    6,   // ethernetCsmacd
    7,   // iso88023Csmacd, old-style ethernet, seen on printers and embedded
    161, // ieee8023adLag
]);

/**
 * THE SECOND HALF OF THE SAME DECISION, ported verbatim from SNMPCanvas
 * discover.js. The ifType test above is necessary and NOT sufficient: all of
 * this plumbing reports a real ethernet ifType and passes it honestly.
 *
 * Measured 2026-08-16 on a Pi 3B+ running Docker - 18 interfaces discovered,
 * all tracked, of which two were real. Five veth pairs, five br-<hash> docker
 * bridges and docker0 all answered ethernetCsmacd. The type set had crossed
 * from the parent at slice 4 and this had not, which is the same omission
 * FS_NOISE avoided for filesystems by being carried at the same time.
 *
 * What the entries are for, kept because the reasons are not guessable from
 * the patterns: docker and libvirt (veth, docker0, br-<hash>, virbr); Proxmox
 * per-VM taps and firewall bridges, which RENUMBER on VM restart or migration
 * and so breed stale entities; the Linux pseudo-device zoo Ubiquiti APs expose
 * (ifb, gretap, erspan, tunnel endpoints, mld-wifi, dummy VAPs); and per-SSID
 * VLAN subinterfaces, where wifi0ap0.50 is noise and the base VAP wifi0ap0
 * stays tracked.
 *
 * UNTRACKED, NOT UNDISCOVERED. Every one of these still appears in the
 * interface list and can be switched on by hand - the default answers "what
 * should drive the sample rate", not "what exists".
 */
export const IF_NOISE = new RegExp('^(' + [
    'veth', 'docker\\d', 'br-[0-9a-f]{12}$', 'virbr',
    'tap\\d+i\\d+', 'fwbr\\d+', 'fwpr\\d+p\\d+', 'fwln\\d+i\\d+',
    'ifb\\d', 'gretap\\d', 'erspan\\d', 'gre\\d', 'sit\\d', 'ip6tnl', 'ip6gre', 'teql\\d',
    'mld-', 'dum\\w*vap', 'miireg', 'soc\\d', 'pd\\d+$',
    'wifi\\d+ap\\d+\\.\\d+$',
    // WINDOWS, added 2026-08-25 from a mainline finding (SNMPCanvas f198fe8).
    // The list above was written entirely from Linux, Proxmox and Ubiquiti
    // names, and Windows pseudo-interfaces report ethernetCsmacd(6) exactly
    // like a real NIC - so WAN Miniports, RAS adapters, isatap and Teredo
    // passed the type gate honestly and were pre-ticked on every Windows
    // host. These are the FALLBACK for agents that do not answer
    // ifConnectorPresent; the .17 test below is the general answer.
    //
    // 'Local Area Connection\\* \\d' carries a LITERAL asterisk - that is the
    // RAS pseudo-adapter naming. A genuine old NIC is "Local Area Connection"
    // with no asterisk and must keep matching nothing here.
    'WAN Miniport', 'RAS Async', 'isatap', 'Teredo',
    'Local Area Connection\\* \\d',
    // BLUETOOTH PAN is a different kind of entry and worth separating in the
    // reader's head: it is not a defect, it is a taste judgement with a
    // reason. Bluetooth PAN is real hardware with a real connector and
    // passes every test correctly. But default-tracked is the set an
    // operator accepts without reading, so it should mean "worth a place on
    // a wall", and a 3 Mbps radio for tethering a phone is not that.
    // 'bnep' is the Linux name; the bare prefix covers bnep0, bnep1 and so on.
    'Bluetooth', 'bnep',
].join('|') + ')');

/**
 * NDIS filter-driver components, matched ANYWHERE in the string - unlike
 * IF_NOISE, which is anchored. A filter driver (Npcap, WFP, the QoS
 * scheduler) clones every adapter it binds: the clone is named
 * "<adapter>-<component>-NNNN", reports the adapter's real ethernet type,
 * speed and connector, and carries live counters - the handoff called
 * these ghosts more convincing than the miniports, and DC-2 proved it
 * with eighteen of them tracked (2026-08-27). The component name is the
 * only tell, it sits mid-string, and ifDescr truncates at 64 chars - so
 * these match the component prefix, which survives the truncation
 * ("...LightWeight Filte") that the full name would not.
 */
export const IF_FILTER_CLONE = new RegExp([
    'Microsoft NDIS Capture',
    'Npcap Packet Driver',
    'QoS Packet Scheduler',
    'WFP Native MAC Layer',
    'WFP 802\.3 MAC Layer',
    'LightWeight Filter',
].join('|'));

/**
 * ifTypes that legitimately have NO physical connector of their own.
 *
 * A LAG has no connector - its members do - and it is usually the thing most
 * worth graphing on the device, so it must never be unticked by the
 * connector test.
 */
export const CONNECTORLESS_BUT_REAL = new Set([161]);

/**
 * Should this interface be TRACKED by default at discovery? One place, so the
 * probe and the poll cannot drift apart on it.
 *
 * Three tests, in increasing order of authority:
 *
 *   1. the ifType gate - plumbing that admits what it is;
 *   2. the name list - plumbing that reports a real ethernet type but is
 *      named recognisably (veth, docker0, WAN Miniport);
 *   3. ifConnectorPresent - the standard MIB asking the real question.
 *
 * THE SAFETY PROPERTY, and it is the whole reason this can ship without a
 * fleet-wide rediscovery plan: **only an EXPLICIT false(2) unticks.** An
 * agent that omits the object, or answers true(1), leaves behaviour exactly
 * as it was. This change can quieten a noisy discovery; it can never silence
 * a fleet.
 *
 * Two honest limits, carried over from mainline rather than rediscovered:
 * on a router the connector test buys nothing, because those
 * pseudo-interfaces already fail the ifType gate (a Cisco CSR reports Nu0 as
 * other(1) and Tu0 as tunnel(131)); and a Hyper-V vSwitch adapter is
 * false(2) with ifType 6, identical to a WAN Miniport on every object IF-MIB
 * exposes, so it unticks too. That last one is defensible - the physical NIC
 * underneath carries the same traffic and stays tracked - but it is a real
 * behaviour change and not an accident.
 */
export function defaultTracked(
    ifType: number | null, name: string, descr: string | null,
    connectorPresent: number | null,
): boolean {
    if (ifType === null || !DEFAULT_TRACKED_IFTYPES.has(ifType)) return false;
    // BOTH names, because the two agents split the truth (DC-2, 2026-08-27):
    // the stock Microsoft service puts "ethernet_32774" in ifName and the
    // human name in ifDescr, so a pattern tested against ifName alone never
    // fired on the one service the Windows patterns were written for. Linux
    // agents put the truth in ifName. Test both; noise in either is noise.
    if (IF_NOISE.test(name) || (descr !== null && IF_NOISE.test(descr))) return false;
    if (IF_FILTER_CLONE.test(name) || (descr !== null && IF_FILTER_CLONE.test(descr))) return false;
    if (connectorPresent === 2 && !CONNECTORLESS_BUT_REAL.has(ifType)) return false;
    return true;
}

/**
 * The six sample columns, in order, and what they mean.
 *
 * Carried from snmp-status.json and NOT negotiable: the handoff calls units
 * and semantics a one-way door, and getting these wrong is unfixable after the
 * fact because the stored numbers are all there is.
 *
 * v2 through v5 are FRACTIONAL rates and must stay fractional. One CRC error a
 * minute is 0.0167 errors per second, and rounding that to an integer reports
 * a failing port as clean.
 */
export const IF_COLUMNS = ['in_bps', 'out_bps', 'in_err_s', 'out_err_s', 'in_disc_s', 'out_disc_s'] as const;

/** oper/admin status values worth naming rather than repeating. */
export const IF_STATUS = { up: 1, down: 2, testing: 3 } as const;
