// A change to what a device is (slice 66): its OS, hardware model or boot
// firmware moved from one known value to another (sql/slice66.sql records
// each in the poll's own write). Every change is on the device's timeline;
// this is the optional alert, off by default (rules.ts DEVICE_CHANGE_DEFAULT
// says why).
//
// Pure, beside fanstop.ts and tempchange.ts and for their reason: emitted
// from the scan, not from evaluate(), which is held against the parent
// suite's rules.js and has no parent for this. tools/test-identity.ts holds
// it.
//
// THE SHAPE IS A RESTART'S (slice 62), deliberately: one condition per
// device the rule covers, raised while the last change is younger than
// CHANGE_HOLD_S and severity null after, so it clears through the ordinary
// counters, and the scan settles that clear without an email - nothing
// recovered, time passed. Not for a muted device (nothing of it raises),
// not for a TRANSIENT one (a laptop's updates are its declared life), and
// not for a change inside a maintenance window, decided when it was
// recorded.

import {
    resolveBool, buildOverrideIndex, DEVICE_CHANGE_DEFAULT, CHANGE_HOLD_S,
    type Condition, type OverrideIndex, type RulesConfig, type ScanDoc,
} from './rules.ts';

export const DEVICE_CHANGE_KIND = 'device-change';

export function deviceChangeKey(name: string): string {
    return `devchange:${name}`;
}

export function deviceChangeConditions(doc: ScanDoc, config: RulesConfig, idx?: OverrideIndex): Condition[] {
    const index = idx ?? buildOverrideIndex(config.overrides);
    const out: Condition[] = [];
    for (const d of doc.devices ?? []) {
        if (!d || !d.name || d.muted === true || d.transient === true) continue;
        const rule = resolveBool(index, config.deviceChange ?? DEVICE_CHANGE_DEFAULT, null, d.name, DEVICE_CHANGE_KIND);
        if (!rule) continue;
        const age = d.changeAgeS;
        const recent = typeof age === 'number' && Number.isFinite(age) && age >= 0 && age < CHANGE_HOLD_S;
        // The words ride on past the hold, so the label a clear writes is the
        // label the raise wrote.
        const text = (d.changeText ?? '').trim();
        out.push({
            key: deviceChangeKey(d.name),
            severity: recent && d.changePlanned !== true ? rule.severity : null, frozen: false,
            kind: DEVICE_CHANGE_KIND, host: d.name, code: null,
            label: `${d.name} (${d.host || '?'}) changed${text !== '' ? `: ${text}` : ''}`,
            value: null, threshold: null, unit: '',
        });
    }
    return out;
}
