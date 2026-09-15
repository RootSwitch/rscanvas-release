#!/usr/bin/env bash
# Evaluate one soak line against SOAK-CRITERIA.md. Prints nothing when healthy.
#
#   echo "<line>" | tools/soak-check.sh          # evaluate one line
#   tools/soak-check.sh --self-test              # prove it can fire
#
# WHY THIS EXISTS. The criteria were the hard part and they were still inert:
# applying them meant a human opening nine columns and remembering what each
# should show. A run that fails on day 2 gets noticed on day 5. So soak.sh
# pipes every line through this and appends what comes back to a breach file
# that stays EMPTY while the run is healthy. Checking the soak becomes "is
# that file empty" rather than an analysis session.
#
# A GAP IS NOT A BREACH. writers<4 means the line was produced while some of
# the load was not running - after a reboot, say - so it is NOT COMPARABLE
# rather than bad. It gets its own prefix, because a stopped run and a failing
# run must not read the same.
#
# AND IT HAS A SELF-TEST, for the reason this whole project keeps relearning:
# an evaluator that never fires and an evaluator that CANNOT fire produce the
# identical empty file. --self-test plants a line per rule that must be caught,
# plus a healthy line that must NOT be, so it cannot pass by flagging
# everything either. (SESSION-NOTES: question 1.)
set -uo pipefail

LOG=${SOAK_LOG:-/home/user/lab/soak.log}
# THE WATERMARK. One line appended per soak line EVALUATED, whether or not it
# breached, so "how far has the checker read" is answerable.
#
# Without it this evaluator has the exact shape it was built to fix, one level
# up: if soak-check dies, errors, or its invocation stops, soak-breaches.log
# stays empty - and empty IS the pass condition. "Healthy" and "nothing was
# checked" produce the identical file. The watermark makes the pass condition
# two-sided: the breach file is empty AND every line written has been read.
EVAL=${SOAK_EVAL_LOG:-/home/user/lab/soak-evaluated.log}

# Thresholds, from SOAK-CRITERIA.md. Kept here as named constants so the file
# and the table can be compared by eye.
MAX_HB_MS=50            # the thesis: a search must not stall the poller
MAX_JOB_FAILS=3         # consecutive failures on any job
MIN_RUNWAY=3            # forward partitions, matching alarmBelowDays
# THERE IS NO MAX_LAG_S, and the reasoning is worth more than the constant.
#
# The rollup writes WHOLE HOURS and its ceiling is the last whole hour at or
# before (now - 5min settle), so at 05:06 the lag reads ~360s and at 05:59 it
# reads ~3540s with the frontier UNMOVED. It sawtooths 300-3900s by
# construction. The first threshold was 900s and breached twice in the first
# hour; raising it to 7200s only moved the problem, because every threshold on
# a sawtooth is wrong in one of two ways - tight enough to fire hourly on a
# healthy rollup, or loose enough that a genuinely stalled frontier hides
# inside the natural range. And it hides WORST at the top of the sawtooth,
# which is exactly when a stall is most likely to be happening.
#
# So the metric changed rather than the number: lag is LOGGED AND NEVER
# CHECKED (like hb_jobs), and what is checked is ADVANCEMENT. See the frontier
# check below.
# THE PLATEAU CONSTANTS ARE DERIVED FROM RETENTION, and moving retention days
# without moving these is how a criterion silently starts describing a
# different system. Recomputed 2026-07-28 for 8-day samples / 9-day messages:
# 45GB steady state, reached about day 9. Each is the plateau plus 25%.
# PER-RUN PINS, OVERRIDABLE FROM THE ENVIRONMENT (2026-09-02, from the first
# morning check of the 30k run). These defaults describe the 450-device
# soak they were derived for. Pinned literally, they made the checker BLIND
# to the 30k ceiling run: that run deliberately carries no syslog or query
# load (two of the four writers), so with EXPECT_WRITERS fixed at 4 every
# one of its hourly lines was a GAP - "not comparable", never evaluated -
# and the only verdicts in its status were the previous run's breaches
# against a plateau (56000) that ruling 9 had already re-pinned to 86000
# for that box. A checker that cannot be told what run it is watching
# grades the wrong run. Override per box in the cron line or a wrapper:
#
#   30k run on lab-stresstest (.50), per DECISIONS ruling 9 and the fleet,
#   APPLIED to its cron line 2026-09-06:
#     MAX_DB_MB=73000 EXPECT_WRITERS=2 MAX_SAMPLES=648000000 MAX_ALERTS_OPEN=2600
#     DERIVED_MSG_DAYS=5 DERIVED_RAW_DAYS=5 DERIVED_ENTITIES=29988 EXPECT_QUERY_LOAD=0
#   (MAX_DB_MB: applied at 86000 on 09-06, the PREVIOUS run's top; re-pinned
#    2026-09-07 to this data's first full sawtooth top, 67,178 MB at the
#    09-07 00:00 line, +5%; re-pinned again 2026-09-13 to 73000 from the
#    09-13 top of 69,802 - the top creeps ~420 MB a night while the 30-day
#    ping-history table fills, so the pin is re-taken about weekly until
#    that table reaches its own retention around 09-30.)
#   (samples: 29,988 entities x 2,880 polls/day x 6 partitions held at
#    RAW_RETENTION_DAYS=5 = 518M, +25%; the 09-02 note said "x 8 days" from
#    the 450-soak default, not that box's unit;
#    alerts_open: a 5%-dead fleet holds ~1,960 if-down rows by construction,
#    which sits inside 40 of the 450-device pin - the fault window would
#    breach it on every cycle.)
#   minipc floor soak (.55), APPLIED the same day:
#     MAX_DB_MB=81000 EXPECT_WRITERS=3 EXPECT_QUERY_LOAD=0
#   (its retention 9/8 and 10k entities ARE the defaults' derivation.)
#
# THE PINS' PROVENANCE MOVES WITH THEM. The first evaluation under the 30k
# pins convicted those pins of describing the wrong system - the derivation
# rule below compared the box's 5/5/29988 against the 450-soak's 9/8/10000
# and breached three times an hour. Overriding a plateau without declaring
# what it was derived for is the drift that rule exists to catch, so the
# DERIVED_* inputs are overridable in the same cron line, and a run without
# query load says so with EXPECT_QUERY_LOAD=0 rather than reading "query
# load is not running" every hour of its life - the evaluator that breaches
# every hour is the one ruling 9 says teaches its reader to skip the line.
#
# The defaults are unchanged so every existing box reads exactly as before.
MAX_DB_MB=${MAX_DB_MB:-56000}
# The count plateaus from SOAK-CRITERIA, with the same headroom. These three
# were in the table and NOT in the evaluator - a criterion nobody checks is a
# criterion in name only, and alerts_open is what the daily fault window
# exists to exercise.
MAX_MSGS=${MAX_MSGS:-97000000}         # 9 days x 8.64M, +25%
MAX_SAMPLES=${MAX_SAMPLES:-288000000}  # 8 days x 28.8M, +25%
MAX_ALERTS_OPEN=${MAX_ALERTS_OPEN:-2000}  # ~450 devices x a few aspects, with room to churn
MAX_WAIT_MS=${MAX_WAIT_MS:-2000}       # interactive-lane p99 wait
EXPECT_WRITERS=${EXPECT_WRITERS:-4}
# 0 declares a run that carries no query load BY DESIGN (the 30k ceiling run,
# the minipc floor soak). The declaration is the record - it sits in the cron
# line beside the pins - so the q_ok rules are silent rather than noting the
# absence hourly. Under the default a dead query load is still a breach.
EXPECT_QUERY_LOAD=${EXPECT_QUERY_LOAD:-1}

