#!/usr/bin/env bash
# One measured ingest step: snapshot the measured box, drive a generator on a
# second box for DURATION_S, let the queue flush, snapshot again, and count
# what actually landed by run tag. Prints a summary and appends one JSON line
# to RESULTS. Runs on the CONTROLLER (a machine that can ssh to both boxes).
#
#   DB=rscanvas_ing MEASURED=user@198.18.50.3 GEN=user@198.18.50.2 KIND=syslog RATE=2000 DURATION_S=1800 \
#     LABEL=syslog-2k RESULTS=ingest-steps.jsonl bash tools/ingest-step.sh
#
# KIND=syslog runs tools/udp-load.ts to SYSLOG_PORT, KIND=trap runs
# tools/trap-load.ts to TRAP_PORT. BURST_RATE / BURST_EVERY_S / BURST_S pass
# through. Both generators need GEN_DIR to be a checkout with node_modules.
#
# THE VERDICT IS ARITHMETIC (tools/verify-run.ts's rule): landed rows carrying
# this step's tag, against what the SENDER says it sent. The counters in the
# snapshots say WHERE a loss happened - the kernel's socket drops, the
# softnet backlog, our own shedding - but only the row count says WHETHER.
# The count reads the measured database through local peer auth as the
# postgres user, so no credential travels.
#
# Written 2026-09-24 for the lab-5 ingest test (RESULTS-INGEST-2026-09-24.md).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEASURED="${MEASURED:?user@measured-box}"; GEN="${GEN:?user@generator-box}"
KIND="${KIND:-syslog}"; RATE="${RATE:?messages per second}"; DURATION_S="${DURATION_S:-600}"
LABEL="${LABEL:-$KIND-$RATE}"; RESULTS="${RESULTS:-ingest-steps.jsonl}"
# REQUIRED, no default: a default name once pointed the count at a stale database
# while the instance wrote to a fresh one, which reads as 100% loss.
DB="${DB:?database the measured instance writes to}"; GEN_DIR="${GEN_DIR:-/home/user/gen}"
TARGET="${TARGET:-${MEASURED#*@}}"; SETTLE_S="${SETTLE_S:-45}"
SYSLOG_PORT="${SYSLOG_PORT:-5514}"; TRAP_PORT="${TRAP_PORT:-15162}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"
case "$(uname -s)" in MINGW*|MSYS*) SSH="wsl -e ssh -o BatchMode=yes -o ConnectTimeout=10" ;; esac
TAG="st-${LABEL}-$(date +%s)"

case "$KIND" in
    syslog) TOOL=tools/udp-load.ts; PORT=$SYSLOG_PORT ;;
    trap)   TOOL=tools/trap-load.ts; PORT=$TRAP_PORT ;;
    *) echo "KIND must be syslog or trap" >&2; exit 2 ;;
esac

BEFORE=$($SSH "$MEASURED" 'bash -s' < "$HERE/tools/ingest-snap.sh")
T0=$(node -e 'console.log(JSON.parse(process.argv[1]).ts)' "$BEFORE")
echo "== $LABEL: $KIND at ${RATE}/s for ${DURATION_S}s -> $TARGET:$PORT, tag $TAG, start $T0"

GENOUT=$($SSH "$GEN" "cd '$GEN_DIR' && TARGET=$TARGET TARGET_PORT=$PORT RATE=$RATE DURATION_S=$DURATION_S \
    BURST_RATE=${BURST_RATE:-$RATE} BURST_EVERY_S=${BURST_EVERY_S:-0} BURST_S=${BURST_S:-0} \
    RUN_TAG=$TAG node $TOOL 2>&1")
echo "$GENOUT" | grep -E "sent ok|send errors|average rate|fidelity|WARNING" | sed 's/^/   gen: /'

sleep "$SETTLE_S"
AFTER=$($SSH "$MEASURED" 'bash -s' < "$HERE/tools/ingest-snap.sh")

COUNT=$($SSH "$MEASURED" 'bash -s' <<EOF
sudo -u postgres psql -d $DB -qAtc "SELECT count(*) || ' ' || count(DISTINCT substring(msg from 'seq=([0-9]+)')) FROM messages WHERE ts >= '$T0'::timestamptz - interval '5 seconds' AND msg LIKE '%$TAG seq=%'"
EOF
)

