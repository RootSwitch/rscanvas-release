// Ping loss on an outside target (slice 68): the alert's conditions,
// offline. src/alerts/pingloss.ts is pure - handed the scan's document and
// the rules - so what it decides is held here without a server.
//
//   node tools/test-pingloss.ts

import { pingLossConditions, pingLossKey, PING_LOSS_KIND } from '../src/alerts/pingloss.ts';
import { resolveRuleInfo, buildOverrideIndex, BOOL_RULE_KINDS, type RulesConfig, type ScanDoc } from '../src/alerts/rules.ts';
import { DEFAULT_RULES } from '../src/alerts/scan.ts';

let pass = 0;
let fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l}\n       got  ${g}\n       want ${w}`); }
};

const LEVEL = 10, MINUTES = 5;
const doc = (devices: ScanDoc['devices']): ScanDoc => ({ devices, interfaces: [], metrics: [] } as unknown as ScanDoc);
const on = (overrides: RulesConfig['overrides']): RulesConfig => ({ ...DEFAULT_RULES, overrides });
const fleetOn: RulesConfig = on([{ scope: 'kind', kind: PING_LOSS_KIND, enabled: true }]);
const ispA = { name: 'isp-a', host: '203.0.113.4', status: 'up', pingLossPct: 15.04 };
const sev = (cs: ReturnType<typeof pingLossConditions>) => cs.map((c) => [c.key, c.severity, c.value]);

console.log('ping loss on an outside target (slice 68)\n');

eq('a yes/no rule: an override is on or off, never levels', BOOL_RULE_KINDS.has(PING_LOSS_KIND), true);
eq('OFF by default: 15% loss raises nothing until it is turned on',
    pingLossConditions(doc([ispA]), DEFAULT_RULES, LEVEL, MINUTES), []);
eq('the device page reads it as off, from no row', resolveRuleInfo(buildOverrideIndex([]), DEFAULT_RULES, PING_LOSS_KIND, null, 'isp-a').source, 'none');

eq('on for every device: 15% over five minutes is a warn, its loss rounded to a tenth',
    sev(pingLossConditions(doc([ispA]), fleetOn, LEVEL, MINUTES)), [[pingLossKey('isp-a'), 'warn', 15]]);
eq('the label says how much, over how long',
    pingLossConditions(doc([ispA]), fleetOn, LEVEL, MINUTES)[0]?.label, 'isp-a (203.0.113.4) lost 15% of its pings over 5 minutes');
eq('exactly the level raises; under it is severity null, so an open alert clears',
    sev(pingLossConditions(doc([{ ...ispA, pingLossPct: 10 }, { ...ispA, name: 'isp-b', pingLossPct: 9.9 }]), fleetOn, LEVEL, MINUTES)),
    [[pingLossKey('isp-a'), 'warn', 10], [pingLossKey('isp-b'), null, 9.9]]);
eq('not while it is down - every ping lost is device-down\'s alert',
    sev(pingLossConditions(doc([{ ...ispA, status: 'down', pingLossPct: 100 }]), fleetOn, LEVEL, MINUTES)), [[pingLossKey('isp-a'), null, 100]]);
eq('no condition for a device that is not an outside target (no loss read)',
    pingLossConditions(doc([{ name: 'core-sw', host: '10.0.0.2', status: 'up' }, { ...ispA, pingLossPct: null }]), fleetOn, LEVEL, MINUTES), []);
eq('nothing for a muted device, or a transient one',
    pingLossConditions(doc([{ ...ispA, muted: true }, { ...ispA, name: 'Laptop', transient: true }]), fleetOn, LEVEL, MINUTES), []);
eq('on for one device: that device only',
    sev(pingLossConditions(doc([ispA, { ...ispA, name: 'public-dns', host: '198.51.100.8' }]),
        on([{ scope: 'host-kind', host: 'public-dns', kind: PING_LOSS_KIND, enabled: true }]), LEVEL, MINUTES)),
    [[pingLossKey('public-dns'), 'warn', 15]]);
eq('on for every device but off for one: its own row wins',
    sev(pingLossConditions(doc([ispA, { ...ispA, name: 'public-dns', host: '198.51.100.8' }]),
        on([{ scope: 'kind', kind: PING_LOSS_KIND, enabled: true }, { scope: 'host-kind', host: 'isp-a', kind: PING_LOSS_KIND, enabled: false }]),
        LEVEL, MINUTES)),
    [[pingLossKey('public-dns'), 'warn', 15]]);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
