#!/usr/bin/env bash
# The restore drill. An untested backup is a belief, not a backup.
#
#   bash tools/restore-drill.sh        (run ON the database host)
#
# Restores the tier-1 dump into a DISPOSABLE database and reads values out of
# it, comparing every table against its source. Never touches the corpus - the
# target name must end in _restore_test, checked below, for the same reason
# sync-lab.sh refuses a DEST that is not a checkout path.
#
# Its first run on 2026-08-13 found four defects in a procedure that looked
# correct on paper, three of which produced a pg_dump that exited 0 while
# losing data. See RUNBOOK-BACKUP.md section 5.
set -u
SRC=postgres://rscanvas:rscanvas@localhost:5432/rscanvas_demo
TARGET_DB=rscanvas_restore_test
TGT=postgres://rscanvas:rscanvas@localhost:5432/$TARGET_DB
OUT=/tmp/restore-drill; mkdir -p "$OUT"
case "$TARGET_DB" in *_restore_test) ;; *) echo refusing >&2; exit 1 ;; esac
DUMP="$OUT/drill.dump"

echo "=== THE INVERSION: dump everything, exclude only the BULK DATA of the big three."
echo "    --exclude-table-data keeps their SCHEMA (so the restore has the partitioned"
echo "    structure) while omitting 79 GB of rows. And nothing has to be listed by"
echo "    name, so a table added next month is backed up without anyone remembering."
time pg_dump "$SRC" \
  --exclude-table-data='public.messages' \
  --exclude-table-data='public.messages_2*' \
  --exclude-table-data='public.samples' \
  --exclude-table-data='public.samples_2*' \
  --format=custom --file="$DUMP" 2>&1 | tail -3
ls -lh "$DUMP" | awk '{print "  dump size: " $5}'

echo
echo "=== restore into the disposable target, showing EVERY error"
psql "$SRC" -c "DROP DATABASE IF EXISTS $TARGET_DB" >/dev/null 2>&1
psql "$SRC" -c "CREATE DATABASE $TARGET_DB" >/dev/null 2>&1 || sudo -u postgres createdb -O rscanvas "$TARGET_DB"
pg_restore --dbname="$TGT" --no-owner --no-privileges "$DUMP" 2>&1 \
  | grep -E "error|warning" | head -10 | sed 's/^/  /'
echo "  (no lines above = a clean restore)"

echo
echo "=== THE FOUR CHECKS, as values read out of the restored system"
echo "--- 1. can anyone log in?"
psql "$TGT" -tAF' | ' -c "
  SELECT count(*) FILTER (WHERE role='admin' AND NOT disabled), count(*) FROM users" \
  | sed 's/^/    live admins | users: /'
echo "--- 2. every table, source vs restored"
for t in users sessions audit devices entities alerts notifications boards board_tokens job_state samples_hourly; do
  a=$(psql "$SRC" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo MISSING)
  b=$(psql "$TGT" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo MISSING)
  flag=""; [ "$a" != "$b" ] && flag="   <-- DIFFERS"
  printf '    %-16s src=%-8s restored=%-8s%s\n' "$t" "$a" "$b" "$flag"
done
echo "--- 3. the empty-parent trap: partitioned tables present, and their children?"
psql "$TGT" -tAF' | ' -c "
  SELECT p.relname, count(*)::text
    FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
    JOIN pg_class p ON p.oid=i.inhparent GROUP BY 1 ORDER BY 1" | sed 's/^/    children of /'
echo "--- 4. thresholds (env, not in any dump - the check is that the unit was captured)"
ls -l /backup/rscanvas-app.unit-*.txt 2>/dev/null | tail -1 | sed 's/^/    /' \
  || echo "    NO UNIT BACKUP - the irreplaceable half is unprotected"

echo
echo "=== cleanup"
psql "$SRC" -c "DROP DATABASE IF EXISTS $TARGET_DB" >/dev/null 2>&1 || sudo -u postgres dropdb --if-exists "$TARGET_DB"
rm -f "$DUMP"
echo "  corpus partitions still: $(psql "$SRC" -tAc 'SELECT count(*) FROM pg_inherits')"