# --- THE INPUTS THESE CONSTANTS WERE DERIVED FROM ---------------------------
#
# Writing a derivation down helps a human re-run it. PINNING ITS INPUTS makes
# drift impossible, and this project already built that mechanism for a
# different reference: the differential harness pins PARENT_FILTER_JS by
# commit and sha256, prints what it compared against, and fails loudly BEFORE
# any comparison if the copy moved.
#
# The same problem cost two criteria in one change. Moving retention from 5/3
# to 9/8 silently invalidated MAX_DB_MB, MAX_MSGS, MAX_SAMPLES and the
# judgement date - four derived values describing a system that was no longer
# running, and only the date had anyone looking at it.
#
# So the inputs are pinned rather than the outputs COMPUTED. Computing the
# plateau outright would need a model of index overhead and trigram sizes
# nobody can write accurately; comparing three integers is exact.
DERIVED_MSG_DAYS=${DERIVED_MSG_DAYS:-9}
DERIVED_RAW_DAYS=${DERIVED_RAW_DAYS:-8}
DERIVED_ENTITIES=${DERIVED_ENTITIES:-10000}
# A third either way. The constants are plateau+25%, so they tolerate a
# little drift - what they cannot survive is a different configuration.
DERIVED_ENTITY_TOLERANCE=3300
# THE FOURTH PIN, and the lesson is that it exists at all: index COUNT is a
# plateau input. The db_mb ceiling was derived assuming ONE msg gin per
# partition; the system carries TWO (the parent's partitioned index plus the
# sync's duplicate, SOAK-CRITERIA "Found while fixing it", 2026-07-28), and
# the corrected steady state is ~53GB rather than ~45GB - a term the
# original pin (retention days, entity count) could not see. Pinned at the
# duplicate value DELIBERATELY: this run measures the system as deployed,
# and the dedup dropping the count to 1 must breach here so the plateau
# constants get re-derived in the same commit that changes the input.
DERIVED_MSG_GINS=2
INPUTS=${SOAK_INPUTS:-/home/user/lab/soak-inputs.txt}
# THE RSS BASELINE CAN BE RE-TAKEN, because a restart invalidates it silently.
# rss_mb is judged at +25% over the run's first writers-4 line - a STORED
# baseline, the only criterion of that shape (the hb_ms and frontier checks
# are rolling movement checks, which a restart only loosens for one cycle;
# the 24h trends compare to a rolling point). A restart drops the process to
# a lower RSS while the old, higher baseline stands, so the leak detector
# keeps working but with more headroom than intended - desensitised, not
# broken, and invisible unless recorded. When this file exists its first
# field IS the baseline, and the rest of the line is the recorded reason for
# the discontinuity, read where the number is used. A malformed file breaches
# loudly: a leak detector with no baseline must not read as a passing one.
RSS_BASELINE_FILE=${SOAK_RSS_BASELINE:-/home/user/lab/soak-rss-baseline.txt}
# THE SUBJECT PIN, DATED IN THE DATA rather than only in the commit log.
# Lines at or after this timestamp measure the app by cmdline; lines before
# it measured whichever node process was LARGEST - a rank whose subject
# provably switched mid-series (rss fell 404 -> 377 and 487 -> 462 with no
# restart). Correcting a metric subject is a discontinuity, and every
# comparison that spans the correction inherits it: the 24h rss trend
# refuses to compare across this boundary (UNMEASURED, the psql-sentinel
# principle - a rule that cannot measure says so rather than producing a
# value). Self-clears once the rolling point passes the pin.
RSS_SUBJECT_PINNED_AT="2026-07-29T18:00"

# --- THE COVERAGE MAP --------------------------------------------------------
#
# A PASSING COUNT CANNOT REPORT A MISSING TEST. "27/27" was printed on the
# morning hb_ms was self-comparing, and it is why conns, rss and notifs sat
# with NO control at all for days - three unfired rules guarding judgement
# day. A count says the tests present all pass; it structurally cannot say
# which rules have no test.
#
# So the map is GENERATED FROM THE RULES THEMSELVES: every emission site
# carries `# RULE:<id>`, every control declares `# COVERS:<id>`, and a rule
# added later without a control appears here as a blank the day it is added.
# This is the frontier discrimination turned on the suite: not "did anything
# fail", but "would this look identical if nothing were being checked".
coverage_map() {
    local self="${BASH_SOURCE[0]}"
    local rules covers rid missing=0
    rules=$(grep -o '# RULE:[a-z0-9_]*' "$self" | sed 's/.*://' | sort -u)
    covers=$(grep -o '# COVERS:[a-z0-9_]*' "$self" | sed 's/.*://' | sort -u)
    echo "rule                        control"
    echo "--------------------------  -------"
    for rid in $rules; do
        if printf '%s
' "$covers" | grep -qx "$rid"; then
            printf '%-26s  yes
' "$rid"
        else
            printf '%-26s  ---- NO CONTROL
' "$rid"
            missing=$((missing + 1))
        fi
    done
    echo
    if [ "$missing" -eq 0 ]; then
        echo "COVERAGE COMPLETE - every rule has a control that makes it fire"
        return 0
    fi
    echo "COVERAGE INCOMPLETE - $missing rule(s) have no control: they cannot be"
    echo "distinguished from rules that are simply never violated."
    return 1
}

