// Ping loss on an outside target (slice 68, SLICE-OUTSIDE-LOSS-PLAN.md): a
// warn while its last few minutes lost too many of their pings. Off by
// default (rules.ts PING_LOSS_DEFAULT says why); the loss is on the roster,
// the device page and its timeline either way.
//
// Pure, beside changes.ts and fanstop.ts and for their reason: emitted from
// the scan, not from evaluate(), which is held against the parent suite's
// rules.js and has no parent for this. tools/test-pingloss.ts holds it.
//
// ONE CONDITION PER OUTSIDE TARGET the rule covers - a device the scan read
// a loss for - raised at or over the level and severity null under it, so
// it clears through the ordinary counters. NOT while the device is down:
// every ping lost is device-down's alert, and a second one saying 100% loss
// would only repeat it. Not for a muted device (nothing of it raises), and
// not for a transient one (its absence is declared not to be a fault).

import {
    resolveBool, buildOverrideIndex, PING_LOSS_DEFAULT,
    type Condition, type OverrideIndex, type RulesConfig, type ScanDoc,
} from './rules.ts';

export const PING_LOSS_KIND = 'ping-loss';

export function pingLossKey(name: string): string {
    return `pingloss:${name}`;
}

export function pingLossConditions(
    doc: ScanDoc, config: RulesConfig, levelPct: number, minutes: number, idx?: OverrideIndex,
): Condition[] {
    const index = idx ?? buildOverrideIndex(config.overrides);
    const out: Condition[] = [];
    for (const d of doc.devices ?? []) {
        if (!d || !d.name || d.muted === true || d.transient === true) continue;
        const loss = d.pingLossPct;
        if (typeof loss !== 'number' || !Number.isFinite(loss)) continue;
        const rule = resolveBool(index, config.pingLoss ?? PING_LOSS_DEFAULT, null, d.name, PING_LOSS_KIND);
        if (!rule) continue;
        const pct = Math.round(loss * 10) / 10;
        out.push({
            key: pingLossKey(d.name),
            severity: pct >= levelPct && d.status !== 'down' ? rule.severity : null, frozen: false,
            kind: PING_LOSS_KIND, host: d.name, code: null,
            label: `${d.name} (${d.host || '?'}) lost ${pct}% of its pings over ${minutes} minutes`,
            value: pct, threshold: levelPct, unit: '%',
        });
    }
    return out;
}
