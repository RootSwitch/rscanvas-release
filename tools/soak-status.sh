#!/usr/bin/env bash
# Is the soak healthy, AND is anyone actually watching it?
#
#   ssh user@192.0.2.50 bash /home/user/rscanvas/tools/soak-status.sh
#
# THE PASS CONDITION IS TWO-SIDED, and this exists because the one-sided
# version has the shape the whole run is built to avoid.
#
# "soak-breaches.log is empty" means the run is healthy OR nothing evaluated
# it - those produce the identical file, which is question 1 of the instrument
# rule applied to the checker instead of the system. Same recursion the
# `writers` column fixed one level down, where a stopped run and a plateau
# both looked flat.
#
# So health is: NO BREACHES, and every line written has been READ, and the
# log is still being written at all. Three ways to fail, three messages.
#
# WHERE THE REGRESS STOPS, said out loud rather than continuing forever: this
# script is the last link, and it is checked by A PERSON RUNNING IT. It takes
# no cron, keeps no state, and reports in one sentence, so "nobody ran it" is
# a fact about a human rather than a silent file. Every automated layer below
# it is now two-sided; adding a watcher for the watcher would just move the
# same question up one more level.
set -uo pipefail

# --- self-test ----------------------------------------------------------------
#
# The daily-read tool meets the same standard as the things it reports on.
# This script silently swallowed every UNMEASURED entry for a day - counted
# nowhere, shown to nobody - and the fix was verified by eye, which is how
# the swallowing shipped in the first place. So: planted fixtures, every
# stanza asserted PRESENT against a file that contains its trigger, and the
# UNMEASURED stanza asserted ABSENT against a file that lacks one - a status
# tool that prints the same report for different files is not reporting.
if [ "${1:-}" = "--self-test" ]; then
    st_pass=0; st_fail=0
    T=$(mktemp -d)
    trap 'rm -rf "$T"' EXIT
    printf 'l1\nl2\nl3\n' > "$T/log"
    printf 'e1\ne2\ne3\n' > "$T/eval"
    : > "$T/faults"
    run_fixture() {
        SOAK_LOG="$T/log" SOAK_EVAL_LOG="$T/eval" SOAK_BREACH_LOG="$T/breach" \
        SOAK_FAULT_LOG="$T/faults" bash "$0" || true
    }
    expect() {
        if [[ "$out" == *"$2"* ]]; then st_pass=$((st_pass + 1)); echo "  ok   $1"
        else st_fail=$((st_fail + 1)); echo "  FAIL $1 - wanted '$2', got: $out"; fi
    }
    expect_absent() {
        if [[ "$out" != *"$2"* ]]; then st_pass=$((st_pass + 1)); echo "  ok   $1"
        else st_fail=$((st_fail + 1)); echo "  FAIL $1 - '$2' printed with no trigger in the fixture"; fi
    }
    echo "soak-status self-test: every stanza against a fixture that triggers it"

    : > "$T/breach"
    out=$(run_fixture)
    expect        "a clean fixture reads HEALTHY"                       "HEALTHY"
    expect_absent "and no breach stanza prints"                         "breach(es) recorded"
    expect_absent "and no UNMEASURED stanza prints"                     "could not measure"

    printf 'BREACH 2026-07-30T01:00 db_mb=99999 planted\nGAP 2026-07-30T02:00 - only 2 of 4 writers planted\nUNMEASURED 2026-07-30T03:00 rss-24h planted\n' > "$T/breach"
    out=$(run_fixture)
    expect "a planted BREACH prints and is counted"                     "1 breach(es) recorded"
    expect "a planted GAP prints its non-failing note"                  "NOT comparable"
    expect "a planted UNMEASURED prints its non-failing note"           "could not measure"
    expect "and the verdict fails on the breach alone"                  "NOT HEALTHY - 1 problem"

    # Blank-first for the stanza that was silently swallowed: BREACH and GAP
    # present, UNMEASURED absent - the note must discriminate, not decorate.
    printf 'BREACH 2026-07-30T01:00 planted\nGAP 2026-07-30T02:00 planted\n' > "$T/breach"
    out=$(run_fixture)
    expect        "with no UNMEASURED in the file, breach still prints" "1 breach(es) recorded"
    expect_absent "and the UNMEASURED stanza stays absent"              "could not measure"

    echo
    if [ "$st_fail" -eq 0 ]; then echo "PASS - $st_pass passed, $st_fail failed"; exit 0; fi
    echo "FAIL - $st_pass passed, $st_fail failed"; exit 1
fi

