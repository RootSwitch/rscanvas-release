// The removal gate's DECISIONS, with no HTTP and no database in them.
//
// WHY THIS IS ITS OWN MODULE. Bulk disable and bulk delete are the two most
// destructive things an operator can do in this product, and until now their
// entire rule set - the sentence, the threshold, the typed confirmation - lived
// inline in a route handler that cannot be imported without starting a server
// and four worker threads. That made the gate testable only by driving a live
// instance by hand, which is how it was in fact verified: once, by one person,
// recorded in prose. A rule nobody can re-run is a rule that drifts.
//
// So the decisions are pure functions over rows the store already returns. The
// route keeps the I/O and calls these for every judgement it makes, which is
// the property that matters - a test here is a test of the shipped path, not
// of a second implementation that agrees with it today.
//
// check-call-sites pins that the route is the only caller and that it has
// exactly one, so the logic cannot quietly grow a second home.

/** One row of `OPS.previewDeviceRemoval`. Counts arrive from pg as text. */
export interface PreviewRow {
    name: string;
    exists: boolean;
    enabled: boolean;
    entities: string;
    shapes: string;
    /** Board ids this device is bound on. Unioned across rows, never summed. */
    boardIds: string[];
}

export type RemovalMode = 'delete' | 'disable' | 'enable';

export interface RemovalPlan {
    mode: RemovalMode;
    found: PreviewRow[];
    missing: string[];
    entities: number;
    shapes: number;
    /** DISTINCT boards affected across the whole selection. */
    boards: number;
    /** The sentence the operator reads. Built here, rendered verbatim. */
    detail: string;
    /** The number to type, or null when a click is enough. */
    typedConfirmation: number | null;
}

/**
 * TYPE THE COUNT above this, for the irreversible verb only.
 *
 * The threshold was 20, on the reasoning that twenty is a list somebody read
 * and two hundred came from a filter. LOWERED TO 1 on 2026-08-17 at the
 * operator's request, after using it: below the old threshold a multi-device
 * delete was a single click, and a single click that removes eight devices is
 * the same reflex the typed confirmation exists to interrupt. The number of
 * devices you can still NAME is not the same as the number you can afford to
 * delete by accident.
 *
 * ONE device stays a click. That is the case where the gate's own sentence
 * already names the thing being removed, so typing "1" would add ceremony
 * without adding information.
 *
 * Exported so the test asserts the boundary rather than restating the number.
 */
export const TYPED_ABOVE = 1;

/**
 * What is about to happen, in numbers and in one sentence.
 *
 * Pure. The caller supplies the rows and the retention horizon; this decides
 * what they mean and how to say it.
 */
export function planRemoval(
    mode: RemovalMode, rows: PreviewRow[], rawRetentionDays: number,
): RemovalPlan {
    const found = rows.filter((r) => r.exists);
    const missing = rows.filter((r) => !r.exists).map((r) => r.name);
    const entities = found.reduce((a, r) => a + Number(r.entities), 0);
    const shapes = found.reduce((a, r) => a + Number(r.shapes), 0);

    // UNION, NOT SUM. Two selected devices pinned to the same board are one
    // board losing two shapes, and adding the per-device counts would report
    // two. The previous version counted neither: it counted how many of the
    // SELECTED DEVICES appear on at least one board, and called that "boards".
    const boards = new Set(found.flatMap((r) => r.boardIds)).size;

    const verb = mode === 'delete' ? 'Delete' : mode === 'enable' ? 'Re-enable' : 'Stop watching';
    const parts = [`${verb} ${found.length} device(s)`];
    if (mode === 'delete') {
        parts.push(`${entities} interface(s) will be deleted with them`);
        // The consequence nobody predicts.
        if (shapes > 0) {
            parts.push(`${shapes} shape(s) on ${boards} wall board(s) will stop binding`);
        }
        // And the one that generates a bug report if left unsaid: somebody
        // deletes eighty devices to reclaim disk and files a bug when the
        // graph does not move.
        parts.push('their history is NOT deleted - samples age out on the retention '
            + `horizon (${rawRetentionDays} days), so disk does not come back today`);
    } else if (mode === 'disable') {
        parts.push('polling stops; history, alerts and board bindings are kept, and '
            + 're-enabling puts them back');
    }
    if (missing.length > 0) parts.push(`${missing.length} name(s) matched nothing`);

    return {
        mode,
        found,
        missing,
        entities,
        shapes,
        boards,
        detail: `${parts.join('. ')}.`,
        typedConfirmation: mode === 'delete' && found.length > TYPED_ABOVE ? found.length : null,
    };
}

export type GateVerdict =
    | { proceed: true }
    | {
        proceed: false;
        status: number;
        reason: 'confirmation-required' | 'typed-confirmation-required';
        detail: string;
        typedConfirmation: number | null;
    };

/**
 * ONE INFORMATIVE GATE, not stacked dialogs.
 *
 * A confirmation prompt with no information in it is worse than no prompt -
 * it trains the operator to click through, so the next one is not read either.
 * Friction scales with blast radius instead: disable is one confirmation
 * because it is reversible, delete carries the estimate, and past TYPED_ABOVE
 * delete also asks for the number to be typed. Typing is the part that cannot
 * become reflex, and it forces the operator to have READ the count the gate
 * computed - which is the only reason computing it was worth anything.
 */
export function gateRemoval(
    plan: RemovalPlan, confirm: boolean, confirmCount: unknown,
): GateVerdict {
    if (!confirm) {
        return {
            proceed: false,
            status: 409,
            reason: 'confirmation-required',
            detail: plan.detail,
            typedConfirmation: plan.typedConfirmation,
        };
    }
    if (plan.typedConfirmation !== null && Number(confirmCount) !== plan.typedConfirmation) {
        return {
            proceed: false,
            status: 409,
            reason: 'typed-confirmation-required',
            detail: `${plan.typedConfirmation} devices is enough that this asks you to type `
                + `the number. Send confirmCount=${plan.typedConfirmation} to proceed.`,
            typedConfirmation: plan.typedConfirmation,
        };
    }
    return { proceed: true };
}

/**
 * NAMED, NOT DISCOVERED.
 *
 * The UI builds a selection from the roster's filter because that is how a
 * human finds forty switches, but what leaves the page is an explicit list of
 * names, and the server echoes it back. Same rule as drop_partitions_guarded
 * and sync-lab.sh: a filter that matched more than the operator believed is
 * how you remove the wrong forty.
 */
/**
 * `verb` exists because this is shared by four routes and the message named
 * only one of them: setting a credential on 1,001 devices told the operator
 * to "remove at most 1000 devices at a time" (2026-08-31, independent review
 * C4). Defaulted rather than required so a future caller that forgets still
 * says something true, if vague.
 */
export function normalizeNames(raw: unknown, cap: number, verb = 'act on'): {
    ok: true; names: string[];
} | { ok: false; detail: string } {
    const names = Array.isArray(raw)
        ? [...new Set(raw.map((n) => String(n)).filter((n) => n !== ''))] : [];
    if (names.length === 0) return { ok: false, detail: 'names is required' };
    if (names.length > cap) {
        return {
            ok: false,
            detail: `${verb} at most ${cap} devices at a time - you sent ${names.length}. `
                + 'Select fewer and repeat.',
        };
    }
    return { ok: true, names };
}

/** Anything that is not a recognised verb is the REVERSIBLE one. */
export function normalizeMode(raw: unknown): RemovalMode {
    return raw === 'delete' ? 'delete' : raw === 'enable' ? 'enable' : 'disable';
}
