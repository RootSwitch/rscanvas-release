// Process-level safety net for every thread.
//
// WHY THIS EXISTS. The store deliberately rethrows anything that is not
// lane-busy or statement-timeout, because a dead database must fail loud rather
// than be papered over. That is right. What was wrong is where those throws
// landed: several call sites fire a store call with `void` and no rejection
// handler, so the throw becomes an unhandled rejection - and on Node 22 that is
// FATAL by default.
//
// The failure it produced was disproportionate and crossed the isolation
// boundary the whole fork exists to build:
//
//   Postgres restarts for five seconds. Within one second the collector's
//   1s dispatch tick rejects unhandled. The collector worker dies. main.ts
//   treats a worker error as FATAL and exits the process. The INGEST worker -
//   which was correctly buffering datagrams through the same blip, and would
//   have flushed them all when the database came back - is killed with up to
//   50,000 accepted, unwritten rows.
//
// A blip the design absorbs everywhere else became a full outage plus a
// never-drop violation, because one unrelated worker did not attach a .catch.
// The lanes isolate slow queries; they do not isolate a rejected promise.
//
// Two layers, and both are needed:
//
//   1. Every call site attaches its own handler. That is where the context is,
//      and where the right response is known - skip this cycle, log and retry,
//      alarm.
//   2. This net, because layer 1 is a discipline and disciplines lapse. It
//      catches what layer 1 missed and keeps the thread alive, LOUDLY, instead
//      of taking the process down.
//
// The net deliberately does NOT swallow uncaughtException. An unhandled
// rejection from a fire-and-forget store call is a transient the thread can
// survive; a genuinely uncaught synchronous exception means state nobody
// reasoned about, and there the fail-loud rule still applies.
//
// WHAT THAT CHOICE HAS COST, written down because "deliberate" is only useful
// with the reason attached, and because the next person to meet a fatal
// uncaught exception will otherwise assume this net was supposed to catch it.
//
// An 'error' event with NO registered listener is THROWN by Node, not dropped.
// That is a language-level rule, not a library quirk, and it produces an
// uncaught exception - so it lands on exactly the side of this line that is not
// caught. Three defects here have come through that door:
//
//   1. The export spool WriteStream, whose listener was attached only after
//      streaming finished. A disk-full mid-export killed the worker that owns
//      the ONLY export-lane pool, taking every concurrent export with it.
//   2. `createReadStream(...).pipe(res)` on the download path, where the sweep
//      can delete the file between statSync and open.
//   3. A CHECKED-OUT pg client. `pool.on('error')` covers idle connections and
//      nothing covered working ones, so stopping Postgres mid-COPY threw with
//      no application frames on the stack. Cost: the process exited with about
//      22,000 accepted datagrams still queued - a never-drop violation.
//
// Finding 5's fix could not reach any of them, and that is not a defect in this
// net. Widening it to swallow uncaughtException would have hidden all three
// instead of fixing them, and would have left the process running on state
// nobody had reasoned about. The correct response is to attach the listener
// where the emitter is created, BEFORE it can emit and for the WHOLE time it
// can emit - attached-too-late is the same defect as never-attached, and it is
// the one that reads as correct.
//
// So: this boundary stays where it is. The audit that keeps it honest is the
// emitter sweep recorded in BUILD-PLAN.

// ---------------------------------------------------------------------------
// FIXTURE GUARD LAYER 3: the destructive-tool interlock.
//
// BUILD-PLAN has described this layer since before slice 5 - "destructive
// retention against a database whose name is in the protected list requires
// ALLOW_FIXTURE_DROPS=1". It was documented and never built. The string
// appeared nowhere in the tree except the sentence claiming it existed, and
// three separate destructive paths (locktest's scan, the guard test's
// samples_hourly drops, the spike's default-on retention call) ran against the
// protected database with nothing between them and the corpus.
//
// That absence had a second cost, which is the one worth recording. The 22GB
// post-mortem concluded "all four fixture-guard layers were in place and none
// covered it" - and reasoned from there that the guards were adequate and the
// CALLER was at fault, so the fix was made to the caller. There were three
// layers. The missing one was precisely the interlock that covers all three
// paths at once. A false premise about what protection existed produced a fix
// scoped to one call site, which is how the second call site in the same file
// survived.
//
// THE DIRECTION OF THIS CHECK IS DELIBERATELY OPPOSITE TO THE ONE IN SQL.
//
//   drop_partitions_guarded is PRODUCT code. Its job is to drop, so it carries
//   a DENY-list: named fixture databases refuse without the flag, and an
//   unrecognised database - a real deployment - works normally.
//
//   This is TEST code. Its job is to be harmless, so it carries an ALLOW-list:
//   only a database explicitly nominated as disposable is acceptable, and an
//   unrecognised name REFUSES. A destructive test pointed at `netmon_prod`
//   would sail through any deny-list, because nobody adds a production
//   database to a list of things to protect until after the first time.
//
// Same rule as guard 5 and the health predicates: absent input is not
// permission.

