// Re-enumeration: does the planner follow the name, refuse to guess, and -
// since the re-deal judgement - heal a whole re-dealt table without splicing?
//
//   node tools/test-rekey.ts

import { planRekey, type KnownInterface } from '../src/collector/rekey.ts';

// An early exit without a verdict must read as FAILURE, not as a green run
// with no output (the test-walk incident, 2026-09-01).
process.exitCode = 1;

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n         wanted ${JSON.stringify(want)}\n         got    ${JSON.stringify(got)}`); }
};
const k = (id: string, idx: string | null, name: string,
    extra: Partial<KnownInterface> = {}): KnownInterface =>
    ({ id, snmp_index: idx, name, ...extra });
const s = (idx: string, name: string) => ({ idx, name });
// Generation shorthand: a corpse is stamped stale polls ago; the living
// generation is unstamped with a fresh reading - the exact state the
// collector's trailing stamp guarantees at planning time.
const corpse = (id: string, idx: string | null, name: string, lv: string) =>
    k(id, idx, name, { lv_stale_since: '2026-09-01T00:00:00Z', lv_ts: lv });
const living = (id: string, idx: string, name: string) =>
    k(id, idx, name, { lv_stale_since: null, lv_ts: '2026-09-01T12:00:00Z' });

console.log('the shuffle this exists for:');
{
    // Before: eth0@1 eth1@2 eth2@3. A card goes in; everything shifts by one.
    // This was the planner's documented honest edge - index-first kept the
    // occupied rows and RENAMED them across adapters. The re-deal judgement
    // (3 displaced, all of 3 eligible) now reads it as the re-enumeration it
    // is: every row follows its name, parks first so the chain of occupied
    // targets cannot trip the unique index, and nothing is spliced.
    const known = [k('a', '1', 'eth0'), k('b', '2', 'eth1'), k('c', '3', 'eth2')];
    const seen = [s('2', 'eth0'), s('3', 'eth1'), s('4', 'eth2')];
    const p = planRekey(seen, known);
    eq('a full +1 shift re-keys every entity by name now - the re-deal judgement',
        p.moves, [{ id: 'a', fromIdx: '1', toIdx: '2', name: 'eth0' },
                  { id: 'b', fromIdx: '2', toIdx: '3', name: 'eth1' },
                  { id: 'c', fromIdx: '3', toIdx: '4', name: 'eth2' }]);
    eq('the occupied targets are parked before the moves land',
        p.parks.map((x) => x.id), ['b', 'c']);
    eq('and nothing is inserted fresh', p.fresh, []);
}
{
    // The clean shift: the old indexes ALL vanish (a re-enumeration to a
    // disjoint range), which is the case that spliced history before rekey
    // existed at all.
    const known = [k('a', '4', 'eth0'), k('b', '5', 'eth1')];
    const seen = [s('7', 'eth0'), s('8', 'eth1')];
    eq('a disjoint shift re-keys every entity by name, inserts nothing',
        planRekey(seen, known),
        { moves: [{ id: 'a', fromIdx: '4', toIdx: '7', name: 'eth0' },
                  { id: 'b', fromIdx: '5', toIdx: '8', name: 'eth1' }],
          parks: [], fresh: [] });
}

console.log('\nthe generations (INVESTIGATION-DUP-INTERFACES-2026-09-01):');
{
    // the operator workstation's Ethernet 4, literally: two stamped corpses from earlier
    // re-deals plus the living generation, and a reboot re-deals again. The
    // old ambiguity rule matched NEITHER and minted a fourth generation;
    // the stamp ranking picks the one unstamped candidate.
    const known = [
        corpse('g1', '7', 'Ethernet 4', '2026-08-20T00:00:00Z'),
        corpse('g2', '8', 'Ethernet 4', '2026-08-31T00:00:00Z'),
        living('g3', '9', 'Ethernet 4'),
        living('w1', '2', 'vEthernet'),
    ];
    const seen = [s('12', 'Ethernet 4'), s('4', 'vEthernet')];
    const p = planRekey(seen, known);
    eq('the living generation wins over the stamped corpses - no fourth generation',
        p.moves, [{ id: 'g3', fromIdx: '9', toIdx: '12', name: 'Ethernet 4' },
                  { id: 'w1', fromIdx: '2', toIdx: '4', name: 'vEthernet' }]);
    eq('the corpses are not touched', p.parks, []);
    eq('nothing fresh', p.fresh, []);
}
{
    // All candidates stamped (the device was quiet longer): the strictly
    // newest reading wins - recency is the next-best evidence of identity.
    const known = [
        corpse('old', '7', 'eth0', '2026-08-01T00:00:00Z'),
        corpse('newer', '9', 'eth0', '2026-08-30T00:00:00Z'),
        living('x', '2', 'other'),
        living('y', '3', 'more'),
    ];
    const p = planRekey([s('5', 'eth0'), s('2', 'other'), s('3', 'more')], known);
    eq('among stamped candidates the strictly newest reading wins',
        p.moves, [{ id: 'newer', fromIdx: '9', toIdx: '5', name: 'eth0' }]);
}
{
    // Two genuinely LIVE twins - same name, both unstamped, readings from
    // the same batch write - tie on every rank and stay refused. A coin
    // flip here is the splice.
    const known = [living('t1', '1', 'twin'), living('t2', '2', 'twin')];
    const p = planRekey([s('9', 'twin')], known);
    eq('live twins tie and are refused, the index is fresh', p, { moves: [], parks: [], fresh: ['9'] });
}
{
    // A parked row (its index was taken in an earlier re-deal) is maximally
    // displaced; when its adapter returns on a free index, it re-keys back
    // onto its own row - code, history and alerts intact.
    const known = [corpse('p', null, 'vEthernet (WSL)', '2026-08-25T00:00:00Z'), living('n', '1', 'eth0')];
    const p = planRekey([s('6', 'vEthernet (WSL)'), s('1', 'eth0')], known);
    eq('a parked row is re-keyed back when its adapter returns',
        p.moves, [{ id: 'p', fromIdx: null, toIdx: '6', name: 'vEthernet (WSL)' }]);
}

console.log('\nthe re-deal threshold - what still reads as a re-label:');
{
    // Two live ports exchange names or indexes: below the threshold, no
    // eviction - index-first stands and the poll's rename branch treats it
    // as the re-label it usually is. The documented small-case judgement.
    const known = [k('a', '1', 'A'), k('b', '2', 'B')];
    const p = planRekey([s('1', 'B'), s('2', 'A')], known);
    eq('a two-port swap stays index-first - no moves, no parks', p, { moves: [], parks: [], fresh: [] });
}
{
    // Three displaced out of eight named entities is not a majority: still
    // not a re-deal, occupied indexes stay index-first.
    const known = [
        k('a', '1', 'p1'), k('b', '2', 'p2'), k('c', '3', 'p3'),
        k('d', '4', 'p4'), k('e', '5', 'p5'), k('f', '6', 'p6'),
        k('g', '7', 'p7'), k('h', '8', 'p8'),
    ];
    const seen = [s('1', 'p2'), s('2', 'p3'), s('3', 'p1'),
        s('4', 'p4'), s('5', 'p5'), s('6', 'p6'), s('7', 'p7'), s('8', 'p8')];
    const p = planRekey(seen, known);
    eq('a minority shuffle is not a re-deal - occupied indexes are not evicted',
        p, { moves: [], parks: [], fresh: [] });
}
{
    // The agent-transition shape: Windows indexes become small ordinals, and
    // an ordinal lands on an index a DIFFERENT adapter's row still holds.
    // Under the re-deal judgement the occupant is parked, never renamed -
    // and the parked row's own move (a chain) still lands because parks run
    // first.
    const known = [living('e4', '9', 'Ethernet 4'), living('wsl', '2', 'vEthernet'), living('eth', '17', 'Ethernet')];
    const seen = [s('2', 'Ethernet 4'), s('1', 'vEthernet'), s('3', 'Ethernet')];
    const p = planRekey(seen, known);
    eq('a reused index evicts its stale-named occupant instead of renaming it',
        p.parks.map((x) => x.id), ['wsl']);
    eq('and every adapter follows its name through the chain',
        p.moves, [{ id: 'e4', fromIdx: '9', toIdx: '2', name: 'Ethernet 4' },
                  { id: 'wsl', fromIdx: '2', toIdx: '1', name: 'vEthernet' },
                  { id: 'eth', fromIdx: '17', toIdx: '3', name: 'Ethernet' }]);
}

console.log('\nwhat must NOT be re-keyed:');
eq('a genuinely new interface with a new name is fresh',
    planRekey([s('1', 'eth0'), s('9', 'veth123')], [k('a', '1', 'eth0')]),
    { moves: [], parks: [], fresh: ['9'] });
eq('a new index whose name matches an entity that is STILL PRESENT is fresh - two ports with one name is not a move',
    planRekey([s('1', 'eth0'), s('2', 'eth0')], [k('a', '1', 'eth0')]),
    { moves: [], parks: [], fresh: ['2'] });
eq('two vanished entities sharing a name, no stamps to rank them: ambiguous, neither is re-keyed',
    planRekey([s('9', 'lo')], [k('a', '1', 'lo'), k('b', '2', 'lo')]),
    { moves: [], parks: [], fresh: ['9'] });
eq('a vanished entity is claimed at most once, even if its name arrives twice',
    planRekey([s('8', 'eth0'), s('9', 'eth0')], [k('a', '1', 'eth0')]),
    { moves: [{ id: 'a', fromIdx: '1', toIdx: '8', name: 'eth0' }], parks: [], fresh: ['9'] });
eq('a null or empty name never matches anything',
    planRekey([s('9', '')], [k('a', '1', '')]),
    { moves: [], parks: [], fresh: ['9'] });
eq('nothing seen, nothing planned', planRekey([], [k('a', '1', 'eth0')]), { moves: [], parks: [], fresh: [] });
eq('nothing known, everything fresh', planRekey([s('1', 'eth0')], []), { moves: [], parks: [], fresh: ['1'] });

console.log('\nsteady state:');
eq('every index already known: no moves, nothing fresh',
    planRekey([s('1', 'eth0'), s('2', 'eth1')], [k('a', '1', 'eth0'), k('b', '2', 'eth1')]),
    { moves: [], parks: [], fresh: [] });
eq('a rename at the same index is not this planner\'s business - index-first, no move',
    planRekey([s('1', 'renamed')], [k('a', '1', 'eth0')]),
    { moves: [], parks: [], fresh: [] });
{
    // Corpses keep a churned device permanently above the re-deal threshold,
    // and that must NOT turn an ordinary rename into an eviction: a new name
    // matches no displaced row, so index-first still answers.
    const known = [
        corpse('g1', '7', 'Ethernet 4', '2026-08-20T00:00:00Z'),
        corpse('g2', '8', 'Ethernet 4', '2026-08-25T00:00:00Z'),
        corpse('g3', null, 'vEthernet', '2026-08-25T00:00:00Z'),
        living('l1', '9', 'Ethernet 4'), living('l2', '2', 'vEthernet (new)'),
    ];
    const p = planRekey([s('9', 'Uplink'), s('2', 'vEthernet (new)')], known);
    eq('on a corpse-laden device a plain rename is still index-first, not an eviction',
        p, { moves: [], parks: [], fresh: [] });
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
