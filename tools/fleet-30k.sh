#!/bin/bash
# Generate the three mock-fleet tiers for the 30k ceiling run.
#
#   sudo -E tools/fleet-30k.sh dense     # install + start one tier
#   sudo -E tools/fleet-30k.sh --plan    # print the port map, change nothing
#
# WHY THREE UNITS AND NO CODE CHANGE. mock-fleet.js takes FLEET_SIZE,
# IFACES_PER and BASE_PORT, which is one uniform density. The plan refuses a
# uniform fleet on purpose (section 3): 30,000 entities on 600 fat switches is
# the CHEAPEST arrangement of that number, because density measured ~40% less
# CPU per entity, so a uniform run tests the easy case and reports the hard
# one. Three instances with different IFACES_PER and non-overlapping port
# ranges give the mixed fleet without touching the generator.
#
# THE DEAD TIER NEEDS NO GENERATOR AT ALL. A dead device is a device row whose
# port has nothing listening, which is exactly what 5% of the fleet should be:
# measured here, a dead device costs 10,000ms against 147ms live, 68x, and a
# fleet where everything answers is not a fleet. fleet-30k-onboard.mjs adds
# them from the port map below; nothing runs for them by design.
#
# ENTITY COUNTS ARE NOW MEASURED, and the calibration step is why the numbers
# below changed. Entities per device is IFACES_PER **plus 4 sensors, flat** -
# counted off a live partial fleet at all three densities: 52 -> 56.00,
# 26 -> 30.00, 3 -> 7.00, exactly, no variance.
#
# The earlier "x1.17 multiplier" here was read off the live LAN fleet, and it
# was the wrong SHAPE of correction: sensors are a constant per device, not a
# proportion of interfaces. A ratio fitted on dense devices (52 -> 56 really is
# about 1.08) understates sparse ones by a factor of two (3 -> 7 is 2.33), and
# this fleet is two thirds sparse by device count. Fitting a curve through one
# density and extrapolating to the others is how a plan misses by thousands.

set -euo pipefail

HOST_IP="${FLEET_BIND:-0.0.0.0}"
MOCK="${MOCK_PATH:-/home/user/lab/mock-fleet.js}"
NODE="${NODE_BIN:-/usr/bin/node}"

# SIZED BACKWARDS FROM THE PRE-REGISTERED TOTAL, after the first draft of this
# file got it wrong in both directions and `--plan` said so before anything was
# built. The plan commits to 30,000 ENTITIES across 1,550 DEVICES, 5% dead.
#
# That draft sized the tiers on NOMINAL entities (interfaces only) and scaled
# them by a fitted multiplier, which came to ~35,100 - a sixth more load than
# the criteria were written against. It also put the 78 dead devices ON TOP of
# 1,550 rather than inside it, giving 1,628. Both are the same error: building
# to the parts instead of to the committed total, which is how a run quietly
# answers a question nobody asked.
#
# Solved exactly against the measured 4-sensor constant, holding mid at 210:
# 56d + 30(210) + 7(1340 - d) = 30,000 gives d = 292.
#
#   tier   devices  ifaces  base   last    entities
#   dense      292      52  16100  16391     16,352
#   mid        210      26  16600  16809      6,300
#   sparse   1,048       3  17000  18047      7,336
#            -----                           ------
#            1,550                           29,988
#
# 29,988 and not 30,000 because devices are integers: 210 mid is the nearest
# whole tier either side, and the plan's own rule is to move DEVICE COUNTS
# rather than let entities drift. Twelve entities is 0.04%, and undershooting
# the pre-registered load is the safe direction to miss in.
#
# THE DEAD TIER IS THE LAST 78 SPARSE PORTS (17970-18047), killed AFTER
# onboarding. They keep their entities, which is why they sit inside the total
# rather than beside it: a dead switch does not stop having had ports.
#
# DEAD_PCT=0 IS SET ON EVERY UNIT, and leaving it at the mock's default of 10
# cost the first attempt at this run. mock-fleet.js leaves every 10th port
# UNBOUND by design, so 1,550 ports served only ~1,395 agents - and those 155
# gaps can never become dead DEVICES, because a device that never answered is
# refused at onboarding (U6, correctly). They are not dead switches; they are
# absent ones. The dead tier has to be built the documented way: onboard live,
# then kill.