evaluate() {
    local line="$1"
    # shellcheck disable=SC2034
    # hb_over/hb_ticks/hb_p99 are named here rather than left to fall into
    # `reasons`. read gives every trailing field to its LAST variable, so
    # appending columns without naming them would have folded three numbers
    # into the refusal-reason string - which is glob-matched, so it would not
    # have failed, it would have printed them inside a breach message. Lines
    # written before 2026-08-14 have 19 fields and leave these three empty;
    # nothing below reads them yet, and whatever eventually does must treat
    # empty as UNMEASURED rather than as zero.
    # trgm_uncov joined them 2026-08-15 and is the first of these trailing
    # columns anything actually READS. Lines written before it have 22 fields
    # and leave it empty, which the admission rule below treats as UNMEASURED
    # exactly as the note above requires - an unmeasured precondition cannot
    # excuse a breach, and cannot convict one either.
    read -r ts conns db_mb msgs samples notifs alerts_open lag_s \
            front_epoch runway rss_mb hb_ms hb_jobs waitp jobfail writers \
            q_ok q_ref reasons hb_over hb_ticks hb_p99 trgm_uncov <<< "$line"

    local num='^-?[0-9]+$'
    if ! [[ $writers =~ $num ]]; then
        echo "MALFORMED $ts - the line does not parse, so nothing below was checked"   # RULE:malformed_line
        return
    fi

    # The gap case first, and it RETURNS: a line produced with the load half
    # down should not also generate a pile of threshold breaches that are
    # really just consequences of nothing running.
    if [ "$writers" -lt "$EXPECT_WRITERS" ]; then
        echo "GAP $ts - only $writers of $EXPECT_WRITERS writers alive; this line is NOT comparable"   # RULE:writers_gap
        return
    fi

    # -1 IS A SENTINEL, NOT A MEASUREMENT, and every check below is an upper
    # bound - so -1 passes all of them. That is form 2 INSIDE the criteria:
    # when the health probe fails, hb_ms, waitp and jobfail all read -1, the
    # line passes cleanly, and `writers` stays 4 because the process is alive
    # and only the login failed. Healthy and blind produce the same verdict.
    #
    # It gets its own outcome for the same reason a gap does: unmeasured is
    # not a value, and it must not be able to satisfy a bound.
    local unmeasured=""
    [ "$hb_ms" -lt 0 ] && unmeasured="$unmeasured hb_ms"
    [ "$waitp" -lt 0 ] && unmeasured="$unmeasured waitP"
    [ "$jobfail" -lt 0 ] && unmeasured="$unmeasured jobfail"
    if [ -n "$unmeasured" ]; then
        echo "UNMEASURED $ts -${unmeasured} read -1: the health probe failed, so THE THESIS COLUMNS were not verified this hour"   # RULE:unmeasured_sentinel
        return
    fi

    # THE DERIVATION PIN. Checked first, because every threshold below is only
    # meaningful for the configuration its constants were derived from.
    if [ -f "$INPUTS" ]; then
        local in_msg in_raw in_ent in_gins
        read -r in_msg in_raw in_ent in_gins < "$INPUTS"
        if [[ $in_msg =~ $num ]] && [ "$in_msg" -ne "$DERIVED_MSG_DAYS" ]; then
            echo "BREACH $ts MESSAGE_RETENTION_DAYS is $in_msg, but the plateau constants were derived for $DERIVED_MSG_DAYS - they describe a system that is no longer running"   # RULE:pin_msg_days
        fi
        if [[ $in_raw =~ $num ]] && [ "$in_raw" -ne "$DERIVED_RAW_DAYS" ]; then
            echo "BREACH $ts RAW_RETENTION_DAYS is $in_raw, but the plateau constants were derived for $DERIVED_RAW_DAYS - recompute them and the judgement date"   # RULE:pin_raw_days
        fi
        if [[ $in_ent =~ $num ]]                 && { [ "$in_ent" -gt $((DERIVED_ENTITIES + DERIVED_ENTITY_TOLERANCE)) ]                   || [ "$in_ent" -lt $((DERIVED_ENTITIES - DERIVED_ENTITY_TOLERANCE)) ]; }; then
            echo "BREACH $ts entities is $in_ent, outside the $DERIVED_ENTITIES the samples plateau was derived from"   # RULE:pin_entities
        fi
        # An OLDER inputs file has no fourth field; that is a gap in the pin,
        # not a pass, and it says so rather than quietly checking three of four.
        if ! [[ ${in_gins:-} =~ $num ]]; then
            echo "BREACH $ts the inputs file has no msg-gin count - the pin is missing a plateau input (rerun soak.sh)"   # RULE:pin_gin_missing
        elif [ "$in_gins" -ne "$DERIVED_MSG_GINS" ]; then
            echo "BREACH $ts today's partition has $in_gins msg gin index(es), but db_mb's ceiling was derived for $DERIVED_MSG_GINS - re-derive the plateau (the dedup landing IS this breach; re-pin in its commit)"   # RULE:pin_gin_drift
        fi
    fi

    # hb_ms IS A RUNNING MAXIMUM. worstGapMs is cumulative from process start
    # and nothing resets it, so once a stall happens the column breaches
    # FOREVER, even after the system recovers - the same monotone-metric bug
    # as overThresholdCount, one level out. Observed live across nine hours:
    # 17, 47, 124, 228, 320, 420, 500, 561, 561 - where the last two are the
    # same stall reported twice.
    #
    # So what is checked is MOVEMENT, the frontier trick inverted: a monotone
    # maximum that stopped rising means no NEW stall happened. A rise past the
    # threshold is a new stall this hour, and it is reported once.
    if [ "$hb_ms" -gt "$MAX_HB_MS" ]; then
        # "Previous" must mean the line BEFORE this one, under BOTH wirings.
        # Under cron, soak.sh's stdout is appended to the log BEFORE the
        # evaluator runs, so tail -1 is the line currently being evaluated -
        # and comparing a line against itself meant "rose" was never true.
        # That is how hb_ms printed 66 -> 543 -> 578 -> 628 across the morning
        # of 2026-07-29 - a live leak, five hourly readings past the 50ms
        # limit - while the breach file stayed empty; the leak announced
        # itself only when the collector crashed at 10:28. The self-test
        # missed it because its fixture pipes lines that were never appended,
        # so tail -1 WAS the previous line there. Both layouts are now
        # handled, and both are controls.
        local prev_hb=""
        if [ -f "$LOG" ] && [ -s "$LOG" ]; then
            if [ "$(tail -1 "$LOG" | awk '{print $1}')" = "$ts" ]; then
                # Cron wiring: last line is this line; previous is one up.
                [ "$(wc -l < "$LOG")" -ge 2 ] && prev_hb=$(tail -2 "$LOG" | head -1 | awk '{print $12}')
            else
                # Fixture/pipe wiring: the log ends at the true previous line.
                prev_hb=$(tail -1 "$LOG" | awk '{print $12}')
            fi
        fi
        if ! [[ $prev_hb =~ $num ]] || [ "$hb_ms" -gt "$prev_hb" ]; then
            echo "BREACH $ts hb_ms rose to $hb_ms (limit $MAX_HB_MS) - a NEW stall on a latency-sensitive thread, which is THE THESIS"   # RULE:hb_ms_movement
        fi
    fi
    [ "$jobfail" -ge "$MAX_JOB_FAILS" ] && \
        echo "BREACH $ts jobfail=$jobfail - a scheduled job has failed $jobfail times running"   # RULE:job_failures
    [ "$runway" -lt "$MIN_RUNWAY" ] && \
        echo "BREACH $ts runway=$runway < $MIN_RUNWAY - partition creation is losing to the clock"   # RULE:partition_runway
    # lag_s IS LOGGED AND NEVER CHECKED, the same treatment as hb_jobs.
    #
    # It sawtooths 300-3900s by construction, so EVERY threshold on it is
    # wrong in one of two ways: tight enough to fire hourly on a healthy
    # rollup, or loose enough that a genuinely stalled frontier hides inside
    # the natural range - and it hides WORST at the top of the sawtooth, which
    # is exactly when a stall is most likely to be happening. A number worth
    # SEEING is not automatically a number worth THRESHOLDING.
    #
    # The actual failure is a frontier that STOPPED, so that is what is
    # measured: has it moved in the last two hours? Phase-independent, cannot
    # sawtooth, and it catches the real thing within two hours wherever in the
    # cycle it happens. Two rather than one because a healthy frontier
    # legitimately sits still for up to 59 minutes.
    if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -ge 3 ]; then
        local two_back
        two_back=$(tail -3 "$LOG" | head -1 | awk '{print $9}')
        if [[ $two_back =~ $num ]] && [ "$two_back" -gt 0 ] \
                && [ "$front_epoch" -eq "$two_back" ]; then
            echo "BREACH $ts the rollup frontier has NOT ADVANCED in 2h (still $front_epoch) - a stalled rollup, whatever lag_s reads"   # RULE:frontier_stalled
        fi
    fi
    # INGEST STALLED: the message count has not moved in two hours.
    #
    # ADDED 2026-08-10 because the run had just been down for 3.5 hours and
    # NOTHING SAID SO. A power outage stopped the VM; postgres came back as a
    # systemd service and the app, the fleet and the load generator did not,
    # because nothing supervises them. The evaluator's existing instruments all
    # missed it by construction: `writers` reads the process count and there was
    # no line at all to read it from, and the gap rule needs somebody to run
    # soak-status and look. It was found by accident, three hours late.
    #
    # This is the frontier-stalled shape applied to ingest, and it is deliberately
    # NOT a threshold on the rate: a rate needs a floor that is wrong in both
    # directions (tight enough to fire on a slow hour, loose enough to hide a
    # stall), whereas STOPPED is unambiguous. Two hours for the same reason the
    # frontier check uses two - one hour of stillness can be a scheduling edge.
    #
    # It fires on the line AFTER writing resumes as well as during, which is
    # wanted: a run that silently lost two hours should say so once it is back.
    #
    # THE MONOTONICITY PRECONDITION, learned 2026-08-20. msgs is a row count,
    # and the night retention began dropping message partitions on
    # lab-stresstest it REGRESSED by a day of rows just after midnight -
    # three consecutive nights of "ingest is stopped" on a box that wrote
    # 360k rows through every hour of it (breach file, Aug 18-20). A count
    # retention subtracts from is not monotonic, so "has not advanced"
    # cannot be read from <= against two-back alone. A stall now requires
    # the count to HOLD STILL against the previous line - no healthy hour
    # writes nothing - while sitting at-or-below two back, so a single
    # scheduling edge still gets its grace hour. The retention shape
    # (regression with fresh writing on top) stays silent, because ingest
    # is demonstrably alive; a stall that overlaps a drop fires one line
    # later, when the post-drop value is seen holding still.
    if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -ge 3 ]; then
        local msgs_two_back msgs_one_back
        msgs_two_back=$(tail -3 "$LOG" | head -1 | awk '{print $4}')
        msgs_one_back=$(tail -2 "$LOG" | head -1 | awk '{print $4}')
        if [[ $msgs_two_back =~ $num ]] && [ "$msgs_two_back" -gt 0 ] \
                && [[ $msgs_one_back =~ $num ]] && [ "$msgs_one_back" -gt 0 ] \
                && [ "$msgs" -le "$msgs_two_back" ] && [ "$msgs" -eq "$msgs_one_back" ]; then
            echo "BREACH $ts msgs has NOT ADVANCED in 2h (still $msgs) - ingest is stopped, whatever writers reads"   # RULE:ingest_stalled
        fi
    fi
    [ "$db_mb" -gt "$MAX_DB_MB" ] && \
        echo "BREACH $ts db_mb=$db_mb > $MAX_DB_MB - past the computed plateau, so retention is not holding"   # RULE:db_mb_ceiling
    [ "$waitp" -gt "$MAX_WAIT_MS" ] && \
        echo "BREACH $ts waitP=$waitp > $MAX_WAIT_MS - the interactive lane is queueing behind something"   # RULE:lane_wait

    # ZERO REFUSALS IS A FAILING SOAK, not a quiet one: it means admission was
    # never exercised, so its passing means nothing.
    if [ "$EXPECT_QUERY_LOAD" -eq 0 ]; then
        :   # declared: no query load on this run, so neither rule below applies (see EXPECT_QUERY_LOAD)
    elif [ "$q_ok" -le 0 ]; then
        echo "BREACH $ts q_ok=$q_ok - the query load is not running, so the thesis is untested this hour"   # RULE:query_load_dead
    elif [ "$q_ref" -le 0 ]; then
        echo "BREACH $ts q_ref=$q_ref - NO refusals: admission never fired, so its passing means nothing"   # RULE:query_refusals_zero
    fi

    # THE THREE COUNT CRITERIA, which SOAK-CRITERIA promised and the evaluator
    # did not implement - so the fault window's own purpose had no rule
    # checking it. alerts_open is the one the daily outage exists to test.
    [ "$msgs" -gt "$MAX_MSGS" ] &&         echo "BREACH $ts msgs=$msgs > $MAX_MSGS - past the 5-day plateau, so message retention is not dropping"   # RULE:msgs_plateau
    [ "$samples" -gt "$MAX_SAMPLES" ] &&         echo "BREACH $ts samples=$samples > $MAX_SAMPLES - past the 3-day plateau, so raw retention is not dropping"   # RULE:samples_plateau
    [ "$alerts_open" -gt "$MAX_ALERTS_OPEN" ] &&         echo "BREACH $ts alerts_open=$alerts_open > $MAX_ALERTS_OPEN - alerts raising and never clearing"   # RULE:alerts_open_climb

    # A query that should have been refused and was not: the rule stopped
    # applying, which is worse than a breach of any threshold above.
    #
    # UNCONDITIONAL, AND IT WAS BRIEFLY NOT. For a few hours on 2026-08-15 the
    # free-text case was excused whenever trgm_uncov was 0, on the reading that
    # complete trigram coverage leaves nothing for the rule to refuse. That
    # reading was WRONG, and the alarm it suppressed was TRUE: minipc's
    # admitted 240h free-text query was taking 27-30 SECONDS, 1,828 times, and
    # saturating the heavy lane that admission itself depends on.
    #
    # THE PROXY WAS THE MISTAKE, not the threshold on it. Coverage answers "is
    # a trigram index present", and the question that matters is "is the cost
    # predictable" - which for `ILIKE '%sub%'` it is not, because Postgres has
    # no selectivity statistics for substrings. With ORDER BY ts DESC LIMIT 50
    # over an OR of two such predicates the planner abandons both trigram
    # indexes and gambles on a backward ts scan, which is fast when the term is
    # common and unbounded when it is rare. EXPLAIN proves it, and proves the
    # gamble is invisible to any index-inventory check:
    #
    #   OR + ORDER BY/LIMIT  ->  Index Scan using messages_*_ts_idx   (30s)
    #   OR, no order/limit   ->  Bitmap Index Scan, both trgm         (fast)
    #   msg only, +order     ->  Bitmap Index Scan, msg_trgm          (fast)
    #
    # So the probe's original expectation - free text, no device filter, long
    # window, REFUSE, full stop - was right for a reason nobody had written
    # down: not "the index is missing" but "the cost is unpredictable".
    # Coverage merely correlated with that on a box old enough to have
    # uncovered partitions, and inverted on a young one. A correlated proxy
    # that inverts is worse than no proxy, because it fails exactly where the
    # thing it stood for stops being true.
    #
    # trgm_uncov stays LOGGED because it is the number that explains WHY a box
    # is admitting - it is context, not a precondition, and nothing reads it as
    # one.
    case "$reasons" in
        *ADMITTED-BUT-SHOULD-REFUSE*)
            echo "BREACH $ts $reasons - a query that MUST be refused was admitted (trgm_uncov=${trgm_uncov:-unmeasured})" ;;   # RULE:admitted_should_refuse
    esac

    # --- the RUN BASELINE, which only a long run can test --------------------
    #
    # Taken from the first line whose writers were all up, so a restart-time
    # reading cannot become the reference. +25% at day 7 allows the sawtooth
    # of a working heap while catching a monotone climb, which is what
    # restart-dependent state looks like when nothing restarts.
    if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -ge 24 ]; then
        local base_rss=""
        if [ -f "$RSS_BASELINE_FILE" ]; then
            base_rss=$(awk '{print $1; exit}' "$RSS_BASELINE_FILE")
            if ! [[ $base_rss =~ $num ]] || [ "${base_rss:-0}" -le 0 ]; then
                echo "BREACH $ts the rss baseline file is malformed - the leak detector has NO baseline, which must not read as passing"   # RULE:rss_baseline_malformed
                base_rss=""
            fi
        else
            # $16 is writers, $11 is rss_mb. Column numbers, not guesses: the
            # first version used $15 and read jobfail, which is how the whole
            # front_epoch insertion shifted two checks at once.
            base_rss=$(awk '$16 == 4 { print $11; exit }' "$LOG")
        fi
        if [[ $base_rss =~ $num ]] && [ "$base_rss" -gt 0 ]                 && [ "$rss_mb" -gt $((base_rss * 5 / 4)) ]; then
            echo "BREACH $ts rss_mb $base_rss -> $rss_mb since the baseline (+25% limit) - the detector for restart-dependent state"   # RULE:rss_over_baseline
        fi
    fi

    # --- trends, against the line 24 hours back ------------------------------
    # Only once the log is deep enough to have one, and only for the columns
    # whose failure mode is a slow climb rather than a threshold.
    if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 25 ]; then
        local prev
        prev=$(tail -25 "$LOG" | head -1)
        # ts conns db msgs samples notifs alerts lag front runway rss ...
        read -r _ p_conns p_db _ _ p_notifs _ _ _ _ _ _ <<< "$prev"
        if [[ $p_conns =~ $num ]]; then
            [ "$conns" -gt $((p_conns + 10)) ] && \
                echo "BREACH $ts conns $p_conns -> $conns in 24h - a connection leak pays out on this timescale"   # RULE:trend_conns
            # THE RSS TREND IS CEILING AGAINST CEILING (2026-09-10), not point
            # against point. The first form compared this hour's reading with
            # the single line 24 hours back, and on lab-stresstest under the
            # HEAD build it convicted a flat process: that build's RSS sits at
            # 620-636 MB nine samples in ten and dips to 386-550 for a few
            # seconds about once a minute (sampled at ten seconds, HANDOFF
            # 5i), so about one hourly line in five is a trough, and a trough
            # exactly a day before a normal reading read as "385 -> 633,
            # memory climbing". A leak is a RISING CEILING; a swing under a
            # flat one is not a leak. So the rule takes the highest reading of
            # the last 24 lines against the highest of the 24 before, same
            # +50% threshold, and needs two full days of log to say anything.
            # The subject-pin guard moves with it: the OLDEST line of the
            # earlier window must post-date the pin, so it self-clears 48h
            # after a pin rather than 24. Column 11 is rss_mb, as in the
            # baseline rule above; -1 sentinels and blanks are not readings.
            if [ "$(wc -l < "$LOG")" -ge 48 ]; then
                local win_ts; win_ts=$(tail -48 "$LOG" | head -1 | awk '{print $1}')
                if [[ "$win_ts" < "$RSS_SUBJECT_PINNED_AT" ]]; then
                    echo "UNMEASURED $ts rss-24h windows span the subject pin ($win_ts predates $RSS_SUBJECT_PINNED_AT): the earlier window measured a rank, this one measures the app - two subjects, no comparison; self-clears 48h after the pin"   # RULE:trend_rss_pin_guard
                else
                    local prev_max cur_max
                    prev_max=$(tail -48 "$LOG" | head -24 | awk '$11 ~ /^[0-9]+$/ && $11 + 0 > m { m = $11 + 0 } END { print m + 0 }')
                    cur_max=$(tail -24 "$LOG" | awk '$11 ~ /^[0-9]+$/ && $11 + 0 > m { m = $11 + 0 } END { print m + 0 }')
                    # The evaluated line counts in its own window whichever
                    # wiring delivered it (already appended under cron, only
                    # piped under a fixture).
                    [ "$rss_mb" -gt "$cur_max" ] && cur_max=$rss_mb
                    [ "$prev_max" -gt 0 ] && [ "$cur_max" -gt $((prev_max * 3 / 2)) ] && \
                        echo "BREACH $ts rss ceiling $prev_max -> $cur_max across 24h windows - memory climbing across days (the highest reading of the last 24 lines against the highest of the 24 before; a swing under a flat ceiling does not fire this)"   # RULE:trend_rss
                fi
            fi
            [ "$notifs" -gt $((p_notifs * 2)) ] && [ "$p_notifs" -gt 1000 ] && \
                echo "BREACH $ts notifs $p_notifs -> $notifs in 24h - the table that was unbounded until 2026-07-28"   # RULE:trend_notifs
        fi
    fi
}

