// Board reconciliation: the VERB the drift detection never had.
//
// The boards list has detected drift, quantified it and named it per board
// since slice 41 - "12 moved away, 3 missing, 2 point at nothing" - and
// offered View, Displays and Delete beside the number. An operator who
// reassigned a fleet (which is exactly what a first real assignment pass IS)
// got a correct, specific, actionable-sounding count and no action: their
// only routes were delete-and-recreate, which revokes every display token,
// or hand-editing the document. DECISIONS-2026-09-01 ruling 8 names the fix:
// three explicit verbs, each a deliberate operator action, never automatic,
// with the board id - and therefore its tokens - surviving all three.
//
// Same posture as devices/onboard.ts and boards/source.ts: the I/O stays in
// the route, the judgements live here where tools/test-board-reconcile.ts
// can reach them without a server. The route feeds this module the SAME
// drift query the boards list reports from, so reconciling drives that
// exact report to zero by construction rather than by a second opinion.
//
// A shape is UNTYPED jsonb from the board document. Only two facts about one
// are ever read here - its `bind` and its geometry - and everything else a
// shape carries (annotations, styling, CrossCanvas fields) must pass through
// byte-identical. The document is the operator's; these verbs edit exactly
// what they name and nothing else.

export type BoardShape = Record<string, unknown>;

/** The creation-time formality grid, extracted from the create route so the
 *  two sites cannot drift: 5 columns at a 210 x 130 pitch, 190 x 100 boxes.
 *  This is generation, not layout - the glance grid ignores the coordinates
 *  entirely; they exist so the DRAWN mode stays renderable. */
export const GRID_COLS = 5;
export const GRID_PITCH_X = 210;
export const GRID_PITCH_Y = 130;
export const SHAPE_W = 190;
export const SHAPE_H = 100;

/** A fresh board document's shapes for a device list, exactly as board
 *  creation has always minted them. Rebuild IS creation with the id kept. */
export function generatedShapes(names: string[]): BoardShape[] {
    return names.map((name, i) => ({
        id: `g${i + 1}`,
        x: (i % GRID_COLS) * GRID_PITCH_X,
        y: Math.floor(i / GRID_COLS) * GRID_PITCH_Y,
        w: SHAPE_W,
        h: SHAPE_H,
        kind: 'device',
        label: name,
        bind: name,
    }));
}

export interface AppendResult { shapes: BoardShape[]; added: string[] }

/**
 * ADD THE MISSING: append shapes for devices now matching the source.
 *
 * Placement is BELOW everything that exists, in fresh formality-grid rows -
 * "placement is the human's, arrival is the machine's" (ruling 8). On a
 * sectioned glance grid the coordinates are ignored and the projection
 * derives each tile's section from the device's LIVE axis value, so an
 * appended bare bind joins its section with no geometry mattering; on a
 * hand-drawn board the new arrivals render as an unarranged row under the
 * drawing, which is the honest rendering of "these arrived, nobody has
 * placed them".
 *
 * Ids stay unique against whatever the document already uses - its own g<n>
 * series, CrossCanvas ids, anything - by continuing past the highest g<n>
 * present and skipping collisions. An id is never reused: shapes carry no
 * cross-references today, but a duplicate id is the kind of latent wrong
 * that surfaces the day something adds one.
 */
export function appendMissing(shapes: BoardShape[], names: string[]): AppendResult {
    if (names.length === 0) return { shapes, added: [] };
    const usedIds = new Set(shapes.map((s) => String(s.id ?? '')));
    let nextN = 1;
    for (const id of usedIds) {
        const m = /^g([0-9]+)$/.exec(id);
        if (m) nextN = Math.max(nextN, Number(m[1]) + 1);
    }
    // The first empty formality row below everything currently drawn. floor,
    // not round: a shape at y=129 occupies row 0 visually, and starting the
    // appended row inside it would stack new tiles onto hand-placed ones.
    let bottom = 0;
    for (const s of shapes) {
        const far = (Number(s.y) || 0) + (Number(s.h) || SHAPE_H);
        if (far > bottom) bottom = far;
    }
    const startRow = shapes.length === 0 ? 0 : Math.floor(bottom / GRID_PITCH_Y) + 1;
    const appended = names.map((name, i) => {
        let id = `g${nextN}`;
        while (usedIds.has(id)) { nextN++; id = `g${nextN}`; }
        usedIds.add(id);
        nextN++;
        return {
            id,
            x: (i % GRID_COLS) * GRID_PITCH_X,
            y: (startRow + Math.floor(i / GRID_COLS)) * GRID_PITCH_Y,
            w: SHAPE_W,
            h: SHAPE_H,
            kind: 'device',
            label: name,
            bind: name,
        };
    });
    return { shapes: [...shapes, ...appended], added: names };
}

export interface DropResult { shapes: BoardShape[]; dropped: string[]; removedShapes: number }

/**
 * DROP THE MOVED: remove shapes bound to devices that no longer match the
 * declared source - which includes devices that no longer exist at all, the
 * drift query's `extra` and `broken` sets together - and NOTHING else.
 *
 * The survival rule is the load-bearing half: a shape with no bind (a text
 * label, a zone, an annotation box) is not ABOUT any device and must pass
 * through untouched, and so must every shape bound to a device still in the
 * group, byte-identical, placement and all. A device bound by more than one
 * shape loses every one of them - each is a box that would lie.
 */
export function dropMoved(shapes: BoardShape[], gone: ReadonlySet<string>): DropResult {
    const kept: BoardShape[] = [];
    const dropped = new Set<string>();
    for (const s of shapes) {
        const bind = typeof s.bind === 'string' ? s.bind : null;
        if (bind !== null && gone.has(bind)) { dropped.add(bind); continue; }
        kept.push(s);
    }
    return {
        shapes: kept,
        dropped: [...dropped].sort(),
        removedShapes: shapes.length - kept.length,
    };
}