declare -A DEVICES=( [dense]=292 [mid]=210 [sparse]=1048 )
declare -A IFACES=(  [dense]=52  [mid]=26  [sparse]=3    )
declare -A BASE=(    [dense]=16100 [mid]=16600 [sparse]=17000 )
DEAD_COUNT=78

plan() {
    printf '%-8s %7s %7s %11s %11s %9s\n' tier devices ifaces base_port last_port entities
    local total_d=0 total_e=0
    for t in dense mid sparse; do
        local d=${DEVICES[$t]} i=${IFACES[$t]} b=${BASE[$t]}
        local last=$(( b + d - 1 )) e=$(( d * (i + 4) ))
        printf '%-8s %7d %7d %11d %11d %9d\n' "$t" "$d" "$i" "$b" "$last" "$e"
        total_d=$(( total_d + d )); total_e=$(( total_e + e ))
    done
    local dead_first=$(( ${BASE[sparse]} + ${DEVICES[sparse]} - DEAD_COUNT ))
    printf '%-8s %7d %7s %11d %11d %9s\n' '(dead)' "$DEAD_COUNT" 3 "$dead_first" \
        $(( ${BASE[sparse]} + ${DEVICES[sparse]} - 1 )) 'within sparse'
    echo
    printf 'devices %d (target 1550)   entities %d (target 30000)\n' "$total_d" "$total_e"
    echo
    echo 'That entity figure is now MEASURED, not estimated: ifaces + 4 sensors,'
    echo 'confirmed against a live partial fleet at all three densities. If it ever'
    echo 'drifts from 30,000, change the DEVICE COUNTS here rather than accepting it -'
    echo 'the plan pre-registered 30,000 entities and 1,550 devices, and a run that'
    echo 'quietly carries 35,000 is answering a question nobody asked.'
}

# ONE PROCESS PER ~260 AGENTS, MEASURED RATHER THAN GUESSED (2026-08-29).
#
# The first attempt ran a whole tier in one mock-fleet process: 297 live agents
# pegged a core at 98.7% and a single probe took 16 SECONDS, because node is
# one thread and every agent shares it. Probes at concurrency 10 simply timed
# out. That is the same shape as the RouterOS finding - a queue overflowing in
# silence, read as slow devices - except here the slow device is the apparatus.
#
# So each tier is split into chunks with contiguous port ranges. 260 sits under
# the measured ceiling with margin for the discovery phase, which is the peak:
# steady polling asks for 16 columns, discovery enumerates everything.
#
# OVERRIDABLE SINCE 2026-09-24, and smaller is truer. The lab-1/lab-3 comparison
# (RESULTS-AB-MPC-2026-09-24.md) measured what a shared mock process costs
# even far below the saturation ceiling: HEAD's median poll read 153 ms against
# one 450-device process and 55 ms against ten-device processes, because every
# device in a process queues behind every other device's requests - a queue no
# real network has. 90 keeps the 78-port dead range inside one sparse process
# (dead_unit refuses otherwise) and gives the lab-5 ingest run 19 processes.
MAX_PER_PROC="${MAX_PER_PROC:-260}"

install_tier() {
    local t="$1"
    [[ -n "${DEVICES[$t]:-}" ]] || { echo "unknown tier: $t (dense|mid|sparse)" >&2; exit 2; }
    local total=${DEVICES[$t]} base=${BASE[$t]} ifaces=${IFACES[$t]}
    local procs=$(( (total + MAX_PER_PROC - 1) / MAX_PER_PROC ))
    local per=$(( (total + procs - 1) / procs ))
    local i=0 done_dev=0
    while (( done_dev < total )); do
        local n=$per
        (( done_dev + n > total )) && n=$(( total - done_dev ))
        install_proc "$t" "$i" "$n" "$(( base + done_dev ))" "$ifaces"
        done_dev=$(( done_dev + n )); i=$(( i + 1 ))
    done
    echo "  tier ${t}: ${total} devices across ${procs} process(es), ports ${base}-$(( base + total - 1 ))"
}

