// The reconcile verbs (DECISIONS-2026-09-01 ruling 8), offline.
//
// Same posture as test-board-source and test-onboarding: the judgements are
// imported from src/boards/reconcile.ts, never re-implemented, and the
// route's I/O (the drift query, the write, the audit) stays live-only. What
// this file pins is the half that decides: what a rebuild mints, where an
// append lands, and - the load-bearing one - what a drop REFUSES to touch.
//
//   node tools/test-board-reconcile.ts

import {
    generatedShapes, appendMissing, dropMoved,
    GRID_COLS, GRID_PITCH_X, GRID_PITCH_Y, SHAPE_W, SHAPE_H,
    type BoardShape,
} from '../src/boards/reconcile.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

console.log('the reconcile verbs, offline\n');

console.log('generatedShapes - rebuild IS creation with the id kept:');
{
    const s = generatedShapes(['a', 'b', 'c', 'd', 'e', 'f']);
    eq('one shape per device', s.length, 6);
    eq('creation parity: first shape', s[0],
        { id: 'g1', x: 0, y: 0, w: SHAPE_W, h: SHAPE_H, kind: 'device', label: 'a', bind: 'a' });
    eq('the sixth wraps to the second formality row',
        [s[5]!.x, s[5]!.y], [0, GRID_PITCH_Y]);
    eq('columns advance at the creation pitch', s[1]!.x, GRID_PITCH_X);
    eq('an empty group is an empty document, not an error', generatedShapes([]), []);
}

console.log('\nappendMissing - arrival is the machine\'s, placement is the human\'s:');
{
    const drawn: BoardShape[] = [
        { id: 'cc-7', x: 40, y: 900, w: 120, h: 60, bind: 'core-sw', note: 'hand-placed' },
        { id: 'g2', x: 0, y: 0, w: 190, h: 100, bind: 'edge-sw' },
    ];
    const r = appendMissing(drawn, ['new-1', 'new-2']);
    eq('the existing shapes pass through byte-identical', r.shapes.slice(0, 2), drawn);
    eq('and the arrivals are reported', r.added, ['new-1', 'new-2']);
    const rowY = r.shapes[2]!.y;
    // 900 + 60 = 960 bottom; floor(960 / 130) + 1 = row 8 -> y 1040.
    eq('arrivals land in the first empty formality row BELOW the drawing',
        rowY, (Math.floor(960 / GRID_PITCH_Y) + 1) * GRID_PITCH_Y);
    eq('in creation-pitch columns', r.shapes[3]!.x, GRID_PITCH_X);
    eq('ids continue past the highest g<n> present', r.shapes[2]!.id, 'g3');
    const ids = r.shapes.map((s) => s.id);
    eq('and no id is ever reused', new Set(ids).size, ids.length);
}
{
    const r = appendMissing([], ['only']);
    eq('appending to an empty board starts at the origin', [r.shapes[0]!.x, r.shapes[0]!.y], [0, 0]);
}
{
    const r = appendMissing([{ id: 'x', bind: 'a' }], []);
    eq('nothing missing appends nothing', r.added, []);
    eq('and leaves the document alone', r.shapes.length, 1);
}
{
    // More arrivals than one row: the run wraps WITHIN the appended block.
    const r = appendMissing([{ id: 'g9', x: 0, y: 0 }], ['a', 'b', 'c', 'd', 'e', 'f']);
    const startY = r.shapes[1]!.y as number;
    eq('a six-device run wraps to a second appended row',
        r.shapes[6]!.y, startY + GRID_PITCH_Y);
    eq('past a taken g<n>, ids keep climbing', r.shapes[1]!.id, 'g10');
}

console.log('\ndropMoved - removes exactly what it names, and NOTHING else:');
{
    const shapes: BoardShape[] = [
        { id: '1', bind: 'stays', x: 5 },
        { id: '2', bind: 'moved', x: 6 },
        { id: '3', label: 'Rack 4', note: 'an annotation with no bind' },
        { id: '4', bind: 'moved', x: 7 },
        { id: '5', bind: 'deleted-dev' },
    ];
    const r = dropMoved(shapes, new Set(['moved', 'deleted-dev']));
    eq('shapes bound to leavers go, ALL of them - each is a box that would lie',
        r.removedShapes, 3);
    eq('the dropped devices are reported once each, sorted',
        r.dropped, ['deleted-dev', 'moved']);
    // THE SURVIVAL RULE, and it is the half that decides whether this verb
    // is safe on a hand-adorned board: a shape with no bind is not ABOUT
    // any device and must pass through untouched.
    eq('an unbound annotation survives', r.shapes[1], shapes[2]);
    eq('and a shape still in the group survives byte-identical', r.shapes[0], shapes[0]);
}
{
    const r = dropMoved([{ id: '1', bind: 'a' }], new Set());
    eq('an empty leaver set drops nothing', r.removedShapes, 0);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
