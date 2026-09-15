#!/usr/bin/env bash
# THE WATCHED RUN. Retention's first real drop outside a test.
#
#   ssh user@192.0.2.50 'bash -s' < tools/watched-retention.sh
#
# BUILD-PLAN says RETENTION_DRY_RUN=1 does not change without one, and the
# demo is the safest instance it will ever run against: a disposable database,
# retention already short, guards 1-5 built and falsified, the measurement
# corpus unreachable from this connection, and a soak log someone reads.
#
# WHY THIS PLANTS DATA FIRST, and it is the whole difference between a watched
# run and a ceremony. The demo database was created today, so every partition
# it owns is today's: retention would drop nothing, report nothing, and the
# flip would pass VACUOUSLY - the failure shape this project has now caught in
# four separate instruments. So the run gets a KNOWN POSITIVE: backdated
# partitions with real rows, old enough to fall outside the window, plus a
# rollup frontier deliberately set BEHIND some of the samples partitions so
# guard 5 has an actual race to lose rather than a theoretical one.
#
# What it checks, in order:
#   1. DRY RUN predicts. Captured before anything acts.
#   2. LIVE run acts. Its report must AGREE with the prediction - a
#      disagreement is the finding, and the reason dry-run exists.
#   3. Guard 5 defers the samples partitions the rollup has not consumed.
#   4. The rollup catches up; the next run takes what it deferred.
#   5. Disk goes DOWN, which is the one thing dry-run can never show.
set -euo pipefail

DB=postgres://rscanvas:rscanvas@localhost:5432/rscanvas_demo
case "$DB" in
    *rscanvas_demo*) ;;
    *) echo "refusing: this plants and drops partitions, demo only"; exit 2 ;;
esac

Q() { psql "$DB" -tAq -c "$1"; }
QF() { psql "$DB" -tAF' ' -c "$1"; }
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }

echo "=== the watched retention run, on rscanvas_demo ==="
echo

# --- 1. plant the known positive ---------------------------------------------
# FOURTEEN DAYS BACK TO YESTERDAY, not just the expired block - and the first
# attempt got this wrong in a way worth keeping.
#
# Planting only days -12..-6 made guard 3 refuse the whole run: "dropping 7 of
# 7 partitions would leave 0, below min_keep 3". Its denominator counts only
# partitions whose window has CLOSED (hi <= now, the restriction added for
# Fable's task 1), so today's partition and the forward runway are not in it -
# the planted block was every partition the guard could see, and dropping all
# of them is exactly what min_keep exists to refuse.
#
# The guard was right and the FIXTURE was wrong. Planting through yesterday
# gives the run something to keep as well as something to drop, which is also
# the realistic shape: a live deployment always has recent closed days.
#
# THE PLANT IS IDEMPOTENT, learned the same way: the refused first attempt had
# already inserted its rows, so the retry collided with its own leftovers. A
# watched run that cannot be re-run is a watched run you get one attempt at.
echo "planting backdated partitions with rows..."
Q "SELECT ensure_daily_partitions('messages', current_date - 14, current_date - 1)" >/dev/null
Q "SELECT ensure_daily_partitions('samples',  current_date - 14, current_date - 1)" >/dev/null

Q "INSERT INTO messages (ts, host, app, proto, severity, facility, msg, raw)
   SELECT (current_date - d)::timestamptz + interval '12 hours',
          'planted-' || d, 'soak', 'udp', 5, 16,
          'planted row for the watched retention run, day -' || d, 'x'
     FROM generate_series(1, 14) d, generate_series(1, 500)
   WHERE NOT EXISTS (SELECT 1 FROM messages WHERE host = 'planted-' || d)" >/dev/null

Q "INSERT INTO samples (entity_id, ts, status, rtt_ms, v0, v1)
   SELECT e.id, (current_date - d)::timestamptz + interval '12 hours',
          1, 1.0, 100, 200
     FROM generate_series(1, 14) d,
          (SELECT id FROM entities ORDER BY id LIMIT 40) e
   ON CONFLICT (entity_id, ts) DO NOTHING" >/dev/null

