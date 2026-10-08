// One poll of one device: discover what is there, read the counters, turn
// counter deltas into rates.
//
// The rate arithmetic is the part with sharp edges, and all of them are
// semantics the handoff calls one-way doors - a wrong number here is stored
// forever and looks entirely plausible on a chart.

import { summarizeReadings, type DeviceSummary, type IfReading, type SensorReading } from './summary.ts';
import { SYS, HR, IF, IFX, DEFAULT_TRACKED_IFTYPES, defaultTracked } from './oids.ts';
import { createSession, get, walk, walkMany, asNumber, asString, asCounter, SnmpError, type Target } from './snmp.ts';
import { rate32 } from './counters.ts';
import { credentialFields, sessionVersion, type Credential } from '../credentials/v3.ts';
import { generateCode } from './codes.ts';
import { discoverSensors } from './probe.ts';
import { guessStencil } from '../export/stencil.ts';
import { sensorSample, planSensorRepin, type SensorExtra } from './sensors.ts';
import { speedTrust } from './speedtrust.ts';
import { planRekey } from './rekey.ts';
import { OPS, storeFailureLane, storeRefusal, type SampleRow } from '../store/index.ts';
import { inDomain } from '../store/bounds.ts';

export interface PollResult {
    ok: boolean;
    /** The roster summary folded from this poll's readings (slice 20); null when the poll failed. */
    summary: DeviceSummary | null;
    deviceId: string;
    /** Wall time for the whole SNMP conversation. Stored per sample; cannot be backfilled. */
    rttMs: number;
    samples: SampleRow[];
    /** Entities whose counters must be saved for the next poll's delta. */
    counters: Array<{ id: string; ts: Date; c: Array<bigint | null> }>;
    /** The FRESH set: only entities this poll actually heard from belong
     *  here. The batch write clears any went-quiet stamp on these rows;
     *  entities ABSENT from this list keep their old values, and the
     *  collector's markInterfacesStale sweep stamps interfaces with when
     *  they went quiet. */
    lastValues: Array<{
        id: string; ts: Date; status: number | null; rttMs: number | null;
        v: Array<number | null>;
    }>;
    discovered: number;
    /** Slice 32: the device-type guess for wall icons; null when the evidence
     *  was ambiguous, which leaves the stored guess alone rather than
     *  blanking a tile on one odd poll. */
    stencil: string | null;
    /** Interfaces whose advertised speed this poll DISPROVED. Named so the
     *  caller logs each once; the row flag prevents a second conviction. */
    speedConvictions: string[];
    /** Interfaces re-keyed to a new ifIndex this poll (re-enumeration). */
    rekeyed: string[];
    sysName: string | null;
    sysDescr: string | null;
    sysLocation: string | null;
    /**
     * The CPU model, when an inventory refresh was due AND the agent answered.
     * null covers both "not due this poll" and "agent does not expose
     * HOST-RESOURCES", which is why `inventoryTried` is separate - the caller
     * must be able to tell a value it did not ask for from one it asked for
     * and did not get.
     */
    cpuModel: string | null;
    /** sysUpTime in seconds, read on every successful poll (slice 21). */
    uptimeS: number | null;
    /** Inventory facts (slice 21): null when the agent does not expose HOST-RESOURCES. */
    cpuCores: number | null;
    ramKb: number | null;
    /** Whether this poll ATTEMPTED the inventory read. Stamps the backoff. */
    inventoryTried: boolean;
    error: string | null;
    /** store (2026-10-06): the poll failed on OUR database, not on the
     *  device - the caller must not count it against the device. */
    errorKind: 'timeout' | 'auth' | 'other' | 'store' | null;
}

/**
 * Counter delta, handling wrap and reset.
 *
 * Three cases and they must be distinguished, because two of them are
 * legitimate and one is not:
 *
 *   * now >= prev            an ordinary delta.
 *   * now < prev, 64-bit     the agent restarted, or the counter was reset.
 *                            A 64-bit counter does not realistically wrap: at
 *                            100Gb/s it takes about 47 years. So treat a
 *                            decrease as a RESET and emit null rather than
 *                            inventing a number.
 *   * elapsed <= 0           clock went backwards or two polls landed in the
 *                            same instant. No rate is computable.
 *
 * Returning null is the honest answer and it is why the sample columns are
 * nullable. The alternative - a synthesised 0 - is indistinguishable from a
 * genuinely idle interface, which is exactly the distinction `stale` exists to
 * preserve elsewhere.
 */
