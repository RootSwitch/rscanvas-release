// What a board declares itself to be a picture OF.
//
// Same reason as devices/onboard.ts: these rules lived inline in the board
// CREATE route, and the moment a second route needed them (the update, slice
// 41) they became a drift risk rather than a paragraph. Two copies of
// "sourceAxis and sourceValues must be given together" is how one of them
// eventually stops being true, and the one that stops being true is whichever
// nobody re-reads.
//
// The I/O stays in the routes. The judgements live here, where a test can
// reach them without a server and four workers.
//
// THE INVARIANT THIS MODULE KEEPS, and it is worth stating because everything
// below is in service of it: a board either declares an axis AND what it
// covers on that axis, or it declares neither and is hand-drawn. There is no
// third state. "The location board for nothing" would make the drift check
// call every ungrouped device missing from it, and a board that quietly
// claims a whole fleet is worse than one that refuses to be made.

export type SourceAxis = 'location' | 'application';

/** null axis and null values together mean a hand-drawn board. An axis with
 *  null values means EVERY value on that axis - the all-fleet board, which is
 *  only reachable by asking for it explicitly. */
export interface SourceDeclaration {
    axis: SourceAxis | null;
    values: string[] | null;
}

export type SourceParse =
    | { ok: true; decl: SourceDeclaration }
    | { ok: false; detail: string };

/** A group name is trimmed, capped, and never empty. 32 is not a technical
 *  limit; it is the point past which a wall of sections stops being glanceable
 *  and the operator wants two boards. */
export const MAX_GROUPS = 32;
const MAX_GROUP_LEN = 120;

/**
 * Read a source declaration off a request body.
 *
 * Accepts `sourceValues` (a list - the team board, slice 27) or the older
 * `sourceValue` (one string, which becomes a list of one). `sourceValues`
 * wins when both arrive, because a caller sending both has already told us
 * which one it thinks in.
 *
 * DEDUPED, ORDER PRESERVED. Declared order IS section order on the wall, so
 * this function must never sort: the team that owns the board decided what
 * leads it. Dropping a duplicate keeps the first occurrence for the same
 * reason - it is the position the operator typed it in.
 */
export function parseSourceDeclaration(body: Record<string, unknown>): SourceParse {
    const axis: SourceAxis | null = body.sourceAxis === 'location' || body.sourceAxis === 'application'
        ? body.sourceAxis : null;

    let values: string[] | null = null;
    if (Array.isArray(body.sourceValues)) {
        const seen = new Set<string>();
        values = [];
        for (const v of body.sourceValues) {
            if (typeof v !== 'string' || v.trim() === '') {
                return { ok: false, detail: 'sourceValues must be non-empty strings' };
            }
            const t = v.trim().slice(0, MAX_GROUP_LEN);
            if (!seen.has(t)) { seen.add(t); values.push(t); }
        }
        if (values.length === 0 || values.length > MAX_GROUPS) {
            return { ok: false, detail: `sourceValues takes 1 to ${MAX_GROUPS} group names` };
        }
    } else if (typeof body.sourceValue === 'string' && body.sourceValue.trim() !== '') {
        values = [body.sourceValue.trim().slice(0, MAX_GROUP_LEN)];
    }

    // THE ALL-FLEET BOARD (slice 30): an axis with NO values means every value
    // of that axis. EXPLICIT rather than inferred from emptiness, because "I
    // meant everything" and "the field was blank" must not be the same
    // request - the second is how a board silently claims a fleet nobody
    // chose.
    const allValues = body.allValues === true;
    if (allValues && axis === null) {
        return { ok: false, detail: 'allValues needs a sourceAxis - every location, or every application' };
    }
    if (!allValues && (axis === null) !== (values === null)) {
        return {
            ok: false,
            detail: 'sourceAxis and sourceValues must be given together, or both omitted for a hand-drawn board',
        };
    }
    return { ok: true, decl: { axis, values: allValues ? null : values } };
}

/**
 * Do two declarations cover the same devices?
 *
 * ORDER-INSENSITIVE ON PURPOSE, and this is the whole reason the function
 * exists. Reordering sections is the common edit - it is what the operator
 * asked for - and it changes nothing about WHICH devices belong to the board.
 * The update route uses this to leave the board document alone on a pure
 * reorder, because regenerating it would discard any layout somebody polished
 * by hand for a change that did not need it.
 *
 * A null values list (all-fleet) only matches another null list on the same
 * axis: "every location" and "every application" are different fleets, and
 * "every location" and a list of three is a different fleet again even if
 * those three are all that exist today. Tomorrow they will not be.
 */
export function sameCoverage(a: SourceDeclaration, b: SourceDeclaration): boolean {
    if (a.axis !== b.axis) return false;
    if (a.values === null || b.values === null) return a.values === b.values;
    if (a.values.length !== b.values.length) return false;
    const sa = [...a.values].sort();
    const sb = [...b.values].sort();
    return sa.every((v, i) => v === sb[i]);
}
