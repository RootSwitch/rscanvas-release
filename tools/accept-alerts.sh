#!/usr/bin/env bash
# The alert vertical slice, end to end, on live processes.
#
# What runs: the real app (ingest + collector + jobs workers) against the real
# mock fleet, with the syslog notification channel pointed at THE APP'S OWN
# INGEST PORT. A raised alert therefore becomes a searchable message row in
# the same database that raised it - the observable end of the slice, with no
# UI and no external infrastructure.
#
# Three phases, each asserted with a bounded wait rather than a sleep-and-hope:
#
#   1. RAISE.  The fleet serves every 10th interface admin-up/oper-down, so
#              polling it crosses the if-down threshold naturally. Expect one
#              active if:*:down alert per device, notified, ingested.
#   2. BREAK.  Stop the fleet. Devices go down -> device:* raises; the if-down
#              alerts FREEZE (down-device suppression) rather than clearing.
#   3. HEAL.   Start the fleet again. device:* alerts CLEAR through the normal
#              machinery, the clears are notified and ingested.
#
# Runs ON the lab (localhost postgres), against the disposable database only.
set -euo pipefail

DB="${DB:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_test}"
case "$DB" in
    *rscanvas_test*) ;;
    *) echo "refusing: DB=$DB is not the disposable database"; exit 2 ;;
esac

FLEET_SIZE=5
IFACES_PER=10
BASE_PORT=16100
SCAN_MS=5000
SYSLOG_PORT=5514

Q() { psql "$DB" -tAq -c "$1"; }
say() { echo "== $*"; }
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }

# Bounded wait: until_q "<sql>" <expected> <seconds> <label>
until_q() {
    local sql="$1" want="$2" secs="$3" label="$4" got=""
    for _ in $(seq 1 "$secs"); do
        got=$(Q "$sql")
        [ "$got" = "$want" ] && { ok "$label (${got})"; return 0; }
        sleep 1
    done
    bad "$label - wanted ${want}, still ${got} after ${secs}s"
    return 1
}

cleanup() {
    [ -f /tmp/rsc-accept.pid ] && kill "$(cat /tmp/rsc-accept.pid)" 2>/dev/null || true
    [ -f /tmp/fleet-accept.pid ] && kill "$(cat /tmp/fleet-accept.pid)" 2>/dev/null || true
    rm -f /tmp/rsc-accept.pid /tmp/fleet-accept.pid
}
trap cleanup EXIT

cd "$(dirname "$0")/.."

say "clean slate: mock devices, alerts, and this app's own notification messages"
pkill -f 'node src/main.ts' 2>/dev/null || true
pkill -f 'lab/mock-fleet.js' 2>/dev/null || true
sleep 1
Q "DELETE FROM alerts" >/dev/null
Q "DELETE FROM messages WHERE app LIKE 'rscanvas%'" >/dev/null
Q "DELETE FROM entities WHERE device_id IN (SELECT id FROM devices WHERE name LIKE 'mock-%')" >/dev/null
Q "DELETE FROM devices WHERE name LIKE 'mock-%'" >/dev/null

say "start the fleet: ${FLEET_SIZE} agents x ${IFACES_PER} interfaces, every 10th oper-down"
FLEET_SIZE=$FLEET_SIZE IFACES_PER=$IFACES_PER BASE_PORT=$BASE_PORT \
    nohup node /home/user/lab/mock-fleet.js > /tmp/fleet-accept.log 2>&1 &
echo $! > /tmp/fleet-accept.pid
sleep 1

say "seed the fleet as devices"
FLEET_SIZE=$FLEET_SIZE BASE_PORT=$BASE_PORT DATABASE_URL="$DB" node tools/seed-fleet.ts

