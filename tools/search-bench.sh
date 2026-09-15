#!/bin/bash
# Measure the slice 1 search cases cold and warm.
#
# Needs root, because a genuinely cold read means dropping the OS page cache AND
# restarting the cluster so shared_buffers is empty too. Dropping only the page
# cache leaves up to shared_buffers worth of the corpus resident and reports a
# number somewhere in between - which is the failure that invalidated run 1 of
# the spike, in a slightly different costume.
#
#   sudo tools/search-bench.sh
#
# Lives outside the Node process on purpose: the application should not be able
# to restart the database, and the SQL stays in the store either way.
#
# Stop the application first. An ingest worker writing during a cold read is
# measuring something else, and its pooled connections survive the restart as
# errors.
set -uo pipefail

CLUSTER="${PG_CLUSTER:-postgresql@18-main}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="${SUDO_USER:-$USER}"
DB="${DATABASE_URL:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_spike}"

CASES=(
    filtered_match_500
    filtered_nomatch
    filtered_14d
    browse_500
    freetext_24h
)

if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root (page cache and cluster restart)" >&2
    exit 1
fi

echo "corpus vs RAM - the denominator is TOTAL RAM, not shared_buffers:"
free -g | awk 'NR==2 {printf "  RAM total %sGB, available %sGB\n", $2, $7}'
su - postgres -c "psql -d rscanvas_spike -tAc \"
SELECT '  messages: ' || pg_size_pretty(sum(pg_total_relation_size(child.oid)))
  FROM pg_inherits i
  JOIN pg_class parent ON parent.oid = i.inhparent
  JOIN pg_class child ON child.oid = i.inhrelid
 WHERE parent.relname = 'messages';\""

printf '\n%-20s %8s %8s %6s %6s %9s %8s %7s  %s\n' \
    case cold_ms warm_ms ratio rows dev_MB_rd blks_rd us/blk verdict_cold

fails=0
for c in "${CASES[@]}"; do
    systemctl stop "$CLUSTER" >/dev/null 2>&1
    sync
    echo 3 > /proc/sys/vm/drop_caches
    systemctl start "$CLUSTER" >/dev/null 2>&1
    for _ in $(seq 1 60); do
        su - postgres -c "psql -d rscanvas_spike -tAc 'SELECT 1'" >/dev/null 2>&1 && break
        sleep 1
    done

    out=$(su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' node tools/search-bench.ts $c" 2>&1)
    if echo "$out" | grep -q '^{'; then
        echo "$out" | node -e '
let s=[];process.stdin.on("data",d=>s.push(d)).on("end",()=>{
  const d=JSON.parse(s.join(""));
  const r=d.residency||{};
  const us=r.usPerBlockRead;
  console.log(
    d.case.padEnd(20)+" "+
    String(d.coldMs).padStart(8)+" "+
    String(d.warmMs).padStart(8)+" "+
    String(d.ratio).padStart(6)+" "+
    String(d.rowsReturned).padStart(6)+" "+
    String(r.mbReadFromDevice ?? "-").padStart(9)+" "+
    String(r.pgBlksRead ?? "-").padStart(8)+" "+
    String(us===null||us===undefined?"-":us.toFixed(0)).padStart(7)+"  "+
    (r.verdict||"?")+(d.withinEnvelope?"":"   OUTSIDE ENVELOPE "+JSON.stringify(d.envelopeMs)));
  process.exit(d.withinEnvelope?0:3);
});'
        [ $? -eq 3 ] && fails=$((fails+1))
    else
        printf '%-20s FAILED: %s\n' "$c" "$out"
        fails=$((fails+1))
    fi
done

echo
if [ "$fails" -gt 0 ]; then
    echo "$fails case(s) outside the envelope or failed"
    echo "A case that is FASTER than the envelope is not a pass - check the residency verdict."
    exit 1
fi
echo "all cases within the measured envelope"
