// Re-enumeration: when an interface's ifIndex changes, follow the NAME.
//
// Entities are keyed by (device, kind, snmp_index), and for interfaces the
// index is ifIndex - which the hardware can renumber. A PCIe re-enumeration
// after a card is installed, a firmware update, or on some platforms a plain
// reboot, shifts every ifIndex by one, and the poll's index-only match then
// did something worse than losing history: it SPLICED it. eth2 arriving on
// index 5 matched the entity that used to be index 5, was quietly renamed to
// eth2 (the poll treats a name change at the same index as a re-label), and
// inherited a series that belongs to a different port. The entity that used to
// be eth2 at index 4 was simply never seen again and went stale. Every graph
// still looked continuous. Nothing said anything.
//
// ifName is the value that IS stable across re-enumeration; that is what it is
// for. So when an index arrives that the database has never seen, and its
// ifName belongs to an entity whose own index did NOT arrive this poll, the
// honest reading is that the entity MOVED, and the fix is to re-key it - keep
// the row, its code, its history, its tracked flag and its speed trust, and
// change only snmp_index. The stable code minted from (device, name) stays
// bound to the interface it was minted for, which is what a board annotation
// needs.
//
// WHAT THIS DELIBERATELY DOES NOT DO. Below the re-deal threshold it never
// re-keys by name when the old index is still present with a different name
// - two ports genuinely swapping names is a re-label, and the index-first
// rule stays. And it never re-keys sensors: LM-SENSORS names are usually
// stable, but "usually" is not the standard for splicing history, and a
// temperature sensor's identity is a separate decision worth its own
// measurement rather than a free ride on this one.
//
// MEASURED AT FLEET SCALE, 2026-08-18, on 50 devices x 8 interfaces:
//
//   SHIFT +100 (disjoint - every old index vanishes)
//     400/400 re-keyed, 400/400 (id, code, name) preserved, 0 fresh rows,
//     0 stale, 400 log lines. Complete.
//
//   SHIFT +1 (indexes 2..8 stay OCCUPIED under different names)
//     was this planner's honest edge: 50/400 re-keyed, the occupied rows
//     kept by index-first and RENAMED across adapters - the splice, by
//     design, because one poll could not tell "every index shifted" from
//     "seven ports swapped names".
//
// THE RE-DEAL JUDGEMENT (2026-09-01) is the extension that header said the
// +1 shape would need: when at least three named entities are displaced AND
// they are a majority of the device's named entities, most names moved
// together - a reboot re-dealing every index (the RSNMPAgent generation
// evidence in INVESTIGATION-DUP-INTERFACES-2026-09-01, and the one-time
// transition to that agent's persistent numbering), not an operator
// re-labelling most of a switch at once. Under a re-deal the name is allowed
// to EVICT: the wrong-named occupant of a reused index is parked
// (snmp_index NULL, never renamed across adapters) and the rightful row
// moves in, parks before moves so chains and cycles of reuse cannot trip
// the unique index. Below the threshold nothing evicts and a two-port swap
// still reads as a re-label - that judgement is unchanged, it just now has
// the device-level signal the per-row view lacked.
//
// GENERATIONS are the second 2026-09-01 change: a name held by several
// displaced entities was "ambiguous, match neither", which was correct
// until duplicate generations existed - and then the corpses of the first
// re-deal locked every later one out, minting more corpses each boot. The
// collector's lv_stale_since stamp resolves what the count could not: it
// trails a re-deal by one successful poll, so at planning time the living
// generation is the unique unstamped candidate and every older corpse is
// stamped. The winner must be strictly better than the runner-up; two
// genuinely live twins tie (their readings land in one batch write) and
// stay refused.
//
// Pure, so tools/test-rekey.ts holds it against a faked shuffle.

export interface SeenInterface { idx: string; name: string }
export interface KnownInterface {
    id: string; snmp_index: string | null; name: string | null;
    /**
     * The generation evidence (INVESTIGATION-DUP-INTERFACES-2026-09-01),
     * optional so a caller without it gets exactly the pre-generations
     * planner. lv_stale_since is the collector's went-quiet stamp; lv_ts is
     * the last reading. Together they rank same-name candidates: the stamp
     * trails a re-deal by exactly one successful poll, so at the moment a
     * plan is drawn the LIVING generation is the unique unstamped candidate
     * and every corpse from an earlier re-deal already wears its stamp.
     */
    lv_stale_since?: Date | string | null;
    lv_ts?: Date | string | null;
}

export interface RekeyPlan {
    /** Existing entity id -> the ifIndex it now lives at. */
    moves: Array<{ id: string; fromIdx: string | null; toIdx: string; name: string }>;
    /**
     * Rows whose index must be FREED before the moves run: occupants of a
     * re-dealt index whose own adapter went elsewhere (or away). Parked
     * (snmp_index NULL) rather than renamed in place, because renaming a
     * row to the name of a DIFFERENT adapter is the splice this module
     * exists to prevent. Executed first, so chains and cycles of index
     * reuse cannot trip the unique (device, kind, snmp_index) constraint.
     */
    parks: Array<{ id: string; fromIdx: string; name: string }>;
    /** Indexes that are new AND matched nothing by name: insert as before. */
    fresh: string[];
}

const ms = (v: Date | string | null | undefined): number =>
    v === null || v === undefined ? 0 : new Date(v).getTime();

