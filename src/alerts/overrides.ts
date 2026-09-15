// Threshold overrides: rows from the table become the engine's Override[],
// merged UNDER the env-var config so an operator who set ALERT_RULES_JSON is
// not broken and one who never did gets a UI.
//
// Pure. tools/test-thresholds.ts holds the merge.

import type { Override, RulesConfig } from './rules.ts';

/** One row of threshold_overrides, as the store returns it. */
export interface OverrideRow {
    kind: string;
    host: string | null;
    code: string | null;
    warn: number | null;
    crit: number | null;
    enabled: boolean;
}

/** Which engine scope a row is, from which of host/code it carries. */
export function rowScope(r: Pick<OverrideRow, 'host' | 'code'>): Override['scope'] {
    if (r.code !== null && r.code !== '') return 'code';
    if (r.host !== null && r.host !== '') return 'host-kind';
    return 'kind';
}

export function rowToOverride(r: OverrideRow): Override {
    const scope = rowScope(r);
    return {
        scope, kind: r.kind,
        code: scope === 'code' ? r.code : null,
        host: scope === 'host-kind' ? r.host : null,
        warn: r.warn, crit: r.crit, enabled: r.enabled,
    };
}

/** The identity an override is keyed on, for the merge. */
export function overrideKey(o: Override): string {
    return o.scope === 'code' ? `code|${o.code}|${o.kind}`
        : o.scope === 'host-kind' ? `host|${o.host}|${o.kind}`
        : `kind|${o.kind}`;
}

/**
 * Env config plus table rows. TABLE WINS on the same target - a row the
 * operator just saved on the page must beat a JSON value they set months ago
 * and may have forgotten. Everything else from the env survives untouched:
 * thresholds, ifRules, deviceDown, and env overrides for targets the table
 * does not name.
 */
export function mergeOverrides(base: RulesConfig, rows: OverrideRow[]): RulesConfig {
    const byKey = new Map<string, Override>();
    for (const o of base.overrides ?? []) byKey.set(overrideKey(o), o);
    for (const r of rows) { const o = rowToOverride(r); byKey.set(overrideKey(o), o); }
    return { ...base, overrides: [...byKey.values()] };
}
