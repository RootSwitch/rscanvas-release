#!/usr/bin/env bash
# One JSON line describing the ingest side of THIS box, for before/after deltas
# around a load step (tools/ingest-step.sh). Runs ON the measured box.
#
#   bash tools/ingest-snap.sh            # BASE defaults to http://127.0.0.1:18080
#
# Written 2026-09-24 for the lab-5 ingest test. Everything in it is a counter or
# a gauge read at one instant; the step script subtracts two of them. The
# sources are deliberately independent of each other, because the project's
# rule for ingest is that no single counter is trusted (tools/verify-run.ts):
#
#   /api/health      what the app says: received, written, shed, its own view
#                    of kernel socket drops, flush timings, per-thread heartbeat
#   /proc/net/snmp   what the kernel says for UDP as a whole
#   softnet_stat     drops BEFORE the socket, at the per-CPU backlog - a
#                    receiver can read zero socket drops while these climb
#   schedstat        CPU seconds per process group, so a step's cost is known
#
# Needs a session for /api/health: SOAK_USER / SOAK_PASS default to the repo's
# documented demo fixture, as tools/soak.sh and tools/jobs-health.sh do.
set -uo pipefail
BASE="${BASE:-http://127.0.0.1:18080}"
CJ="$(mktemp)"; H="$(mktemp)"; trap 'rm -f "$CJ" "$H"' EXIT
curl -s -m 10 -c "$CJ" -X POST "$BASE/api/login" -H 'content-type: application/json' \
     -d "{\"username\":\"${SOAK_USER:-admin}\",\"password\":\"${SOAK_PASS:-rscanvas-demo-2026}\"}" -o /dev/null || true
curl -s -m 20 -b "$CJ" "$BASE/api/health" -o "$H" || echo '{}' > "$H"

udp() { awk '/^Udp:/ { if (!h) { for (i=2;i<=NF;i++) k[i]=$i; h=1 } else { for (i=2;i<=NF;i++) printf "\"%s\":%s,", k[i], $i } }' /proc/net/snmp; }
# softnet_stat column 2 is packets dropped because the CPU's backlog was full.
softnet() { local s=0; while read -r _ d _; do s=$((s + 16#$d)); done < /proc/net/softnet_stat; echo "$s"; }
cpu_ns() {
    local t=0
    for p in "$@"; do
        for f in /proc/"$p"/task/*/schedstat; do
            [ -r "$f" ] || continue
            read -r r _ < "$f"; t=$((t + r))
        done
    done
    echo "$t"
}
APP=$(systemctl show -p MainPID --value rscanvas-app 2>/dev/null || echo 0)
# systemd's per-service CPU accounting (cgroup) counts every process the unit
# ever ran, including postgres backends that exited between two snapshots -
# which the per-PID schedstat sum cannot see; on the first lab-5 steps that
# made postgres read as 0.04 cores. Both kept; ingest-step prefers this.
cg_ns() { systemctl show -p CPUUsageNSec --value "$1" 2>/dev/null | grep -E '^[0-9]+$' || echo null; }
PG=$(pgrep -d ' ' -u postgres postgres || true)
# The data directory is postgres-owned; unprivileged du reads almost nothing.
DBSIZE=$(sudo -n du -sm /var/lib/postgresql 2>/dev/null | cut -f1 || du -sm /var/lib/postgresql 2>/dev/null | cut -f1)

jq -c --arg ts "$(date -u +%FT%T.%3NZ)" \
      --argjson udp "{$(udp | sed 's/,$//')}" \
      --argjson softnetDrops "$(softnet)" \
      --argjson appCpuNs "$(cpu_ns $APP)" \
      --argjson pgCpuNs "$(cpu_ns $PG)" \
      --argjson dbMb "${DBSIZE:-0}" \
      --argjson appCgNs "$(cg_ns rscanvas-app)" \
      --argjson pgCgNs "$(cg_ns postgresql@18-main)" \
      --arg load "$(cut -d' ' -f1-3 /proc/loadavg)" \
      --argjson rmemMax "$(sysctl -n net.core.rmem_max)" \
      '{ts: $ts, load: $load, rmemMax: $rmemMax, udp: $udp, softnetDrops: $softnetDrops,
        appCpuNs: $appCpuNs, pgCpuNs: $pgCpuNs, appCgNs: $appCgNs, pgCgNs: $pgCgNs, dbMb: $dbMb,
        ingest: (.ingest | if . then {received, written, queued, shedByUs, flushes, flushFailures,
                  flushP50Ms, flushP99Ms, flushMaxMs, kernel, hb: .heartbeat} else null end),
        collector: (.collector | if . then {polls, failures, pollP50Ms, pollP95Ms, pollLagP95Ms,
                  pendingSamples, hb: .heartbeat} else null end),
        main: .heartbeat}' "$H"
