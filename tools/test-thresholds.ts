// Threshold overrides, offline: row -> override, and the env/table merge.
//
//   node tools/test-thresholds.ts
//
// SLICE-THRESHOLDS-PLAN done-when 2.

import { rowScope, rowToOverride, overrideKey, mergeOverrides } from '../src/alerts/overrides.ts';
import type { RulesConfig, Override } from '../src/alerts/rules.ts';
import { evaluate, buildOverrideIndex, resolveRuleInfo, IF_RULE_KINDS } from '../src/alerts/rules.ts';

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

// --- resolveRuleInfo AGAINST THE ENGINE (2026-09-23) --------------------------
//
// The device page's interface badge and the alert detail's MUTED line both
// come from resolveRuleInfo. Their claim is "this rule raises nothing", and
// the only honest test of that claim is the engine itself. So for each
// override arrangement, an interface breaching ALL FOUR rules and a CPU
// breaching its default are evaluated, and "muted" from the resolver must
// equal "no condition of that kind" from evaluate() - per kind, per case.
console.log('\nresolveRuleInfo agrees with evaluate():');
{
    const base: RulesConfig = {
        thresholds: { cpu: { warn: 80, crit: 90 } },
        ifRules: {
            down: { enabled: true, severity: 'crit' },
            errors: { warn: 1, crit: 10 }, discards: { warn: 5, crit: 50 }, util: { warn: 80, crit: 95 },
        },
        deviceDown: { enabled: true, severity: 'crit' },
        overrides: [],
    };
    const doc = {
        devices: [{ name: 'sw1', host: '192.0.2.1', status: 'up' }],
        interfaces: [{ id: 'sw1:1', code: 'IFAA', name: 'Gi0/1', device: { name: 'sw1', status: 'up' },
            adminStatus: 'up', operStatus: 'down', speedBps: 1e9, inBps: 9.9e8, outBps: 0,
            inErrorsPerSec: 100, outErrorsPerSec: 0, inDiscardsPerSec: 100, outDiscardsPerSec: 0 }],
        metrics: [{ code: 'CPU1', host: 'sw1', kind: 'cpu', value: 99 }],
    };
    const cases: Array<[string, Override[]]> = [
        ['no overrides', []],
        ['code mute on if-down', [{ scope: 'code', code: 'IFAA', kind: 'if-down', enabled: false }]],
        ['code mute on all four', IF_RULE_KINDS.map((k) => ({ scope: 'code' as const, code: 'IFAA', kind: k, enabled: false }))],
        ['host-kind mute on if-errors', [{ scope: 'host-kind', host: 'sw1', kind: 'if-errors', enabled: false }]],
        ['kind mute on if-util', [{ scope: 'kind', kind: 'if-util', enabled: false }]],
        ['a mute on ANOTHER interface', [{ scope: 'code', code: 'IFZZ', kind: 'if-down', enabled: false }]],
        ['code levels on if-util (99/100)', [{ scope: 'code', code: 'IFAA', kind: 'if-util', warn: 99, crit: 100, enabled: true }]],
        ['code mute on the cpu sensor', [{ scope: 'code', code: 'CPU1', kind: 'cpu', enabled: false }]],
        // MANUAL LINK-DOWN (2026-10-02): the device-wide mute the add step
        // writes, and the same with this port turned back on.
        ['manual link-down (host-kind if-down mute)', [{ scope: 'host-kind', host: 'sw1', kind: 'if-down', enabled: false }]],
        ['manual link-down, this port turned on', [
            { scope: 'host-kind', host: 'sw1', kind: 'if-down', enabled: false },
            { scope: 'code', code: 'IFAA', kind: 'if-down', enabled: true },
        ]],
    ];
    let judged = 0;
    for (const [name, overrides] of cases) {
        const cfg = { ...base, overrides };
        const idx = buildOverrideIndex(overrides);
        const cs = evaluate(doc as never, cfg);
        for (const k of [...IF_RULE_KINDS, 'cpu']) {
            const code = k === 'cpu' ? 'CPU1' : 'IFAA';
            const info = resolveRuleInfo(idx, cfg, k, code, 'sw1');
            const cond = cs.find((c) => c.code === code && c.kind === k);
            eq(`${name}: ${k} muted=${info.muted} matches the engine`, info.muted, cond === undefined);
            if (cond && info.levels && cond.severity !== null) {
                judged++;
                const want = cond.severity === 'crit' ? info.levels.crit : info.levels.warn;
                eq(`${name}: ${k} levels are the ones the engine judged against`, cond.threshold, want);
            }
        }
    }
    // The fixture must actually breach, or "no condition" would be true for
    // every kind and the comparison above would prove nothing.
    eq('the fixture breaches: leveled conditions were judged in every unmuted case', judged > 20, true);
    const idx = buildOverrideIndex([]);
    eq('if-down resolves as a yes/no rule - no levels', resolveRuleInfo(idx, base, 'if-down', 'IFAA', 'sw1'),
        { source: 'default', muted: false, levels: null });
    eq('device-down keys by host and resolves too',
        resolveRuleInfo(buildOverrideIndex([{ scope: 'host-kind', host: 'sw1', kind: 'device-down', enabled: false }]),
            base, 'device-down', null, 'sw1').muted, true);
    // The turned-on port must actually RAISE, not merely resolve as unmuted:
    // the row is yes/no, so the engine must take the default severity from it.
    const manualOn: Override[] = [
        { scope: 'host-kind', host: 'sw1', kind: 'if-down', enabled: false },
        { scope: 'code', code: 'IFAA', kind: 'if-down', enabled: true },
    ];
    const raised = evaluate(doc as never, { ...base, overrides: manualOn })
        .find((c) => c.code === 'IFAA' && c.kind === 'if-down');
    eq('a port turned on under a manual device raises crit', raised?.severity, 'crit');
    const other = evaluate({ ...doc, interfaces: [{ ...doc.interfaces[0], id: 'sw1:2', code: 'IFBB', name: 'Gi0/2' }] } as never,
        { ...base, overrides: manualOn }).find((c) => c.code === 'IFBB' && c.kind === 'if-down');
    eq('and a port NOT turned on raises nothing', other, undefined);
    eq('the device-level answer (no code) is the manual mute, from the host tier',
        resolveRuleInfo(buildOverrideIndex(manualOn), base, 'if-down', null, 'sw1'),
        { source: 'host override', muted: true, levels: null });
    eq('a kind the engine never evaluates answers none, even with a row naming it',
        resolveRuleInfo(buildOverrideIndex([{ scope: 'code', code: 'IFAA', kind: 'if-bogus', enabled: false }]),
            base, 'if-bogus', 'IFAA', 'sw1').source, 'none');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
