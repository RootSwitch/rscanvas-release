#!/usr/bin/env bash
# Read the lab boxes' health samples side by side (tools/lab-box.sh sampler).
#
#   bash tools/lab-ab.sh user@boxA user@boxB [N]      # last N samples each (default 12)
#   bash tools/lab-ab.sh --summary user@boxA user@boxB [SINCE]
#
# Written 2026-09-23 for the lab-1/lab-3 comparison. READ-ONLY: it tails
# ~/lab/health.jsonl on each box over ssh and prints the collector fields
# both builds share - the same names since 2026-07-26, so one filter reads
# the old tree and HEAD alike. The per-sample figures are windowed by the
# collector itself (its last 10,000 polls); --summary gives the median of
# those window readings since SINCE (an ISO time, default: everything), so
# one noisy sample cannot carry a verdict.
set -uo pipefail

SUMMARY=0
[ "${1:-}" = "--summary" ] && { SUMMARY=1; shift; }
A="${1:?user@boxA}"; B="${2:?user@boxB}"; ARG="${3:-}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8"
# From Git Bash on Windows the keys live in WSL, not in Git Bash's own ssh.
case "$(uname -s)" in MINGW*|MSYS*) SSH="wsl -e ssh -o BatchMode=yes -o ConnectTimeout=8" ;; esac

ROW='[.ts[5:16], (.load|split(" ")[0]),
      (.health.collector.pollP50Ms // "-"), (.health.collector.pollP95Ms // "-"),
      (.health.collector.pollLagP95Ms // "-"), (.health.collector.inFlight // "-"),
      (.health.collector.inFlightDown // "-"), (.health.collector.pendingSamples // "-"),
      (.health.collector.polls // "-"), (.health.collector.failures // "-"),
      (.health.collector.heartbeat.worstGapMs // "-"),
      ((.health.collector.heartbeat.overThresholdCount // 0) as $o | (.health.collector.heartbeat.ticks // 0) as $t
        | if $t > 0 then (($o * 10000 / $t | floor) / 100 | tostring) + "%" else "-" end),
      ((.health.memory.rssBytes // 0) / 1048576 | floor)] | @tsv'

SUM='[.[] | select(.health.collector.pollP50Ms != null)] as $s
     | def med(f): ([$s[] | f] | sort) as $v | if ($v|length) == 0 then "-" else $v[(($v|length)/2|floor)] end;
     {samples: ($s|length), first: ($s[0].ts // "-"), last: ($s[-1].ts // "-"),
      pollP50Ms: med(.health.collector.pollP50Ms), pollP95Ms: med(.health.collector.pollP95Ms),
      lagP95Ms: med(.health.collector.pollLagP95Ms), inFlight: med(.health.collector.inFlight),
      pendingSamples: med(.health.collector.pendingSamples),
      load1: med(.load|split(" ")[0]|tonumber),
      failRate: (($s[-1].health.collector.failures // 0) / (($s[-1].health.collector.polls // 1) | if . == 0 then 1 else . end) * 10000 | floor / 100)}'

for box in "$A" "$B"; do
    echo "== $box  $($SSH "$box" 'cat ~/rscanvas/DEPLOYED_COMMIT 2>/dev/null' | head -1)"
    if [ "$SUMMARY" = 1 ]; then
        $SSH "$box" "jq -c --arg since '${ARG:-0}' 'select(.ts >= \$since)' ~/lab/health.jsonl | jq -s -c '$SUM'"
    else
        echo -e "time\tload\tp50ms\tp95ms\tlagp95\tinfl\tinDown\tpending\tpolls\tfails\thbWorst\thb>50\trssMB"
        $SSH "$box" "tail -n ${ARG:-12} ~/lab/health.jsonl | jq -r '$ROW'"
    fi
done
