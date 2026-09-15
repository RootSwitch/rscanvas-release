#!/usr/bin/env bash
# The three-class reachability drill: live down-detection in BOTH flavours,
# on a disposable box, cleaned up after itself.
#
#   bash tools/reach-drill.sh     (run ON the box that runs the app)
#
# Ported in SHAPE from the suite's TCP scale-test kit (accept / refuse /
# drop), at the operator's suggestion, translated to ICMP:
#
#   accept  127.0.3.10   loopback answers all of 127/8 by default
#   drop    127.0.4.10   iptables OUTPUT DROP: the probe never leaves, fping
#                        waits out the full timeout - the silent flavour
#   nack    127.0.5.10   iptables REJECT icmp-host-unreachable: the network
#                        answers ON BEHALF of the target, fast - the flavour
#                        a dead LAN host produces via its router
#
# WHY A DRILL AND NOT A STANDING FIXTURE. iptables rules do not survive a
# reboot, and a "down" fixture that silently starts answering after a power
# cycle is a lying canary - worse than none. testnet-dead-1 stays as the one
# standing born-dead device precisely because TEST-NET needs no rules. This
# script sets up, verifies, and REMOVES everything it made.
#
# NAMED, NOT DISCOVERED, as every destructive path here: the iptables rules
# are exact-match deletes of the exact rules added, and the fixture devices
# are deleted by their literal names.
set -uo pipefail
DB="${DB:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_demo}"
INTERVAL="${PING_INTERVAL_S:-10}"
P() { psql "$DB" -v ON_ERROR_STOP=1 -tAc "$1"; }

ACCEPT=127.0.3.10
DROP=127.0.4.10
NACK=127.0.5.10

cleanup() {
    sudo -n iptables -D OUTPUT -d 127.0.4.0/24 -p icmp -j DROP 2>/dev/null || true
    sudo -n iptables -D OUTPUT -d 127.0.5.0/24 -p icmp -j REJECT --reject-with icmp-host-unreachable 2>/dev/null || true
    P "DELETE FROM devices WHERE name IN ('fixture-accept-1','fixture-drop-1','fixture-nack-1')" >/dev/null 2>&1 || true
    echo "  (fixture rules and devices removed)"
}
trap cleanup EXIT

echo "### 1. the classes"
sudo -n iptables -A OUTPUT -d 127.0.4.0/24 -p icmp -j DROP
sudo -n iptables -A OUTPUT -d 127.0.5.0/24 -p icmp -j REJECT --reject-with icmp-host-unreachable
echo "  rules in place"

echo
echo "### 2. RAW fping against the classes - the parser's format assumptions on trial"
echo "--- stderr, verbatim:"
fping -C 1 -q -r 0 -t 800 $ACCEPT $DROP $NACK 2>&1 | sed 's/^/  |/'
echo "--- the parser's reading of each line is asserted offline (test-reach);"
echo "--- what matters HERE is that the summary lines carry the truth: accept"
echo "--- with an rtt, drop and nack both with a dash."

echo
echo "### 3. fixture devices, the lab way (the U6 probe gate would rightly refuse them)"
P "INSERT INTO devices (name, host, status, snmp_port, snmp_version, credential_ref, poll_interval_s)
   VALUES ('fixture-accept-1', '$ACCEPT', 'up', 161, '2c', 'SNMP_COMMUNITY', 30),
          ('fixture-drop-1',   '$DROP',   'up', 161, '2c', 'SNMP_COMMUNITY', 30),
          ('fixture-nack-1',   '$NACK',   'up', 161, '2c', 'SNMP_COMMUNITY', 30)
   ON CONFLICT (name) DO NOTHING" >/dev/null
echo "  inserted; waiting 3 sweep intervals ($((INTERVAL * 3 + 5))s)..."
sleep $((INTERVAL * 3 + 5))

echo
echo "### 4. what the state machine decided"
P "SELECT '  ' || name || ': ' || reach_state
     || coalesce(' (rtt ' || reach_rtt_ms || 'ms)', '')
   FROM devices WHERE name LIKE 'fixture-%' ORDER BY name"

echo
echo "### 5. the transitions written (want exactly one per fixture device)"
P "SELECT '  ' || d.name || ': ' || e.from_state || ' -> ' || e.to_state
   FROM reachability_events e JOIN devices d ON d.id = e.device_id
   WHERE d.name LIKE 'fixture-%' ORDER BY d.name, e.ts"

echo
echo "### 6. the verdicts"
ok=0; bad=0
check() {
    local name=$1 want=$2
    local got
    got=$(P "SELECT reach_state FROM devices WHERE name = '$name'")
    if [ "$got" = "$want" ]; then ok=$((ok+1)); echo "  ok   $name is $want"
    else bad=$((bad+1)); echo "  FAIL $name is '$got', wanted '$want'"; fi
}
check fixture-accept-1 up
check fixture-drop-1 down
check fixture-nack-1 down
n=$(P "SELECT count(*) FROM reachability_events e JOIN devices d ON d.id=e.device_id WHERE d.name LIKE 'fixture-%'")
if [ "$n" = "3" ]; then ok=$((ok+1)); echo "  ok   exactly 3 transitions for 3 devices - no flapping, no per-probe writes"
else bad=$((bad+1)); echo "  FAIL $n transition(s) for 3 devices"; fi

echo
echo "### 7. teardown (the trap owns it)"
echo "$([ "$bad" = "0" ] && echo PASS || echo FAIL) - $ok passed, $bad failed"
[ "$bad" = "0" ]