self_test() {
    # The self-test proves the RULES against the pins its fixtures were
    # written for, so the per-run overrides above are reset here: a cron
    # wrapper exporting the 30k pins must not make `npm test` fail (a
    # planted db_mb=60000 only breaches under 56000) - or, worse, pass a
    # broken rule because the fixture no longer reaches it.
    MAX_DB_MB=56000; MAX_MSGS=97000000; MAX_SAMPLES=288000000
    MAX_ALERTS_OPEN=2000; MAX_WAIT_MS=2000; EXPECT_WRITERS=4
    DERIVED_MSG_DAYS=9; DERIVED_RAW_DAYS=8; DERIVED_ENTITIES=10000; EXPECT_QUERY_LOAD=1
    echo "soak-check self-test: every rule must FIRE, and a healthy line must not"
    # ISOLATE FROM PRODUCTION STATE. Three rules now read $LOG for history -
    # the frontier advancement, the RSS baseline, and hb_ms movement - so with
    # LOG pointing at the real soak.log a control's verdict depends on what
    # the running soak happens to contain. It did: this passed locally where
    # no soak.log exists and FAILED on the lab, where the last line held
    # hb_ms=561 and a planted 51 was therefore not a rise. A self-test whose
    # result depends on the machine it runs on is not a test.
    LOG=$(mktemp)
    EVAL=/dev/null
    # The derivation pin reads a file too, so it gets the same isolation - and
    # it is seeded with the PINNED values so the other controls see a matching
    # configuration rather than a spurious drift breach.
    INPUTS=$(mktemp)
    printf '%s %s %s %s
' "$DERIVED_MSG_DAYS" "$DERIVED_RAW_DAYS" "$DERIVED_ENTITIES" "$DERIVED_MSG_GINS" > "$INPUTS"
    # Same isolation for the rss baseline file: the in-process controls keep
    # their fixture logs under 24 lines so the rss rule never fires there, but
    # "never fires" resting on a line count is thinner than pointing the path
    # somewhere that cannot exist.
    RSS_BASELINE_FILE="$LOG.nobase"
    trap 'rm -f "$LOG" "$INPUTS"' RETURN
    local pass=0 fail=0
    # ts conns db_mb msgs samples notifs alerts lag runway rss hb waitP jobfail writers q_ok q_ref reasons
    # hb_jobs is deliberately LARGE in the healthy line: the jobs thread
    # blocking must not by itself flag anything.
    local HEALTHY="2026-07-28T05:00 15 12000 40000000 80000000 900 40 300 1790000000 7 400 12 800 50 0 4 120 30 unindexed-free-text=10"

    # ASSERT THE SPECIFIC MESSAGE, never just that a breach appeared.
    #
    # In a thirteen-rule evaluator a control can pass on the WRONG RULE'S
    # verdict: plant an RSS violation, a breach appears, the control goes
    # green - and the breach was the stalled-frontier check answering first.
    # The control then proved that A rule fired, not that YOURS did, and it
    # proves it silently.
    #
    # AN EMPTY `want` IS REFUSED, because `[[ x == *""* ]]` is true for every
    # string including the empty one - so a control written that way can never
    # fail. There was exactly one: the busy-jobs-thread control, which existed
    # to assert SILENCE and instead asserted nothing at all, including the
    # violation it was there to forbid. Use check_silent for that case.
    check() {
        local label="$1" line="$2" want="$3"
        if [ -z "$want" ]; then
            fail=$((fail + 1))
            echo "  FAIL $label - EMPTY expectation: this control could never fail. Use check_silent."
            return
        fi
        local got
        got=$(evaluate "$line")
        if [[ "$got" == *"$want"* ]]; then
            pass=$((pass + 1)); echo "  ok   $label"
        else
            fail=$((fail + 1)); echo "  FAIL $label - wanted '$want', got '${got:-<nothing>}'"
        fi
    }

    # A line that must produce NOTHING at all.
    check_silent() {
        local label="$1" line="$2"
        local got
        got=$(evaluate "$line")
        if [ -z "$got" ]; then
            pass=$((pass + 1)); echo "  ok   $label"
        else
            fail=$((fail + 1)); echo "  FAIL $label - expected silence, got '$got'"
        fi
    }

    # The negative control FIRST. Without it this could pass by flagging
    # everything, which is an evaluator that is useless in the other direction.
    local got
    got=$(evaluate "$HEALTHY")
    if [ -z "$got" ]; then
        pass=$((pass + 1)); echo "  ok   a healthy line produces NOTHING - the file stays empty when the run is fine"
    else
        fail=$((fail + 1)); echo "  FAIL a healthy line was flagged: $got"
    fi

    check "heartbeat over threshold is caught"  "${HEALTHY/ 12 800 / 51 800 }" "THE THESIS"   # COVERS:hb_ms_movement
    check_silent "a BUSY JOBS THREAD alone is NOT flagged - it blocks by design"                  "${HEALTHY/ 12 800 / 12 4000 }"
    check "job failures are caught"             "${HEALTHY/ 0 4 120 / 3 4 120 }" "jobfail=3"   # COVERS:job_failures
    check "a shrinking runway is caught"        "${HEALTHY/1790000000 7 /1790000000 2 }" "runway=2"   # COVERS:partition_runway
    check "passing the plateau is caught"       "${HEALTHY/ 12000 / 60000 }" "db_mb=60000"   # COVERS:db_mb_ceiling
    check "lane queueing is caught"             "${HEALTHY/ 800 50 0 4 / 800 5000 0 4 }" "interactive lane"   # COVERS:lane_wait
    check "ZERO REFUSALS is caught"             "${HEALTHY/ 120 30 / 120 0 }" "admission never fired"   # COVERS:query_refusals_zero
    check "a dead query load is caught"         "${HEALTHY/ 4 120 30 / 4 0 0 }" "query load is not running"   # COVERS:query_load_dead
    # A run DECLARED to carry no query load is not a dead query load. The
    # 30k ceiling run and the minipc floor soak run without soak-query by
    # design, and under the default they breached "query load is not
    # running" every hour - the evaluator-that-breaches-every-hour failure
    # ruling 9 names. The declaration lives in the cron line, so the verdict
    # is silence rather than an hourly note nobody would read. Both
    # directions asserted: the default must still convict the same line.
    local NOQ="${HEALTHY/ 4 120 30 unindexed-free-text=10/ 4 -1 -1 no-query-load}"
    EXPECT_QUERY_LOAD=0
    check_silent "a DECLARED no-query-load run is silent on q_ok=-1" "$NOQ"
    EXPECT_QUERY_LOAD=1
    check "and the same line under the default is still a dead query load" "$NOQ" "query load is not running"
    # THE PINS' PROVENANCE MOVES WITH THEM. The first evaluation under the
    # 30k pins convicted those pins of describing the wrong system, because
    # the derivation inputs were still the 450-soak's. Declaring them in the
    # same cron line is what makes an overridden plateau honest; a run whose
    # inputs differ from the DECLARED derivation is still caught.
    {
        local ptmp; ptmp=$(mktemp); printf '5 5 29988 2\n' > "$ptmp"
        local oldin="$INPUTS"; INPUTS="$ptmp"
        check "inputs that differ from the DEFAULT derivation are caught" "$HEALTHY" "derived for 9"   # COVERS:pin_msg_days
        check "and the entity count too"                                 "$HEALTHY" "outside the 10000"   # COVERS:pin_entities
        DERIVED_MSG_DAYS=5; DERIVED_RAW_DAYS=5; DERIVED_ENTITIES=29988
        check_silent "DECLARING the derivation those pins came from makes the same inputs silent" "$HEALTHY"
        DERIVED_MSG_DAYS=9; DERIVED_RAW_DAYS=8; DERIVED_ENTITIES=10000
        INPUTS="$oldin"; rm -f "$ptmp"
    }
    check "an admitted-but-should-refuse is caught"           "${HEALTHY/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:no-index=1}" "MUST be refused"   # COVERS:admitted_should_refuse

    # THE SUPPRESSION REGRESSION GUARD (2026-08-15). The first control below
    # is the one that matters, and it exists because this exact line was
    # asserted the OTHER WAY for a few hours the same day: free text admitted
    # with trgm_uncov=0 was called UNMEASURED on the reading that complete
    # coverage leaves nothing to refuse. It was suppressing a 30-second query
    # running 1,828 times. Coverage is context, never an excuse - if this test
    # ever needs changing, read the block in evaluate() first.
    local NOCOL="$HEALTHY 4231 9086000 2"         # 22 fields, pre-2026-08-15
    local UNCOV0="$NOCOL 0"                       # 23 fields, nothing uncovered
    local UNCOV3="$NOCOL 3"                       # 23 fields, 3 uncovered
    check_silent "a 23-field line is healthy and silent"                    "$UNCOV0"
    check "free text admitted with NOTHING uncovered is STILL a breach - coverage never excuses" \
        "${UNCOV0/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:free-text=10}" "MUST be refused"   # COVERS:admitted_should_refuse
    check "and the breach carries trgm_uncov as context, not as a verdict" \
        "${UNCOV0/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:free-text=10}" "trgm_uncov=0"
    check "free text admitted WITH uncovered partitions is a breach too" \
        "${UNCOV3/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:free-text=10}" "MUST be refused"
    check "an admission on a line with no trgm_uncov column still breaches" \
        "${NOCOL/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:free-text=10}" "trgm_uncov=unmeasured"
    check "a pre-label admission breaches - unattributable is not unjudgeable" \
        "${UNCOV0/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE=1}" "MUST be refused"
    check "no-index breaches alongside free-text, not instead of it" \
        "${UNCOV0/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:free-text=10,ADMITTED-BUT-SHOULD-REFUSE:no-index=1}" "no-index=1"

    # BOTH LINE WIDTHS PARSE, which is the whole risk of appending columns.
    # The 22-field shape arrived 2026-08-14 (hb_over, hb_ticks, hb_p99); the
    # 19-field shape is every line written before it, and 401 of those exist on
    # the lab host. An evaluator that only handled the new width would go blind
    # on history, and one that only handled the old would fold three numbers
    # into `reasons` - which is glob-matched, so it would not fail, it would
    # quietly print them inside a breach message.
    local WIDE="$HEALTHY 4231 9086000 2"
    check_silent "the WIDE line (22 fields, post-2026-08-14) is healthy and silent" "$WIDE"
    check "and its rules still fire - the new columns did not shift the old ones" \
        "${WIDE/ 12 800 / 51 800 }" "THE THESIS"
    check "a wide line's refusal reasons are still read cleanly" \
        "${WIDE/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:no-index=1}" "MUST be refused"
    # And the reason string must not have absorbed the trailing numbers: the
    # breach prints $reasons, so a fold shows up here and nowhere else.
    if [[ "$(evaluate "${WIDE/unindexed-free-text=10/ADMITTED-BUT-SHOULD-REFUSE:no-index=1}")" == *"9086000"* ]]; then
        fail=$((fail + 1)); echo "  FAIL the new columns were folded into reasons"
    else
        pass=$((pass + 1)); echo "  ok   the new columns stayed out of the reason string"
    fi
    # The baseline check needs a log to read, so it is exercised against a
    # temp one rather than left untested - an unfired rule is an unproven rule.
    {
        local tmp; tmp=$(mktemp)
        local i
        # Advancing frontier in the fixture, so ONLY the RSS rule can fire -
        # otherwise the stalled-frontier check answers first and the control
        # passes for the wrong reason.
        for i in $(seq 1 30); do
            echo "${HEALTHY/1790000000/$((1790000000 + i * 3600))}" >> "$tmp"
        done
        local grown; grown="${HEALTHY/1790000000 7 400 /1790100000 7 900 }"
        # SOAK_EVAL_LOG TO /dev/null. Without it this control appends to the
        # REAL watermark - a test writing production state, which soak-status
        # caught immediately as "more lines evaluated than written". Form 3 in
        # my own self-test, one file away from where it is described.
        # EVERY file the subprocess reads is pointed at fixture state - the
        # inputs pin and the rss baseline file included. Without the explicit
        # SOAK_RSS_BASELINE the control silently switches baselines the day a
        # real baseline file exists on this machine, and passes for the wrong
        # number: a control touching production state is not portable.
        local got
        got=$(SOAK_LOG="$tmp" SOAK_EVAL_LOG=/dev/null SOAK_INPUTS="$INPUTS" \
              SOAK_RSS_BASELINE="$tmp.nobase" bash "$0" <<< "$grown")
        if [[ "$got" == *"400 -> 900 since the baseline"* ]]; then
            pass=$((pass + 1)); echo "  ok   RSS growth against the RUN BASELINE is caught - the 7-day detector"   # COVERS:rss_over_baseline
        else
            fail=$((fail + 1)); echo "  FAIL the baseline RSS check did not fire - got '${got:-<nothing>}'"
        fi

        # THE RE-TAKEN BASELINE: a restart drops RSS and desensitises the
        # stored day-1 number, so the baseline file overrides the first-line
        # scan. 500 makes the same grown line breach at a DIFFERENT number -
        # proof the file is the operative baseline, not just present.
        printf '500 taken after a restart, for this control
' > "$tmp.base"
        got=$(SOAK_LOG="$tmp" SOAK_EVAL_LOG=/dev/null SOAK_INPUTS="$INPUTS" \
              SOAK_RSS_BASELINE="$tmp.base" bash "$0" <<< "$grown")
        if [[ "$got" == *"500 -> 900 since the baseline"* ]]; then
            pass=$((pass + 1)); echo "  ok   a re-taken baseline file OVERRIDES the first-line scan - restarts get a recorded reset"
        else
            fail=$((fail + 1)); echo "  FAIL the baseline file did not override - got '${got:-<nothing>}'"
        fi

        # And a malformed baseline file must be LOUD: a leak detector with no
        # baseline reading as a pass is form 2 wearing a config file.
        printf 'not-a-number
' > "$tmp.base"
        got=$(SOAK_LOG="$tmp" SOAK_EVAL_LOG=/dev/null SOAK_INPUTS="$INPUTS" \
              SOAK_RSS_BASELINE="$tmp.base" bash "$0" <<< "$grown")
        if [[ "$got" == *"NO baseline"* ]]; then
            pass=$((pass + 1)); echo "  ok   a malformed baseline file breaches instead of silently disarming the detector"   # COVERS:rss_baseline_malformed
        else
            fail=$((fail + 1)); echo "  FAIL a malformed baseline file was tolerated - got '${got:-<nothing>}'"
        fi
        rm -f "$tmp" "$tmp.base"
    }

    # THE CRON WIRING, which the fixture layout never tested: under cron the
    # evaluated line is ALREADY the log's last line, and the first version
    # compared it against itself - hb could rise forever without one breach.
    # These two controls pin both halves: a rise over the true previous line
    # fires, and a repeat of an old stall stays silent.
    {
        local wtmp; wtmp=$(mktemp)
        local risen="${HEALTHY/ 12 800 / 600 800 }"
        printf '%s\n%s\n' "${HEALTHY/ 12 800 / 100 800 }" "$risen" > "$wtmp"
        local got
        got=$(SOAK_LOG="$wtmp" SOAK_EVAL_LOG=/dev/null SOAK_INPUTS="$INPUTS" \
              SOAK_RSS_BASELINE="$wtmp.nobase" bash "$0" <<< "$risen")
        if [[ "$got" == *"hb_ms rose to 600"* ]]; then
            pass=$((pass + 1)); echo "  ok   under CRON WIRING (line already in the log) an hb rise still fires"   # COVERS:hb_ms_movement
        else
            fail=$((fail + 1)); echo "  FAIL cron-wired hb rise was missed - the self-compare bug is back - got '${got:-<nothing>}'"
        fi
        printf '%s\n%s\n' "${HEALTHY/ 12 800 / 600 800 }" "$risen" > "$wtmp"
        got=$(SOAK_LOG="$wtmp" SOAK_EVAL_LOG=/dev/null SOAK_INPUTS="$INPUTS" \
              SOAK_RSS_BASELINE="$wtmp.nobase" bash "$0" <<< "$risen")
        if [[ "$got" != *"hb_ms rose"* ]]; then
            pass=$((pass + 1)); echo "  ok   and an OLD stall repeated is silent - movement, not threshold"
        else
            fail=$((fail + 1)); echo "  FAIL a repeated stall re-fired: '$got'"
        fi
        rm -f "$wtmp"
    }

    # EVERY MOVEMENT CHECK, under the wiring production actually has. The hb
    # self-compare bug proved the class: a current-vs-previous check whose
    # "previous" resolves differently under cron (line already appended) and
    # fixture (line only piped) can pass its self-test forever while blind or
    # blaring in production. So the frontier and the 24h trends get planted
    # movement under CRON wiring - the evaluated line is the log's LAST line -
    # with both directions asserted where the failure mode differs.
    {
        local mtmp; mtmp=$(mktemp)
        local oldlog="$LOG"
        local got
        # Frontier, cron-wired, STALLED: same front three lines running. Its
        # self-compare failure mode is the OPPOSITE of hb's - it would breach
        # every healthy line - so the advancing case below is the load-bearing
        # negative, not a formality.
        printf '%s\n%s\n%s\n' "$HEALTHY" "$HEALTHY" "$HEALTHY" > "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$HEALTHY"); LOG="$oldlog"
        # ASSERT THE FRONTIER'S OWN WORDING, not the shared "NOT ADVANCED".
        # Three identical lines stall the frontier AND the message count, so
        # both stall rules fire here and a loose match would let ingest_stalled
        # answer for this control. That is the failure this block's own comment
        # warns about, and adding a second stall rule created it.
        if [[ "$got" == *"frontier has NOT ADVANCED"* ]]; then
            pass=$((pass + 1)); echo "  ok   cron-wired frontier STALL fires"   # COVERS:frontier_stalled
        else
            fail=$((fail + 1)); echo "  FAIL cron-wired frontier stall missed - got '${got:-<nothing>}'"
        fi
        # INGEST STALLED, isolated the other way: the frontier ADVANCES across
        # these three lines so the frontier rule is silent and cannot answer,
        # while msgs stands still.
        local f1="${HEALTHY/1790000000 7 /1790003600 7 }"
        local f2="${HEALTHY/1790000000 7 /1790007200 7 }"
        printf '%s\n%s\n%s\n' "$HEALTHY" "$f1" "$f2" > "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$f2"); LOG="$oldlog"
        if [[ "$got" == *"msgs has NOT ADVANCED"* ]]; then
            pass=$((pass + 1)); echo "  ok   cron-wired INGEST STALL fires"   # COVERS:ingest_stalled
        else
            fail=$((fail + 1)); echo "  FAIL cron-wired ingest stall missed - got '${got:-<nothing>}'"
        fi
        # The load-bearing negative for BOTH stall rules: everything advances.
        local g1="${f1/ 40000000 / 40001000 }"
        local g2="${f2/ 40000000 / 40002000 }"
        printf '%s\n%s\n%s\n' "$HEALTHY" "$g1" "$g2" > "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$g2"); LOG="$oldlog"
        if [ -z "$got" ]; then
            pass=$((pass + 1)); echo "  ok   cron-wired ADVANCING frontier and ingest are silent - no self-compare false alarm"
        else
            fail=$((fail + 1)); echo "  FAIL an advancing frontier/ingest was flagged under cron wiring: '$got'"
        fi
        # THE RETENTION SHAPE, silent: the count regresses by a day of rows
        # (a partition dropped) with fresh writing on top. This exact
        # sequence fired "ingest is stopped" for three nights on
        # lab-stresstest (2026-08-18..20) under the old <=-against-two-back
        # comparison, while the box wrote 360k rows every hour of it.
        local r1="${f1/ 40000000 / 31500000 }"
        local r2="${f2/ 40000000 / 31860000 }"
        printf '%s\n%s\n%s\n' "$HEALTHY" "$r1" "$r2" > "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$r2"); LOG="$oldlog"
        if [ -z "$got" ]; then
            pass=$((pass + 1)); echo "  ok   cron-wired retention regression is SILENT - ingest demonstrably alive"
        else
            fail=$((fail + 1)); echo "  FAIL a retention drop with live ingest was called a stall: '$got'"
        fi
        # And a stall OVERLAPPING a drop still fires, one line later: the
        # post-drop value holds still, which no healthy hour does.
        local s2="${f2/ 40000000 / 31500000 }"
        printf '%s\n%s\n%s\n' "$HEALTHY" "$r1" "$s2" > "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$s2"); LOG="$oldlog"
        if [[ "$got" == *"msgs has NOT ADVANCED"* ]]; then
            pass=$((pass + 1)); echo "  ok   cron-wired stall-after-drop fires"
        else
            fail=$((fail + 1)); echo "  FAIL a stall behind a retention drop was missed - got '${got:-<nothing>}'"
        fi
        # The 24h trends - conns, rss, notifs - had NO controls at all: three
        # unfired rules guarding judgement day. One cron-wired fixture, 47
        # steady lines then a line that climbs all three, each named breach
        # asserted individually so no rule can hide behind another's firing.
        # (47, not 26, since 2026-09-10: the rss trend compares two 24-line
        # windows and says nothing under 48 lines of log.)
        : > "$mtmp"
        local i base
        # Post-pin timestamps, or the subject-pin guard (correctly) refuses
        # the rss comparison and this control tests the guard, not the trend.
        base="${HEALTHY/2026-07-28T05:00/2026-07-30T05:00}"
        base="${base/ 80000000 900 40 / 80000000 1500 40 }"
        for i in $(seq 1 47); do
            echo "${base/1790000000/$((1790000000 + i * 3600))}" >> "$mtmp"
        done
        local climbed="${HEALTHY/2026-07-28T05:00/2026-07-30T05:00}"
        climbed="${climbed/T05:00 15 12000 /T05:00 40 12000 }"
        climbed="${climbed/ 80000000 900 40 / 80000000 4000 40 }"
        climbed="${climbed/1790000000 7 400 /1790200000 7 900 }"
        echo "$climbed" >> "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$climbed"); LOG="$oldlog"
        local want
        for want in "conns 15 -> 40 in 24h" "rss ceiling 400 -> 900" "notifs 1500 -> 4000 in 24h"; do
            if [[ "$got" == *"$want"* ]]; then
                pass=$((pass + 1)); echo "  ok   24h trend fires under cron wiring: $want"   # COVERS:trend_conns # COVERS:trend_rss # COVERS:trend_notifs
            else
                fail=$((fail + 1)); echo "  FAIL 24h trend missed '$want' - got '${got:-<nothing>}'"
            fi
        done
        # The guard itself, on a PRE-pin fixture: rss-24h refuses with the
        # pin named, the rss breach is suppressed, and conns still fires -
        # the guard is surgical, not a blanket over the trend block.
        : > "$mtmp"
        base="${HEALTHY/ 80000000 900 40 / 80000000 1500 40 }"
        for i in $(seq 1 47); do
            echo "${base/1790000000/$((1790000000 + i * 3600))}" >> "$mtmp"
        done
        local preclimb="$HEALTHY"
        preclimb="${preclimb/T05:00 15 12000 /T05:00 40 12000 }"
        preclimb="${preclimb/1790000000 7 400 /1790200000 7 900 }"
        echo "$preclimb" >> "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$preclimb"); LOG="$oldlog"
        if [[ "$got" == *"span the subject pin"* && "$got" != *"memory climbing"* && "$got" == *"conns 15 -> 40 in 24h"* ]]; then
            pass=$((pass + 1)); echo "  ok   a pre-pin earlier window makes rss-24h UNMEASURED, suppresses only rss, conns still fires"   # COVERS:trend_rss_pin_guard
        else
            fail=$((fail + 1)); echo "  FAIL the subject-pin guard misbehaved - got '${got:-<nothing>}'"
        fi
        # THE SWING, which the point-against-point form convicted on
        # lab-stresstest at 2026-09-10 03:00: a flat 633 MB ceiling for two
        # days with one 385 MB trough sitting exactly 24 lines before the
        # evaluated line. The old rule read the trough as the baseline and
        # the ceiling as a 64% climb; ceiling against ceiling reads 633
        # against 633 and says nothing. Everything else in the fixture
        # advances (frontier, msgs) so only the trend block can speak, and
        # the assertion is SILENCE, which check_silent would not give under
        # cron wiring - hence the explicit form.
        : > "$mtmp"
        base="${HEALTHY/2026-07-28T05:00/2026-07-30T05:00}"
        local flat="${base/ 7 400 / 7 633 }"
        local trough="${base/ 7 400 / 7 385 }"
        for i in $(seq 1 47); do
            local src="$flat"
            [ "$i" -eq 24 ] && src="$trough"
            src="${src/1790000000/$((1790000000 + i * 3600))}"
            echo "${src/ 40000000 / $((40000000 + i * 1000)) }" >> "$mtmp"
        done
        local swung="${flat/1790000000/$((1790000000 + 48 * 3600))}"
        swung="${swung/ 40000000 / $((40000000 + 48 * 1000)) }"
        echo "$swung" >> "$mtmp"
        LOG="$mtmp"; got=$(evaluate "$swung"); LOG="$oldlog"
        if [ -z "$got" ]; then
            pass=$((pass + 1)); echo "  ok   a trough a day before a normal reading under a FLAT ceiling is silent - a swing is not a leak"
        else
            fail=$((fail + 1)); echo "  FAIL the swing was called a climb: '$got'"
        fi
        rm -f "$mtmp"
    }

    check "msgs past the plateau is caught"     "${HEALTHY/ 40000000 / 99000000 }" "msgs=99000000"   # COVERS:msgs_plateau
    check "samples past the plateau is caught"  "${HEALTHY/ 80000000 / 300000000 }" "samples=300000000"   # COVERS:samples_plateau
    check "alerts_open climbing is caught"      "${HEALTHY/ 900 40 / 900 5000 }" "alerts_open=5000"   # COVERS:alerts_open_climb
    check "a -1 sentinel is UNMEASURED, never a pass"           "${HEALTHY/ 12 800 50 0 / -1 800 50 0 }" "UNMEASURED"   # COVERS:unmeasured_sentinel
    check "and -1 in waitP is caught too"       "${HEALTHY/ 800 50 0 4 / 800 -1 0 4 }" "UNMEASURED"
    # THE DERIVATION PIN, in both directions.
    {
        printf '5 3 10000 %s
' "$DERIVED_MSG_GINS" > "$INPUTS"
        local got; got=$(evaluate "$HEALTHY")
        if [[ "$got" == *"no longer running"* ]] && [[ "$got" == *"RAW_RETENTION_DAYS is 3"* ]]; then
            pass=$((pass + 1)); echo "  ok   retention drifting from the pinned inputs is caught, BOTH days named"   # COVERS:pin_msg_days   # COVERS:pin_raw_days
        else
            fail=$((fail + 1)); echo "  FAIL the derivation pin missed a retention change - got '${got:-<nothing>}'"
        fi

        printf '%s %s 30000 %s
' "$DERIVED_MSG_DAYS" "$DERIVED_RAW_DAYS" "$DERIVED_MSG_GINS" > "$INPUTS"
        got=$(evaluate "$HEALTHY")
        if [[ "$got" == *"outside the $DERIVED_ENTITIES"* ]]; then
            pass=$((pass + 1)); echo "  ok   and an entity count outside tolerance is caught"   # COVERS:pin_entities
        else
            fail=$((fail + 1)); echo "  FAIL the entity-count pin missed 30,000 - got '${got:-<nothing>}'"
        fi

        # The msg-gin count: the input the first pin could not see. 1 is the
        # exact value the dedup will produce, so this control is a rehearsal
        # of the breach that change MUST cause.
        printf '%s %s %s 1
' "$DERIVED_MSG_DAYS" "$DERIVED_RAW_DAYS" "$DERIVED_ENTITIES" > "$INPUTS"
        got=$(evaluate "$HEALTHY")
        if [[ "$got" == *"re-derive the plateau"* ]]; then
            pass=$((pass + 1)); echo "  ok   the msg-gin count drifting is caught - the dedup cannot land without re-deriving"   # COVERS:pin_gin_drift
        else
            fail=$((fail + 1)); echo "  FAIL the index-count pin missed a change - got '${got:-<nothing>}'"
        fi

        # A three-field inputs file is a PIN WITH A HOLE, not a pass.
        printf '%s %s %s
' "$DERIVED_MSG_DAYS" "$DERIVED_RAW_DAYS" "$DERIVED_ENTITIES" > "$INPUTS"
        got=$(evaluate "$HEALTHY")
        if [[ "$got" == *"missing a plateau input"* ]]; then
            pass=$((pass + 1)); echo "  ok   an inputs file without the gin count is flagged, not quietly three-quarters checked"   # COVERS:pin_gin_missing
        else
            fail=$((fail + 1)); echo "  FAIL a short inputs file passed the pin - got '${got:-<nothing>}'"
        fi

        # The negative control: matching inputs must say NOTHING, or every
        # line of a correctly configured run carries a spurious breach.
        printf '%s %s %s %s
' "$DERIVED_MSG_DAYS" "$DERIVED_RAW_DAYS" "$DERIVED_ENTITIES" "$DERIVED_MSG_GINS" > "$INPUTS"
        got=$(evaluate "$HEALTHY")
        if [ -z "$got" ]; then
            pass=$((pass + 1)); echo "  ok   and matching inputs produce nothing - the pin is silent when it agrees"
        else
            fail=$((fail + 1)); echo "  FAIL matching inputs still flagged: $got"
        fi
    }

    check "a gap is a GAP, not a breach"        "${HEALTHY/ 0 4 120 / 0 2 120 }" "GAP"   # COVERS:writers_gap
    check "a malformed line says so"            "garbage" "MALFORMED"   # COVERS:malformed_line

    echo
    # THE MAP RUNS AS PART OF THE SELF-TEST, not beside it: a suite that can
    # pass while a rule is untested is the thing this whole section exists to
    # prevent, so an incomplete map FAILS the self-test.
    coverage_map || fail=$((fail + 1))
    echo
    if [ "$fail" -eq 0 ]; then
        echo "PASS - $pass passed, $fail failed, coverage complete"
        return 0
    fi
    echo "FAIL - $pass passed, $fail failed"
    return 1
}

if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
fi

if [ "${1:-}" = "--coverage" ]; then
    coverage_map
    exit $?
fi

while IFS= read -r line; do
    [ -z "$line" ] && continue
    evaluate "$line"
    # After evaluating, not before: a line that crashed the evaluator must not
    # be recorded as read, or the backlog check would forgive the crash.
    printf '%s
' "${line%% *}" >> "$EVAL"
done
