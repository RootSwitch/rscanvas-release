// What a board declares itself to be a picture of (slice 41). No database,
// no server - the same posture as test-onboarding, and for the same reason:
// these rules used to live inside a route that cannot be imported without
// four worker threads, so the only way to check them was to drive a live
// instance by hand.
//
// The case that matters most is ORDER. Declared order is section order on
// the wall, so a function that helpfully sorted the list would silently
// rearrange somebody's NOC board, and no test of "did it save" would catch
// it.

import { parseSourceDeclaration, sameCoverage, MAX_GROUPS } from '../src/boards/source.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

console.log('board source declarations\n');

// --- ORDER IS PRESERVED, which is the whole feature ----------------------------
{
    const zones = ['Services', 'Data Center', 'Basement', 'First Floor', 'Second Floor'];
    const r = parseSourceDeclaration({ sourceAxis: 'location', sourceValues: [...zones] });
    if (r.ok && r.decl.values !== null && r.decl.values.join('|') === zones.join('|')) {
        ok('declared order survives verbatim - it IS the section order on the wall');
    } else bad('the group order was not preserved', r);
}
{
    // The one that would look like a helpful improvement and is not.
    const r = parseSourceDeclaration({ sourceAxis: 'location', sourceValues: ['Zulu', 'Alpha'] });
    if (r.ok && r.decl.values?.[0] === 'Zulu') ok('the list is NOT sorted - a tidy-up here rearranges a NOC wall');
    else bad('the list was sorted', r);
}
{
    const r = parseSourceDeclaration({
        sourceAxis: 'location', sourceValues: ['HQ', 'Plant', 'HQ', ' HQ '],
    });
    if (r.ok && r.decl.values?.join('|') === 'HQ|Plant') {
        ok('duplicates drop and the FIRST position wins - where the operator typed it');
    } else bad('dedupe kept the wrong occurrence or the wrong order', r);
}

// --- both or neither, the invariant the drift check depends on -----------------
{
    const a = parseSourceDeclaration({ sourceAxis: 'location' });
    const b = parseSourceDeclaration({ sourceValues: ['HQ'] });
    if (!a.ok && !b.ok) ok('an axis without groups, or groups without an axis, are both refused');
    else bad('a half-declared board was accepted', { a, b });
}
{
    const r = parseSourceDeclaration({});
    if (r.ok && r.decl.axis === null && r.decl.values === null) {
        ok('neither is the HAND-DRAWN board, and stays valid');
    } else bad('the hand-drawn case was refused', r);
}

// --- the all-fleet board is asked for, never inferred --------------------------
{
    const r = parseSourceDeclaration({ sourceAxis: 'application', allValues: true });
    if (r.ok && r.decl.axis === 'application' && r.decl.values === null) {
        ok('allValues with an axis is the all-fleet board');
    } else bad('allValues did not produce the all-fleet board', r);
}
{
    const r = parseSourceDeclaration({ allValues: true });
    if (!r.ok) ok('allValues without an axis is refused - every WHAT?');
    else bad('allValues with no axis was accepted', r);
}
{
    // The distinction that stops a blank field claiming a fleet.
    const blank = parseSourceDeclaration({ sourceAxis: 'location', sourceValues: [] });
    if (!blank.ok) ok('an EMPTY list is refused, so a blank field cannot become "everything"');
    else bad('an empty list was read as all-fleet', blank);
}

// --- bounds and hygiene --------------------------------------------------------
{
    const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => `g${i}`);
    const r = parseSourceDeclaration({ sourceAxis: 'location', sourceValues: many });
    if (!r.ok && r.detail.includes(String(MAX_GROUPS))) ok(`over ${MAX_GROUPS} groups is refused, and the cap is named`);
    else bad('the group cap did not hold', r);
}
{
    const r = parseSourceDeclaration({ sourceAxis: 'location', sourceValues: ['HQ', ''] });
    if (!r.ok) ok('an empty group name is refused rather than silently dropped');
    else bad('an empty group name survived', r);
}
{
    const r = parseSourceDeclaration({ sourceAxis: 'location', sourceValue: '  HQ  ' });
    if (r.ok && r.decl.values?.join('') === 'HQ') ok('the single-value form still works, trimmed, as a list of one');
    else bad('the legacy single value broke', r);
}

// --- sameCoverage: the reorder must be distinguishable from the retarget -------
// The route uses this to tell the operator whether the board still covers the
// devices it covered a second ago. Getting it wrong in the safe direction
// (claiming a change) is noise; getting it wrong the other way tells someone
// their board is fine when its shapes now bind the wrong fleet.
{
    const a = { axis: 'location' as const, values: ['A', 'B', 'C'] };
    const b = { axis: 'location' as const, values: ['C', 'A', 'B'] };
    if (sameCoverage(a, b)) ok('a REORDER is the same coverage - the same devices, stacked differently');
    else bad('a reorder was read as a retarget', { a, b });
}
{
    const a = { axis: 'location' as const, values: ['A', 'B'] };
    const b = { axis: 'location' as const, values: ['A', 'B', 'C'] };
    if (!sameCoverage(a, b)) ok('adding a group is NOT the same coverage');
    else bad('an added group was read as a reorder', { a, b });
}
{
    const a = { axis: 'location' as const, values: ['A'] };
    const b = { axis: 'application' as const, values: ['A'] };
    if (!sameCoverage(a, b)) ok('the same name on a different AXIS is a different fleet');
    else bad('an axis change was read as a reorder', { a, b });
}
{
    const all = { axis: 'location' as const, values: null };
    const some = { axis: 'location' as const, values: ['A', 'B'] };
    if (!sameCoverage(all, some) && sameCoverage(all, { axis: 'location' as const, values: null })) {
        ok('all-fleet matches only all-fleet - today\'s list is not tomorrow\'s');
    } else bad('all-fleet was confused with a list', { all, some });
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
