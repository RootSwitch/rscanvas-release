// The single data-access module.
//
// ARCHITECTURE.md rule 1: no SQL outside here, and every query is a named
// operation declaring its lane and both timeouts. A handler has no way to
// obtain a connection except by naming an operation - that is what makes the
// lanes real rather than documented.
//
// It is also the insurance policy against the engine choice. The genuinely
// non-portable parts of Postgres are small and knowable, and confining them to
// one module is what keeps SQLite-versus-Postgres a two-way door.

// RULE 1 IS STRUCTURAL HERE, NOT CONVENTIONAL.
//
// `onLane` and `laneQuery` are deliberately NOT re-exported. They were, and
// that made rule 1's claim - "a handler has NO WAY to obtain a connection
// except by naming an operation" - a convention one import away from not
// existing. The first crack had already appeared: residency.ts ran inline SQL
// through `laneQuery('jobs', ...)` on a path reachable from an HTTP request,
// choosing its own lane at the call site.
//
// Anything needing the database names an operation in ops.ts. The two callers
// that genuinely need raw access - the schema applier and the guard test - go
// through `internalUnsafeLane` below, which is named so that reaching for it is
// a decision rather than an autocomplete.
export { LANES, ALL_LANES, type Lane, type LaneSpec, type ExhaustionPolicy } from './lanes.ts';
export {
    laneState,
    allLaneStates,
    closeAll,
    storeFailureLane,
    storeRefusal,
    type Timing,
    type Outcome,
    type Refused,
} from './pool.ts';

/**
 * Raw lane access, for schema application and the guard tests only.
 *
 * Named to be conspicuous in a diff. Everything a request path needs is a named
 * operation; this exists because DDL and the retention guard test genuinely
 * cannot be expressed as one, not as a general escape hatch.
 *
 * If a handler ever imports this, that is the finding.
 */
export { onLane as internalUnsafeLane } from './pool.ts';
export { copyEscape, copyLine, stripNul } from './copy.ts';
export {
    OPS,
    GRID_FIELDS,
    GRID_DEFAULT_FIELDS,
    UI_PAGE_CAP,
    UI_DEVICE_ENTITY_CAP,
    copyMessages,
    exportProbe,
    streamExportCsv,
    copySamples,
    type SampleRow,
    type MessageRow,
    type CopyResult,
    type ExportProbeResult,
    type StreamExportResult,
    type SearchFilters,
    type SearchRefusal,
    type MessageHit,
    type AlertRecord,
} from './ops.ts';
