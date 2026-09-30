// Group alerts' judgements (src/alerts/groups.ts), offline: when a group
// trips, what its condition says, and the sentence its notification carries.
// The delivery half - members held while the group is open, owed when it
// clears, their clears waived - is SQL (store/ops.ts) and is drilled live.
//
//   node tools/test-group-alerts.ts

import {
    GROUP_KIND, groupKey, parseGroupKey, groupTripped, groupConditions, groupDetail, type GroupCount,
} from '../src/alerts/groups.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

console.log('when a group trips (percent of the known AND a minimum count):');
eq('6 of 10 down at 50% and 3 trips', groupTripped(4, 6, 50, 3), true);
eq('exactly the percent trips (5 of 10 at 50%)', groupTripped(5, 5, 50, 3), true);
eq('one short of the percent does not (4 of 10 at 50%)', groupTripped(6, 4, 50, 3), false);
eq('the percent without the minimum does not (2 of 3 at 50%, minimum 3)', groupTripped(1, 2, 50, 3), false);
eq('the minimum without the percent does not (3 of 20 at 50%)', groupTripped(17, 3, 50, 3), false);
eq('a whole small group down trips when it meets the minimum (3 of 3)', groupTripped(0, 3, 50, 3), true);
eq('a group with nothing known cannot trip', groupTripped(0, 0, 50, 1), false);
eq('a minimum of 0 is treated as 1, never "trips with nothing down"', groupTripped(10, 0, 0, 0), false);
eq('100% needs every known device down', [groupTripped(1, 9, 100, 1), groupTripped(0, 9, 100, 1)], [false, true]);

console.log('\nthe condition the scan pushes, one per rule:');
const row = (over: Partial<GroupCount>): GroupCount => ({
    axis: 'location', value: 'HQ / Floor 2', enabled: true, threshold_pct: 50, min_down: 3, up: 4, down: 6, ...over,
});
{
    const [c] = groupConditions([row({})]);
    eq('keyed by axis and value', c?.key, 'group:location:HQ / Floor 2');
    eq('its own kind, and no host - it is a place, not a device', [c?.kind, c?.host], [GROUP_KIND, null]);
    eq('crit while tripped', c?.severity, 'crit');
    eq('the label says how many of how many', c?.label, 'HQ / Floor 2 (location): 6 of 10 devices down');
    eq('value is the share down, threshold the rule, in percent', [c?.value, c?.threshold, c?.unit], [60, 50, '%']);
    eq('never frozen - the counts are always a reading', c?.frozen, false);
}
eq('a healthy group is a normal reading, so an open alert clears',
    groupConditions([row({ up: 9, down: 1 })])[0]?.severity, null);
eq('a switched-off group is a normal reading even when down',
    groupConditions([row({ enabled: false })])[0]?.severity, null);
eq('a group emptied by a rename reads 0 of 0, normal',
    [groupConditions([row({ up: 0, down: 0 })])[0]?.severity, groupConditions([row({ up: 0, down: 0 })])[0]?.value], [null, 0]);
eq('an application group keys and labels as one',
    [groupConditions([row({ axis: 'application', value: 'PAM Prod' })])[0]?.key,
        groupConditions([row({ axis: 'application', value: 'PAM Prod' })])[0]?.label],
    ['group:application:PAM Prod', 'PAM Prod (application): 6 of 10 devices down']);
eq('counts arriving as text from the driver still count',
    groupConditions([row({ up: '4' as unknown as number, down: '6' as unknown as number })])[0]?.severity, 'crit');

console.log('\nkeys round-trip, even with a colon in the name:');
eq('location', parseGroupKey(groupKey('location', 'HQ')), { axis: 'location', value: 'HQ' });
eq('a value with colons', parseGroupKey(groupKey('application', 'db:prod:eu')), { axis: 'application', value: 'db:prod:eu' });
eq('a device-down key is not a group key', parseGroupKey('device:core-sw1'), null);
eq('an unknown axis is not a group key', parseGroupKey('group:site:HQ'), null);

console.log('\nthe sentence the group notification carries:');
{
    const d = groupDetail(['ap-1', 'ap-2', 'sw-3'], 50, 3);
    eq('the names, then the rule', d.startsWith('down now: ap-1, ap-2, sw-3 (trips at 50% and 3 down)'), true);
    eq('and not the count again - the label beside it says that', /d+ of d+/.test(d), false);
    eq('and what it stands in for', d.includes('their own device-down notifications are held'), true);
    const many = groupDetail(Array.from({ length: 30 }, (_, i) => `d${i}`), 50, 3);
    eq('a long list is cut at 25 and says how many more', many.includes('d24, and 5 more'), true);
    eq('and never names the 26th', many.includes('d25,'), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
