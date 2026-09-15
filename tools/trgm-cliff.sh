#!/bin/bash
# Map the cost of a FILTERED search as its window crosses the edge of the
# trigram index window.
#
# ARCHITECTURE.md section 3b concludes that the trigram index "is never used by
# the realistic query" and "contributes exactly nothing to the realistic path".
# That was measured on a 24 HOUR window, which sits entirely inside the
# 3-day trigram window, so every partition it touched had the index.
#
# Section 3b also permits a filtered search across the full retention: free-text
# without a device filter is refused outside the indexed window, but WITH a
# device filter it is allowed over all 14 days. This sweep measures that
# permitted path, one window width at a time, everything else held constant.
#
#   sudo tools/trgm-cliff.sh
set -uo pipefail

CLUSTER="${PG_CLUSTER:-postgresql@18-main}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="${SUDO_USER:-$USER}"
DB="${DATABASE_URL:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_spike}"

WINDOWS="${WINDOWS:-24 48 72 96 168 336}"

if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root (page cache and cluster restart)" >&2
    exit 1
fi

echo "trigram window is TRGM_RECENT_DAYS=${TRGM_RECENT_DAYS:-3} days"
printf '\n%7s %9s %9s %9s %9s  %s\n' hours cold_ms warm_ms dev_MB_rd blks_rd verdict

for h in $WINDOWS; do
    systemctl stop "$CLUSTER" >/dev/null 2>&1
    sync
    echo 3 > /proc/sys/vm/drop_caches
    systemctl start "$CLUSTER" >/dev/null 2>&1
    for _ in $(seq 1 60); do
        su - postgres -c "psql -d rscanvas_spike -tAc 'SELECT 1'" >/dev/null 2>&1 && break
        sleep 1
    done

    out=$(su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' BENCH_HOURS=$h WARM_RUNS=2 node tools/search-bench.ts filtered_window" 2>&1)
    if echo "$out" | grep -q '^{'; then
        echo "$out" | node -e '
let s=[];process.stdin.on("data",d=>s.push(d)).on("end",()=>{
  const d=JSON.parse(s.join("")); const r=d.residency||{};
  console.log(
    String(process.argv[1]).padStart(7)+" "+
    String(d.coldMs).padStart(9)+" "+
    String(d.warmMs).padStart(9)+" "+
    String(r.mbReadFromDevice ?? "-").padStart(9)+" "+
    String(r.pgBlksRead ?? "-").padStart(9)+"  "+(r.verdict||"?"));
});' "$h"
    else
        printf '%7s FAILED: %s\n' "$h" "$out"
    fi
done