export function rate(
    now: bigint | null, prev: bigint | null, elapsedS: number,
): number | null {
    if (now === null || prev === null) return null;
    if (elapsedS <= 0) return null;
    if (now < prev) return null;
    return Number(now - prev) / elapsedS;
}

/** Whose failure a thrown poll error is: the device's (by SNMP's own kind),
 *  the store's, or other. Exported for tools/test-poll-store.ts. */
export function pollErrorKind(err: unknown): NonNullable<PollResult['errorKind']> {
    if (err instanceof SnmpError) return err.kind;
    return storeFailureLane(err) !== null ? 'store' : 'other';
}

export async function pollDevice(
    device: {
        id: string; name: string; host: string; snmp_port: number;
        snmp_version: string; credential_ref: string;
    },
    credential: Credential,
    takenCodes: Set<string>,
    /**
     * Read the inventory attributes on this poll. Decided by the CALLER from
     * the device's inventory_ts, not here - this function polls one device and
     * has no business knowing the schedule.
     */
    wantInventory = false,
): Promise<PollResult> {
    const t0 = performance.now();
    const target: Target = {
        host: device.host,
        port: device.snmp_port,
        // The credential decides the version when it is a v3 profile (slice
        // 29). The rule lives in sessionVersion beside credentialFields, so
        // this site and the probe cannot drift - the probe once applied the
        // credential half of the rule and not this half, which made
        // rediscover time out on any device polling through a v3 profile
        // over a stale 2c row.
        version: sessionVersion(device.snmp_version, credential),
        ...credentialFields(credential),
    };
    const session = createSession(target);

    const ifReadings: IfReading[] = [];
    const sensorReadings: SensorReading[] = [];
    const result: PollResult = {
        ok: false, summary: null, deviceId: device.id, rttMs: 0, samples: [], counters: [], lastValues: [],
        discovered: 0, speedConvictions: [], rekeyed: [], sysName: null, sysDescr: null, sysLocation: null,
        cpuModel: null, uptimeS: null, cpuCores: null, ramKb: null, stencil: null,
        inventoryTried: false, error: null, errorKind: null,
    };

    try {
        // sysUpTime rides the same PDU: one more varbind, no extra round
        // trip. TimeTicks are hundredths of a second.
        const sys = await get(session, [SYS.sysName, SYS.sysDescr, SYS.sysLocation, SYS.sysUpTime]);
        result.sysName = asString(sys.get(SYS.sysName) ?? null);
        result.sysDescr = asString(sys.get(SYS.sysDescr) ?? null);
        result.sysLocation = asString(sys.get(SYS.sysLocation) ?? null);
        const ticks = asNumber(sys.get(SYS.sysUpTime) ?? null);
        result.uptimeS = ticks === null || ticks < 0 ? null : Math.round(ticks / 100);

        // THE INVENTORY READ, and it is deliberately fenced off from the poll.
        //
        // Its own try/catch, because a device that does not expose
        // HOST-RESOURCES must not have its POLL fail - the counters and status
        // above are the product, and losing them because an optional CPU
        // string was unavailable would be the tail wagging the dog. The
        // attempt is recorded either way so the caller can back off.
        //
        // Walk the processor table for indices, then read the matching
        // description. One walk of N cores plus one get, once a day.
        if (wantInventory) {
            result.inventoryTried = true;
            try {
                const procs = await walk(session, HR.hrProcessorLoad);
                // walk() keys are SUFFIXES - it strips the base OID itself. An
                // earlier version sliced the base off a second time, producing
                // a junk index and a GET that could never resolve. It shipped
                // for a day because no agent in the lab exposes HOST-RESOURCES,
                // so the read was only ever proven to BACK OFF correctly, never
                // to return a value. The identical mistake in the probe was
                // caught within one run, because the mock fleet does have
                // interfaces.
                // The rows ARE the cores (hrProcessorTable has one per
                // logical processor); the walk was already paid for.
                result.cpuCores = procs.size > 0 ? procs.size : null;
                const memRes = await get(session, [HR.hrMemorySize]);
                const kb = asNumber(memRes.get(HR.hrMemorySize) ?? null);
                result.ramKb = kb !== null && kb > 0 ? kb : null;
                const idx = [...procs.keys()][0];
                if (idx !== undefined) {
                    const d = await get(session, [`${HR.hrDeviceDescr}.${idx}`]);
                    const raw = asString(d.get(`${HR.hrDeviceDescr}.${idx}`) ?? null);
                    // "GenuineIntel: Intel(R) N150" - the vendor prefix is
                    // noise for every purpose this string has.
                    result.cpuModel = raw === null ? null
                        : raw.replace(/^[A-Za-z]+Intel:\s*|^AuthenticAMD:\s*/, '').trim() || null;
                }
            } catch {
                // Silent by design: an agent without HOST-RESOURCES is the
                // normal case for switches and appliances, not an incident.
                // inventoryTried stays true, so it is asked again tomorrow
                // rather than on every poll forever.
            }

            // THE SENSOR BACKFILL AND RE-PIN, both at the inventory cadence.
            // Backfill: devices added before the sensors slice grow sensors
            // without a rediscover button - discover-if-NONE, so an operator
            // who deleted a junk sensor does not get it back every midnight.
            // RE-PIN (2026-09-01, the DC investigation): devices that HAVE
            // sensors get their polling instructions refreshed instead -
            // extra pins literal OIDs at discovery, Windows renumbers
            // hrDeviceIndex and hrStorage across reboots, and no other path
            // could ever heal the pin (backfill never re-runs, rediscover's
            // ON CONFLICT DO NOTHING keeps the stale row). The planner in
            // sensors.ts updates instructions on existing rows only: codes,
            // history, tracked flags and deletions all honoured. Rides here
            // because the cadence question is already answered: once a day
            // per device, on the device's own poll slot.
            try {
                const sc = await OPS.sensorCountForDevice(device.id);
                if (sc.ok) {
                    const so = await get(session, [SYS.sysObjectID]);
                    const sensors = await discoverSensors(
                        session, asString(so.get(SYS.sysObjectID) ?? null), result.sysDescr);
                    if (sc.rows[0]?.n === 0) {
                        for (const s of sensors) {
                            const code = generateCode(device.name, s.name, takenCodes);
                            takenCodes.add(code);
                            // WRITE-IN-LOOP-OK: DISCOVERY ONLY, once per
                            // device EVER (the none-gate above), each row
                            // minting its own collision-checked code - the
                            // same shape and justification as the
                            // interface-discovery insert below.
                            const created = await OPS.insertEntity(
                                device.id, s.kind, s.snmpIndex, s.name, s.descr,
                                s.alias, s.speedBps, code,
                                s.extra !== null ? JSON.stringify(s.extra) : null,
                                s.tracked);
                            if (created.ok && created.rows.length > 0) result.discovered++;
                        }
                    } else if (sensors.length > 0) {
                        const rows = await OPS.sensorRowsForRepin(device.id);
                        if (rows.ok) {
                            const plan = planSensorRepin(
                                sensors.flatMap((s) => (s.extra === null ? [] : [{
                                    kind: s.kind, snmpIndex: s.snmpIndex,
                                    name: s.name, extra: s.extra,
                                }])),
                                rows.rows);
                            for (const u of plan) {
                                // WRITE-IN-LOOP-OK: fires only when a
                                // sensor's instruction DRIFTED (a reboot
                                // renumbered the agent's tables) - the
                                // steady-state plan is empty and writes
                                // nothing, canonical-compared so jsonb key
                                // order cannot masquerade as drift.
                                const w = await OPS.repinSensor(
                                    u.id, u.snmpIndex, JSON.stringify(u.extra));
                                if (w.ok && w.rows.length > 0) {
                                    result.rekeyed.push(
                                        `${u.name}: sensor instruction re-pinned (the agent renumbered; readings resume, history kept)`);
                                }
                            }
                        }
                    }
                }
            } catch {
                // Sensors are the bonus, the poll is the product - same
                // reasoning as the probe's own sensor catch.
            }
        }

        // One walk per column. GetBulk makes each cheap, and the alternative -
        // a GET per interface per column - is the 5,200-queries-per-page-load
        // shape the parent had on the read side. BOUNDED concurrency, not
        // Promise.all: fourteen at once overflowed RouterOS's silent request
        // queue and cost a constant timeout-plus-retry on every MikroTik
        // poll - the fleet's "slow switches" were this line. Measurements in
        // walkMany's comment.
        const [names, descrs, types, aliases, highSpeed, speed, admin, oper,
            inOct, outOct, inErr, outErr, inDisc, outDisc,
            inOct32, outOct32] = await walkMany(session, [
            IFX.ifName,
            IF.ifDescr,
            IF.ifType,
            IFX.ifAlias,
            IFX.ifHighSpeed,
            IF.ifSpeed,
            IF.ifAdminStatus,
            IF.ifOperStatus,
            IFX.ifHCInOctets,
            IFX.ifHCOutOctets,
            IF.ifInErrors,
            IF.ifOutErrors,
            IF.ifInDiscards,
            IF.ifOutDiscards,
            // Slice 28: the Counter32 octets, walked ALWAYS. Walking them
            // only on demand would need per-device capability state the poll
            // does not have at walk time, and two more bounded walks cost
            // milliseconds against a 30s interval - while an agent with no
            // ifHC at all (the operator's Windows Server DCs) is invisible
            // without them, forever.
            IF.ifInOctets,
            IF.ifOutOctets,
        ]);

        const rtt = performance.now() - t0;
        result.rttMs = Number(rtt.toFixed(1));

        // Slice 32: the device-type guess, from the strings this poll just
        // read. Computed here rather than at discovery because sysDescr
        // CHANGES - a firmware upgrade can turn "Linux" into a vendor string
        // that names the model - and an icon that was right in March should
        // not still be wrong in November. Empty stays empty: guessStencil
        // returns '' when the evidence is ambiguous, and coalesce keeps the
        // last confident answer rather than blanking a tile on one odd poll.
        const guessed = guessStencil({
            sysDescr: result.sysDescr, sysName: result.sysName,
            name: device.name, cpuModel: result.cpuModel,
        });
        result.stencil = guessed === '' ? null : guessed;

        const existing = await OPS.entitiesForDevice(device.id);
        if (!existing.ok) throw storeRefusal('entitiesForDevice', existing);
        const byIndex = new Map(existing.rows.map((r) => [r.snmp_index ?? '', r]));

        // RE-ENUMERATION, decided from the whole table BEFORE the per-row
        // loop, because "did this entity move" needs to know which indexes
        // arrived and which did not - a per-row view cannot see displacement.
        // A planned move re-keys the existing row and the loop below then
        // finds it at its new index like any other known interface, keeping
        // its code, history, tracked flag and speed trust. Nothing is
        // inserted for a moved interface and nothing is orphaned. See
        // src/collector/rekey.ts for the rule and what it refuses to do.
        {
            const seen: Array<{ idx: string; name: string }> = [];
            // A tracked interface of any type is seen too (see "THE TYPE LIST
            // IS DISCOVERY'S" below), by its index or by its name, so one the
            // agent renumbers is followed like any Ethernet port.
            const trackedIdx = new Set(existing.rows.filter((r) => r.tracked).map((r) => r.snmp_index));
            const trackedNames = new Set(existing.rows.filter((r) => r.tracked).map((r) => r.name));
            for (const [idx, typeVal] of types) {
                const t = asNumber(typeVal);
                const nm = asString(names.get(idx) ?? null) ?? asString(descrs.get(idx) ?? null) ?? `if${idx}`;
                const ofTrackedType = t !== null && DEFAULT_TRACKED_IFTYPES.has(t);
                if (!ofTrackedType && !trackedIdx.has(idx) && !trackedNames.has(nm)) continue;
                seen.push({ idx, name: nm });
            }
            const plan = planRekey(seen, existing.rows.map((r) => ({
                id: r.id, snmp_index: r.snmp_index, name: r.name,
                lv_ts: r.lv_ts, lv_stale_since: r.lv_stale_since,
            })));
            const rowById = new Map(existing.rows.map((r) => [r.id, r]));
            // PARKS BEFORE MOVES, unconditionally: a re-deal reuses indexes in
            // chains and cycles, and freeing every contested slot first is
            // what lets the moves land without tripping the unique index.
            for (const p of plan.parks) {
                // WRITE-IN-LOOP-OK: fires only under a re-deal (a reboot
                // re-numbering the agent's whole table), not a poll cycle -
                // the same event bound as the moves below.
                const r = await OPS.parkEntity(p.id);
                if (r.ok && r.rows.length > 0) {
                    if (byIndex.get(p.fromIdx)?.id === p.id) byIndex.delete(p.fromIdx);
                    result.rekeyed.push(`${p.name}: ifIndex ${p.fromIdx} freed - its adapter is no longer there, and renaming the row to the new arrival would splice two histories`);
                }
            }
            for (const m of plan.moves) {
                // WRITE-IN-LOOP-OK: fires only on a re-enumeration, which is a
                // hardware event - a card installed, a firmware update, a
                // reboot re-dealing the table - not a poll cycle. Steady-state
                // rate is zero; worst case is one statement per interface on
                // the ONE poll that follows it.
                const r = await OPS.rekeyEntity(m.id, m.toIdx);
                const row = rowById.get(m.id);
                if (r.ok && r.rows.length > 0 && row) {
                    if (m.fromIdx !== null && byIndex.get(m.fromIdx)?.id === m.id) byIndex.delete(m.fromIdx);
                    byIndex.set(m.toIdx, { ...row, snmp_index: m.toIdx });
                    result.rekeyed.push(`${m.name}: ifIndex ${m.fromIdx ?? '(parked)'} -> ${m.toIdx} (history kept)`);
                } else {
                    // The target index was taken between plan and write, or
                    // the row vanished. The loop below inserts fresh at that
                    // index, which is the pre-existing behaviour, and the
                    // orphan goes stale as before - named so it is not silent.
                    result.rekeyed.push(`${m.name}: ifIndex ${m.fromIdx ?? '(parked)'} -> ${m.toIdx} REFUSED - target index taken, inserted fresh instead`);
                }
            }
        }

        const now = new Date();
        // See "UNTRACKED MEANS NO HISTORY" below.
        let trackedSampled = false;
        let rttCarrier: { entityId: string; status: number | null } | null = null;

        for (const [idx, typeVal] of types) {
            const ifType = asNumber(typeVal);
            // THE TYPE LIST IS DISCOVERY'S, NOT THE OPERATOR'S (2026-09-30).
            // DEFAULT_TRACKED_IFTYPES decides which NEW interfaces become
            // entities here; it also skipped every existing one of another
            // type, tracked or not, so ticking "track" on a Wi-Fi adapter
            // (ieee80211) or a tunnel saved the tick and read nothing. The
            // operator's A17 and RSAlly Wi-Fi, tracked on 2026-09-22, and
            // FW-1's three OpenVPN interfaces had never had one reading. An
            // interface someone tracked is polled whatever its type.
            const ofTrackedType = ifType !== null && DEFAULT_TRACKED_IFTYPES.has(ifType);
            if (!ofTrackedType && byIndex.get(idx)?.tracked !== true) continue;

            // ifName is the operator-facing name and the one a board annotation
            // binds by; ifDescr is the fallback for agents that omit ifXTable.
            const name = asString(names.get(idx) ?? null) ?? asString(descrs.get(idx) ?? null) ?? `if${idx}`;
            const descr = asString(descrs.get(idx) ?? null);
            const alias = asString(aliases.get(idx) ?? null);
            // ifHighSpeed is Mbps and does not saturate; ifSpeed is bps and
            // pins at about 4.29G, which silently understates every 10G port.
            const hs = asNumber(highSpeed.get(idx) ?? null);
            const speedBps = hs !== null && hs > 0 ? hs * 1_000_000 : asNumber(speed.get(idx) ?? null);
            // Inside their RFC 2863 domains or nothing (review F7): an
            // agent's 70000 is not a status the alerting can reason about.
            const adminStatus = inDomain(asNumber(admin.get(idx) ?? null), 1, 3);
            const operStatus = inDomain(asNumber(oper.get(idx) ?? null), 1, 7);

            let row = byIndex.get(idx);
            if (!row) {
                const code = generateCode(device.name, name, takenCodes);
                takenCodes.add(code);
                // WRITE-IN-LOOP-OK: DISCOVERY ONLY. This runs when an
                // interface is seen for the first time, not every poll -
                // the steady-state path is the `else` branch below. Each
                // insert also mints and collision-checks a short code,
                // which is per-row work by construction.
                // THE SAME POLICY THE PROBE APPLIES, as far as this path can
                // see it. An interface appearing AFTER onboarding took the
                // default `tracked = true` unconditionally, so a host that
                // churns virtual interfaces - any Docker box - re-accumulated
                // exactly the plumbing IF_NOISE exists to keep out, one
                // container at a time, forever.
                //
                // TWO of the three tests apply here, and the comment that used
                // to sit in this spot was WRONG about which: it said the poll
                // does not walk ifType. It does, and has since this loop was
                // written - the loop is keyed on `types` and skips anything
                // outside DEFAULT_TRACKED_IFTYPES before reaching this line.
                // Corrected 2026-08-25 by reading rather than by a failure.
                //
                // The one test genuinely missing is ifConnectorPresent, which
                // is walked at discovery only: adding a per-poll walk of the
                // whole ifXTable column to serve first-sight discovery IS the
                // wrong trade. So a Windows pseudo-interface that appears
                // after onboarding is caught by the name list rather than by
                // the MIB, and /api/devices/rediscover remains the
                // authoritative re-evaluation.
                const created = await OPS.insertEntity(
                    device.id, 'if', idx, name, descr, alias, speedBps, code,
                    null, defaultTracked(ifType, name, descr, null),
                );
                if (!created.ok || created.rows.length === 0) continue;
                result.discovered++;
                row = {
                    id: created.rows[0]?.id as string, snmp_index: idx, name,
                    code: created.rows[0]?.code ?? code,
                    descr, alias, speed_bps: speedBps,
                    speed_untrusted: false, speed_override_bps: null,
                    tracked: defaultTracked(ifType, name, descr, null),
                    hc_missing: false,
                    admin_status: null, oper_status: null,
                    lv_ts: null, lv_stale_since: null,
                    prev_ts: null, prev_c0: null, prev_c1: null,
                    prev_c2: null, prev_c3: null, prev_c4: null, prev_c5: null,
                };
            } else if (
                name !== row.name || descr !== row.descr || alias !== row.alias
                || speedBps !== row.speed_bps
                || adminStatus !== row.admin_status || operStatus !== row.oper_status
            ) {
                // Names and speeds change on a live device. The CODE does not:
                // it was minted once and lives in saved boards.
                //
                // AND THE WRITE HAPPENS ONLY WHEN SOMETHING CHANGED. The
                // unconditional form of this call rewrote name/descr/alias/
                // speed/status for EVERY entity on EVERY poll - values that
                // change when an operator re-labels a port, not every 30s -
                // which was 331 identical-value transactions a second, ~29M
                // no-op tuple versions a day for autovacuum, and a third of
                // the measured 457 GB/day of device writes (SOAK-CRITERIA
                // 2026-08-10). A transaction that modifies no rows still
                // assigns an XID, writes WAL and fsyncs at commit, so the
                // skip must happen HERE, before the statement - a batched
                // no-op write would keep every cost but the fsyncs. The
                // comparison is against columns entitiesForDevice now
                // carries for exactly this purpose.
                //
                // WRITE-IN-LOOP-OK: fires only when a device-reported field
                // actually changed - a re-label or a link flap, not a poll
                // cycle. Steady-state rate ~0; worst case bounded by how
                // much of the fleet an operator re-labels at once.
                await OPS.refreshEntity(row.id, name, descr, alias, speedBps, adminStatus, operStatus);
            }

            // THE 32-BIT FALLBACK (slice 28), decided PER INTERFACE: one
            // agent can serve ifHC for some rows and not others (RSAlly:
            // wired yes, Wi-Fi no), and the operator's Windows Server DCs
            // serve none at all. The flag is persistent state, because a
            // delta computed across a source flip is garbage - the flip
            // poll skips its octet deltas and the next one flows.
            const hasHc = inOct.has(idx) || outOct.has(idx);
            let flippedNow = false;
            if (row.hc_missing !== !hasHc) {
                // WRITE-IN-LOOP-OK: fires when an agent's COUNTER CAPABILITY
                // changes - first sight of a legacy agent, or a firmware
                // upgrade growing ifHC. Effectively once per interface.
                await OPS.setHcMissing(row.id, !hasHc);
                row.hc_missing = !hasHc;
                flippedNow = true;
            }
            const c: Array<bigint | null> = [
                hasHc ? asCounter(inOct.get(idx) ?? null) : asCounter(inOct32.get(idx) ?? null),
                hasHc ? asCounter(outOct.get(idx) ?? null) : asCounter(outOct32.get(idx) ?? null),
                asCounter(inErr.get(idx) ?? null),
                asCounter(outErr.get(idx) ?? null),
                asCounter(inDisc.get(idx) ?? null),
                asCounter(outDisc.get(idx) ?? null),
            ];
            const prev: Array<bigint | null> = [
                row.prev_c0, row.prev_c1, row.prev_c2, row.prev_c3, row.prev_c4, row.prev_c5,
            ].map((s) => (s === null ? null : BigInt(s)));

            const elapsedS = row.prev_ts === null ? 0 : (now.getTime() - row.prev_ts.getTime()) / 1000;

            // Octets to BITS per second for throughput; the error and discard
            // columns are already counts, so their rate is per second and
            // FRACTIONAL. One CRC error a minute is 0.0167/s and must not be
            // rounded to zero.
            //
            // 64-bit octets use rate() (a decrease is a reset, null); 32-bit
            // octets use rate32() (a decrease is a WRAP, adjusted exactly,
            // clamped to null past what the interface's own speed claim can
            // carry - see counters.ts for the three rules and the accepted
            // reboot limitation). Errors and discards are Counter32 on every
            // agent and stay on rate(): at error-count rates a wrap takes
            // years, and a decrease there really is a reboot.
            const octetsToBps = (r: number | null): number | null => (r === null ? null : r * 8);
            const clampBps = row.speed_override_bps ?? row.speed_bps;
            const octRate = (nowC: bigint | null, prevC: bigint | null): number | null =>
                flippedNow ? null
                    : hasHc ? rate(nowC, prevC, elapsedS)
                    : rate32(nowC, prevC, elapsedS, clampBps);
            const v: Array<number | null> = [
                octetsToBps(octRate(c[0] ?? null, prev[0] ?? null)),
                octetsToBps(octRate(c[1] ?? null, prev[1] ?? null)),
                rate(c[2] ?? null, prev[2] ?? null, elapsedS),
                rate(c[3] ?? null, prev[3] ?? null, elapsedS),
                rate(c[4] ?? null, prev[4] ?? null, elapsedS),
                rate(c[5] ?? null, prev[5] ?? null, elapsedS),
            ];

            // SPEED TRUST, decided from this poll's own rate. Ported from
            // SNMPCanvas poller.js speedTrustAndClamp - see speedtrust.ts for
            // the rule. Only the CONVICTING poll writes; every later poll on
            // an untrusted interface sees the flag in its row and skips this.
            // Deliberately does NOT clamp the HC sample: the parent's clamp
            // exists for 32-bit double-wrap garbage, and on the HC path the
            // rate is real and belongs in the graph - it is the CLAIM that
            // is wrong, not the measurement.
            //
            // THE PRE-NAMED GATE, now real: only a 64-bit counter may
            // convict. A 32-bit rate can itself be wrap garbage, so the
            // fallback path hands speed-trust NO rates - utilization still
            // computes against the claim, but the claim cannot be convicted
            // by evidence this weak.
            const trust = speedTrust({
                advertisedBps: row.speed_bps, overrideBps: row.speed_override_bps,
                untrusted: row.speed_untrusted,
                inBps: hasHc ? v[0] ?? null : null,
                outBps: hasHc ? v[1] ?? null : null,
            });
            if (trust.convictNow) {
                // WRITE-IN-LOOP-OK: fires ONCE per interface, ever - the row
                // flag stops it recurring - so steady-state rate is zero.
                await OPS.markSpeedUntrusted(row.id);
                result.speedConvictions.push(`${name}: measured ${Math.round(trust.worstBps / 1e6)} Mbps `
                    + `exceeds advertised ${Math.round((row.speed_bps ?? 0) / 1e6)} Mbps - speed marked `
                    + 'untrusted, utilization suspended (set a speed override to restore it)');
            }

            // UNTRACKED MEANS NO HISTORY (2026-09-30). Slice 23's schema note
            // says tracked gates the poll's sample writes, and the poll never
            // checked it: every interface of a tracked TYPE wrote a row every
            // poll, tracked or not. On the operator's network that was 232
            // untracked interfaces against 104 tracked - two thirds of the
            // interface rows - and an access point's untracked virtual radio
            // reached the Dashboard's top errors with a chart nobody could
            // open from its device page. Counters and current values still
            // move for an untracked interface: the rekey planner reads lv_ts
            // as evidence of which generation is live, and the first rate
            // after someone tracks it must span one poll, not the months it
            // sat untracked.
            if (row.tracked) {
                result.samples.push({ entityId: row.id, ts: now, status: operStatus, rttMs: result.rttMs, v });
                trackedSampled = true;
            } else if (rttCarrier === null) {
                rttCarrier = { entityId: row.id, status: operStatus };
            }
            ifReadings.push({
                name, tracked: row.tracked, operStatus, adminStatus,
                inBps: v[0] ?? null, outBps: v[1] ?? null, inErrs: v[2] ?? null, outErrs: v[3] ?? null,
                trustedSpeedBps: row.speed_override_bps !== null && row.speed_override_bps > 0
                    ? row.speed_override_bps
                    : (row.speed_untrusted || trust.convictNow) ? null : row.speed_bps,
            });
            result.counters.push({ id: row.id, ts: now, c });
            // stale is PRESENT-WHEN-TRUE, and this list is its FRESH half:
            // an interface that answered this poll appears here, and the
            // batch write clears any went-quiet stamp. One that did not
            // answer is ABSENT - it keeps whatever values it had, and the
            // collector's markInterfacesStale sweep stamps when it went
            // quiet. Never a boolean, because a consumer must be able to
            // tell "0 bps" from "we have not heard about this port".
            result.lastValues.push({
                id: row.id, ts: now, status: operStatus, rttMs: result.rttMs, v,
            });
        }

        // The device's response time is stored on its interface rows, so a
        // device with no tracked interface (a Wi-Fi-only laptop, the
        // operator's A17) would lose its response-time chart with them. It
        // keeps ONE row per poll, on its first interface, carrying the
        // response time and no readings: no traffic or error history for an
        // interface nobody asked to watch.
        if (!trackedSampled && rttCarrier !== null) {
            result.samples.push({
                entityId: rttCarrier.entityId, ts: now, status: rttCarrier.status, rttMs: result.rttMs,
                v: [null, null, null, null, null, null],
            });
        }

        // --- sensors (the sensors slice) --------------------------------------
        //
        // TRACKED sensors only (the discovery gates exist so junk never
        // reaches samples), each polled by the instruction discovery stored:
        // the OIDs across every extra are folded into deduped, chunked GETs,
        // then sensorSample computes each entity's values pure. The rows ride
        // the SAME writeback lanes as interfaces - samples through the
        // pending batch, current values through the lastValues batch - so no
        // new write path exists to audit. status stays null except for
        // state-like kinds, which reuse the up/down ints; rttMs is null
        // because the device-level rtt already rode in on every interface
        // row and repeating it per sensor would double-count it in any
        // aggregate.
        //
        // Its own try/catch: sensors are the bonus, the poll is the product.
        try {
            const sensors = await OPS.sensorsForDevice(device.id);
            if (sensors.ok && sensors.rows.length > 0) {
                const oidSet = new Set<string>();
                for (const s of sensors.rows) {
                    const x = s.extra;
                    for (const o of x.oids ?? []) oidSet.add(o);
                    for (const o of [x.valueOid, x.usedOid, x.freeOid, x.sizeOid]) {
                        if (o !== undefined) oidSet.add(o);
                    }
                }
                const values = new Map<string, unknown>();
                const oids = [...oidSet];
                // 30 varbinds per PDU: comfortably under every agent's limit,
                // and a 4-sensor host is one GET.
                for (let i = 0; i < oids.length; i += 30) {
                    const slice = oids.slice(i, i + 30);
                    try {
                        const got = await get(session, slice);
                        for (const [k, v] of got) values.set(k, v);
                    } catch {
                        // ONE POISONED VARBIND MUST NOT STARVE THE CHUNK. Some
                        // agents (the stock Windows service among them) answer
                        // a GET containing a vanished OID with an error-status
                        // for the whole PDU rather than a per-varbind
                        // noSuchInstance - which is how the demo's DC-3 froze
                        // cpu, mem AND fs at one shared timestamp when only
                        // the CPU pins had died. Retry one at a time and let
                        // the dead OID be the only blank; the extra round
                        // trips cost only on the poll where something is
                        // already wrong, and the re-pin pass above removes
                        // the dead pin within an inventory cycle.
                        for (const oid of slice) {
                            try {
                                const got = await get(session, [oid]);
                                for (const [k, v] of got) values.set(k, v);
                            } catch { /* that one is dead; sensorSample reads it as absent */ }
                        }
                    }
                }
                for (const s of sensors.rows) {
                    const smp = sensorSample(s.kind, s.extra,
                        (oid) => values.get(oid));
                    const v = [smp.v0, smp.v1, null, null, null, null];
                    result.samples.push({
                        entityId: s.id, ts: now, status: smp.status, rttMs: null, v,
                    });
                    result.lastValues.push({
                        id: s.id, ts: now, status: smp.status, rttMs: null, v,
                    });
                    sensorReadings.push({ kind: s.kind, name: s.name, v0: smp.v0, v1: smp.v1, status: smp.status });
                }
            }
        } catch { /* a failed sensor pass costs one cycle of readings, nothing else */ }

        result.ok = true;
        result.summary = summarizeReadings(ifReadings, sensorReadings);
    } catch (err) {
        result.rttMs = Number((performance.now() - t0).toFixed(1));
        result.error = (err as Error).message;
        result.errorKind = pollErrorKind(err);

        // A session-level error explains the failure better than the timeout
        // it caused. Without this, a device sending an undecodable response
        // looks identical to a device that is switched off - and those need
        // different responses from whoever is holding the pager. Not for a
        // store failure: whatever the session last said is not why.
        if (result.errorKind !== 'store' && session.lastError !== null) {
            result.error = `${result.error} (session error: ${session.lastError.message})`;
        }
    } finally {
        session.close();
    }

    return result;
}