LOG=${SOAK_LOG:-/home/user/lab/soak.log}
EVAL=${SOAK_EVAL_LOG:-/home/user/lab/soak-evaluated.log}
BREACH=${SOAK_BREACH_LOG:-/home/user/lab/soak-breaches.log}
FAULTS=${SOAK_FAULT_LOG:-/home/user/lab/soak-faults.log}
# The soak line is hourly, so anything past 90 minutes is a stalled cron
# rather than a slow one.
MAX_AGE_MIN=${MAX_AGE_MIN:-90}

fail=0
say() { echo "$*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

written=$( [ -f "$LOG" ]    && wc -l < "$LOG"    || echo 0 )
read_n=$(  [ -f "$EVAL" ]   && wc -l < "$EVAL"   || echo 0 )
# `grep -c` PRINTS 0 AND EXITS 1 when nothing matches, so a `|| echo 0`
# fallback yields TWO zeroes on separate lines, and every arithmetic test
# after it fails with "integer expression expected". Count with a pipeline
# that cannot fail instead. Caught on the first live run - which is the only
# reason the status command was not itself broken in the quiet direction.
# NO PIPELINE HERE, deliberately. `set -o pipefail` is on, so `grep -c | head`
# reports GREP's failure even though head succeeded, the `|| echo 0` fires,
# and the variable ends up holding two zeroes again - the same bug in a new
# costume, which is what the first fix earned by using a pipe to dodge it.
count_matching() {
    [ -f "$2" ] || { echo 0; return; }
    local n
    n=$(grep -c "$1" "$2" 2>/dev/null || true)
    echo "${n:-0}"
}
breaches=$(count_matching '^BREACH'   "$BREACH")
gaps=$(    count_matching '^GAP'      "$BREACH")
faults=$(  count_matching 'FAULT-END' "$FAULTS")
breaches=${breaches:-0}; gaps=${gaps:-0}; faults=${faults:-0}

say "soak: $written line(s) written, $read_n evaluated, $breaches breach(es), $gaps gap(s), $faults fault cycle(s)"

# 1. Is it still being written?
if [ "$written" -eq 0 ]; then
    bad "the soak log is empty - the hourly cron has never run"
else
    age_min=$(( ( $(date +%s) - $(stat -c %Y "$LOG") ) / 60 ))
    if [ "$age_min" -gt "$MAX_AGE_MIN" ]; then
        bad "the newest line is ${age_min}m old (limit ${MAX_AGE_MIN}m) - the hourly cron has stopped"
    else
        say "  ok   the log is current (${age_min}m since the last line)"
    fi
fi

# 2. Has everything written been read? THE BACKLOG CHECK.
backlog=$((written - read_n))
if [ "$backlog" -gt 1 ]; then
    bad "$backlog line(s) written but NOT EVALUATED - the checker is dead or behind, so an empty breach file means nothing"
elif [ "$backlog" -lt 0 ]; then
    bad "more lines evaluated than written ($read_n > $written) - one of the logs was truncated"
else
    say "  ok   every line written has been evaluated"
fi

# 3. And the breaches themselves.
if [ "$breaches" -gt 0 ]; then
    bad "$breaches breach(es) recorded:"
    grep '^BREACH' "$BREACH" | tail -10 | sed 's/^/       /'
else
    say "  ok   no breaches"
fi

# Gaps are reported but do not fail: a line produced while the load was down
# is not comparable, which is a fact about the data rather than a fault.
if [ "$gaps" -gt 0 ]; then
    say "  note ${gaps} line(s) were produced with writers missing and are NOT comparable"
    grep '^GAP' "$BREACH" | tail -3 | sed 's/^/       /'
fi

# UNMEASURED entries likewise: a rule that could not measure said so instead
# of producing a value (dead health probe, or a comparison spanning the rss
# subject pin). Before this stanza they landed in the breach file and were
# counted NOWHERE - visible to nobody is the one thing a sentinel must not be.
unmeasured=$(count_matching '^UNMEASURED' "$BREACH")
unmeasured=${unmeasured:-0}
if [ "$unmeasured" -gt 0 ]; then
    say "  note ${unmeasured} UNMEASURED entr(y/ies) - rules that could not measure, and said so"
    grep '^UNMEASURED' "$BREACH" | tail -3 | sed 's/^/       /'
fi

# The fault window should have fired once a day. Zero after a day means the
# recovery criteria have nothing behind them.
if [ "$written" -gt 26 ] && [ "$faults" -eq 0 ]; then
    bad "no fault window has completed in over a day - the recovery criteria are untested"
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "HEALTHY - and verified to have been WATCHED, which is the half an empty file cannot show."
    exit 0
fi
echo "NOT HEALTHY - $fail problem(s) above."
exit 1