/**
 * Databases a destructive test may target, by name.
 *
 * `rscanvas_test` is created by `tools/make-test-db.sh` - schema only, a tiny
 * fixture, nothing whose loss costs more than a minute. Anything else has to be
 * nominated explicitly through DESTRUCTIVE_TEST_DB.
 */
const DISPOSABLE_DATABASES = new Set(
    (process.env.DESTRUCTIVE_TEST_DB ?? 'rscanvas_test')
        .split(',').map((s) => s.trim()).filter(Boolean),
);

/** Database name out of a libpq URL, or null if it cannot be determined. */
export function databaseNameOf(url: string): string | null {
    try {
        const name = new URL(url).pathname.replace(/^\//, '');
        return name === '' ? null : decodeURIComponent(name);
    } catch {
        return null;
    }
}

/**
 * Refuse to run a destructive tool against anything but a disposable database.
 *
 * Called at the TOP of a tool, before it opens a pool. Failing here costs a
 * developer thirty seconds; failing to have called it has now cost 158GB and
 * 22GB in two separate incidents with the same shape.
 *
 * ALLOW_FIXTURE_DROPS=1 overrides, because there is a legitimate case - proving
 * a guard against the real corpus - and a check with no override gets deleted
 * rather than respected. The override is per-run, per-command-line, and says
 * what it is doing.
 */
export function assertDestructiveTarget(tool: string, databaseUrl: string): void {
    const db = databaseNameOf(databaseUrl);

    if (process.env.ALLOW_FIXTURE_DROPS === '1') {
        console.error(
            `[safety] ${tool}: ALLOW_FIXTURE_DROPS=1 - running destructively against `
            + `${db ?? 'an unparseable DATABASE_URL'}. This is the override, not the default.`,
        );
        return;
    }

    // Unparseable is not "probably fine". It is the case where the check cannot
    // tell what it is about to destroy, which is the worst state to proceed in.
    if (db === null) {
        throw new Error(
            `${tool} refuses to run: DATABASE_URL names no database, so its target cannot be identified`,
        );
    }

    if (!DISPOSABLE_DATABASES.has(db)) {
        throw new Error(
            `${tool} refuses to run against "${db}": it drops tables, and only a database `
            + `nominated as disposable may be its target (currently [${[...DISPOSABLE_DATABASES].join(', ')}]).\n`
            + `  Create one:      tools/make-test-db.sh\n`
            + `  Point at it:     DATABASE_URL=postgres://rscanvas:rscanvas@localhost:5432/rscanvas_test\n`
            + `  Or nominate one: DESTRUCTIVE_TEST_DB=<name>\n`
            + `  Or override:     ALLOW_FIXTURE_DROPS=1 (deliberate, and it says so in the log)`,
        );
    }
}

export interface SafetyOptions {
    /** Thread name, for the log line. */
    thread: string;
    /** Called on each swallowed rejection, so a worker can count them. */
    onRejection?: (err: unknown) => void;
}

let installed = false;

export function installSafetyNet(opts: SafetyOptions): void {
    if (installed) return;
    installed = true;

    process.on('unhandledRejection', (reason: unknown) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        // Loud, with a stack, and never silent: this is a bug at a call site
        // that should have handled it, and the message is what identifies which.
        console.error(
            new Date().toISOString(),
            `[${opts.thread}] ALARM unhandled rejection survived - a call site is missing a .catch`,
            err.stack ?? err.message,
        );
        opts.onRejection?.(reason);
    });
}