node - "$BEFORE" "$AFTER" "$GENOUT" "$COUNT" "$LABEL" "$KIND" "$RATE" "$DURATION_S" "$TAG" "${BURST_RATE:-}" "${BURST_EVERY_S:-0}" "${BURST_S:-0}" "$HERE/$RESULTS" <<'NODE'
const [b, a, gen, count, label, kind, rate, dur, tag, burstRate, burstEvery, burstS, out] = process.argv.slice(2);
const B = JSON.parse(b), A = JSON.parse(a);
const g = (re) => { const m = gen.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
const sent = g(/^SENT=(\d+)/m), maxSeq = g(/^MAX_SEQ=(\d+)/m);
const [landed, distinct] = (count.trim() || '0 0').split(/\s+/).map(Number);
const d = (f) => { try { const x = f(A), y = f(B); return x === null || y === null || x === undefined || y === undefined ? null : x - y; } catch { return null; } };
const hb = (sel) => {
    const ticks = d((s) => sel(s)?.ticks), over = d((s) => sel(s)?.overThresholdCount);
    return { ticks, over, pct: ticks ? +(100 * over / ticks).toFixed(4) : null, worstMs: sel(A)?.worstGapMs ?? null };
};
const wallS = (Date.parse(A.ts) - Date.parse(B.ts)) / 1000;
const r = {
    label, kind, rate: +rate, durationS: +dur, tag, start: B.ts, end: A.ts,
    burst: burstEvery !== '0' ? { rate: +burstRate, everyS: +burstEvery, s: +burstS } : null,
    sent, landed, distinct, lost: sent === null ? null : sent - distinct,
    lossPct: sent ? +(100 * (sent - distinct) / sent).toFixed(4) : null,
    genWarnings: (gen.match(/WARNING[^\n]*/g) || []),
    ingest: {
        received: d((s) => s.ingest.received), written: d((s) => s.ingest.written),
        shedByUs: d((s) => s.ingest.shedByUs), queuedAtEnd: A.ingest?.queued ?? null,
        flushP99Ms: A.ingest?.flushP99Ms ?? null, flushMaxMs: A.ingest?.flushMaxMs ?? null,
        syslogSocketDrops: d((s) => s.ingest.kernel.syslogDrops), trapSocketDrops: d((s) => s.ingest.kernel.trapDrops),
        peakRxQueueBytes: A.ingest?.kernel?.peakRxQueueBytes ?? null,
    },
    kernel: {
        udpRcvbufErrors: d((s) => s.udp.RcvbufErrors), udpInErrors: d((s) => s.udp.InErrors),
        udpInDatagrams: d((s) => s.udp.InDatagrams), softnetDrops: d((s) => s.softnetDrops), rmemMax: A.rmemMax,
    },
    // cgroup accounting when both snapshots carry it (it counts exited
    // postgres backends); the per-PID sum otherwise, which undercounts.
    cpu: (() => {
        const cg = d((s) => s.pgCgNs) !== null && d((s) => s.appCgNs) !== null;
        const app = cg ? d((s) => s.appCgNs) : d((s) => s.appCpuNs);
        const pg = cg ? d((s) => s.pgCgNs) : d((s) => s.pgCpuNs);
        return { source: cg ? 'cgroup' : 'per-pid', appCores: +((app / 1e9) / wallS).toFixed(3), pgCores: +((pg / 1e9) / wallS).toFixed(3) };
    })(),
    heartbeat: { ingest: hb((s) => s.ingest?.hb), collector: hb((s) => s.collector?.hb),
        main: hb((s) => s.main?.threads?.find((t) => t.thread === 'main')), jobs: hb((s) => s.main?.threads?.find((t) => t.thread === 'jobs')) },
    collector: { polls: d((s) => s.collector.polls), failures: d((s) => s.collector.failures), pollP50Ms: A.collector?.pollP50Ms ?? null, lagP95Ms: A.collector?.pollLagP95Ms ?? null },
    dbMbGrowth: d((s) => s.dbMb), load: A.load,
};
require('node:fs').appendFileSync(out, JSON.stringify(r) + '\n');
const f = (n) => (n === null || n === undefined ? '-' : n.toLocaleString());
if (sent > 0 && landed === 0) console.log('   WARNING no rows at all carry this tag - check DB is the database the instance writes to before reading this as loss');
console.log(`   sent ${f(sent)}  landed ${f(landed)} (distinct ${f(distinct)})  lost ${f(r.lost)} (${r.lossPct ?? '-'}%)`);
console.log(`   drops: syslog socket ${f(r.ingest.syslogSocketDrops)}, trap socket ${f(r.ingest.trapSocketDrops)}, udp rcvbuf ${f(r.kernel.udpRcvbufErrors)}, softnet ${f(r.kernel.softnetDrops)}, shed by us ${f(r.ingest.shedByUs)}`);
console.log(`   flush p99 ${r.ingest.flushP99Ms} ms max ${r.ingest.flushMaxMs} ms; cpu app ${r.cpu.appCores} cores, postgres ${r.cpu.pgCores} (${r.cpu.source})`);
console.log(`   heartbeat >50ms: ingest ${r.heartbeat.ingest.over}/${f(r.heartbeat.ingest.ticks)} (${r.heartbeat.ingest.pct}%), collector ${r.heartbeat.collector.over}/${f(r.heartbeat.collector.ticks)} (${r.heartbeat.collector.pct}%), main ${r.heartbeat.main.over}/${f(r.heartbeat.main.ticks)} (${r.heartbeat.main.pct}%), jobs ${r.heartbeat.jobs.over}`);
console.log(`   collector: ${f(r.collector.polls)} polls, ${f(r.collector.failures)} failed, p50 ${r.collector.pollP50Ms} ms; db +${f(r.dbMbGrowth)} MB`);
NODE