/**
 * Decide, for the indexes this poll reported, which are re-keyed entities and
 * which are genuinely new.
 *
 * `seen` is every interface the agent reported this poll (index and ifName).
 * `known` is every interface entity the database holds for the device.
 */
export function planRekey(seen: SeenInterface[], known: KnownInterface[]): RekeyPlan {
    const knownByIdx = new Map<string, KnownInterface>();
    for (const k of known) if (k.snmp_index !== null) knownByIdx.set(k.snmp_index, k);

    // Entities that are NO LONGER WHERE THEY WERE - the only candidates for
    // having moved. "Vanished" is not "its index is absent": in a shift-by-one
    // the old index is still present, now carrying a DIFFERENT name. The
    // first draft of this tested index absence alone and could not re-key
    // eth2 in exactly the scenario the module exists for. So an entity is
    // displaced if its index is gone, now reports another name, or was
    // parked by an earlier plan (snmp_index NULL - an adapter that returns
    // a boot after its index was taken re-keys back onto its old row).
    const seenNameAt = new Map(seen.map((x) => [x.idx, x.name]));
    const displaced = (k: KnownInterface): boolean => {
        if (k.snmp_index === null) return true;
        const nowAt = seenNameAt.get(k.snmp_index);
        return nowAt === undefined || nowAt !== k.name;
    };
    const displacedByName = new Map<string, KnownInterface[]>();
    let eligible = 0;
    let displacedCount = 0;
    for (const k of known) {
        if (k.name === null || k.name === '') continue;
        eligible++;
        if (!displaced(k)) continue;
        displacedCount++;
        const list = displacedByName.get(k.name);
        if (list) list.push(k);
        else displacedByName.set(k.name, [k]);
    }

    // THE DEVICE-LEVEL JUDGEMENT the original header said a +1 shift would
    // need: when MOST of the device's names moved together, this is a
    // RE-DEAL (a reboot re-dealing every index - the RSNMPAgent generation
    // evidence, or the one-time transition to its persistent numbering),
    // not a re-label, and the name is allowed to evict a row from a reused
    // index. Below the threshold nothing evicts: two live ports exchanging
    // names or indexes keeps today's index-first reading (a re-label), which
    // is the documented judgement for the small case. Three displaced and a
    // majority, so a two-port swap can never qualify on its own.
    const redeal = displacedCount >= 3 && displacedCount * 2 > eligible;

    // A name held by several displaced entities was "ambiguous, match
    // neither" - correct until generations existed, and then every future
    // re-deal was locked out by the corpses of the previous ones, minting
    // MORE corpses each boot. The stamp ranking resolves what the count
    // could not: corpses carry lv_stale_since (stamped polls ago) and the
    // living generation does not, so the unique unstamped-and-freshest
    // candidate wins. The winner must be STRICTLY better than the runner-up
    // on (stamp, last-reading) - two genuinely live twins tie on both (their
    // readings land in the same batch write) and stay refused, because a
    // coin flip here splices two ports' histories.
    const winner = (name: string, exclude: Set<string>): KnownInterface | null => {
        const cands = (displacedByName.get(name) ?? []).filter((k) => !exclude.has(k.id));
        if (cands.length === 0) return null;
        if (cands.length === 1) return cands[0]!;
        const rank = (k: KnownInterface): [number, number] =>
            [k.lv_stale_since === null || k.lv_stale_since === undefined ? 0 : 1, -ms(k.lv_ts)];
        const sorted = [...cands].sort((a, b) => {
            const [as, at] = rank(a); const [bs, bt] = rank(b);
            return as - bs || at - bt;
        });
        const [ws, wt] = rank(sorted[0]!);
        const [rs, rt] = rank(sorted[1]!);
        if (ws === rs && wt === rt) return null;   // tie: refuse, never guess
        return sorted[0]!;
    };

    const moves: RekeyPlan['moves'] = [];
    const parks: RekeyPlan['parks'] = [];
    const fresh: string[] = [];
    const claimed = new Set<string>();
    for (const s of seen) {
        const occ = knownByIdx.get(s.idx);
        if (occ && occ.name === s.name) continue;      // steady state: same row, same name
        if (occ) {
            // The index is OCCUPIED by a row whose name went elsewhere. Under
            // a re-deal, if the arriving name has a rightful row, the
            // occupant is a different adapter wearing a reused index: park
            // it and move the rightful row in. Otherwise this stays what it
            // always was - index-first, the poll's rename branch treats it
            // as a re-label - including every below-threshold case.
            if (!redeal) continue;
            const cand = winner(s.name, claimed);
            if (cand === null || cand.id === occ.id) continue;
            claimed.add(cand.id);
            parks.push({ id: occ.id, fromIdx: s.idx, name: occ.name ?? '' });
            moves.push({ id: cand.id, fromIdx: cand.snmp_index, toIdx: s.idx, name: s.name });
            continue;
        }
        // A free index: the pre-generations rule, plus the ranking.
        const cand = winner(s.name, claimed);
        if (cand) {
            claimed.add(cand.id);
            moves.push({ id: cand.id, fromIdx: cand.snmp_index, toIdx: s.idx, name: s.name });
        } else {
            fresh.push(s.idx);
        }
    }
    return { moves, parks, fresh };
}
