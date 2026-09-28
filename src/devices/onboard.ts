// Onboarding's DECISIONS: what a probe result means, and what gets written.
//
// Same reason as removal.ts - these rules lived inline in a route that cannot
// be imported without a server and four workers, so the only way to check them
// was to drive a live instance by hand. The I/O stays in the route; the
// judgements live here, where a test can reach them.
//
// The property this module exists to keep honest is U6's central claim:
// **a device that did not answer cannot be added.** That is enforced in two
// places - the add route accepts a probe TOKEN rather than an address, which
// is the route's job, and `selectForAdd` refuses any result that did not
// answer, which is this module's. The token half needs a live server. This
// half does not, and it is the half that decides.

/**
 * The fields onboarding reads off a probe result.
 *
 * Deliberately structural and loose: the worker returns plain objects across a
 * thread boundary, so this describes what is READ rather than what is sent.
 */
export interface ProbedDevice {
    /**
     * Indexed because the worker's reply crosses a thread boundary as a plain
     * object and the route carries the whole thing through to the insert. This
     * module reads four fields; it must not narrow away the rest.
     */
    [k: string]: unknown;
    host?: unknown;
    ok?: unknown;
    sysName?: unknown;
    sysLocation?: unknown;
}

/** A probed device's name: what it calls itself, else what we called it. */
export function probedName(r: ProbedDevice): string {
    return String(r.sysName ?? r.host);
}

export interface LocationGroup { value: string; devices: string[] }

export interface LocationSuggestion {
    /** How many devices answered at all. The denominator. */
    answered: number;
    /** Of those, how many reported a location. The numerator. */
    reported: number;
    /** How many distinct values those were. The number that decides it. */
    distinct: number;
    groups: LocationGroup[];
}

/**
 * THE TWO NUMBERS, computed before anything is created.
 *
 * sysLocation is an ONBOARDING ACCELERATOR for shops that already keep the
 * field tidy, and it has to cost everyone else nothing. So the whole design is
 * two numbers an operator reads in one glance: "405 of 450 devices reported 4
 * distinct locations" is an obvious yes, "38 of 450 reported 31" is an obvious
 * no, and the product never has to guess whether this shop is disciplined.
 *
 * Devices that did not answer are excluded entirely - they have no reading to
 * report, and counting them in the denominator would make a shop with a few
 * unreachable hosts look undisciplined rather than partly unreachable.
 *
 * sysLocation is DEVICE-CONTROLLED, which is why this only ever produces a
 * SUGGESTION. The operator-assigned column is written with what a human
 * confirmed; see sql/slice11.sql.
 */
export function suggestLocations(results: ProbedDevice[]): LocationSuggestion {
    const answered = results.filter((r) => r.ok === true);
    const byLocation = new Map<string, string[]>();
    for (const r of answered) {
        const loc = String(r.sysLocation ?? '').trim();
        if (loc === '') continue;
        const list = byLocation.get(loc) ?? [];
        list.push(probedName(r));
        byLocation.set(loc, list);
    }
    const distinct = [...byLocation.keys()];
    return {
        answered: answered.length,
        reported: [...byLocation.values()].reduce((a, l) => a + l.length, 0),
        distinct: distinct.length,
        groups: distinct.sort().map((v) => ({ value: v, devices: byLocation.get(v) ?? [] })),
    };
}

export interface AddSelection<T> {
    /** In probe order, and every one of these answered. */
    write: T[];
    /** Named, with the reason, because the report IS the feature. */
    skipped: Array<{ host: string; why: string }>;
}

/**
 * Which probed devices get written, and which are refused and why.
 *
 * Three outcomes, and they are deliberately not the same:
 *
 * * NOT ACCEPTED - the operator did not tick it. Omitted silently, because it
 *   was never proposed; reporting it as "skipped" would bury the two that
 *   failed under two hundred that were simply not chosen.
 * * DID NOT ANSWER - refused, and named. This is the property the whole
 *   two-step shape exists for.
 * * accepted and answered - written.
 *
 * `accept` of null means "all that answered", which is the common case and is
 * still bounded by the probe the operator just read.
 */
export function selectForAdd<T extends ProbedDevice>(
    results: T[], accept: Set<string> | null,
): AddSelection<T> {
    const write: T[] = [];
    const skipped: Array<{ host: string; why: string }> = [];
    for (const r of results) {
        const host = String(r.host);
        if (accept !== null && !accept.has(host)) continue;
        if (r.ok !== true) { skipped.push({ host, why: 'did not answer the probe' }); continue; }
        write.push(r);
    }
    return { write, skipped };
}

