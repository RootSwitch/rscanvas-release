// Threshold overrides, offline: row -> override, and the env/table merge.
//
//   node tools/test-thresholds.ts
//
// SLICE-THRESHOLDS-PLAN done-when 2.

import { rowScope, rowToOverride, overrideKey, mergeOverrides } from '../src/alerts/overrides.ts';
import type { RulesConfig } from '../src/alerts/rules.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? (pass++, console.log(`  ok   ${l}`))
        : (fail++, console.log(`  FAIL ${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
};
const row = (o: Partial<Parameters<typeof rowToOverride>[0]>) =>
    ({ kind: 'temp', host: null, code: null, warn: null, crit: null, enabled: true, ...o });

console.log('scope from shape:');
eq('host NULL, code NULL is kind-global', rowScope({ host: null, code: null }), 'kind');
eq('host set, code NULL is host-kind', rowScope({ host: 'sw1', code: null }), 'host-kind');
eq('code set is code, whatever host says', rowScope({ host: 'sw1', code: 'ABCD' }), 'code');
eq('an empty-string host is treated as NULL', rowScope({ host: '', code: null }), 'kind');

console.log('\nrow to override:');
eq('a kind row carries neither host nor code',
    rowToOverride(row({ enabled: false })), { scope: 'kind', kind: 'temp', code: null, host: null, warn: null, crit: null, enabled: false });
eq('a code row drops the host - the code is the identity',
    rowToOverride(row({ host: 'sw1', code: 'ABCD', warn: 60, crit: 70 })).host, null);

console.log('\nthe merge - env first, table wins:');
const env: RulesConfig = {
    thresholds: { temp: { warn: 45, crit: 55 } }, ifRules: {}, deviceDown: { enabled: true, severity: 'crit' },
    overrides: [
        { scope: 'code', code: 'ABCD', kind: 'temp', warn: 50, crit: 60, enabled: true },   // env says 50/60
        { scope: 'host-kind', host: 'old-box', kind: 'cpu', enabled: false },              // env-only mute
    ],
} as unknown as RulesConfig;
{
    const m = mergeOverrides(env, [row({ code: 'ABCD', warn: 80, crit: 90 })]);
    const o = m.overrides!.find((x) => overrideKey(x) === 'code|ABCD|temp')!;
    eq('a table row for the same target REPLACES the env override', [o.warn, o.crit], [80, 90]);
    eq('an env-only override for another target survives', m.overrides!.some((x) => overrideKey(x) === 'host|old-box|cpu'), true);
    eq('thresholds, ifRules and deviceDown pass through untouched', [m.thresholds, m.deviceDown], [env.thresholds, env.deviceDown]);
}
{
    const m = mergeOverrides(env, []);
    eq('no table rows: the env config is returned whole', m.overrides!.length, 2);
}
{
    const m = mergeOverrides({ ...env, overrides: undefined }, [row({ enabled: false })]);
    eq('no env overrides at all: the table alone', m.overrides, [{ scope: 'kind', kind: 'temp', code: null, host: null, warn: null, crit: null, enabled: false }]);
}
{
    // Two table rows at different tiers for one kind coexist - precedence is
    // the engine's job, the merge only keys them.
    const m = mergeOverrides({ ...env, overrides: [] }, [row({ enabled: false }), row({ host: 'hot', warn: 80, crit: 95 })]);
    eq('kind row and host-kind row for one kind are BOTH kept', m.overrides!.length, 2);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
