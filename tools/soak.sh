#!/usr/bin/env bash
# One soak snapshot line. EVERY COLUMN HAS A FAILURE READING, written down in
# SOAK-CRITERIA.md before the run started - a column with no failure reading
# is a column not worth logging, and a soak with no stated pass condition is
# form 2 of the instrument rule: its success and its blindness look identical.
#
# Read it with:  column -t /home/user/lab/soak.log | less -S
#
# Columns, and what each is for (full pass/fail table in SOAK-CRITERIA.md):
#
#   ts             hour stamp
#   conns          pooled connections. Monotone climb = a leak, and days are
#                  the only timescale it is visible on.
#   db_mb          must PLATEAU near 45GB by day 9, not climb.
#   msgs samples   must plateau near 78M / 230M. Climbing = retention is not.
#   notifs         the table that was unbounded until 2026-07-28.
#   alerts_open    churns within a band; climbing = alerts never clearing.
#   lag_s          rollup frontier lag. LOGGED, NEVER CHECKED: it sawtooths
#                  300-3900s by construction, so any threshold either fires
#                  hourly or hides a stall inside the natural range.
#   front_epoch    the frontier itself. What IS checked: has it advanced in
#                  the last two hours? Phase-independent, and it detects the
#                  real failure - a rollup that stopped.
#   runway         forward partitions. >= 3 always.
#   rss_mb         largest node RSS. Includes the load generators, by design
#                  and stated in demo-lab.sh.
#   hb_ms          worst gap across the LATENCY-SENSITIVE threads (main,
#                  ingest, collector) WHILE QUERIES RUN. This is THE THESIS: a
#                  search must not stall the poller. Over 50 is a failure.
#                  CUMULATIVE from process start, so it is checked for
#                  MOVEMENT, not level - see soak-check.sh. It answers "how bad
#                  was the worst one" and nothing about how often.
#   hb_jobs        the jobs thread's worst gap, INFORMATIONAL. It blocks by
#                  design - that is what its own thread is for - so a large
#                  value here is the rollup working, not a fault. It would
#                  only matter if it moved hb_ms, which is the point of
#                  measuring them apart.
#   waitP          the interactive lane's worst wait. Tracking export activity
#                  would mean the lanes are not isolating.
#   jobfail        worst consecutive-failure count across the three jobs.
#   writers        how many of the 4 load processes are alive. ANYTHING BELOW
#                  4 MEANS THE LINE IS NOT COMPARABLE - after a reboot the
#                  cron survives and the writers do not, so the counts go flat
#                  and a stopped run reads exactly like a healthy plateau.
#   q_ok q_ref     queries admitted / refused in the last minute. ZERO
#                  REFUSALS IS A FAILING SOAK - it means admission was never
#                  exercised, so its passing means nothing.
#   reasons        refusal reasons seen, so the right rules are firing.
#
#   -- appended 2026-08-14, at the END per the rule below --
#   hb_over        excursions past the 50ms threshold, SUMMED across the three
#                  latency-sensitive threads, CUMULATIVE from process start.
#   hb_ticks       heartbeat ticks over the same three, also cumulative. Logged
#                  beside hb_over so the pair can be DIFFERENCED against the
#                  previous line: (hb_over now - hb_over prev) is the hour's
#                  excursions, and dividing by the tick delta gives the rate.
#                  This is the pair hb_ms could not be, because a maximum does
#                  not difference.
#   hb_p99         worst p99 gap across the same three. A since-start
#                  percentile, so it lags - context for the counts, not the
#                  detector.
#
#   LOGGED, NOT YET CHECKED, deliberately - the same treatment lag_s gets. Two
#   readings exist (lab 11 excursions in 3.0M ticks, mini PC 3,680 in 5.1M) and
#   that is not a range. A threshold guessed from two points either fires
#   hourly on the mini PC, whose whole purpose is to be the modest machine, or
#   hides a real change inside the natural spread. It gets derived from
#   measurement once there are days of it, per the constants rule.
set -euo pipefail