install_proc() {
    local t="$1" idx="$2" count="$3" base="$4" ifaces="$5"
    local unit="/etc/systemd/system/rscanvas-fleet-${t}${idx}.service"
    cat > "$unit" <<EOF
[Unit]
Description=RSCanvas mock fleet ${t}${idx} (30k ceiling run): ${count} agents from ${base}
After=network-online.target

[Service]
Type=simple
User=user
Environment=FLEET_SIZE=${count} IFACES_PER=${ifaces} BASE_PORT=${base} FLEET_BIND=${HOST_IP} DEAD_PCT=0
ExecStart=${NODE} ${MOCK}
Restart=always
RestartSec=5
# NOT capped, because these no longer share a scheduler with the subject. The
# generators live on their own VM now, so the thing to protect is the
# HYPERVISOR's ability to schedule the subject - and a weight inside this guest
# cannot do that. idle-control.mjs on the subject is what watches for it.

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "rscanvas-fleet-${t}${idx}.service"
    echo "    ${t}${idx}: ${count} agents, ports ${base}-$(( base + count - 1 ))"
}

# KILLING THE DEAD TIER IS ONE NUMBER, AND IT IS REVERSIBLE. The dead range is
# the tail of the sparse tier, so exactly one process serves it - shrink that
# process's FLEET_SIZE and the last DEAD_COUNT ports stop answering. `revive`
# puts the number back.
#
# Not iptables, and not a separate always-stopped unit. A DROP rule and an
# unbound port are not the same failure: the plan's 10,000ms-per-dead-device
# cost is a TIMEOUT, and it was measured against ports that nothing was
# listening on. Shrinking the listener reproduces exactly that, which is the
# whole reason to prefer it over a mechanism that merely looks equivalent.
dead_unit() {
    local base=${BASE[sparse]} total=${DEVICES[sparse]}
    local dfirst=$(( base + total - DEAD_COUNT ))
    local procs=$(( (total + MAX_PER_PROC - 1) / MAX_PER_PROC ))
    local per=$(( (total + procs - 1) / procs ))
    if (( DEAD_COUNT > per )); then
        echo "the dead range spans more than one process (${DEAD_COUNT} > ${per} per proc)." >&2
        echo "this action assumes one, so it refuses rather than half-killing a tier." >&2
        exit 2
    fi
    local idx=$(( (dfirst - base) / per ))
    DEAD_IDX=$idx
    DEAD_PBASE=$(( base + idx * per ))
    DEAD_KEEP=$(( dfirst - DEAD_PBASE ))
    DEAD_FIRST=$dfirst
    DEAD_LAST=$(( base + total - 1 ))
    DEAD_FULL=$(( DEAD_KEEP + DEAD_COUNT ))
}

set_size() {
    local unit="/etc/systemd/system/rscanvas-fleet-sparse${DEAD_IDX}.service"
    [[ -f "$unit" ]] || { echo "no such unit: $unit - install the sparse tier first" >&2; exit 2; }
    sed -i "s/^Environment=FLEET_SIZE=[0-9]*/Environment=FLEET_SIZE=$1/" "$unit"
    systemctl daemon-reload
    systemctl restart "rscanvas-fleet-sparse${DEAD_IDX}.service"
    grep -o 'FLEET_SIZE=[0-9]*' "$unit"
}

case "${1:---plan}" in
    --plan|-p) plan ;;
    dense|mid|sparse) install_tier "$1" ;;
    dead)
        dead_unit
        echo "killing ports ${DEAD_FIRST}-${DEAD_LAST} (${DEAD_COUNT} agents) by shrinking sparse${DEAD_IDX} to ${DEAD_KEEP}"
        set_size "$DEAD_KEEP"
        echo "onboard FIRST, kill second: a device that never answered cannot be added at all."
        ;;
    revive)
        dead_unit
        echo "restoring sparse${DEAD_IDX} to ${DEAD_FULL} agents (ports ${DEAD_PBASE}-${DEAD_LAST})"
        set_size "$DEAD_FULL"
        ;;
    *) echo "usage: fleet-30k.sh [--plan | dense | mid | sparse | dead | revive]" >&2; exit 2 ;;
esac
