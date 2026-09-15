#!/usr/bin/env bash
# (Re)start the demo instance on the lab: mock fleet + full app, detached.
#
#   ssh user@192.0.2.50 'bash -s' < tools/demo-lab.sh
#
# THE DEMO HAS ITS OWN DATABASE, and that is the point of this file, not a
# detail. It ran in rscanvas_test first, and rscanvas_test exists precisely to
# PERMIT broadly destructive tests - so a test doing DELETE FROM users to
# guarantee an empty table killed the demo's login, twice, while passing 14/14
# both times. Narrowing that test fixed that test; the next broadly
# destructive test would have killed the demo again, and it would have been a
# DIFFERENT test, so no per-test fix covers it.
#
# rscanvas_demo is NOT in DISPOSABLE_DATABASES, so assertDestructiveTarget
# refuses every destructive tool aimed at it - the same interlock that
# protects the corpus now protects the demo, and the disposable database goes
# back to meaning what it says. A test must own its blast radius; a demo must
# live where no test's blast radius reaches. (SESSION-NOTES, the third form.)
#
# Login: admin / rscanvas-demo-2026 (bootstrap runs only when no users exist).
set -euo pipefail
cd /home/user/rscanvas
DB=postgres://rscanvas:rscanvas@localhost:5432/rscanvas_demo

pkill -f 'node src/main.ts' 2>/dev/null || true
pkill -f 'lab/mock-fleet.js' 2>/dev/null || true
pkill -f 'tools/udp-load.ts' 2>/dev/null || true
pkill -f 'tools/soak-query.ts' 2>/dev/null || true
sleep 1

# FLEET AND LOAD ARE SIZED FOR THE SOAK, not for a burst measurement.
#
# The demo ran for a day holding only what the alert channel wrote into it -
# five messages - so the soak was watching an empty database, which mostly
# proves the process does not crash. No partition is created, the rollup has
# nothing to chunk, retention has nothing to decide about and the trigram sync
# has no populated partition to build on. Those are exactly the slow movers
# soak.log exists to watch.
#
# 400 devices x 25 interfaces = ~10,000 entities, about a THIRD OF THE 30,000
# CEILING. Enough that rollup chunks are real work, ROLLUP_CHUNKS_PER_RUN and
# single-flight get stressed, and retention weighs partitions that matter -
# with headroom so a problem appears before the wall does.
#
# 400 rather than 500 devices keeps the fleet's UDP socket count clear of the
# default 1024 fd limit, with the interface count carrying the entity total
# instead.
FLEET_SIZE=400 IFACES_PER=25 BASE_PORT=16100 \
    nohup node /home/user/lab/mock-fleet.js > /tmp/fleet-demo.log 2>&1 &
sleep 2

# Idempotent: the seed skips devices that already exist, and the app's
# bootstrap creates the admin only on first run. Nothing here deletes
# anything - this database accumulates real history, which is what makes the
# demo worth looking at.
FLEET_SIZE=400 BASE_PORT=16100 DATABASE_URL="$DB" node tools/seed-fleet.ts >/dev/null

# THE VOLATILE SLICE: a second fleet, on its own ports, under its own device
# names, that the daily fault window takes away and gives back.
#
# A soak with 400 agents up for a week never sees a device go unreachable, so
# stepMissing never runs outside a test and the device-down freeze - an
# interface alert must NOT clear while its device is unreachable - is never
# exercised for real. And what only a long run can show is not one recovery
# but a HUNDRED, with nothing accumulating across them.
bash tools/soak-fault.sh start
sleep 2
FLEET_SIZE=50 BASE_PORT=16600 FLEET_PREFIX=volatile     DATABASE_URL="$DB" node tools/seed-fleet.ts >/dev/null