DB=postgres://rscanvas:rscanvas@localhost:5432/rscanvas_demo
BASE=${SOAK_BASE:-http://127.0.0.1:18080}
QLOG=${SOAK_QUERY_LOG:-/tmp/soak-query.log}
CJ=/tmp/soak-cookie.txt

Q() { psql "$DB" -tAq -c "$1"; }

# --- MEMOIZED PARTITION COUNTS (2026-08-13) ----------------------------------
#
# The naive `count(*) FROM messages` was, measured, THE SYSTEM'S DOMINANT DISK
# READER: 703,124 buffer pages per call on 2026-08-02, sprinting to 33+ GB of
# actual disk per hour once the corpus outgrew the page cache (the LRU cliff,
# SOAK-CRITERIA) - an instrument costing more IO than the application it
# watched. On the mini PC's 16 GB the cliff would arrive on day 2.
#
# WHY MEMOIZATION IS EXACT RATHER THAN APPROXIMATE, which is the whole
# argument (reltuples was rejected as the fallback for being an estimate):
# a CLOSED daily partition is STRUCTURALLY immutable. `ts` is receive time,
# stamped by parse() from the collector's own clock - never the device's
# claim - and the tables are PARTITION BY RANGE (ts), so once a day's
# partition has closed, no row can ever land in it again. Its count is a
# fact, not a cache. Retention DROPS whole partitions, which the sum handles
# by only ever summing partitions that still exist.
#
# So: each closed partition is counted ONCE EVER (the first run after it
# closes pays one scan of one day), the memo carries it until the partition
# is dropped, and the hourly query scans only TODAY - which is exactly the
# data the page cache holds anyway.
#
# All-or-nothing on failure: any error empties the result and the sentinel
# path below fires unchanged, so the evaluator's contract is untouched.
MEMO=${SOAK_COUNTS_MEMO:-/home/user/lab/soak-counts-memo.txt}

memoized_count() {
    local parent=$1
    local closed memo_total live p c
    closed=$(psql "$DB" -tAq -c "
        SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = '${parent}'::regclass
           AND c.relname ~ ('^${parent}_[0-9]{8}' || chr(36))
           AND to_date(right(c.relname, 8), 'YYYYMMDD') < current_date") || return 1
    touch "$MEMO"
    memo_total=0
    for p in $closed; do
        c=$(awk -v p="$p" '$1 == p {print $2; exit}' "$MEMO")
        if [ -z "$c" ]; then
            c=$(psql "$DB" -tAq -c "SELECT count(*) FROM ${p}") || return 1
            [ -n "$c" ] || return 1
            printf '%s %s\n' "$p" "$c" >> "$MEMO"
        fi
        memo_total=$(( memo_total + c ))
    done
    # Prune memo lines for THIS parent whose partition no longer exists
    # (retention dropped it). Other parents' lines pass through untouched.
    awk -v pfx="^${parent}_" -v keep="$(echo $closed | tr ' ' ',')" '
        $1 !~ pfx { print; next }
        index("," keep ",", "," $1 ",") > 0 { print }' "$MEMO" > "$MEMO.tmp" \
        && mv "$MEMO.tmp" "$MEMO"
    # Today's partition only, by pruning: the predicate matches the partition
    # bounds, so postgres never touches a closed partition here.
    live=$(psql "$DB" -tAq -c "SELECT count(*) FROM ${parent} WHERE ts >= current_date") || return 1
    [ -n "$live" ] || return 1
    echo $(( memo_total + live ))
}

msgs_memo=$(memoized_count messages) || msgs_memo=""
samples_memo=$(memoized_count samples) || samples_memo=""

counts=$(psql "$DB" -tAF' ' -c "
    SELECT to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI'),
           (SELECT numbackends FROM pg_stat_database WHERE datname = 'rscanvas_demo'),
           pg_database_size('rscanvas_demo') / 1024 / 1024,
           (SELECT count(*) FROM notifications),
           (SELECT count(*) FROM alerts WHERE state <> 'cleared'),
           (SELECT coalesce(extract(epoch FROM now() - max(through_ts))::int, -1)
              FROM job_state WHERE job = 'rollup'),
           -- The frontier ITSELF, so advancement is checkable. lag_s cannot
           -- say whether it moved: it changes every hour whether the rollup
           -- runs or not. (No double quotes in here - this SQL lives inside a
           -- double-quoted shell string and one closed it.)
           (SELECT coalesce(extract(epoch FROM max(through_ts))::bigint, 0)
              FROM job_state WHERE job = 'rollup'),
           -- The date parse hides inside CASE so it cannot run on a
           -- non-partition name. The naked form let the planner push
           -- to_date(right(relname, 8)) below the inhparent join and evaluate
           -- it against EVERY pg_class row - which errored on the first name
           -- whose tail is not a date, killed the whole counts query, and
           -- emitted the postgres-down sentinel while postgres was fine.
           -- Never bit on the lab because ITS planner ordered the join first:
           -- same SQL, two plans, one of them an outage. Found on the mini
           -- PC's first line, 2026-08-13.
           (SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = 'samples'::regclass
               AND CASE WHEN c.relname ~ ('^samples_[0-9]{8}' || chr(36))
                        THEN to_date(right(c.relname, 8), 'YYYYMMDD') > current_date
                        ELSE false END)" 2>/dev/null || true)

# POSTGRES ITSELF DOWN is the single most important condition this run could
# report, and until 2026-07-29 it was the one condition guaranteed to be
# SILENT: psql failing under set -e killed this script before the line was
# emitted. A monitor that queries what it monitors dies exactly when what it
# monitors dies - the failure is not merely possible, it is CORRELATED with
# the event of interest. So the counts degrade to sentinels and the line goes
# out anyway; -1 in every database column with the writers count intact is a
# line the evaluator refuses to score (UNMEASURED/GAP), and a refused line in
# the log beats a hole nobody can date.
# Reassemble the line in its HISTORICAL column order: the msgs and samples
# columns now come from the memo path, spliced back into positions 4 and 5.
# The evaluator parses by column number and must see the format it always has.
# All-or-nothing: a failure in EITHER path degrades the whole line to the
# sentinel, exactly as before - a partially-real line would defeat the
# evaluator's "-1 in every database column" recognition.
if [ -n "$counts" ] && [ -n "$msgs_memo" ] && [ -n "$samples_memo" ]; then
    counts=$(echo "$counts" | awk -v m="$msgs_memo" -v s="$samples_memo" \
        '{printf "%s %s %s %s %s", $1, $2, $3, m, s; for (i = 4; i <= NF; i++) printf " %s", $i; print ""}')
else
    counts="$(date -u +%Y-%m-%dT%H:%M) -1 -1 -1 -1 -1 -1 -1 -1 -1"
fi

# THE INPUTS EVERY DERIVED CONSTANT ASSUMES, written to their own file.
#
# Recorded rather than recomputed, and in a SEPARATE file rather than as more
# columns: the plateau constants were derived from retention days and an
# entity count, and when retention changed those constants silently began
# describing a different system. Writing the derivation down helps a human
# re-run it; PINNING THE INPUTS makes the drift impossible - which is exactly
# what test-engine-differential does with PARENT_FILTER_JS, printing the
# commit and sha256 it compared against and failing before any comparison if
# the copy moved. Same problem, solved once already.
#
# Read from the RUNNING process, not from demo-lab.sh: what matters is the
# configuration that is actually live, and those two have already disagreed
# once this session.
INPUTS=${SOAK_INPUTS:-/home/user/lab/soak-inputs.txt}
# `|| true` IS THE POINT, here and on rss below: under set -euo pipefail a
# dead app makes pgrep exit 1 and KILLS THIS SCRIPT before the line is
# emitted - which is how the 2026-07-29 collector crash produced NO lines at
# all instead of GAP lines, and why the all-writers-dead scenario the writers
# column was designed for could never have produced its gap marks either
# (ps -C node fails the same way with no node processes at all). Every
# command in this script must survive the states the script exists to record.
main_pid=$(pgrep -f 'node src/main.ts' 2>/dev/null | head -1 || true)
# xargs -0 rather than tr, deliberately: writing a NUL into this script is
# what broke it the first time. The file itself went BINARY, charcheck's
# tracked-text count dropped by one, grep reported 'binary file matches'
# instead of a value, and env_of silently returned empty - so the pin read
# the CONFIG DEFAULTS and correctly reported drift on its first live run.
env_of() {
    [ -n "${main_pid:-}" ] || { echo ""; return; }
    xargs -0 -n1 < "/proc/$main_pid/environ" 2>/dev/null | sed -n "s/^$1=//p" | head -1
}
live_msg_days=$(env_of MESSAGE_RETENTION_DAYS)
live_raw_days=$(env_of RAW_RETENTION_DAYS)
live_entities=$(Q "SELECT count(*) FROM entities" 2>/dev/null || echo 0)
# THE FOURTH PINNED INPUT, added 2026-07-28: how many gin indexes sit on
# today's partition's msg column. The plateau's trigram term turned out to
# depend on INDEX COUNT - the parent's partitioned gin plus the sync's
# duplicate is ~8GB more steady state than the one-index derivation - and an
# input that is demonstrably in the arithmetic gets pinned like the others.
# The dedup dropping this from 2 to 1 SHOULD breach the pin: that is the
# mechanism asking for the deliberate re-derivation, in the same commit.
live_msg_gins=$(Q "SELECT count(*) FROM pg_index x
    JOIN pg_class ic ON ic.oid = x.indexrelid
    JOIN pg_am am ON am.oid = ic.relam AND am.amname = 'gin'
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
   WHERE x.indrelid = ('messages_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD'))::regclass
     AND x.indisvalid AND a.attname = 'msg'" 2>/dev/null || echo 0)
echo "${live_msg_days:-30} ${live_raw_days:-14} ${live_entities:-0} ${live_msg_gins:-0}" > "$INPUTS"

# RSS OF THE APPLICATION, IDENTIFIED BY ROLE - never "the largest node
# process", which is a RANK and not an identity.
#
# The first version took the largest, and the subject could change between
# readings with nothing in the series to show it. Two consequences, both real:
# the collector leak of 2026-07-29 was caught only because the app happened to
# outweigh the mock fleet at read time (425 MB vs 413 MB on the same box - an
# 11 MB margin, so either could lead), and the series contains DROPS WITHOUT
# RESTARTS (404 -> 377 at 20:00, 487 -> 462 at 08:00) that a single leaking
# process cannot produce. That is the subject switching mid-series - a spliced
# series, and a leak that hid behind a fat generator would have read flat and
# healthy through a live emitter and a correct threshold.
#
# The collector is a WORKER THREAD inside `node src/main.ts`, so this one
# process is the right subject for every thread the fork owns. The generators
# are lab apparatus; if they ever need watching they get their OWN named
# columns appended at the END of the line - never folded into a max, and never
# inserted mid-line where they would shift every column number the evaluator
# reads. Absent app = -1, the sentinel, not some generator's memory.
rss=$(ps -o rss=,args= -C node 2>/dev/null | awk '/node src\/main\.ts/ {print $1; exit}' || true)
rss_mb=$(( ${rss:-0} / 1024 ))
[ "${rss:-0}" -gt 0 ] || rss_mb=-1

# HOW MANY WRITERS ARE ACTUALLY RUNNING. Four are expected: the app, the mock
# fleet, the syslog generator, the query load.
#
# This column exists because of a specific way this log could lie. The cron
# survives a reboot; the four nohup'd processes do NOT. After a power cut
# Postgres comes back on its own and soak.sh keeps appending - against a
# database nothing is writing to. Every count column then goes FLAT, which is
# indistinguishable from the plateau this run is trying to observe, and the
# most persuasive possible reading of a run that stopped.
#
# So a line records how many writers produced it. writers<4 means the line is
# NOT COMPARABLE, and a stretch of them is a gap rather than a plateau.
writers=0
for p in 'node src/main.ts' 'lab/mock-fleet.js' 'tools/udp-load.ts' 'tools/soak-query.ts'; do
    pgrep -f "$p" >/dev/null 2>&1 && writers=$((writers + 1))
done

# THE THESIS COLUMNS come from /api/health, which needs a session - the
# detailed report is behind auth by design (ARCHITECTURE section 3), and a
# soak reading it is a legitimate user like any other.
curl -s -c "$CJ" -X POST "$BASE/api/login" -H 'content-type: application/json' \
     -d "{\"username\":\"${SOAK_USER:-admin}\",\"password\":\"${SOAK_PASS:-rscanvas-demo-2026}\"}" \
     -o /dev/null 2>/dev/null || true
health=$(curl -s -b "$CJ" "$BASE/api/health" 2>/dev/null || echo '{}')

# TWO HEARTBEAT COLUMNS, NOT ONE, and the split is the whole point.
#
# The first version logged worstGapMsAcrossThreads and breached on hour one:
# 105ms. The breakdown said main 9.7, ingest 22.5, collector 21.6, JOBS 105.
# The poller was fine; the jobs thread was blocking - which is exactly what it
# has its own thread FOR. Rolling up 10,000 entities in 24h chunks is heavy
# synchronous work, and isolating it is the design rather than a fault.
#
# So the thesis column is the worst across the LATENCY-SENSITIVE threads only
# (main, ingest, collector). A jobs-thread gap is logged separately and is
# informational: it tells you how hard the rollup is working, and it would
# only be a fault if it stopped the others - which is what hb_ms measures.
#
# Measuring the wrong thing here would have failed the run for a week on the
# design working correctly.
hb_ms=$(printf '%s' "$health" | python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
th = d.get('heartbeat',{}).get('threads',[])
w = [t.get('worstGapMs',0) for t in th if t.get('thread') in ('main','ingest','collector')]
print(round(max(w)) if w else -1)" 2>/dev/null || echo -1)

hb_jobs=$(printf '%s' "$health" | python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
th = d.get('heartbeat',{}).get('threads',[])
w = [t.get('worstGapMs',0) for t in th if t.get('thread') == 'jobs']
print(round(max(w)) if w else -1)" 2>/dev/null || echo -1)

# THE FREQUENCY COLUMNS, added 2026-08-14, because hb_ms ALONE CANNOT TELL TWO
# MACHINES APART THAT DIFFER BY 334x.
#
# Read on that day: the 12-vCPU lab box and the 4-core mini PC reported worst
# gaps of 68.8 and 77.6 - practically identical, and the column's whole job is
# to separate them. Their EXCURSION COUNTS were 11 and 3,680, and their p99s
# 2ms and 18ms. A maximum is one sample of the tail and says nothing about how
# often the tail is reached, which is the number that decides whether a mini PC
# can own a fleet.
#
# BOTH COUNTERS ARE CUMULATIVE FROM PROCESS START, exactly like worstGapMs -
# see the monotone-metric note in soak-check.sh, which already names
# overThresholdCount as having the same shape. That is why ticks is logged
# BESIDE over rather than a rate being computed here: a pair of counters can be
# DIFFERENCED against the previous line to get a true per-hour figure, and a
# rate computed at read time could not. A maximum cannot be differenced at all,
# which is the difference between this pair and hb_ms.
#
# Summed across the three latency-sensitive threads, not maxed: the question is
# how often ANY of them stalled, and each ticks on the same interval so the
# totals are comparable. hb_p99 is a MAX because a percentile does not add.
#
# hb_p99 is a since-start percentile and therefore lags - millions of healthy
# ticks dilute a new stall. It is logged as context for the counts, not as the
# detector.
hb_stats=$(printf '%s' "$health" | python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: print('-1 -1 -1'); raise SystemExit
th = [t for t in d.get('heartbeat',{}).get('threads',[])
      if t.get('thread') in ('main','ingest','collector')]
if not th: print('-1 -1 -1'); raise SystemExit
print('%d %d %d' % (
    sum(t.get('overThresholdCount',0) for t in th),
    sum(t.get('ticks',0) for t in th),
    round(max(t.get('p99GapMs',0) for t in th))))" 2>/dev/null || echo '-1 -1 -1')
read -r hb_over hb_ticks hb_p99 <<< "${hb_stats:--1 -1 -1}"

waitp=$(printf '%s' "$health" | python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
# allLaneStates() returns an ARRAY of per-lane objects, and the field is
# waitP99Ms - checked against src/store/pool.ts rather than guessed, since a
# wrong key here logs -1 for a week and the column silently means nothing.
lanes = d.get('lanes') or []
if not lanes: print(-1); raise SystemExit
w = 0
for s in lanes:
    if isinstance(s, dict) and s.get('lane') == 'interactive':
        w = max(w, s.get('waitP99Ms') or 0)
print(round(w))" 2>/dev/null || echo -1)

jobfail=$(printf '%s' "$health" | python3 -c "
import json,sys
try: d = json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
jobs = ((d.get('jobs') or {}).get('jobs')) or []
# Absent is UNMEASURED (-1), not zero: a dead app must not report zero
# failures, the same sentinel discipline as hb_ms.
print(max([j.get('consecutiveFailures', 0) for j in jobs]) if jobs else -1)" 2>/dev/null || echo -1)

# The last minute of query load, from soak-query.ts.
if [ -f "$QLOG" ]; then
    read -r _ q_ok q_ref _ _ _ reasons <<< "$(tail -1 "$QLOG")"
else
    q_ok=-1; q_ref=-1; reasons='no-query-load'
fi

# THE PRECONDITION COLUMN, added 2026-08-15, because a rule that cannot fire
# was being read as a rule that failed.
#
# soak-query's `free-text` case asks for a 240h free-text search and expects a
# refusal. Admission refuses it only when some partition INSIDE that window
# lacks coverage, where covered means a gin on BOTH msg and host. On a box
# young enough that every partition it owns is still inside the trigram
# window, no such partition exists, the search is genuinely index-served, and
# admitting it is CORRECT - measured on minipc, which reported the phantom for
# all 49 hours of its run while lab-stresstest, holding ten days, refused
# correctly every hour. Same code, same schema, different amount of history.
#
# So the precondition becomes a FACT IN THE LINE rather than an assumption in
# the criteria, for the same reason hb_over is logged beside hb_ticks: a
# reader cannot recover at evaluation time what was not measured at write
# time. 0 means the case has no refusal available and must be UNMEASURED, not
# a breach. -1 is the usual sentinel for could-not-measure.
#
# The coverage test is a copy of TRGM_COVERAGE_SQL in src/store/ops.ts, which
# is what admission actually reads. If that changes, this must change with it,
# or the soak will excuse a real regression.
trgm_uncov=$(Q "
    SELECT count(*) FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'messages'::regclass
       AND c.relname ~ '^messages_[0-9]{8}\$'
       -- inside the probe's 240h window, and never a future partition: those
       -- cannot hold a row a backward-looking search would read.
       AND to_date(right(c.relname, 8), 'YYYYMMDD') >  current_date - 10
       AND to_date(right(c.relname, 8), 'YYYYMMDD') <= current_date
       AND (SELECT count(DISTINCT a.attname)
              FROM pg_index x
              JOIN pg_class ic ON ic.oid = x.indexrelid
              JOIN pg_am am ON am.oid = ic.relam AND am.amname = 'gin'
              JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
             WHERE x.indrelid = c.oid AND x.indisvalid AND x.indisready
               AND a.attname IN ('msg', 'host')) < 2" 2>/dev/null || echo -1)

line="$counts $rss_mb $hb_ms $hb_jobs $waitp $jobfail $writers ${q_ok:--1} ${q_ref:--1} ${reasons:--} ${hb_over:--1} ${hb_ticks:--1} ${hb_p99:--1} ${trgm_uncov:--1}"
echo "$line"

# EVALUATE IT. The criteria were inert while applying them meant a human
# opening nine columns and remembering what each should show - a run failing
# on day 2 would be noticed on day 5. Breaches go to their own file, which
# stays EMPTY while the run is healthy, so checking the soak is "is that file
# empty" rather than an analysis session.
printf '%s
' "$line" | bash "$(dirname "$0")/soak-check.sh"     >> "${SOAK_BREACH_LOG:-/home/user/lab/soak-breaches.log}" 2>&1 || true