/**
 * FORCE ADD (2026-09-01, from the operator's LibreNMS comparison): which
 * no-answer hosts get added anyway, as PENDING rows discovered on first
 * contact.
 *
 * The refusal of unanswered hosts is the two-step shape's central property
 * and it STAYS the default - the operator's own habit of powering up every
 * guest machine before discovery is what this answers, and the answer is an
 * explicit second act, never a softening of the first. Two rules keep the
 * force door honest:
 *
 * - A host not in THIS probe is refused: force is not a way to smuggle an
 *   arbitrary address past the probe, it is a verdict on a host the
 *   operator just watched fail.
 * - A host that ANSWERED is refused from the force list: forcing it would
 *   silently discard the probe data the normal path would have written,
 *   and "accept it normally" is strictly better in every case.
 *
 * A forced row is created with its credential and nothing else - no
 * entities, no sys facts, last_seen_ts NULL - and the machinery that fills
 * it already exists: the poller retries it on the down-lane cadence, and
 * the first successful poll discovers interfaces, inventory and sensors
 * exactly as it would for any device whose tables it has never seen. Until
 * then the ONE status definition reads it as 'pending', which is why a
 * forced host that stays dark raises no device-down alert: down is a
 * verdict about a device we have seen, and this one has only ever been a
 * promise.
 */
export function selectForForce<T extends ProbedDevice>(
    results: T[], force: string[],
): AddSelection<T> {
    const byHost = new Map(results.map((r) => [String(r.host), r]));
    const write: T[] = [];
    const skipped: Array<{ host: string; why: string }> = [];
    const seen = new Set<string>();
    for (const raw of force) {
        const host = String(raw);
        if (seen.has(host)) continue;
        seen.add(host);
        const r = byHost.get(host);
        if (r === undefined) {
            skipped.push({ host, why: 'not part of this probe - force adds a host you just watched fail, not a new address' });
            continue;
        }
        if (r.ok === true) {
            skipped.push({ host, why: 'answered the probe - accept it normally so its discovery is kept' });
            continue;
        }
        write.push(r);
    }
    return { write, skipped };
}

export interface LocationAssignment { location: string; names: string[] }

/**
 * The accepted location groups, resolved to the devices actually written.
 *
 * The client sends back a map of { reportedValue: chosenName } - so accepting
 * is one decision, RENAMING is the same decision with a different string, and
 * REJECTING is leaving the value out. There is no reject verb because absence
 * already means it.
 *
 * Resolved against `added` only, so a re-run cannot retag devices somebody has
 * since moved by hand: the second run adds nothing, so it tags nothing.
 */
export function locationAssignments(
    results: ProbedDevice[], accepted: Record<string, unknown>, added: Set<string>,
): LocationAssignment[] {
    const out: LocationAssignment[] = [];
    for (const [reported, chosen] of Object.entries(accepted)) {
        if (typeof chosen !== 'string' || chosen.trim() === '') continue;
        const names = results
            .filter((r) => String(r.sysLocation ?? '').trim() === reported)
            .map((r) => probedName(r))
            .filter((n) => added.has(n));
        if (names.length === 0) continue;
        out.push({ location: chosen.trim(), names });
    }
    return out;
}

/**
 * What the insert's conflict arm reports. Structural and loose for the same
 * reason as ProbedDevice: rows cross the store boundary as plain objects.
 */
export interface InsertOutcomeRow {
    [k: string]: unknown;
    outcome?: unknown;
    incumbent_host?: unknown;
    incumbent_port?: unknown;
    same_target?: unknown;
}

export type AddOutcome =
    | { kind: 'added' }
    | { kind: 'known'; why: string }
    | { kind: 'collision'; why: string };

/**
 * What one add's outcome row MEANS, and the refusal it earns (ruling 5,
 * DECISIONS-2026-09-01). The store answers with facts - inserted, or the
 * incumbent's host:port and whether it is the same target; this function
 * owns the judgement, so tools/test-onboarding.ts can pin the whole matrix
 * without a database.
 *
 * The two ways out differ by who chose the name, and the refusal says the
 * one that applies: a sysName collision is resolved by re-adding with an
 * explicit name (the operator never chose "switch"; twelve factory-default
 * switches did), while an explicit-name collision is resolved by picking a
 * different one. NOTHING is ever auto-renamed - names are identity, codes
 * are minted from them, and those codes live in .xcanvas files on other
 * people's disks.
 *
 * An undefined row is the one race the store documents (the incumbent
 * committed after our snapshot): it degrades to the HISTORIC generic
 * message rather than to a guess about an incumbent we cannot see.
 */
export function addOutcome(
    name: string, host: string, row: InsertOutcomeRow | undefined, explicitName: boolean,
): AddOutcome {
    if (row === undefined) return { kind: 'known', why: 'already known' };
    if (row.outcome === 'added') return { kind: 'added' };
    if (row.same_target === true) return { kind: 'known', why: 'already known' };
    const at = `${String(row.incumbent_host ?? '?')}:${String(row.incumbent_port ?? '?')}`;
    return {
        kind: 'collision',
        why: `device name ${JSON.stringify(name)} already belongs to the device at ${at}`
            + (explicitName
                ? ' - rename that device, or pick a different name'
                : ` - rename that device, or re-add ${host} with an explicit name`),
    };
}

/** A roster row as the probe compares against it. */
export interface KnownDeviceRow { name: string; host: string; snmp_port: number }

export type ProbeStanding =
    | { kind: 'new' }
    | { kind: 'known' }
    | { kind: 'name-taken'; why: string };