# RETENTION IS ARMED HERE, DELIBERATELY, and the flag is DECLARED rather than
# inherited - see RETENTION_DRY_RUN=0 below.
#
# A previous commit claimed this file already pinned it to 1. It did not: the
# edit never landed, the claim was not checked, and the demo ran on the config
# default the whole time. Recorded because the lesson is not about retention -
# it is that "the script ran" is not evidence that "the edit applied", and this
# is the second instance in one session (the fleet came up with 5 devices under
# a paragraph explaining why it had 50).
#
# It is now 0 because tools/watched-retention.sh did the run BUILD-PLAN
# required before this could change, against a PLANTED POSITIVE - the demo's
# own partitions were all one day old, so a flip would have passed vacuously.
# All five checks held: the live run did exactly what dry-run predicted
# partition for partition, guard 5 deferred the six samples partitions the
# rollup had not consumed while dropping the five it had, the deferral proved
# to be a DELAY rather than a wedge, and the database went 51MB -> 44MB, which
# is the one thing dry-run can never show.
#
# Armed on the instance where arming it is safe and where NOT arming it is the
# actual risk: several GB a day with nothing reclaiming, on a volume shared
# with the 105GB measurement corpus.
#
# RETENTION DAYS SIT ABOVE THE FLOOR, and the first attempt did not.
#
# I set MESSAGE_RETENTION_DAYS=5 and RAW_RETENTION_DAYS=3 to give retention
# something to decide about within a soak's timescale. RETENTION_MIN_KEEP_DAYS
# is 7, so drop_partitions_guarded REFUSED every run: "keep_days 3 is below
# the floor of 7 for samples", eight consecutive failures per job, and
# RETENTION NEVER RAN ON THE DEMO AT ALL. The database climbed linearly while
# the plateau criterion sat there waiting for a curve that could not happen.
#
# The floor is the guard working - it is layer 1, and lowering it to suit a
# demo would be exactly the move this project keeps refusing. So the retention
# DAYS move above it instead: 9 and 8, which still expire inside a seven-day
# run because the watched-retention fixture planted fourteen backdated days.
#
# Found by the soak evaluator, not by reading: jobfail climbed 1..8 in the
# hourly log and the breach named it.
#
# THE CORPUS'S OWN RETENTION IS UNTOUCHED. This is the demo only.
# THE MAINTENANCE CREDENTIAL (slice 19). Index DDL runs on its own lane as
# rscanvas_admin, because CREATE/DROP INDEX CONCURRENTLY cannot run inside a
# function and a hardened app role owns no index at all. rscanvas_admin is
# harden-roles.sh's own default and is right for the lab; a real install takes
# the value from the installer env file. Without it every trgm drop on a
# HARDENED database fails with "must be owner of index", which is how the lab
# found the bug (slice 19) in the first place.
#
# AND THE UNIT FILE MUST MATCH. rscanvas-app.service duplicates these because
# a unit cannot source a script, and its own comment says this script wins.
# On 2026-08-25 they had drifted: the unit was missing ADMIN_USERNAME,
# ADMIN_PASSWORD and this line.
DATABASE_URL="$DB" COLLECTOR_ENABLED=1 JOBS_ENABLED=1 SNMP_COMMUNITY=public \
    HTTP_PORT=18080 SYSLOG_PORT=5514 TRAP_PORT=15162 \
    ALERT_SCAN_INTERVAL_MS=5000     MESSAGE_RETENTION_DAYS=9 RAW_RETENTION_DAYS=8 \
    ALERT_SYSLOG_HOST=127.0.0.1 ALERT_SYSLOG_PORT=5514 \
    ADMIN_USERNAME=admin ADMIN_PASSWORD=rscanvas-demo-2026 \
    RETENTION_DRY_RUN=0 \
    RSCANVAS_ADMIN_DB_PASSWORD=rscanvas_admin \
    nohup node src/main.ts > /tmp/rsc-demo.log 2>&1 &

sleep 5

# Syslog volume. THE OFF-BOX RULE IN udp-load.ts DOES NOT BIND HERE, and it is
# worth saying why rather than looking like it was ignored: that rule protects
# a MEASUREMENT - the 10ms heartbeat's worst gap, which a generator sharing the
# 12 vCPU would corrupt, and the loopback path which does not exercise a real
# NIC. This is not a measurement run. It is a volume feeder whose job is to
# give the daily partition, the trigram sync and retention something real to
# act on, and 100 datagrams a second is about 2% of the rate that argument was
# written about.
#
# The consequence is stated rather than hidden: soak.log's node_rss column now
# includes this process, and its heartbeat figures are NOT slice-1 numbers. A
# real heartbeat measurement still runs off-box, from a second host, exactly as
# before.
RATE=100 BURST_RATE=100 DURATION_S=2592000     TARGET=127.0.0.1 TARGET_PORT=5514 RUN_TAG=soak     nohup node tools/udp-load.ts > /tmp/loadgen-demo.log 2>&1 &

# THE MISSING DIMENSION: USERS.
#
# Without this the soak measures a system nothing queries, which leaves the
# fork's whole thesis untested - one person's heavy query cannot freeze the
# poller is not a claim you can check with nothing competing. The lanes carry
# no load, admission never fires, and rule 7's lock_timeout never has a
# collision to lose.
#
# Includes queries that MUST BE REFUSED, and the run counts them: an admission
# rule that never triggers passes for the same reason a scanner with nothing
# to find passes. Zero refusals in an hour is a FAILING soak.
sleep 5
SOAK_BASE=http://127.0.0.1:18080 SOAK_USER=admin SOAK_PASS=rscanvas-demo-2026     SOAK_QPS=2 SOAK_HEAVY_PER_HOUR=3     nohup node tools/soak-query.ts > /tmp/soak-query-run.log 2>&1 &

sleep 3
curl -s http://127.0.0.1:18080/api/health/live >/dev/null && echo "live on :18080"
grep -c 'http listening' /tmp/rsc-demo.log >/dev/null && echo "workers up"
echo "fleet: 400 devices x 25 interfaces (~10,000 entities); syslog 100/s; queries 2/s + 3 heavy/hour"
echo "volatile slice: 50 devices, taken away daily at 02:00 for 10 minutes"
# The judgement date is DERIVED in SOAK-CRITERIA.md; restating it here is how
# it went stale the first time (this line said day 7 after the criteria moved
# to day 11). Point at the owner, do not copy the value.
echo "criteria: SOAK-CRITERIA.md - judged on the date derived there, not by how the graph looks"
