#!/bin/bash
# What each background job did last, read from /api/health.
#
# READ-ONLY. The jobs worker keeps a per-job record (runs, failures, the
# last outcome string) and the health report carries it, but nothing on a
# box prints it: the journal logs only failures, and the soak line reduces
# the whole section to one failure count. So the question "what did the
# trigram sync actually drop this morning" had no answer short of psql on
# job_state - which is what this exists to give without a database
# credential. Investigated 2026-09-06, when the uncovered-partition count
# on lab-stresstest was climbing one a day and the only evidence was that
# count.
#
# Needs a session, exactly as tools/soak.sh does: SOAK_USER / SOAK_PASS
# default to the repo's demo fixture, and BASE to the local port.
#
#   BASE=http://127.0.0.1:18080 bash tools/jobs-health.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:18080}"
CJ="$(mktemp)"
H="$(mktemp)"
trap 'rm -f "$CJ" "$H"' EXIT

curl -s -c "$CJ" -X POST "$BASE/api/login" -H 'content-type: application/json' \
     -d "{\"username\":\"${SOAK_USER:-admin}\",\"password\":\"${SOAK_PASS:-rscanvas-demo-2026}\"}" \
     -o /dev/null 2>/dev/null || true
if ! curl -s -b "$CJ" "$BASE/api/health" -o "$H" 2>/dev/null; then
    echo "no answer from $BASE/api/health" >&2
    exit 1
fi

python3 - "$H" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"health is not JSON ({e}) - login refused?", file=sys.stderr)
    sys.exit(1)
if 'error' in d and 'jobs' not in d:
    print(f"health refused: {d.get('error')}", file=sys.stderr)
    sys.exit(1)
print(f"ok={d.get('ok')} now={d.get('now') or d.get('ts') or ''}")
j = d.get('jobs') or {}
jobs = j.get('jobs') if isinstance(j, dict) else j
if isinstance(jobs, dict):
    jobs = [dict(name=k, **(v or {})) for k, v in jobs.items()]
jobs = jobs or []
if not jobs:
    print("no jobs section in the health report - is JOBS_ENABLED on this box?")
    sys.exit(1)
for r in jobs:
    print(f"{r.get('name', '?'):24} runs={r.get('runs')} fail={r.get('failures')} "
          f"consec={r.get('consecutiveFailures')} lastOk={r.get('lastOkAt')} "
          f"lastRun={r.get('lastRunAt')} lastMs={r.get('lastMs')}")
    detail = str(r.get('lastDetail') or '')
    if detail:
        print(f"    {detail[:900]}")
PY