/**
 * What the probe table says about one probed host BEFORE anything is added -
 * the same judgement addOutcome makes after the insert, so the two cannot
 * disagree.
 *
 * A device is its TARGET, address and port together. The probe used to call
 * a host known if any device had its address, or any device had its name,
 * and greyed the row out. That hid two different devices:
 *
 * - a second agent on the same address at another port (a NAT gateway
 *   forwarding ports to the boxes behind it, one agent per container, a
 *   lab's mock fleet): found by the operator's own walkthrough, 2026-09-28,
 *   adding 198.18.50.2:16101 after :16100;
 * - a different target whose sysName a device already owns - the twelve
 *   factory-default `switch`es of ruling 5, which the add path has named as
 *   a collision since 2026-09-01 while the probe went on folding them into
 *   "already known" and never let the add path see them.
 *
 * Same target is known whatever it is called now (an operator may have
 * renamed it). A taken name on another target is its own outcome, with the
 * way out: an explicit name for this one, or a rename of that one.
 */
export function probeStanding(
    name: string, host: string, port: number, known: KnownDeviceRow[],
): ProbeStanding {
    if (known.some((k) => k.host === host && Number(k.snmp_port) === port)) return { kind: 'known' };
    const owner = known.find((k) => k.name === name);
    if (owner === undefined) return { kind: 'new' };
    return {
        kind: 'name-taken',
        why: `device name ${JSON.stringify(name)} already belongs to the device at `
            + `${owner.host}:${owner.snmp_port} - give this one its own name, or rename that device`,
    };
}

/** A standing as the probe response's row fields: `known` kept for its readers. */
export function standingFields(s: ProbeStanding): { known: boolean; nameTaken: string | null } {
    return { known: s.kind === 'known', nameTaken: s.kind === 'name-taken' ? s.why : null };
}

/**
 * The device-name control-character class, OWNED HERE: C0 (0x00-0x1f) plus
 * DEL (0x7f). The rename route consumed its own regex-literal copy of this
 * rule for one day before AUDIT-2026-09-01 finding 3 caught the pair -
 * two byte-identical definitions minted by the commit that was fixing the
 * two-definitions class - and now both name paths call
 * normalizeExplicitName below, pinned by check-call-sites. CONSTRUCTED
 * rather than written as a regex literal because the literal form has
 * twice arrived in a source file as the raw bytes it names rather than as
 * escapes - which charcheck then rightly refuses - and a class built from
 * char codes cannot be collapsed that way by any editing layer.
 */
const CONTROL_CHARS = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

/**
 * One host's explicit-name override from the add body's `names` map -
 * `{ "<probed host>": "<chosen name>" }`, the same accept-by-map shape the
 * location suggestion uses. Held to the SAME rules as the rename route,
 * because an add-time name and a rename land in the same column: at most
 * 120 characters, no control characters. Absent or blank means no
 * override; a malformed value is REFUSED rather than silently ignored,
 * because a typo'd override that quietly falls back to the colliding
 * sysName re-manufactures the exact ambiguity this exists to resolve.
 */
export function normalizeExplicitName(
    v: unknown,
): { ok: true; name: string | null } | { ok: false; detail: string } {
    if (v === undefined || v === null) return { ok: true, name: null };
    if (typeof v !== 'string') return { ok: false, detail: 'an explicit name must be a string' };
    const name = v.trim();
    if (name === '') return { ok: true, name: null };
    if (name.length > 120) return { ok: false, detail: 'a device name is at most 120 characters' };
    if (CONTROL_CHARS.test(name)) {
        return { ok: false, detail: 'a device name cannot contain control characters' };
    }
    return { ok: true, name };
}

export interface ProbeRequest {
    hosts: string[];
    version: '1' | '2c' | '3';
    port: number;
    credentialRef: string;
}

/**
 * What the probe route accepts, and what it silently will not.
 *
 * A CREDENTIAL REFERENCE, never a secret. Secrets are env-only in this fork by
 * standing decision, so an operator pasting SNMPv3 auth and priv passphrases
 * into this request is a shape the route does not offer - there is nowhere in
 * `ProbeRequest` to put one. The reference model exists precisely to make that
 * impossible rather than discouraged.
 */
export function normalizeProbeRequest(
    body: Record<string, unknown>, cap: number,
): { ok: true; req: ProbeRequest } | { ok: false; detail: string } {
    const hosts = Array.isArray(body.hosts)
        ? body.hosts.map((h) => String(h).trim()).filter((h) => h !== '') : [];
    if (hosts.length === 0) return { ok: false, detail: 'hosts is required' };
    if (hosts.length > cap) {
        return { ok: false, detail: `probe at most ${cap} hosts at a time` };
    }
    return {
        ok: true,
        req: {
            hosts,
            version: body.version === '1' ? '1' : body.version === '3' ? '3' : '2c',
            port: Number(body.port) || 161,
            credentialRef: typeof body.credentialRef === 'string' && body.credentialRef !== ''
                ? body.credentialRef : 'SNMP_COMMUNITY',
        },
    };
}
