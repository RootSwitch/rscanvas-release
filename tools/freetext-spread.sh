#!/bin/bash
# The free-text case measured as a DISTRIBUTION rather than a single number.
#
# Why this exists. "free-text, all devices, 24h" against an absent plausible
# address is not one query with one cost: the cost depends heavily on which
# literal is typed, because GIN has to intersect the posting lists of that
# fragment's trigrams and recheck whatever survives. Two runs of the same case
# with different addresses measured 206ms and 832ms cold - a factor of four,
# from nothing but the literal.
#
# spike/RESULTS.md already says this about the unbounded case ("a fragment whose
# trigrams are all common, which is what an operator actually types, forces GIN
# to intersect large posting lists and recheck tens of thousands of candidates
# to find nothing") and reports it as 667ms p50 with a 3.2s worst case rather
# than as a point figure. The bounded case has the same property, smaller, and
# reporting one sample of it invites reading the sample as the cost.
#
#   sudo tools/freetext-spread.sh
set -uo pipefail

CLUSTER="${PG_CLUSTER:-postgresql@18-main}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="${SUDO_USER:-$USER}"
DB="${DATABASE_URL:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_spike}"
RUNS="${RUNS:-6}"
CASE="${CASE:-freetext_24h}"

if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root (page cache and cluster restart)" >&2
    exit 1
fi

echo "case $CASE, $RUNS cold runs, a different fragment each time"
printf '\n%4s %9s %9s %10s %9s  %s\n' run cold_ms warm_ms dev_MB_rd blks_rd verdict

for i in $(seq 1 "$RUNS"); do
    systemctl stop "$CLUSTER" >/dev/null 2>&1
    sync
    echo 3 > /proc/sys/vm/drop_caches
    systemctl start "$CLUSTER" >/dev/null 2>&1
    for _ in $(seq 1 60); do
        su - postgres -c "psql -d rscanvas_spike -tAc 'SELECT 1'" >/dev/null 2>&1 && break
        sleep 1
    done

    out=$(su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' WARM_RUNS=1 node tools/search-bench.ts $CASE" 2>&1)
    if echo "$out" | grep -q '^{'; then
        echo "$out" > /tmp/freetext-run-$i.json
        node -e '
const d = require("/tmp/freetext-run-" + process.argv[1] + ".json");
const r = d.residency || {};
console.log(
  String(process.argv[1]).padStart(4) + " " +
  String(d.coldMs).padStart(9) + " " +
  String(d.warmMs).padStart(9) + " " +
  String(r.mbReadFromDevice ?? "-").padStart(10) + " " +
  String(r.pgBlksRead ?? "-").padStart(9) + "  " + (r.verdict || "?"));
' "$i"
    else
        printf '%4s FAILED: %s\n' "$i" "$out"
    fi
done

echo
node -e '
const fs = require("fs");
const runs = Number(process.argv[1]);
const cold = [];
for (let i = 1; i <= runs; i++) {
  try { cold.push(JSON.parse(fs.readFileSync("/tmp/freetext-run-" + i + ".json", "utf8")).coldMs); } catch {}
}
if (!cold.length) { console.log("no runs to summarise"); process.exit(0); }
cold.sort((a, b) => a - b);
const at = (p) => cold[Math.min(cold.length - 1, Math.ceil(p / 100 * cold.length) - 1)];
console.log("cold ms over " + cold.length + " fragments: min " + cold[0] +
            ", p50 " + at(50) + ", max " + cold[cold.length - 1] +
            ", spread " + (cold[cold.length - 1] / cold[0]).toFixed(1) + "x");
' "$RUNS"
