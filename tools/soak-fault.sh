#!/usr/bin/env bash
# The soak's scheduled fault window: take a slice of the fleet away for ten
# minutes, then give it back. Run daily by cron at a FIXED HOUR.
#
#   5 2 * * *  bash /home/user/rscanvas/tools/soak-fault.sh
#
# MINUTE FIVE, NOT ZERO. The hourly soak line also runs at minute zero,
# and on 2026-09-07 the kill below and that line's writer count ran in the
# same second on lab-stresstest: the line counted one writer of two and was
# a GAP - non-comparable - every day, invisible until the writer pin was
# right. Five minutes apart, both instruments read a whole fleet.
#
# WHY A SOAK NEEDS FAILURES IN IT. Four hundred agents up for a week means the
# collector never sees a device go unreachable, stepMissing never runs outside
# a test, and the device-down freeze - the subtlest rule in machine.ts, where
# an interface alert must NOT clear while its device is unreachable - is never
# exercised under real conditions. The 40 dead ports the mock fleet leaves are
# STATIC: nothing ever transitions.
#
# WHAT ONLY A LONG RUN CAN SHOW is not one recovery, it is a HUNDRED, with
# nothing accumulating across them. A connection not returned on an error
# path, an alert row orphaned, a counter that only resets on the happy path,
# notification debt that never settles - each is invisible in a single
# recovery and obvious in a hundred. The chaos suite covers faults in bursts
# of seconds; this covers repetition, which nothing else does.
#
# AT A FIXED HOUR, deliberately, so the criteria can account for it: the
# plateau reading stays clean because the window's effect on every column is
# known in advance and lands in the same two hourly lines each day.
set -uo pipefail

VOLATILE_SIZE=${VOLATILE_SIZE:-50}
VOLATILE_PORT=${VOLATILE_PORT:-16600}
WINDOW_S=${WINDOW_S:-600}
MARK=/home/user/lab/soak-faults.log

start_volatile() {
    FLEET_SIZE="$VOLATILE_SIZE" IFACES_PER=25 BASE_PORT="$VOLATILE_PORT" \
        nohup node /home/user/lab/mock-fleet.js > /tmp/fleet-volatile.log 2>&1 &
}

# KILL ONLY THE VOLATILE SLICE, identified by the BASE_PORT in its own
# environment.
#
# The first draft of this reached for `pkill -f mock-fleet.js` to "make sure"
# the slice was down, which would have taken the MAIN fleet with it: a broad
# destructive operation used to establish a known state, which is form 3 of
# the instrument rule and the shape that has already cost this project 158GB,
# 22GB and a login. The whole point of a fault window is that it is a SLICE
# and the rest keeps reporting.
#
# BASE_PORT is an environment variable rather than an argument, so `pkill -f`
# cannot see it. /proc/PID/environ can.
kill_volatile() {
    local killed=0 pid
    for pid in $(pgrep -f 'mock-fleet.js' 2>/dev/null); do
        if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null \
                | grep -qx "BASE_PORT=$VOLATILE_PORT"; then
            kill "$pid" 2>/dev/null && killed=$((killed + 1))
            echo "$(date -Is) FAULT-KILLED pid $pid (BASE_PORT=$VOLATILE_PORT)" >> "$MARK"
        fi
    done
    echo "$killed"
}

case "${1:-window}" in
    start)
        # Used by demo-lab.sh at boot; not the fault itself.
        kill_volatile >/dev/null
        sleep 1
        start_volatile
        echo "volatile fleet up: $VOLATILE_SIZE devices from $VOLATILE_PORT"
        ;;
    window)
        echo "$(date -Is) FAULT-START taking $VOLATILE_SIZE devices away for ${WINDOW_S}s" >> "$MARK"
        n=$(kill_volatile)
        if [ "$n" -eq 0 ]; then
            # Nothing killed means nothing recovers, so the window proves
            # nothing. Said out loud rather than sleeping quietly for ten
            # minutes and logging FAULT-END as though it had worked.
            echo "$(date -Is) FAULT-NOTHING-KILLED - the volatile fleet was not running" >> "$MARK"
        fi

        sleep "$WINDOW_S"

        start_volatile
        # FAULT-END ONLY IF A FAULT HAPPENED. It was written unconditionally,
        # including on the nothing-killed path - so soak-status counted a
        # cycle that never occurred, and the recovery criteria would have been
        # credited against an outage that did not happen. A window that killed
        # nothing recovered nothing.
        if [ "$n" -gt 0 ]; then
            echo "$(date -Is) FAULT-END volatile fleet restored after killing $n" >> "$MARK"
        else
            echo "$(date -Is) FAULT-ABORTED nothing was killed, so nothing recovered - NOT a cycle" >> "$MARK"
        fi
        ;;
    *)
        echo "usage: soak-fault.sh [start|window]" >&2
        exit 2
        ;;
esac
