// The ghost gate: when a stale-stamped interface stops being scanned at all.
//
// The scan's freshness rule FREEZES an interface nobody has heard from -
// severity null, alert held - which is right for the transient causes
// (device outage, an index flapping out of one walk) and wrong forever for
// the permanent one: a generation corpse whose ifIndex the agent re-dealt at
// a reboot (INVESTIGATION-DUP-INTERFACES-2026-09-01). Frozen has no terminal
// state, so a corpse's if-down alert was held ACTIVE for weeks, last_seen
// refreshing on every scan, while the machinery built to end it - the
// missing-scans counter aging an absent condition out as source-removed -
// never fired, because a tracked corpse still emitted its frozen condition
// every pass.
//
// The gate is the collector's own verdict, not a new clock: lv_stale_since
// is stamped only when the DEVICE answers while this index is gone from its
// table (a failed poll stamps nothing), so a device outage never starts the
// horizon and outage-freezing is untouched. Once the stamp is older than the
// horizon, the row leaves the scan doc entirely; its conditions go missing;
// the missing-scans counter does what it always did. One filter, and the
// terminal state the freeze lacked is the one that already existed.
//
// Pure, so tools/test-ghost-aging.ts holds the boundary without a database.

/**
 * True when a row's went-quiet stamp is older than the horizon - the row is
 * a ghost and must not be scanned. An unstamped row is never a ghost, and a
 * malformed stamp reads as unstamped rather than silently ghosting a live
 * row on a parse quirk.
 */
export function isGhostInterface(
    staleSince: Date | string | null, nowMs: number, horizonMs: number,
): boolean {
    if (staleSince === null) return false;
    const stampMs = new Date(staleSince).getTime();
    if (Number.isNaN(stampMs)) return false;
    return nowMs - stampMs > horizonMs;
}