say "start the app: collector + jobs on, syslog notifications aimed at its own ingest"
DATABASE_URL="$DB" COLLECTOR_ENABLED=1 JOBS_ENABLED=1 SNMP_COMMUNITY=public \
    HTTP_PORT=18080 SYSLOG_PORT=$SYSLOG_PORT TRAP_PORT=15162 \
    ALERT_SCAN_INTERVAL_MS=$SCAN_MS \
    ALERT_SYSLOG_HOST=127.0.0.1 ALERT_SYSLOG_PORT=$SYSLOG_PORT \
    nohup node src/main.ts > /tmp/rsc-accept.log 2>&1 &
echo $! > /tmp/rsc-accept.pid

echo
say "PHASE 1 - RAISE: the collector's own polls cross the if-down threshold"
until_q "SELECT count(*) FROM alerts WHERE alert_key LIKE 'if:%:down' AND state='active'" \
    "$FLEET_SIZE" 90 "one active if-down alert per device"
until_q "SELECT count(*) FROM alerts WHERE alert_key LIKE 'if:%:down' AND state='active' AND notified_raise" \
    "$FLEET_SIZE" 30 "every raise delivered (notified_raise=true)"
until_q "SELECT count(DISTINCT alert_id) FROM notifications n JOIN alerts a ON a.id=n.alert_id
          WHERE n.channel='syslog' AND n.ok AND a.alert_key LIKE 'if:%:down'" \
    "$FLEET_SIZE" 15 "every attempt in the notifications log"
until_q "SELECT CASE WHEN count(*) >= $FLEET_SIZE THEN 'yes' ELSE 'no' END
           FROM messages WHERE app LIKE 'rscanvas%' AND severity=2 AND msg LIKE '%link%'" \
    "yes" 30 "the raises came BACK IN through ingest as searchable crit messages"
echo "  sample: $(Q "SELECT msg FROM messages WHERE app LIKE 'rscanvas%' AND severity=2 LIMIT 1")"

echo
say "PHASE 2 - BREAK: stop the fleet; devices must raise, if-downs must freeze"
kill "$(cat /tmp/fleet-accept.pid)" 2>/dev/null || true
rm -f /tmp/fleet-accept.pid
until_q "SELECT count(*) FROM alerts WHERE alert_key LIKE 'device:mock-%' AND state='active'" \
    "$FLEET_SIZE" 150 "every device raised device-down"
until_q "SELECT count(*) FROM alerts WHERE alert_key LIKE 'if:%:down' AND state='active'" \
    "$FLEET_SIZE" 5 "and the if-down alerts are STILL active - frozen, not cleared, while the cause is the device"

echo
say "PHASE 3 - HEAL: start the fleet; device alerts must clear through the machinery"
FLEET_SIZE=$FLEET_SIZE IFACES_PER=$IFACES_PER BASE_PORT=$BASE_PORT \
    nohup node /home/user/lab/mock-fleet.js > /tmp/fleet-accept2.log 2>&1 &
echo $! > /tmp/fleet-accept.pid
until_q "SELECT count(*) FROM alerts WHERE alert_key LIKE 'device:mock-%' AND state != 'cleared'" \
    "0" 150 "every device-down alert cleared"
until_q "SELECT count(*) FROM alerts WHERE alert_key LIKE 'device:mock-%' AND state='cleared' AND notified_clear" \
    "$FLEET_SIZE" 30 "every clear delivered"
until_q "SELECT CASE WHEN count(*) >= $FLEET_SIZE THEN 'yes' ELSE 'no' END
           FROM messages WHERE app LIKE 'rscanvas%' AND severity=5 AND msg LIKE '%clear%'" \
    "yes" 30 "the clears ingested as notice messages"

echo
echo "app log tail:"
tail -3 /tmp/rsc-accept.log | sed 's/^/  /'
echo
if [ "$FAIL" -eq 0 ]; then
    echo "PASS - $PASS passed, $FAIL failed: a threshold was crossed, a notification went out,"
    echo "and the notification is a searchable row in the store that raised it."
    exit 0
else
    echo "FAIL - $PASS passed, $FAIL failed"
    exit 1
fi
