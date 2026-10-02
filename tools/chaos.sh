#!/bin/bash
# Chaos profile: a REGRESSION SUITE for CODE-REVIEW-2026-07-26, not a fuzzer.
#
#   sudo -E tools/chaos.sh            # all scenarios
#   sudo -E tools/chaos.sh restart    # one by name
#
# WHY IT EXISTS. The review's closing disagreement was correct and is endorsed:
# "every real problem was found by measuring" had become half-false as an
# operating rule. Findings 1 through 5 were invisible to the harness precisely
# because they live on paths the load generator never drives - a restarting
# database, a SIGTERM mid-burst, a missed maintenance run, a full disk. The
# measurement culture is this project's strength; it needed a fixture that
# injects FAILURE, not only load.
#
# WHY A REGRESSION SUITE RATHER THAN A FUZZER. A generic fault fuzzer finds new
# things occasionally. This finds the SPECIFIC regressions a refactor two slices
# from now would silently reintroduce, and every assertion is already justified
# by a measured failure. Each scenario names the finding it guards:
#
#   restart    finding 1  - kill Postgres mid-burst, assert zero rows lost
#   sigterm    finding 3  - SIGTERM at peak, assert the drain had work to do AND
#                           that every accepted datagram is accounted for
#   partition  finding 2  - start with a one-day runway under a five-day alarm,
#                           assert health degrades while ingest keeps writing
#   spool      finding 9  - fill the spool mid-export, assert one job dies alone
#   wiring     class      - absent worker data must fail CLOSED
#   blip       finding 5  - blip the database during logins, assert no worker
#                           dies
#
# THE PARTITION LINE USED TO SAY "remove tomorrow's partition". It does not, and
# should not: dropping a real partition from a chaos script is the mechanism
# that has cost this project 158GB and 22GB (BUILD-PLAN, "the fixture guard"),
# and this suite contains no destructive SQL at all - deliberately. It shortens
# the LOOKAHEAD instead, which produces the same short-runway state without
# touching data. The genuinely-missing-partition case belongs in a test against
# a disposable table in rscanvas_test, and is not covered here.
#
# EVERY ASSERTION COMES IN A PAIR: one checks the system behaved, the other
# checks the fault actually arrived. A scenario that cannot tell "it worked"
# from "nothing happened" is worse than no scenario, because it reports green.
# Three scenarios were failing that rule and are fixed - see the comments at
# each. Outcomes are ok, skip or FAIL; `skip` exists so an unobservable case
# stops being counted as a pass.
#
# Needs root for systemctl and for filling a loopback filesystem. Run it from
# the lab, with the load generator driving from a second host.
set -uo pipefail

CLUSTER="${PG_CLUSTER:-postgresql@18-main}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_AS="${SUDO_USER:-$USER}"
DB="${DATABASE_URL:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_spike}"
ADMIN_PW="${ADMIN_PASSWORD:-lab-admin-password-1}"
BASE="http://localhost:8080"
ONLY="${1:-all}"

pass=0; fail=0; skip=0
APPLOG=/tmp/chaos-app.log
GENLOG=/tmp/chaos-gen.log
# Per-scenario log files. The first run of this suite had every scenario
# writing to one path, so the spool scenario overwrote the blip scenario's
# evidence before it could be read - an instrument clobbering its own output.
setlogs() {
    APPLOG="/tmp/chaos-$1-app.log"; GENLOG="/tmp/chaos-$1-gen.log"
    # KEEP THE PREVIOUS RUN'S LOG, whether or not it failed.
    #
    # `bad()` preserves logs on failure, which found the pg client error. But
    # the run that showed that error being HANDLED - the evidence the fix
    # worked - was a PASSING run, and it was destroyed by the next one before
    # it could be quoted. Interesting evidence is not confined to failures.
    #
    # One generation deep on purpose: enough to re-read what just happened,
    # not enough to fill /tmp with a history nobody prunes.
    [ -f "$APPLOG" ] && mv "$APPLOG" "${APPLOG%.log}-prev.log" 2>/dev/null
    # Removed and recreated AS THE USER who will write them.
    #
    # Truncating them as root left files the su'd process could not open, and
    # every assertion that reads the log then failed for the wrong reason -
    # the first run reported "the process died on a transient database outage"
    # when the process had simply never started. An instrument breaking its own
    # subject, which is the tenth entry in that tally.
    rm -f "$APPLOG" "$GENLOG"
    su "$RUN_AS" -c "touch '$APPLOG' '$GENLOG'"
}
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
# PRESERVE THE EVIDENCE. setlogs removes each scenario's log at the start of the
# next run, so an intermittent failure destroys its own diagnosis before anyone
# can look at it - which is what happened to a sigterm failure that appeared
# twice in seven runs and could not be reproduced afterwards.
bad() {
    fail=$((fail+1)); echo "  FAIL $1"
    [ -f "$APPLOG" ] && cp "$APPLOG" "${APPLOG%.log}-FAILED.log" 2>/dev/null
    return 0
}
# An outcome that is neither. Counted separately because an `ok` emitted for a
# case the scenario could not observe is ANTI-INFORMATION: it inflates the pass
# count with a check that did not happen, and the suite's total stops meaning
# "this many properties hold".
skip() { skip=$((skip+1)); echo "  skip $1"; }

