// U6's rules - onboarding and removal - as assertions that need no database.
//
// WHY THIS FILE EXISTS. U6 shipped verified in the sense a demo is verified:
// every criterion was checked once, against the live lab, by one person, and
// recorded in prose in UI-PLAN.md. Its three commits touched no test file at
// all. That left adding a device and deleting one - the two most destructive
// operator actions in the product - as the two with the least regression
// cover, which the 2026-08-14 review-doc refresh said out loud rather than
// leaving for a reviewer to notice. This is the answer to that paragraph.
//
// WHAT IT CAN AND CANNOT REACH. The properties here are the DECISIONS: what
// the gate says, when it demands a typed number, which probe results may be
// written, what the location suggestion counts. They are the shipped functions
// - src/devices/*.ts and public/parse.js are imported, never re-implemented -
// which is the dom.js argument: a copy cannot rot in the same direction as the
// original.
//
// It cannot reach the parts that are genuinely I/O, and those stay live-only:
// that a probe token is single-use and TTL'd, that the insert is atomic, that
// re-running reports "already known", that a viewer gets 403. Those are in
// UI-PLAN's evidence table and still need the lab.
//
// PROVEN ABLE TO FAIL before it was trusted, 2026-08-14 - a test that has
// never failed has never demonstrated it can. Nine defects planted one at a
// time in the shipped modules, suite re-run against each, every one caught:
//
//   selectForAdd drops the did-it-answer check      -> 5
//   TYPED_ABOVE 20 -> 200 (escalation never fires)  -> 4
//   suggestLocations counts all, not just answered  -> 4
//   boards SUMMED instead of unioned                -> 2
//   boards counts devices-on-a-board (what shipped) -> 2
//   normalizeMode falls back to DELETE              -> 2
//   normalizeNames truncates instead of refusing    -> 1
//   parseHosts loses the dedupe                     -> 1
//   the retention clause hard-coded, not from config -> 1
//
// The two `boards` rows are the ones that matter most: this suite was written
// after the extraction found that the shipped route counted how many SELECTED
// DEVICES sit on any board and reported it as "boards". Both the old shape and
// the obvious wrong fix are now planted defects rather than prose.

import {
    planRemoval, gateRemoval, normalizeNames, normalizeMode, TYPED_ABOVE,
    type PreviewRow, type RemovalMode,
} from '../src/devices/removal.ts';
import {
    suggestLocations, selectForAdd, selectForForce, locationAssignments,
    normalizeProbeRequest, probedName, addOutcome, normalizeExplicitName,
    probeStanding, standingFields, parseOnboardChoices, trackedFor, goneSensors,
    type ExistingSensor,
} from '../src/devices/onboard.ts';
// Untyped (it is browser JS), so the shape is asserted at the boundary - the
// same import shape test-render-hostile.ts uses for public/dom.js.
const { parseHosts } = await import('../public/parse.js' as string) as {
    parseHosts: (text: string) => string[];
};

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

const RETENTION = 8;

/** One preview row. Counts arrive from pg as text, so they are text here. */
const row = (name: string, over: Partial<PreviewRow> = {}): PreviewRow => ({
    name, exists: true, enabled: true, entities: '4', shapes: '0', boardIds: [], ...over,
});
const rows = (n: number, over: Partial<PreviewRow> = {}): PreviewRow[] =>
    Array.from({ length: n }, (_, i) => row(`sw-${String(i + 1).padStart(3, '0')}`, over));

const plan = (mode: RemovalMode, r: PreviewRow[]) => planRemoval(mode, r, RETENTION);

