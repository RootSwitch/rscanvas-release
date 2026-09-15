// How many slots each poll lane may claim on one dispatch pass (slice 47).
//
// Split out of the scheduler because it is the arithmetic that decides
// whether a fleet gets polled at all, and the scheduler itself cannot be
// imported without a database and four worker threads. The same split as
// boards/source.ts and health/work.ts, for the same reason.
//
// WHAT WENT WRONG WITHOUT IT. There was one candidate query for both
// populations, ordered by how overdue each device was. Down devices are
// retired only as fast as the down cap allows, so they are permanently the
// most overdue rows in the table and permanently the head of that ordering;
// the caller skipped the ones it could not give a slot, which consumed a
// candidate and freed nothing. Measured at 30k with 78 of 1,550 devices
// dead: 44 of 48 candidates were dead devices, 1,048 live devices sat due,
// throughput fell 77%, and 20 of 24 slots stayed idle the whole time.
//
// THE ORDER OF THE TWO LANES IS DELIBERATE and is the part most likely to be
// "tidied" later. Down is dispatched FIRST, because it is the lane with a
// cap bounded below the pool and therefore the one that cannot do any damage
// by going first: half the pool by default since C6 (downCap below), never
// all of it, so the worst it can do is leave the answering fleet the other
// half - which the 30k box measured as eight times what that fleet uses.
// Dispatch live first instead and a busy fleet fills every slot on every
// pass, no down device is ever retried, and a device that comes back stays
// marked down forever - a quieter bug than the one this replaces and harder
// to see, because the fleet looks healthy while a corner of it is
// permanently wrong.

/**
 * The down lane's cap, resolved once at startup (C6, 2026-09-06).
 *
 * PROPORTIONAL BY DEFAULT: half the pool, the rule the parent poller used.
 * The hardcoded 4 it replaces was a sixth of the stock pool and a sixteenth
 * of the 64 the 30k run was once mitigated to, and the cost of a small cap
 * is not throughput - it is how long a dead device that has RECOVERED waits
 * to be noticed. The lane retires cap / timeout devices per second (a dead
 * poll holds its slot for SNMP_TIMEOUT_MS x (SNMP_RETRIES + 1), 10 s stock),
 * so a dead population of N cycles every N x 10 / cap seconds: 78 dead at 4
 * is ~195 s, which the 30k box reported as a 159 s worst poll lag; at 12 it
 * is ~65 s; at 32, the default for a pool of 64, ~24 s.
 *
 * What half the pool costs the answering fleet was measured on the same box
 * before choosing it: live polls p50 29 ms / p95 229 ms, so 1,472 live
 * devices at 30 s occupy about 2.5 slots of the 20 they had, and at every
 * sampled instant all four polls in flight were dead devices. The live lane
 * is not where the slots are needed.
 *
 * An explicit POLL_DOWN_CONCURRENCY still wins, inside the pool. A cap at or
 * above the pool is REFUSED rather than clamped: down is dispatched first,
 * so on a dead-heavy fleet it would take every slot and the answering fleet
 * would get none - the starvation slice 47 exists to prevent, arriving by
 * configuration instead of by query order.
 */
export function downCap(concurrency: number, explicit: number | null): number {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`POLL_CONCURRENCY must be a positive integer, got ${concurrency}`);
    }
    const ceiling = Math.max(1, concurrency - 1);
    if (explicit === null) return Math.min(ceiling, Math.max(1, Math.floor(concurrency / 2)));
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > ceiling) {
        throw new Error(`POLL_DOWN_CONCURRENCY=${explicit} must be an integer from 1 to ${ceiling} `
            + '(POLL_CONCURRENCY - 1): the down lane is dispatched first, and a cap covering the '
            + 'whole pool would leave the answering fleet nothing');
    }
    return explicit;
}

/**
 * Slots the DOWN lane may use now: whatever is free, capped by its own
 * concurrency and by what it already holds.
 *
 * Never negative, and never larger than the free pool - a cap raised above
 * POLL_CONCURRENCY must not let the down lane claim slots that do not exist.
 */
export function downBudget(
    inFlight: number, inFlightDown: number, concurrency: number, downConcurrency: number,
): number {
    const free = concurrency - inFlight;
    const downRoom = downConcurrency - inFlightDown;
    return Math.max(0, Math.min(free, downRoom));
}

/**
 * Slots the LIVE lane may use, which is simply everything still free.
 *
 * Called AFTER the down lane has dispatched, so `inFlight` already includes
 * anything it took. Live is not capped separately on purpose: the fleet that
 * answers should be able to use the whole pool, and the only thing standing
 * between it and the pool is the down lane's small reservation.
 */
export function liveBudget(inFlight: number, concurrency: number): number {
    return Math.max(0, concurrency - inFlight);
}
