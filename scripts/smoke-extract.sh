#!/usr/bin/env bash
# Live extraction smoke (plan task 3.6; real model calls). Proves A01–A03/A09 and D04 on the
# installed harness: a seeded session extracts `ready` with no tools offered, an empty branch
# extracts `needs_context`, and a 1 ms deadline leaves `raw` with last_error `aborted`.
# Prints the ready record's path for the A01 cold review; artifacts stay in the temp dir.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
ext="$repo/extension/index.ts"
D=$(mktemp -d /tmp/omp-capture-extract.XXXX)
cd "$D" # omp runs in a neutral cwd
run() {
  local status=0
  "$@" 2>>"$D/omp.err" >/dev/null || status=$?
  [ "$status" -eq 0 ] || { echo "FAIL: $1 exited $status; see $D/omp.err"; exit 1; }
}
capture() { run omp --no-extensions --trusted-extension "$ext" "$@"; }
assert() { bun "$repo/scripts/assert-record.ts" "$@"; }

# 1. Seeded episode → ready; provider payload carries no tools.
run omp --session-dir "$D/s" --no-extensions \
  -p "In 4 sentences: why can a job worker run the same job twice after a restart, and what does an idempotency key do?"
OMP_CAPTURE_DIR="$D/c1" OMP_CAPTURE_DEBUG_PAYLOAD="$D/payload.json" capture --session-dir "$D/s" --continue \
  -p "/capture that thing about the worker doing the job twice"
assert "$D/c1" --request "that thing about the worker doing the job twice" --state ready --min-parts 2 --last-error none
test -s "$D/payload.json" || { echo "FAIL: no provider payload recorded"; exit 1; }
jq -e '(.tools == null or .tools == []) and (.tool_choice == null or .tool_choice == "none" or .tool_choice.type? == "none")' \
  "$D/payload.json" >/dev/null || { echo "FAIL: tools offered to extractor: $(cat "$D/payload.json")"; exit 1; }
echo "payload tools=none"

# 2. Bare /capture on an empty branch → needs_context (A02/A03).
OMP_CAPTURE_DIR="$D/c2" capture --no-session -p "/capture"
assert "$D/c2" --request "" --state needs_context --last-error none

# 3. Deadline hit → the receipt-backed record stays raw with a bounded diagnostic (A09).
OMP_CAPTURE_DIR="$D/c3" OMP_CAPTURE_TIMEOUT_MS=1 capture --no-session -p "/capture timeout check"
assert "$D/c3" --state raw --last-error aborted

echo "ready record: $(ls "$D"/c1/*.json)"