function main(): void {
    console.log('U6 offline: the onboarding and removal DECISIONS\n');

    // --- the gate's arithmetic -----------------------------------------------
    console.log('the estimate gate, and what it counts');
    {
        const p = plan('delete', [
            row('a', { entities: '12', shapes: '2', boardIds: ['7'] }),
            row('b', { entities: '30', shapes: '1', boardIds: ['7'] }),
            row('c', { entities: '1' }),
        ]);
        eq('entities are summed across the selection', p.entities, 43);
        eq('shapes are summed too - each one stops binding', p.shapes, 3);
        // THE REGRESSION THIS PINS. Two devices pinned to the same board are
        // ONE board losing two shapes. Summing per-device board counts says
        // two; the shipped code before 2026-08-14 said something else again -
        // it counted how many of the SELECTED DEVICES sit on any board, and
        // called that "boards".
        eq('boards are UNIONED, not summed - two devices on one board is one board',
            p.boards, 1);
    }
    {
        const p = plan('delete', [
            row('a', { shapes: '1', boardIds: ['7'] }),
            row('b', { shapes: '1', boardIds: ['9'] }),
            row('c', { shapes: '2', boardIds: ['7', '9'] }),
        ]);
        eq('and a device on two boards contributes both, once', p.boards, 2);
    }
    {
        const p = plan('delete', [row('a'), row('gone', { exists: false })]);
        eq('a name that matched nothing is not a device', p.found.length, 1);
        eq('and is reported rather than dropped', p.missing, ['gone']);
        if (p.detail.includes('1 name(s) matched nothing')) {
            ok('the sentence says so - a silent miss is how you delete the wrong one');
        } else bad('missing names are absent from the sentence', p.detail);
    }

    // --- the sentence, which is the whole point of the gate -------------------
    console.log('\nthe sentence the operator reads');
    {
        const d = plan('delete', [row('a', { entities: '25', shapes: '1', boardIds: ['3'] })]).detail;
        for (const want of [
            'Delete 1 device(s)',
            '25 interface(s) will be deleted with them',
            '1 shape(s) on 1 wall board(s) will stop binding',
            'history is NOT deleted',
            `retention horizon (${RETENTION} days)`,
        ]) {
            if (d.includes(want)) ok(`delete names "${want}"`);
            else bad(`delete does not name "${want}"`, d);
        }
    }
    {
        // The consequence that generates a bug report if left unsaid: somebody
        // deletes eighty devices to reclaim disk and files a bug when the
        // graph does not move. It has to come from CONFIG, not a literal.
        const d = planRemoval('delete', [row('a')], 30).detail;
        if (d.includes('(30 days)')) ok('the retention horizon comes from config, not a constant');
        else bad('the retention horizon is hard-coded', d);
    }
    {
        const d = plan('disable', [row('a'), row('b')]).detail;
        if (d.includes('Stop watching 2 device(s)') && d.includes('re-enabling puts them back')) {
            ok('disable says it is reversible, because that is why it is the default verb');
        } else bad('disable does not say it is reversible', d);
        if (!d.includes('NOT deleted')) {
            ok('and disable does not talk about deletion at all');
        } else bad('disable borrowed delete\'s wording', d);
    }
    {
        const d = plan('enable', [row('a')]).detail;
        if (d.startsWith('Re-enable 1 device(s)')) ok('enable has its own verb');
        else bad('enable did not get its own verb', d);
    }
    {
        // A device on no board must not produce "0 shape(s) on 0 wall board(s)"
        // - a clause naming a consequence that does not exist is noise in the
        // one sentence that has to be read.
        const d = plan('delete', [row('a')]).detail;
        if (!d.includes('stop binding')) ok('no boards touched means no board clause at all');
        else bad('the board clause fired with nothing bound', d);
    }

    // --- friction scales with blast radius ------------------------------------
    console.log('\nthe typed confirmation, and where its boundary is');
    {
        eq(`at the threshold (${TYPED_ABOVE}) a click is still enough`,
            plan('delete', rows(TYPED_ABOVE)).typedConfirmation, null);
        eq(`one past it (${TYPED_ABOVE + 1}) the number must be typed`,
            plan('delete', rows(TYPED_ABOVE + 1)).typedConfirmation, TYPED_ABOVE + 1);
        // Reversible verbs never escalate, however many are selected. Making
        // the reversible action as expensive as the irreversible one is how
        // both get clicked through.
        eq('disable never asks for a typed number, at any size',
            plan('disable', rows(500)).typedConfirmation, null);
        eq('nor does enable', plan('enable', rows(500)).typedConfirmation, null);
    }
    {
        // The count is of what EXISTS, not of what was asked for - otherwise
        // padding a list with typos would lower the friction.
        const p = plan('delete', [...rows(21), row('x', { exists: false })]);
        eq('the typed number counts found devices, not submitted names',
            p.typedConfirmation, 21);
    }

    // --- the gate's verdicts --------------------------------------------------
    console.log('\nthe gate itself');
    {
        const p = plan('delete', rows(3));
        const v = gateRemoval(p, false, undefined);
        eq('an unconfirmed request is refused', v.proceed, false);
        if (!v.proceed) {
            eq('with 409, not 400 - the request was well formed', v.status, 409);
            eq('and a reason the client switches on', v.reason, 'confirmation-required');
            eq('and the sentence, so the client renders rather than composes',
                v.detail, p.detail);
        }
        // THE THRESHOLD MOVED TO 1 on 2026-08-17, so a MULTI-device delete no
        // longer proceeds on a click alone. This assertion used to read "a
        // small delete proceeds" with three devices, which was the old design
        // and is now exactly what must NOT happen.
        eq('confirmed but untyped, a 3-device delete is STILL held',
            gateRemoval(p, true, undefined).proceed, false);
        eq('and typing the count releases it',
            gateRemoval(p, true, 3).proceed, true);
        // One device stays a click: the gate's own sentence already names the
        // single thing being removed, so typing "1" adds ceremony, not
        // information.
        eq('a SINGLE-device delete still proceeds on confirmation alone',
            gateRemoval(plan('delete', rows(1)), true, undefined).proceed, true);
    }
    {
        const p = plan('delete', rows(25));
        eq('above the threshold, confirm alone is not enough',
            gateRemoval(p, true, undefined).proceed, false);
        eq('a WRONG count is refused',
            gateRemoval(p, true, 24).proceed, false);
        eq('a stringly-typed right count is accepted - it came from an input box',
            gateRemoval(p, true, '25').proceed, true);
        const v = gateRemoval(p, true, 24);
        if (!v.proceed) {
            eq('the second refusal is its own reason', v.reason, 'typed-confirmation-required');
            if (v.detail.includes('confirmCount=25')) {
                ok('and it names the number rather than saying "wrong"');
            } else bad('the typed refusal does not name the number', v.detail);
        }
    }
    {
        // Confirmation cannot be inherited from a smaller preview: the verdict
        // is computed from THIS plan every time.
        // The numbers changed with the threshold; the PROPERTY did not. One
        // device is the case a click still settles, 200 is not, and the same
        // confirmed-but-untyped request must be judged against whichever plan
        // it is actually presented with.
        const small = gateRemoval(plan('delete', rows(1)), true, undefined);
        const big = gateRemoval(plan('delete', rows(200)), true, undefined);
        if (small.proceed && !big.proceed) {
            ok('the same confirmed request proceeds at 1 and is held at 200');
        } else bad('the gate is not re-evaluated per plan');
    }

    // --- named, not discovered -----------------------------------------------
    console.log('\nnamed, not discovered');
    {
        eq('an empty list is refused, not treated as "all"',
            normalizeNames([], 1000), { ok: false, detail: 'names is required' });
        eq('a missing list is refused the same way',
            normalizeNames(undefined, 1000), { ok: false, detail: 'names is required' });
        // A filter result arriving as a string would be the exact failure the
        // rule exists to prevent - one value that means "many".
        eq('a bare string is not a list', normalizeNames('sw-001', 1000).ok, false);
        const n = normalizeNames(['a', 'b', 'a', '', 'c'], 1000);
        eq('duplicates collapse and blanks are dropped',
            n.ok === true ? n.names : null, ['a', 'b', 'c']);
        eq('the cap refuses rather than truncating - a silent truncation is a '
            + 'different removal than the one confirmed',
            normalizeNames(Array.from({ length: 1001 }, (_, i) => `d${i}`), 1000).ok, false);
    }
    {
        eq('an unknown verb falls to the REVERSIBLE one', normalizeMode('destroy'), 'disable');
        eq('and so does a missing one', normalizeMode(undefined), 'disable');
        eq('delete has to be asked for by name', normalizeMode('delete'), 'delete');
        eq('enable too', normalizeMode('enable'), 'enable');
    }

    // --- a device that did not answer cannot be added -------------------------
    console.log('\nonboarding: what may be written');
    {
        const results = [
            { host: '10.0.0.1', ok: true, sysName: 'core-sw-01' },
            { host: '10.0.0.2', ok: false, error: 'timeout', errorKind: 'timeout' },
            { host: '10.0.0.3', ok: true, sysName: 'edge-sw-02' },
        ];
        const s = selectForAdd(results, null);
        eq('only what answered is written', s.write.map((r) => r.host), ['10.0.0.1', '10.0.0.3']);
        eq('and what did not is NAMED, with the reason',
            s.skipped, [{ host: '10.0.0.2', why: 'did not answer the probe' }]);

        const one = selectForAdd(results, new Set(['10.0.0.1']));
        eq('an unticked device is omitted, not reported as skipped',
            one.write.map((r) => r.host), ['10.0.0.1']);
        eq('- because 198 "not chosen" would bury the 2 that failed',
            one.skipped.length, 0);

        // The interesting case: ticked AND unreachable. Choosing it does not
        // override the probe, which is the whole point of the two-step shape.
        const forced = selectForAdd(results, new Set(['10.0.0.2']));
        eq('ticking a device that did not answer still writes nothing',
            forced.write.length, 0);
        eq('and it is still reported', forced.skipped.length, 1);

        // FORCE ADD (2026-09-01): the explicit second act, judged by its own
        // function so the normal path's refusal above stays exactly as
        // pinned. Force is a verdict on a host the operator just watched
        // fail - never a side door.
        const f = selectForForce(results, ['10.0.0.2']);
        eq('a no-answer host in the force list is written',
            f.write.map((r) => r.host), ['10.0.0.2']);
        eq('and nothing else rides along', f.skipped.length, 0);
        const smuggled = selectForForce(results, ['10.9.9.9']);
        eq('a host outside the probe is refused - force is not a side door',
            smuggled.write.length, 0);
        eq('and the refusal says so',
            smuggled.skipped[0]?.why?.includes('not part of this probe'), true);
        const answered = selectForForce(results, ['10.0.0.1']);
        eq('an ANSWERED host is refused from force - accepting it keeps its discovery',
            answered.write.length, 0);
        eq('with the better path named',
            answered.skipped[0]?.why?.includes('accept it normally'), true);
        eq('a duplicated force entry is written once',
            selectForForce(results, ['10.0.0.2', '10.0.0.2']).write.length, 1);

        eq('an empty accept set writes nothing at all - it is not "everything"',
            selectForAdd(results, new Set()).write.length, 0);
        // ok is checked with ===, so a truthy value is not an answer.
        eq('a truthy non-true ok is not an answer',
            selectForAdd([{ host: 'h', ok: 1 }], null).write.length, 0);
    }
    {
        eq('a device that names itself is stored under that name',
            probedName({ host: '10.0.0.1', sysName: 'core-sw-01' }), 'core-sw-01');
        eq('one that does not falls back to the address',
            probedName({ host: '10.0.0.9' }), '10.0.0.9');
    }

    // --- the two numbers ------------------------------------------------------
    console.log('\nthe location suggestion: two numbers before anything is created');
    {
        const results = [
            { host: 'a', ok: true, sysName: 'a', sysLocation: 'HQ / Floor 2' },
            { host: 'b', ok: true, sysName: 'b', sysLocation: 'HQ / Floor 2' },
            { host: 'c', ok: true, sysName: 'c', sysLocation: 'DR Site' },
            { host: 'd', ok: true, sysName: 'd', sysLocation: '   ' },
            { host: 'e', ok: true, sysName: 'e' },
            { host: 'f', ok: false, sysLocation: 'HQ / Floor 2' },
        ];
        const s = suggestLocations(results);
        // THE DENOMINATOR IS WHAT ANSWERED. Counting unreachable devices would
        // make a shop with a few dead hosts look undisciplined rather than
        // partly unreachable, and the whole feature is a judgement about
        // discipline.
        eq('the denominator is devices that ANSWERED, not devices submitted',
            s.answered, 5);
        eq('the numerator is those that reported a location', s.reported, 3);
        eq('whitespace is not a location', s.distinct, 2);
        eq('groups are sorted, so two runs read the same',
            s.groups.map((g) => g.value), ['DR Site', 'HQ / Floor 2']);
        eq('and each names its devices', s.groups[1]?.devices, ['a', 'b']);
        // A device that did not answer has no reading to contribute, even if
        // the object carries a stale one.
        if (!s.groups.some((g) => g.devices.includes('f'))) {
            ok('a device that did not answer contributes no location');
        } else bad('an unanswered probe leaked into a group');
    }
    {
        const s = suggestLocations([{ host: 'a', ok: true }]);
        eq('nothing reported is zero distinct, not an empty-string group', s.distinct, 0);
        eq('and no groups', s.groups.length, 0);
    }

    // --- accepting, renaming, rejecting --------------------------------------
    console.log('\nwhat the operator does with the suggestion');
    {
        const results = [
            { host: 'a', ok: true, sysName: 'a', sysLocation: 'RS Labs' },
            { host: 'b', ok: true, sysName: 'b', sysLocation: 'RS Labs' },
            { host: 'c', ok: true, sysName: 'c', sysLocation: 'Closet' },
        ];
        const added = new Set(['a', 'b', 'c']);
        eq('accepting as-is tags the group',
            locationAssignments(results, { 'RS Labs': 'RS Labs' }, added),
            [{ location: 'RS Labs', names: ['a', 'b'] }]);
        eq('RENAMING is the same decision with a different string',
            locationAssignments(results, { 'RS Labs': 'Lab Rack One' }, added),
            [{ location: 'Lab Rack One', names: ['a', 'b'] }]);
        // There is no reject verb because absence already means it.
        eq('rejecting is leaving it out - no verb needed',
            locationAssignments(results, { Closet: 'Closet' }, added).length, 1);
        eq('an empty chosen name is a rejection, not a blank location',
            locationAssignments(results, { 'RS Labs': '   ' }, added), []);
        eq('a non-string chosen name is ignored rather than stringified',
            locationAssignments(results, { 'RS Labs': 42 as unknown as string }, added), []);
        // Applied only to what was WRITTEN, so a re-run cannot retag devices
        // somebody has since moved by hand: the second run adds nothing, so it
        // tags nothing.
        eq('a re-run that added nothing tags nothing',
            locationAssignments(results, { 'RS Labs': 'Lab Rack One' }, new Set()), []);
        eq('and a partial re-run tags only what it added',
            locationAssignments(results, { 'RS Labs': 'Lab Rack One' }, new Set(['b'])),
            [{ location: 'Lab Rack One', names: ['b'] }]);
    }

    // --- the probe request ----------------------------------------------------
    console.log('\nwhat the probe route accepts');
    {
        /** The accepted request, or null if it was refused. */
        const req = (body: Record<string, unknown>, cap = 500) => {
            const r = normalizeProbeRequest(body, cap);
            return r.ok ? r.req : null;
        };
        eq('hosts are trimmed and blanks dropped',
            req({ hosts: [' 10.0.0.1 ', '', 'sw-2'] })?.hosts, ['10.0.0.1', 'sw-2']);
        eq('the default version is 2c', req({ hosts: ['h'] })?.version, '2c');
        eq('an unknown version falls back rather than being passed through',
            req({ hosts: ['h'], version: '2' })?.version, '2c');
        eq('v3 is accepted as a version', req({ hosts: ['h'], version: '3' })?.version, '3');
        eq('port 0 is not a port', req({ hosts: ['h'], port: 0 })?.port, 161);
        eq('an empty list is refused', normalizeProbeRequest({ hosts: [] }, 500).ok, false);
        eq('and the cap refuses rather than truncating',
            normalizeProbeRequest({ hosts: Array.from({ length: 501 }, () => 'h') }, 500).ok,
            false);
        eq('a credential REFERENCE has a default',
            req({ hosts: ['h'] })?.credentialRef, 'SNMP_COMMUNITY');
        // SECRETS ARE ENV-ONLY BY STANDING DECISION. There is nowhere in the
        // normalized request to put a passphrase, which is how the model stays
        // impossible to misuse rather than merely discouraged.
        const withSecret = req(
            { hosts: ['h'], community: 'public', authKey: 'hunter2', privKey: 'hunter2' });
        if (withSecret !== null && !JSON.stringify(withSecret).includes('hunter2')) {
            ok('a pasted passphrase has nowhere to land - it is dropped, not carried');
        } else bad('a secret survived normalization', JSON.stringify(withSecret));
    }

    // --- the paste box --------------------------------------------------------
    console.log('\nthe paste surface (public/parse.js, the shipped parser)');
    {
        eq('one host per line', parseHosts('10.0.0.1\n10.0.0.2\n'), ['10.0.0.1', '10.0.0.2']);
        eq('blank lines and padding are not hosts',
            parseHosts('\n  10.0.0.1  \n\n\n10.0.0.2\n'), ['10.0.0.1', '10.0.0.2']);
        eq('CRLF, because the paste came from Windows',
            parseHosts('10.0.0.1\r\n10.0.0.2\r\n'), ['10.0.0.1', '10.0.0.2']);
        eq('duplicates collapse - one device must not become two review rows',
            parseHosts('10.0.0.1\n10.0.0.1\n'), ['10.0.0.1']);
        eq('a CSV header picks the address column, and is not itself a host',
            parseHosts('Name,IP Address,Site\ncore-sw,10.0.0.1,HQ\nedge-sw,10.0.0.2,DR'),
            ['10.0.0.1', '10.0.0.2']);
        eq('hostname is an address column too',
            parseHosts('Hostname,Vendor\nsw-1,cisco\nsw-2,mikrotik'), ['sw-1', 'sw-2']);
        eq('with no header, the first field is the host',
            parseHosts('10.0.0.1,cisco\n10.0.0.2,mikrotik'), ['10.0.0.1', '10.0.0.2']);
        eq('tab-delimited, which is what a spreadsheet paste actually is',
            parseHosts('Name\tIP\ncore\t10.0.0.1'), ['10.0.0.1']);
        eq('quoted cells are unwrapped',
            parseHosts('"IP","Site"\n"10.0.0.1","HQ"'), ['10.0.0.1']);
        eq('IPv6 survives the address test',
            parseHosts('2001:db8::1\n'), ['2001:db8::1']);
        eq('a title row that is not a header is dropped by the address test, '
            + 'not turned into a failed probe',
            parseHosts('Device Inventory Export\n10.0.0.1\n'), ['10.0.0.1']);
        eq('nothing usable is an empty list, not a throw', parseHosts(''), []);
        eq('and neither is whitespace', parseHosts('   \n\t\n'), []);
    }

    console.log('\nthe sysName collision matrix (ruling 5, DECISIONS-2026-09-01):');
    {
        // The defect this pins: "already known" for both a genuine rerun and
        // a DIFFERENT host whose sysName an existing row already owns.
        // Twelve factory switches named `switch` onboarded as one; 1,235 of
        // 1,550 mock devices vanished behind the fold once. The store now
        // answers with facts; this function owns the judgement.
        const conflictWith = (h: string, p: number, same: boolean) => ({
            outcome: 'conflict', incumbent_host: h, incumbent_port: p, same_target: same,
        });
        const a1 = addOutcome('switch', '10.0.4.8', { outcome: 'added' }, false);
        eq('an inserted row is added', a1.kind, 'added');
        const a2 = addOutcome('switch', '10.0.4.7', conflictWith('10.0.4.7', 161, true), false);
        eq('same host and port is genuinely already known', a2.kind, 'known');
        if (a2.kind === 'known') eq('and says so in the historic words', a2.why, 'already known');
        const a3 = addOutcome('switch', '10.0.4.8', conflictWith('10.0.4.7', 161, false), false);
        eq('a different host claiming an owned sysName is a COLLISION', a3.kind, 'collision');
        if (a3.kind === 'collision') {
            if (a3.why.includes('10.0.4.7:161')) ok('the refusal names the incumbent');
            else bad('incumbent unnamed', a3.why);
            if (a3.why.includes('re-add 10.0.4.8 with an explicit name')) {
                ok('and states the sysName way out - re-add with an explicit name');
            } else bad('no way out named', a3.why);
        }
        // Same host, DIFFERENT port: two agents on one box are two devices.
        const a4 = addOutcome('switch', '10.0.4.7', conflictWith('10.0.4.7', 1161, false), false);
        eq('same host on a different port is still a collision', a4.kind, 'collision');
        // The typed-name variant: the operator chose it, so the way out is
        // choosing differently, not an explicit-name field they already used.
        const a5 = addOutcome('switch', '10.0.4.8', conflictWith('10.0.4.7', 161, false), true);
        if (a5.kind === 'collision' && a5.why.includes('pick a different name')
            && !a5.why.includes('explicit name')) {
            ok('an explicit-name collision says "pick a different name"');
        } else bad('typed-name wording wrong', JSON.stringify(a5));
        // The one race the store documents: incumbent committed after our
        // snapshot, zero rows. Degrades to the historic message, not a guess.
        const a6 = addOutcome('switch', '10.0.4.8', undefined, false);
        eq('zero rows degrades to the historic already-known', a6.kind, 'known');
    }

    console.log('\nthe probe table says what the add would (a device is its address AND port):');
    {
        // Found in the operator's first-15-minutes walkthrough, 2026-09-28:
        // 198.18.50.2:16100 added, then :16101 read "already known" and could
        // not be ticked, because the probe matched the address alone.
        const roster = [
            { name: 'fleet-16100', host: '198.18.50.2', snmp_port: 16100 },
            { name: 'switch', host: '10.0.4.7', snmp_port: 161 },
        ];
        eq('another port on a known address is a new device',
            probeStanding('fleet-16101', '198.18.50.2', 16101, roster), { kind: 'new' });
        eq('the same address and port is already known',
            probeStanding('fleet-16100', '198.18.50.2', 16100, roster), { kind: 'known' });
        eq('the same target renamed since is still already known, not a second device',
            probeStanding('fleet-renamed', '198.18.50.2', 16100, roster), { kind: 'known' });
        eq('an unknown address with an unknown name is new',
            probeStanding('core-1', '10.0.4.9', 161, roster), { kind: 'new' });
        // Ruling 5's collision, which the probe used to fold into "already
        // known" before the add path could name it.
        const t1 = probeStanding('switch', '10.0.4.8', 161, roster);
        eq('a name owned by another address is taken, not known', t1.kind, 'name-taken');
        if (t1.kind === 'name-taken' && t1.why.includes('10.0.4.7:161')
            && t1.why.includes('its own name')) {
            ok('and the reason names the owner and the way out');
        } else bad('name-taken reason', JSON.stringify(t1));
        const t2 = probeStanding('fleet-16100', '198.18.50.2', 16101, roster);
        eq('a name owned by another port on the same address is taken too', t2.kind, 'name-taken');
        eq('the row fields keep `known` for its readers',
            standingFields({ kind: 'known' }), { known: true, nameTaken: null });
        eq('a taken name is not known', standingFields(t1).known, false);
        // The port may arrive as a string from a driver: compared as a number.
        eq('a port read back as text still matches',
            probeStanding('x', '198.18.50.2', 16100,
                [{ name: 'y', host: '198.18.50.2', snmp_port: '16100' as unknown as number }]),
            { kind: 'known' });
    }

    console.log('\nexplicit names are held to the rename rules:');
    {
        eq('absent means no override', normalizeExplicitName(undefined), { ok: true, name: null });
        eq('blank means no override', normalizeExplicitName('   '), { ok: true, name: null });
        eq('a name is trimmed', normalizeExplicitName('  sw-b  '), { ok: true, name: 'sw-b' });
        const long = normalizeExplicitName('x'.repeat(121));
        eq('121 characters is refused, as rename refuses it', long.ok, false);
        const ctrl = normalizeExplicitName(`sw${String.fromCharCode(7)}b`);
        eq('control characters are refused, as rename refuses them', ctrl.ok, false);
        // A malformed override REFUSES rather than silently falling back to
        // the colliding sysName - the silent fallback would re-manufacture
        // the exact ambiguity this exists to resolve.
        const wrong = normalizeExplicitName(42);
        eq('a non-string override is refused, never ignored', wrong.ok, false);
    }

    // THE TWO ADD-STEP CHOICES (2026-10-02). Absent is today's behaviour,
    // so a script that never heard of them gets what it got before; a typo
    // is refused, because "manul" quietly arming 48 ports is the failure.
    console.log('\nthe add step\'s two choices:');
    {
        eq('absent means all ports, alerts on', parseOnboardChoices({}),
            { ok: true, choices: { track: 'all', linkDown: 'on' } });
        eq('both chosen', parseOnboardChoices({ track: 'active', linkDownAlerts: 'manual' }),
            { ok: true, choices: { track: 'active', linkDown: 'manual' } });
        eq('a misspelt link-down choice is refused, not defaulted to on',
            parseOnboardChoices({ linkDownAlerts: 'manul' }).ok, false);
        eq('a misspelt track choice is refused', parseOnboardChoices({ track: 'up' }).ok, false);
        eq('a non-string is refused', parseOnboardChoices({ track: 1 }).ok, false);

        const port = (oper: number | null | undefined, tracked = true, kind = 'if') => ({ kind, tracked, operStatus: oper });
        eq('all: a down port stays tracked, as today', trackedFor(port(2), 'all'), true);
        eq('active: an up port is tracked', trackedFor(port(1), 'active'), true);
        eq('active: a down port is not', trackedFor(port(2), 'active'), false);
        eq('active: dormant is not up', trackedFor(port(5), 'active'), false);
        eq('active: notPresent is not up', trackedFor(port(6), 'active'), false);
        eq('active: lowerLayerDown is not up', trackedFor(port(7), 'active'), false);
        // ONLY AN EXPLICIT ANSWER UNTICKS - the connector test's safety rule.
        eq('active: no status from the agent keeps the default', trackedFor(port(null), 'active'), true);
        eq('active: a status never read keeps the default', trackedFor(port(undefined), 'active'), true);
        eq('active: unknown(4) is no answer, and keeps the default', trackedFor(port(4), 'active'), true);
        // It only ever unticks.
        eq('active never TICKS a port the discovery rule left out', trackedFor(port(1, false), 'active'), false);
        eq('a sensor is not a port - active leaves it alone', trackedFor(port(null, true, 'cpu'), 'active'), true);
        eq('an entity with no kind is an interface (the add route\'s own default)',
            trackedFor({ tracked: true, operStatus: 2 }, 'active'), false);
    }

    // SENSORS THE AGENT NO LONGER SERVES (2026-10-02, the operator desktop's GPU swap):
    // gone needs two witnesses - unlisted by the probe AND no reading - so a
    // walk that failed cannot untrack a live sensor.
    console.log('\nrediscover and the sensors that left:');
    {
        const s = (name: string, kind: string, idx: string, tracked: boolean, v: number | null): ExistingSensor =>
            ({ code: `C-${name}`, name, kind, snmp_index: idx, tracked, lv_v0: v });
        const existing = [
            s('Util: fan-GPU0', 'gauge', 'ext-util-fan-GPU0', true, null),    // the 5090's fan
            s('Temp: GPU1', 'temp', 'ext-temp-GPU1', true, 69),                // still served
            s('Temp: GPU7', 'temp', 'ext-temp-GPU7', true, 50),                // unlisted, still reads
            s('Power: old', 'power', 'ext-power-old', false, null),            // already untracked
            s('eth9', 'if', '9', true, null),                                  // an interface
        ];
        const probed = [{ kind: 'temp', snmpIndex: 'ext-temp-GPU1' }, { kind: 'fan', snmpIndex: 'ext-fan-GPU1' }];
        const g = goneSensors(existing, probed);
        eq('the dead fan reading is untracked', g.untrack.map((x) => x.name), ['Util: fan-GPU0']);
        eq('an unlisted sensor that still reads is named, not untracked', g.stillAnswering.map((x) => x.name), ['Temp: GPU7']);
        eq('a sensor the probe lists is left alone, reading or not',
            goneSensors([s('Temp: GPU1', 'temp', 'ext-temp-GPU1', true, null)], probed).untrack.length, 0);
        eq('identity is kind AND index: the same index under another kind is not a match',
            goneSensors([s('Util: GPU1', 'gauge', 'ext-temp-GPU1', true, null)], probed).untrack.length, 1);
        // A WALK THAT FAILED returns no sensors at all: every live one still
        // has its reading, so nothing is untracked.
        const live = existing.filter((x) => x.lv_v0 !== null);
        eq('an empty probe untracks no sensor that is reading', goneSensors(live, []).untrack.length, 0);
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
