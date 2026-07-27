#!/usr/bin/env bash
# End-to-end check of a deployed scheduled job.
#
# It waits for the platform's own scheduler to fire and then confirms the run
# was recorded: when it started, how long it took, what it printed and whether
# it worked. That wait is the point - anything faster would only prove the code
# runs, not that the schedule does.
#
#   scripts/verify-schedule.sh https://your-history.up.railway.app 'the-token'
set -uo pipefail

BASE="${1:?usage: verify-schedule.sh <history-url> <history-token>}"
TOKEN="${2:?usage: verify-schedule.sh <history-url> <history-token>}"
BASE="${BASE%/}"
WAIT_MINUTES="${WAIT_MINUTES:-7}"
failed=0

ok()   { echo "  ok   $1${2:+ - $2}"; }
fail() { echo "  FAIL $1 - $2"; failed=1; }

runs_json() { curl -s --max-time 30 "$BASE/api/runs" -H "authorization: Bearer $TOKEN"; }

count_runs() {
  python3 -c '
import json, sys
try:
    print(len(json.loads(sys.argv[1]).get("runs", [])))
except Exception:
    print(0)
' "$1"
}

echo "checking $BASE"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/health")
[ "$code" = "200" ] && ok "health" || fail "health" "got $code"

# 1. Job output can contain anything - connection strings, customer names. The
#    history is not published.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/api/runs")
[ "$code" = "401" ] && ok "history is not readable without the token" || fail "history is not readable without the token" "got $code"

# 2. Wait for the scheduler. The default schedule is every five minutes, which
#    is also the platform's shortest interval.
echo "  ..   waiting up to ${WAIT_MINUTES} minutes for a scheduled run"
deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
body=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  body=$(runs_json)
  [ "$(count_runs "$body")" != "0" ] && break
  sleep 15
done

if [ "$(count_runs "$body")" = "0" ]; then
  fail "a scheduled run was recorded" "nothing in ${WAIT_MINUTES} minutes - check the schedule on the job service"
else
  python3 -c '
import json, sys
run = json.loads(sys.argv[1])["runs"][0]
lines = (run.get("output") or "").strip().splitlines()
first = lines[0][:60] if lines else "(none)"
print("  ok   a scheduled run was recorded - %s %s in %sms" % (run["job"], run["status"], run.get("duration_ms")))
print("  ok   the run kept its output - %s" % first)
if run["status"] != "succeeded":
    print("  FAIL the run succeeded - status %s, exit %s" % (run["status"], run.get("exit_code")))
    raise SystemExit(1)
print("  ok   the run succeeded - exit %s" % run.get("exit_code"))
' "$body" || failed=1
fi

echo
[ "$failed" = "0" ] && echo "all checks passed" || { echo "some checks failed"; exit 1; }