PLANTED_M=$(Q "SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
                WHERE i.inhparent='messages'::regclass
                  AND to_date(right(c.relname,8),'YYYYMMDD') < current_date - 5")
PLANTED_S=$(Q "SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
                WHERE i.inhparent='samples'::regclass
                  AND to_date(right(c.relname,8),'YYYYMMDD') < current_date - 3")
echo "  14 backdated days planted; $PLANTED_M message and $PLANTED_S samples partitions"
echo "  are outside their windows, and the rest are what the run must KEEP"

# The frontier goes back to day -9, so samples from -9 forward are UNCONSUMED
# and guard 5 must refuse them while taking the older ones. Idempotent: the
# rollup rewrites hours it has already produced (measured slice 5).
Q "INSERT INTO job_state (job, through_ts, last_run_ts, runs) VALUES
     ('rollup', (current_date - 9)::timestamptz, now(), 0)
   ON CONFLICT (job) DO UPDATE SET through_ts = excluded.through_ts" >/dev/null
echo "  rollup frontier moved back to $(Q "SELECT through_ts FROM job_state WHERE job='rollup'")"
echo

BEFORE_MB=$(Q "SELECT pg_database_size('rscanvas_demo')/1024/1024")
echo "database before: ${BEFORE_MB} MB"
echo

# --- 2. the prediction --------------------------------------------------------
echo "--- DRY RUN, the prediction -------------------------------------------"
PRED_M=$(QF "SELECT action, partition_name FROM drop_partitions_guarded('messages', 5, 2, 50, 3, 3650, true, '2s') ORDER BY 2")
PRED_S=$(QF "SELECT action, partition_name FROM drop_partitions_guarded('samples', 3, 2, 50, 3, 3650, true, '2s') ORDER BY 2")
echo "$PRED_M" | sed 's/^/  messages  /'
echo "$PRED_S" | sed 's/^/  samples   /'
echo

# --- 3. the live run ----------------------------------------------------------
echo "--- LIVE RUN, and it must agree with the prediction --------------------"
ACT_M=$(QF "SELECT action, partition_name FROM drop_partitions_guarded('messages', 5, 2, 50, 3, 3650, false, '2s') ORDER BY 2")
ACT_S=$(QF "SELECT action, partition_name FROM drop_partitions_guarded('samples', 3, 2, 50, 3, 3650, false, '2s') ORDER BY 2")
echo "$ACT_M" | sed 's/^/  messages  /'
echo "$ACT_S" | sed 's/^/  samples   /'
echo

# dry-run reports 'would-drop' where a live run reports 'dropped'; every other
# action word must match exactly.
NORM_PRED=$(printf '%s\n%s\n' "$PRED_M" "$PRED_S" | sed 's/^would-drop/dropped/' | sort)
NORM_ACT=$(printf '%s\n%s\n' "$ACT_M" "$ACT_S" | sort)
if [ "$NORM_PRED" = "$NORM_ACT" ]; then
    ok "the live run did EXACTLY what dry-run predicted, partition for partition"
else
    bad "prediction and action disagree - this is the finding, not a formality"
    diff <(echo "$NORM_PRED") <(echo "$NORM_ACT") | sed 's/^/       /' || true
fi

# --- 4. guard 5 ---------------------------------------------------------------
DEFERRED=$(echo "$ACT_S" | grep -c '^deferred-unrolled' || true)
DROPPED_S=$(echo "$ACT_S" | grep -c '^dropped' || true)
if [ "$DEFERRED" -gt 0 ]; then
    ok "guard 5 DEFERRED $DEFERRED samples partition(s) the rollup has not consumed"
else
    bad "guard 5 deferred nothing - the frontier race did not happen, so the cross-job invariant is untested"
fi
if [ "$DROPPED_S" -gt 0 ]; then
    ok "and dropped $DROPPED_S that it had - the guard discriminates rather than refusing everything"
else
    bad "no samples partition was dropped, so the guard may simply be refusing all"
fi

# --- 5. the rollup catches up, the next run takes the rest --------------------
echo
echo "--- letting the rollup catch up, then running retention again ----------"
for _ in $(seq 1 40); do
    CAUGHT=$(Q "SELECT caught_up FROM roll_up_chunk(24, 5)")
    [ "$CAUGHT" = "t" ] && break
done
echo "  frontier now $(Q "SELECT through_ts FROM job_state WHERE job='rollup'")"
ACT_S2=$(QF "SELECT action, partition_name FROM drop_partitions_guarded('samples', 3, 2, 50, 3, 3650, false, '2s') ORDER BY 2")
echo "$ACT_S2" | sed 's/^/  samples   /'
DROPPED2=$(echo "$ACT_S2" | grep -c '^dropped' || true)
if [ "$DROPPED2" -ge "$DEFERRED" ]; then
    ok "the deferral was a DELAY, not a wedge: the rollup caught up and the next run took them"
else
    bad "partitions deferred for the rollup were not taken after it caught up"
fi

# --- 6. disk ------------------------------------------------------------------
echo
Q "VACUUM" >/dev/null 2>&1 || true
AFTER_MB=$(Q "SELECT pg_database_size('rscanvas_demo')/1024/1024")
echo "database after:  ${AFTER_MB} MB (was ${BEFORE_MB} MB)"
if [ "$AFTER_MB" -lt "$BEFORE_MB" ]; then
    ok "DISK WENT DOWN - the one thing a dry run can never show"
else
    bad "the database did not shrink: ${BEFORE_MB} -> ${AFTER_MB} MB"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "PASS - $PASS passed, $FAIL failed. Retention has now dropped real partitions,"
    echo "under its own guards, and been watched doing it."
    exit 0
else
    echo "FAIL - $PASS passed, $FAIL failed"
    exit 1
fi