if [ "$(id -u)" -ne 0 ]; then echo "must run as root" >&2; exit 1; fi

as_user() { su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' ADMIN_PASSWORD='$ADMIN_PW' $1"; }

# WAIT FOR THE APP, do not sleep and hope.
#
# `sleep 6` was the whole of the readiness check, and the setlogs comment above
# records what that cost on the first run: every assertion failed loudly and
# MISATTRIBUTED, because the process had never started. That fix addressed the
# log-permission instance; this addresses the class. A scenario following a
# loaded one can also find port 8080 still held - the ingest drain deadline is
# 15s and stop_app waited 2 - so the next app fails to bind and the scenario
# runs its assertions against a dead process.
#
# Returns non-zero rather than exiting, so the caller reports it as a scenario
# failure with a name attached instead of the suite dying anonymously.
wait_app() {
    for _ in $(seq 1 45); do
        curl -fsS -m 2 "$BASE/api/health/live" >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

start_app() {
    stop_app
    su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' ADMIN_PASSWORD='$ADMIN_PW' \
        EXPORT_SPOOL_DIR='${SPOOL:-/home/user/rscanvas-exports}' \
        nohup node src/main.ts > $APPLOG 2>&1 &"
    wait_app || { bad "the app never became live - every assertion below would be misattributed"; return 1; }
}

# Wait for the PORT to be free, not just for the signal to be sent. A graceful
# shutdown drains for up to 15s, and the next scenario binding 8080 during that
# window fails in a way that looks like the scenario's own subject.
stop_app() {
    as_user "pkill -x -f 'node src/main.ts'" 2>/dev/null
    for _ in $(seq 1 30); do
        curl -fsS -m 1 "$BASE/api/health/live" >/dev/null 2>&1 || return 0
        sleep 1
    done
    # Still holding the port after 30s: take it, and say so.
    as_user "pkill -9 -x -f 'node src/main.ts'" 2>/dev/null
    sleep 2
}

wait_pg() {
    for _ in $(seq 1 60); do
        su - postgres -c "psql -d rscanvas_spike -tAc 'SELECT 1'" >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

# --- finding 1: a restarting database must not lose accepted datagrams -------
#
# The bug: the flush catch discarded the spliced batch on a thrown COPY. Every
# counter the done-when criterion watches read zero while ~15,000 datagrams
# went missing, because the queue never filled so shedding never fired.
scenario_restart() {
    setlogs restart
    echo; echo "=== restart: Postgres down 10s mid-burst (finding 1) ==="
    start_app
    local tag="chaos-restart-$$"

    as_user "TARGET=127.0.0.1 RATE=500 BURST_RATE=2000 BURST_EVERY_S=15 BURST_S=5 \
             DURATION_S=45 RUN_TAG=$tag node tools/udp-load.ts > $GENLOG 2>&1 &"
    sleep 12

    echo "  killing Postgres for 10s while datagrams are arriving"
    systemctl stop "$CLUSTER" >/dev/null 2>&1
    sleep 10
    systemctl start "$CLUSTER" >/dev/null 2>&1
    wait_pg || { bad "Postgres did not come back"; return; }

    # Let the generator finish and the requeued backlog drain.
    sleep 45

    local sent
    sent=$(grep -oP '^SENT=\K[0-9]+' "$GENLOG" | tail -1)
    if [ -z "$sent" ]; then bad "generator produced no SENT line"; return; fi

    local out
    out=$(as_user "RUN_TAG=$tag EXPECT_SENT=$sent WINDOW_HOURS=1 node tools/verify-run.ts" 2>&1)
    if echo "$out" | grep -q '^PASS'; then
        ok "all $sent datagrams survived a 10s database outage"
    else
        bad "datagrams lost across the outage"
        echo "$out" | grep -E 'FAIL|missing|rows in database' | head -4 | sed 's/^/       /'
    fi

    # The requeue path must have actually been exercised, or this proves
    # nothing. A run where the outage happened to miss every flush would pass.
    if grep -q 'ALARM flush threw' "$APPLOG"; then
        ok "the requeue path was exercised (flush threw and requeued)"
    else
        bad "no flush threw - the outage missed the write path, so this run proves nothing"
    fi

    # AND THE KERNEL MUST NOT HAVE DROPPED ANY, which is what this scenario is
    # named for and was not checking.
    #
    # verify-run compares what the application WROTE against what the generator
    # SENT, so it already fails if datagrams went missing - but it cannot say
    # whether they were lost in the application or never delivered to it, and
    # those need completely different fixes. A kernel drop is not recoverable by
    # any queue, requeue or drain: raise RCVBUF_BYTES and net.core.rmem_max.
    #
    # Measured while wiring this up: a 4KB receive buffer at 40,000/s loses
    # 109,707 of 144,911 datagrams, and until today /api/health reported 200
    # throughout.
    # READ WHILE THE APP IS STILL UP, not from the final stats.
    #
    # The shutdown snapshot cannot carry this number: the socket is closed by
    # then, so it has no /proc/net/udp entry and `syslogDrops` comes back null
    # rather than a total. Found by writing this assertion and watching it
    # report UNMONITORED against a run that had dropped nothing.
    #
    # Reading /api/health also means the assertion tests the path an operator
    # actually uses, rather than a log format.
    curl -s -X POST -H 'content-type: application/json' \
         -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" "$BASE/api/login" -c /tmp/chaos-kck >/dev/null
    curl -s -b /tmp/chaos-kck -o /tmp/chaos-kernel.json "$BASE/api/health"
    local kdrops
    kdrops=$(node -e 'const j=require("/tmp/chaos-kernel.json");
        const k=j.ingest&&j.ingest.kernel;
        console.log(!k||!k.available?"UNMONITORED":(k.syslogDrops===null?"NULL":k.syslogDrops))' 2>/dev/null)
    if [ "$kdrops" = "0" ]; then
        ok "the KERNEL dropped none either - nothing was lost before the application saw it"
    elif [ "$kdrops" = "UNMONITORED" ] || [ "$kdrops" = "NULL" ] || [ -z "$kdrops" ]; then
        bad "kernel drops are UNMONITORED here ($kdrops) - this scenario cannot prove its own claim"
    else
        bad "THE KERNEL DROPPED $kdrops datagrams - lost before the application, unrecoverable by any queue"
    fi
    stop_app
}

# --- finding 3: SIGTERM mid-flush must drain, not abandon ---------------------
#
# The bug: stop called flush(), whose reentrancy guard made it a no-op whenever
# a flush was in flight. Shutdown drained nothing and process.exit killed the
# queue - up to 40,000 accepted datagrams during a routine deploy.
scenario_sigterm() {
    setlogs sigterm
    echo; echo "=== sigterm: SIGTERM at peak with a COPY in flight (finding 3) ==="
    start_app
    local tag="chaos-term-$$"

    as_user "TARGET=127.0.0.1 RATE=2000 BURST_RATE=6000 BURST_EVERY_S=10 BURST_S=6 \
             DURATION_S=30 RUN_TAG=$tag node tools/udp-load.ts > $GENLOG 2>&1 &"
    sleep 14

    # BUILD A REAL QUEUE FIRST, and this is not decoration.
    #
    # The first version of this fix asserted the right things and still passed
    # against a deliberately regressed drain() - the exact regression the review
    # described. The reason is that the flush triggers at 200 rows, so under
    # steady load the queue is never more than a few hundred deep and is almost
    # always covered by an in-flight batch. `drain()` returning early then loses
    # nothing, because the flush already in flight writes everything owed.
    #
    # The assertions were sound; the SCENARIO never produced the state they
    # discriminate on. Sending faster does not help - the flush keeps up.
    #
    # So take the database away for a few seconds. The queue builds into the
    # thousands with no flush able to complete, then Postgres comes back and
    # SIGTERM lands with a genuinely deep queue that the drain must work through.
    # It is also the realistic version of this failure: a deploy during a
    # database hiccup is exactly when shutdown has something to lose.
    echo "  stopping Postgres for 6s to build a deep queue"
    systemctl stop "$CLUSTER" >/dev/null 2>&1
    sleep 6

    # SIGTERM WHILE THE DATABASE IS STILL DOWN, then bring it back underneath
    # the drain.
    #
    # Signalling after `wait_pg` does not work: the requeued backlog flushes in
    # the second or two that wait_pg spends polling, and SIGTERM then lands on
    # an empty queue - measured, 0 rows owed. The drain must START with the
    # backlog, which means the signal has to arrive before the database does.
    #
    # This is also the honest version of the failure: a deploy during a database
    # outage. Shutdown holds thousands of accepted datagrams, the database
    # returns mid-drain, and everything owed a write must still get one inside
    # the 15s deadline.
    # IS THE APP STILL ALIVE AT THE MOMENT THE SIGNAL LANDS?
    #
    # Without this the scenario cannot tell its two failure causes apart, and
    # they need completely different fixes. "No stopped line, no drain line, no
    # final stats" is produced BOTH by a broken shutdown path AND by a process
    # that was already dead - and the second is finding 5's territory: a
    # database outage must not kill the process.
    #
    # This mattered immediately. The suite failed with exactly that signature
    # twice in seven full runs and could not be reproduced in four isolated
    # sigterm runs, a restart+sigterm pair, or five further full runs. The
    # output could not say which cause it was, so the failure went undiagnosed.
    # It is also an assertion worth having in its own right, since surviving the
    # outage is finding 5's actual claim.
    local pid_before
    pid_before=$(pgrep -x -f 'node src/main.ts' | head -1)
    if [ -z "$pid_before" ]; then
        bad "THE APP WAS ALREADY GONE BEFORE SIGTERM - it died during the 6s database outage. \
That is finding 5 (a blip must not kill the process), not a shutdown bug. Log kept at ${APPLOG%.log}-FAILED.log"
        systemctl start "$CLUSTER" >/dev/null 2>&1
        wait_pg
        return
    fi
    ok "the app survived the 6s database outage and is alive as SIGTERM lands (pid $pid_before)"

    # THE REGRESSION GUARD FOR THE BUG THIS SCENARIO FOUND.
    #
    # Stopping Postgres with a COPY in flight emitted an 'error' on a
    # CHECKED-OUT client, which had no listener, so Node threw it - and in a
    # worker thread that reaches main as `worker.on('error')`, which exits the
    # process with ~22,000 accepted rows still queued.
    #
    # The liveness check above catches the symptom. This names the cause, so a
    # reintroduction is not mistaken for the environment.
    # jobs included: this enumeration once listed three workers while main.ts
    # wired four, so a jobs-worker death passed green. An enumerated grep has
    # to grow with the thing it enumerates.
    if grep -qE 'FATAL (ingest|collector|export|jobs) worker' "$APPLOG"; then
        bad "a worker died on the outage: $(grep -m1 -oE 'FATAL .* worker error.*' "$APPLOG" | head -c 120)"
    else
        ok "no worker died on the database outage - the connection error stayed a handled transient"
    fi

    echo "  SIGTERM while Postgres is still down, with the backlog held"
    pkill -TERM -x -f 'node src/main.ts'
    sleep 1
    systemctl start "$CLUSTER" >/dev/null 2>&1
    wait_pg || { bad "Postgres did not come back"; return; }
    # The drain has a 15s deadline; give it room plus margin.
    sleep 20

    # WHICH SHUTDOWN PATH DID THIS RUN ACTUALLY TAKE?
    #
    # Printed on every run, passing or failing. If it only appeared on failure,
    # the evidence would exist only in the ~30% of runs that fail - and two of
    # those have already been lost to the next run's setlogs.
    #
    # Four causes produce the same "no stopped line" signature and need four
    # different fixes, so the four markers are read out and named:
    echo "  shutdown trace:"
    for marker in 'SHUTDOWN stop-posted' 'SHUTDOWN stop-received' \
                  'SHUTDOWN drain-enter' 'SHUTDOWN drain-exit' 'SHUTDOWN wait-ended'; do
        line=$(grep -m1 -o "${marker}.*" "$APPLOG")
        printf '    %-28s %s\n' "${marker#SHUTDOWN }" "${line:-MISSING}"
    done

    if grep -q 'stopped' "$APPLOG"; then
        ok "the process completed its shutdown sequence rather than being killed mid-flight"
    elif ! grep -q 'SHUTDOWN stop-posted' "$APPLOG"; then
        bad "main never POSTED the stop - it died before shutdown began, which is finding 5 and not a shutdown bug"
    elif ! grep -q 'SHUTDOWN stop-received' "$APPLOG"; then
        bad "the stop was posted and the worker never RECEIVED it - the ingest worker was wedged"
    elif grep -q 'reason=deadline' "$APPLOG"; then
        bad "drain hit its DEADLINE - $(grep -m1 -o 'drain-exit.*' "$APPLOG")"
    else
        bad "drain exited cleanly but the process never finished reporting - the reporting path only"
    fi

    # --- THE FAULT-ARRIVED HALF ---------------------------------------------
    #
    # This scenario used to stop at the two log-line checks above, and it
    # guarded a DATA LOSS finding without looking at any data. The vacuous pass
    # was concrete: regress drain() to return when `!flushing` without checking
    # queue.length - a one-line simplification of exactly the shape finding 3
    # had - and SIGTERM landing between flushes returns instantly, no ALARM is
    # logged, `stopped` is printed, and 40,000 queued rows die in process.exit.
    # Both assertions pass while the finding is reintroduced.
    #
    # So: prove there was something to drain, then prove it was accounted for.
    #
    # A THOUSAND is the bar, not "more than zero". A few hundred rows are
    # normally covered by whatever flush is already in flight, so a shallow
    # queue cannot distinguish a working drain from one that returns early.
    local owed
    owed=$(grep -oP 'drain-enter owed=\K[0-9]+' "$APPLOG" | tail -1)
    if [ -n "$owed" ] && [ "$owed" -ge 1000 ]; then
        ok "the drain had real work: $owed rows were owed a write when SIGTERM landed"
    elif [ -n "$owed" ]; then
        bad "only $owed rows were queued at SIGTERM - too shallow to discriminate, this run proves nothing"
    else
        bad "no drain line at all - the shutdown path did not reach drain()"
    fi

    # --- THE DATA HALF -------------------------------------------------------
    #
    # Everything ACCEPTED must be accounted for: written, or explicitly shed.
    # verify-run is not usable here because the generator keeps sending after
    # the app is gone and those datagrams are legitimately lost - nothing is
    # listening. What must hold is the ingest worker's own conservation law,
    # read from the final stats it posts on shutdown.
    local final
    final=$(sed -n '/final ingest stats:/,/^}/p' "$APPLOG")
    if [ -z "$final" ]; then
        bad "no final ingest stats were logged - the shutdown path did not report"
    else
        local rec wr shed refused
        rec=$(echo "$final" | grep -oP '"received":\s*\K[0-9]+' | head -1)
        wr=$(echo "$final" | grep -oP '"written":\s*\K[0-9]+' | head -1)
        shed=$(echo "$final" | grep -oP '"shedByUs":\s*\K[0-9]+' | head -1)
        # Rows the database refused on their content (review F4); absent on
        # builds before the field, which is 0.
        refused=$(echo "$final" | grep -oP '"rowsRefused":\s*\K[0-9]+' | head -1)
        refused=${refused:-0}
        local q
        q=$(echo "$final" | grep -oP '"queued":\s*\K[0-9]+' | head -1)
        if [ -n "$rec" ] && [ -n "$wr" ] && [ -n "$shed" ] && [ "$((wr + shed + refused))" -eq "$rec" ]; then
            ok "every accepted datagram is accounted for: received $rec = written $wr + shed $shed + refused $refused"
        else
            bad "accepted datagrams went missing across shutdown: received $rec, written $wr, shed $shed, refused $refused"
        fi
        # The same fact from the other side, and the one a regressed drain
        # trips first: an early return leaves rows sitting in the queue at exit.
        if [ "$q" = "0" ]; then
            ok "the queue was empty at exit - nothing was left behind"
        elif grep -q 'ALARM shutdown deadline reached' "$APPLOG"; then
            ok "$q rows remained but the deadline ALARM named them - loud, not silent"
        else
            bad "$q rows were still queued at exit and nothing said so - drain returned early"
        fi
    fi

    # --- THE OTHER WORKERS (2026-09-01) --------------------------------------
    #
    # Shutdown reached only the ingest worker for the fork's whole life: the
    # collector, jobs and export stop handlers were dead code, the collector
    # lost up to a second of fleet samples on every clean shutdown - and this
    # scenario asserted none of it, which is why it stayed invisible. Every
    # worker that logged `ready` must now drain and post final stats, and a
    # collector drain that hit its deadline must say so the loud way.
    for w in collector jobs; do
        if grep -q "${w} worker ready" "$APPLOG"; then
            if grep -q "final ${w} stats:" "$APPLOG"; then
                ok "the ${w} worker was stopped and posted final stats"
            else
                bad "the ${w} worker started and posted no final stats - its stop path did not run"
            fi
        fi
    done
    if grep -q 'collector worker ready' "$APPLOG" \
        && grep -q 'ALARM abandoning.*pending sample' "$APPLOG"; then
        bad "the collector abandoned pending samples at its drain deadline: $(grep -m1 -o 'ALARM abandoning.*' "$APPLOG" | head -c 120)"
    fi

    # THE BLOCK THAT USED TO BE HERE IS GONE, and its removal is the point.
    #
    # It read: deadline ALARM present -> ok; else `stopped` present -> ok, "the
    # queue drained fully before exit". That second branch inferred a completed
    # drain from the existence of a shutdown log line. Under a deliberately
    # regressed drain() it still reported ok while 21,929 accepted datagrams
    # were dropped - measured, not argued.
    #
    # The three real outcomes - drained, abandoned-and-named, abandoned-silently
    # - are all decided by the `queued` check above, against the number rather
    # than against a string. Keeping both would only have restored the false
    # green beside the true red.
    stop_app
}

# --- finding 2: a missing partition must degrade health before ingest ---------
#
# The bug: nothing created tomorrow's partition, so at the first midnight past
# the last one every COPY failed - and finding 1 discarded each batch silently.
# The fix gives seven days of runway; this asserts the runway is VISIBLE, since
# a margin nothing shouts inside is a fuse.
scenario_partition() {
    setlogs partition
    echo; echo "=== partition: runway exhaustion must be visible (finding 2) ==="
    # One day of lookahead and an alarm threshold above it, so the runway is
    # short the moment the worker starts - no clock manipulation needed.
    as_user "pkill -x -f 'node src/main.ts'" 2>/dev/null; sleep 2
    su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' ADMIN_PASSWORD='$ADMIN_PW' \
        PARTITION_LOOKAHEAD_DAYS=1 PARTITION_RUNWAY_ALARM_DAYS=5 \
        nohup node src/main.ts > $APPLOG 2>&1 &"
    sleep 8

    wait_app || { bad "the app never became live"; return; }

    # `body` and `code` were captured here and never read - two more
    # half-assertions in a scenario already carrying one. The login result is
    # now checked, because every assertion below depends on the cookie it sets
    # and a failed login would make them all report on an unauthenticated 401.
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
           -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" "$BASE/api/login" -c /tmp/chaos-cookie)
    if [ "$code" != "200" ]; then
        bad "login returned $code - the health assertions below would read a 401 body"
        stop_app
        return
    fi
    local health_code
    health_code=$(curl -s -b /tmp/chaos-cookie -o /tmp/chaos-health.json -w '%{http_code}' "$BASE/api/health")

    if [ "$health_code" = "503" ]; then
        ok "/api/health returns 503 while the runway is short"
    else
        bad "/api/health returned $health_code - a short runway is invisible"
    fi

    if grep -q 'partition runway' /tmp/chaos-health.json; then
        ok "the problems array names the runway explicitly"
    else
        bad "health degraded without saying why"
    fi

    # And liveness must NOT degrade, or a container healthcheck pointed here
    # would restart-loop while creating zero partitions.
    local live
    live=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health/live")
    if [ "$live" = "200" ]; then
        ok "/api/health/live stays 200 - a healthcheck here will not restart-loop"
    else
        bad "/api/health/live returned $live - a healthcheck would restart-loop"
    fi

    # --- ingest must still be WRITING, and that has to be observed ----------
    #
    # This was `grep -q '"written"'` - a match on the KEY NAME, which is present
    # in every health payload where ingest has reported at all, at any value,
    # during a scenario that sent no datagrams. It also had no else branch, so a
    # non-match reported nothing. The label claimed a fact the check could not
    # observe.
    #
    # The runway being short is a WARNING, not an outage: writes must continue.
    # So send some, and require the counter to MOVE.
    local w0 w1
    w0=$(node -e 'const j=require("/tmp/chaos-health.json");console.log(j.ingest?.written??"")' 2>/dev/null)
    as_user "TARGET=127.0.0.1 RATE=200 DURATION_S=6 RUN_TAG=chaos-part-$$ node tools/udp-load.ts >> $GENLOG 2>&1"
    sleep 4
    curl -s -b /tmp/chaos-cookie -o /tmp/chaos-health2.json "$BASE/api/health" >/dev/null
    w1=$(node -e 'const j=require("/tmp/chaos-health2.json");console.log(j.ingest?.written??"")' 2>/dev/null)

    if [ -n "$w0" ] && [ -n "$w1" ] && [ "$w1" -gt "$w0" ]; then
        ok "ingest is still accepting and writing while the runway is short ($w0 -> $w1)"
    else
        bad "ingest did not write during a short runway - a WARNING became an outage (written $w0 -> $w1)"
    fi
    stop_app
}

# --- finding 9: a full spool must kill one export, not the worker -------------
scenario_spool() {
    setlogs spool
    echo; echo "=== spool: fill the spool mid-export (finding 9) ==="
    local small=/tmp/chaos-spool
    umount "$small" 2>/dev/null; rm -rf "$small"; mkdir -p "$small"
    # A tiny filesystem, so an export fills it in seconds.
    mount -t tmpfs -o size=12M tmpfs "$small"
    chown "$RUN_AS" "$small"

    SPOOL="$small" start_app
    curl -s -X POST -H 'content-type: application/json' \
         -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" "$BASE/api/login" -c /tmp/chaos-cookie >/dev/null

    # Job A: large enough to overrun 12MB. Job B: small, and innocent.
    #
    # The field greps tolerate spacing (": ?") because they once read only the
    # pretty-printed form, and the 08-31 review's compact-JSON fix broke them
    # without failing them visibly here - a fix that changes an output format
    # has to find every grep that reads the format.
    local a b
    a=$(curl -s -b /tmp/chaos-cookie -X POST -H 'content-type: application/json' \
        -d '{"hours":24,"confirm":true}' "$BASE/api/syslog/export" | grep -oP '"id": ?"\K[^"]+' | head -1)
    b=$(curl -s -b /tmp/chaos-cookie -X POST -H 'content-type: application/json' \
        -d '{"hours":1,"host":"sw-0001"}' "$BASE/api/syslog/export" | grep -oP '"id": ?"\K[^"]+' | head -1)
    sleep 25

    local sa sb
    sa=$(curl -s -b /tmp/chaos-cookie "$BASE/api/exports/$a" | grep -oP '"state": ?"\K[^"]+' | head -1)
    sb=$(curl -s -b /tmp/chaos-cookie "$BASE/api/exports/$b" | grep -oP '"state": ?"\K[^"]+' | head -1)

    if [ "$sa" = "failed" ]; then ok "job A failed on the full spool"; else bad "job A is $sa, expected failed"; fi
    if [ "$sb" = "done" ]; then
        ok "job B completed - one job's disk error did not take the worker down"
    else
        bad "job B is $sb - an innocent job died with job A"
    fi

    # The worker must still be alive to serve a third.
    local c
    c=$(curl -s -b /tmp/chaos-cookie -o /dev/null -w '%{http_code}' -X POST \
        -H 'content-type: application/json' -d '{"hours":1,"host":"sw-0002"}' "$BASE/api/syslog/export")
    if [ "$c" = "202" ]; then ok "the export worker still accepts new jobs"; else bad "export accepts nothing ($c)"; fi

    stop_app
    umount "$small" 2>/dev/null; rm -rf "$small"
}

# --- finding 5: a database blip must not kill a worker ------------------------
scenario_blip() {
    setlogs blip
    echo; echo "=== blip: database restart during a login burst (finding 5) ==="
    as_user "pkill -x -f 'node src/main.ts'" 2>/dev/null; sleep 2
    su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' ADMIN_PASSWORD='$ADMIN_PW' \
        COLLECTOR_ENABLED=1 SNMP_COMMUNITY=public \
        nohup node src/main.ts > $APPLOG 2>&1 &"
    sleep 8

    local tag="chaos-blip-$$"
    as_user "TARGET=127.0.0.1 RATE=500 DURATION_S=40 RUN_TAG=$tag node tools/udp-load.ts > $GENLOG 2>&1 &"
    ( for _ in $(seq 1 40); do
        curl -s -o /dev/null -X POST -H 'content-type: application/json' \
             -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" "$BASE/api/login"
        sleep 0.5
      done ) &

    sleep 10
    echo "  restarting Postgres under login + ingest + collector load"
    # THE RESTART'S OWN EXIT CODE IS CHECKED, because it is the one way this
    # scenario can do nothing at all and still report six green checkmarks.
    # PG_CLUSTER defaults to postgresql@18-main; on a box where the cluster is
    # named anything else, systemctl fails into >/dev/null, wait_pg succeeds
    # immediately because Postgres never stopped, and every assertion below
    # passes by describing a system that was never disturbed.
    if ! systemctl restart "$CLUSTER" >/dev/null 2>&1; then
        bad "systemctl restart $CLUSTER failed - no blip was injected (set PG_CLUSTER)"
        stop_app
        return
    fi
    wait_pg || { bad "Postgres did not come back"; return; }
    sleep 25

    # The whole point: the process is STILL RUNNING. Before the fix, one
    # unhandled rejection in the collector killed the process and took the
    # ingest worker's buffer with it.
    if curl -s -m 5 "$BASE/api/health/live" | grep -q '"ok"'; then
        ok "the process survived the blip - no worker took it down"
    else
        bad "the process died on a transient database outage"
    fi
    # Match OUR fatal line, not any occurrence of the word.
    #
    # A bare grep for FATAL matched `severity: 'FATAL'` inside a logged Postgres
    # error object - which is exactly what a terminated connection reports, so
    # the assertion failed on evidence that the scenario was WORKING. The thing
    # being asserted is that no worker died, and main.ts spells that
    # "FATAL <name> worker".
    if grep -qE 'FATAL (ingest|collector|export|jobs) worker' "$APPLOG"; then
        bad "a worker died: $(grep -m1 -E 'FATAL (ingest|collector|export|jobs) worker' "$APPLOG")"
    else
        ok "no worker died - the blip stayed a handled transient"
    fi
    # The blip must have been FELT, or the scenario proves nothing - a restart
    # that happened to land between every database call would pass the two
    # assertions above while testing nothing.
    #
    # The evidence is any handled failure, not specifically an "async error"
    # line. That first version was too narrow and reported a false FAIL: the
    # blip HAD reached the code, but flush() catches internally and logs
    # "ALARM flush threw", and runPoll catches internally too, so nothing ever
    # reached onAsyncError. The assertion was right and its evidence was wrong.
    #
    # THEN IT WAS WIDENED TOO FAR. The corrected pattern included `failed \(`,
    # which matches the collector's routine poll failures - `failed (timeout)` -
    # and this scenario GENERATES those continuously, because it enables the
    # collector against a fleet that is not running. The meta-assertion
    # therefore passed whether or not the restart did anything, which is the
    # exact defect it was written to prevent, reintroduced by its own fix.
    #
    # The evidence must be DATABASE-shaped: something only a database outage
    # produces. A dead SNMP agent cannot make a COPY throw or a connection be
    # terminated.
    local ev='ALARM flush threw|unhandled rejection survived|ALARM lane refused'
    ev="$ev|ECONNREFUSED|terminating connection|the database system is (starting up|shutting down)"
    if grep -qE "$ev" "$APPLOG"; then
        ok "the blip reached the code and every failure was handled: $(grep -oE "$ev" "$APPLOG" | sort -u | tr '\n' ' ')"
    else
        bad "no DATABASE-shaped failure observed - the blip missed the code path, so this proves nothing"
    fi
    stop_app
}

# --- fail-closed: absent worker data must read as UNHEALTHY -------------------
#
# Not a review finding - a bug the chaos suite itself exposed, and its class is
# broader than the instance. `partitionsUnhealthy` was `partitions !== null &&
# healthy === false`, so MISSING data read as healthy. The ingest worker is
# supposed to publish a runway every second; silence means something is wrong.
#
# The window right after startup, before the first stats message arrives, is
# the absent case occurring naturally - no code needs breaking to produce it.
scenario_wiring() {
    setlogs wiring
    echo; echo "=== wiring: absent worker data must fail CLOSED (class of the nested-field bug) ==="
    as_user "pkill -x -f 'node src/main.ts'" 2>/dev/null; sleep 2
    su "$RUN_AS" -c "cd '$DIR' && DATABASE_URL='$DB' ADMIN_PASSWORD='$ADMIN_PW' \
        nohup node src/main.ts > $APPLOG 2>&1 &"

    # Log in and probe immediately, while the ingest worker has published
    # nothing yet.
    sleep 2
    curl -s -X POST -H 'content-type: application/json' \
         -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" "$BASE/api/login" -c /tmp/chaos-ck >/dev/null 2>&1
    local early
    early=$(curl -s -b /tmp/chaos-ck -o /tmp/chaos-early.json -w '%{http_code}' "$BASE/api/health")

    # THE ONLY BRANCH THAT EARNS AN `ok` IS THE ONE THAT OBSERVED SOMETHING.
    #
    # All three branches used to emit `ok`, including a catch-all that accepted
    # ANY status - a 401 from a failed login, or `000` from an app that never
    # started - as "the worker reported before the probe". The comment
    # acknowledged the race honestly, and then counted the unobserved case as a
    # pass anyway, which inflates the suite's total with a check that did not
    # happen. Connection-refused is not evidence of correct fail-closed
    # behaviour.
    #
    # The race is real and this scenario does not control it, so the honest
    # outcomes are pass, skip, or fail - never pass-by-default. The
    # deterministic version lives in tools/test-health-predicates.ts.
    if [ "$early" = "503" ] && grep -q 'no partition state\|published no stats' /tmp/chaos-early.json; then
        ok "before the worker reports, health is 503 and names the absence"
    elif [ "$early" = "200" ]; then
        skip "the worker reported before the probe - the absent window closed first (covered by test-health-predicates)"
    elif [ "$early" = "503" ]; then
        bad "health was 503 but did not name an absence: $(head -c 200 /tmp/chaos-early.json)"
    else
        bad "probe got HTTP $early - the app was not answering, so nothing was tested"
    fi

    # And it must SETTLE - a predicate that fails closed forever is as useless
    # as one that fails open.
    sleep 10
    local later
    later=$(curl -s -b /tmp/chaos-ck -o /tmp/chaos-later.json -w '%{http_code}' "$BASE/api/health")
    if [ "$later" = "200" ]; then
        ok "and it settles to 200 once the worker is reporting"
    else
        bad "health stayed $later after the worker started reporting: $(grep -m1 -A3 problems /tmp/chaos-later.json | tr -d '\n')"
    fi
    stop_app
}

echo "chaos profile - a regression suite for CODE-REVIEW-2026-07-26"

# ORDER IS SETTABLE, because ORDER IS EVIDENCE.
#
#   SCENARIOS="sigterm restart partition spool blip wiring" sudo -E tools/chaos.sh
#
# The sharpest clue in the undiagnosed sigterm failure is that it passes in
# ISOLATION and fails intermittently in the FULL SUITE. That asymmetry rules out
# anything intrinsic to the scenario and points at accumulated state from
# whatever ran before it - a leaked process still holding port 8080, an
# unreleased Postgres backend, file handles, disk. An app that never starts
# because the previous scenario's cleanup lost a race produces exactly the
# observed signature, because there is then nothing there to shut down.
#
# Moving a scenario to the front tests that in ONE pass instead of many: a
# failure from first position kills the accumulation explanation outright, and
# the same capability bisects which predecessor is responsible if it survives.
DEFAULT_ORDER="restart sigterm partition spool blip wiring"

run_scenario() {
    case "$1" in
        restart)   scenario_restart ;;
        sigterm)   scenario_sigterm ;;
        partition) scenario_partition ;;
        spool)     scenario_spool ;;
        blip)      scenario_blip ;;
        wiring)    scenario_wiring ;;
        *) echo "unknown scenario $1"; exit 2 ;;
    esac
}

if [ "$ONLY" = "all" ]; then
    ORDER="${SCENARIOS:-$DEFAULT_ORDER}"
    [ "$ORDER" != "$DEFAULT_ORDER" ] && echo "scenario order overridden: $ORDER"
    for s in $ORDER; do run_scenario "$s"; done
else
    run_scenario "$ONLY"
fi

echo
echo "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL) - $pass passed, $fail failed, $skip skipped"
if [ "$skip" -gt 0 ]; then
    echo "  ($skip check(s) could not observe their case - a skip is not a pass)"
fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
