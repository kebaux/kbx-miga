#!/usr/bin/env bash
# A10 live smoke (plan task 4.9; real model calls): after the session moves on, /capture-retry
# re-interprets the same capture from its saved packet only. Same id, byte-identical packet,
# and the new extraction's input_revision is the revision the retry started from.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
ext="$repo/extension/index.ts"
D=$(mktemp -d /tmp/omp-capture-retry.XXXX)
cd "$D"
export OMP_CAPTURE_DIR="$D/c"
run() {
  local status=0
  "$@" 2>>"$D/omp.err" >/dev/null || status=$?
  [ "$status" -eq 0 ] || { echo "FAIL: $1 exited $status; see $D/omp.err"; exit 1; }
}
packet_hash() { jq -cS .source_packet "$D"/c/*.json | shasum -a 256 | cut -d' ' -f1; }

run omp --session-dir "$D/s" --no-extensions -p "In 3 sentences: why might a job worker run the same job twice after a restart?"
run omp --session-dir "$D/s" --continue --no-extensions --trusted-extension "$ext" -p "/capture the worker running twice"
bun "$repo/scripts/assert-record.ts" "$D/c" --request "the worker running twice" --min-parts 2
id=$(jq -r .id "$D"/c/*.json)
before_hash=$(packet_hash)

# The conversation drifts: a later turn on another subject must not enter the capture.
run omp --session-dir "$D/s" --continue --no-extensions -p "Now in one sentence: what is a dead-letter queue?"
before_rev=$(jq -r .revision "$D"/c/*.json)

run omp --session-dir "$D/s" --continue --no-extensions --trusted-extension "$ext" -p "/capture-retry ${id:0:8}"
bun "$repo/scripts/assert-record.ts" "$D/c" --last-error none
after_id=$(jq -r .id "$D"/c/*.json)
[ "$after_id" = "$id" ] || { echo "FAIL: id changed $id -> $after_id"; exit 1; }
[ "$(packet_hash)" = "$before_hash" ] || { echo "FAIL: source_packet changed on retry"; exit 1; }
input_rev=$(jq -r .extraction.input_revision "$D"/c/*.json)
[ "$input_rev" = "$before_rev" ] || { echo "FAIL: input_revision=$input_rev, expected $before_rev"; exit 1; }
if jq -e '[.source_packet.parts[].segments[].text | test("dead-letter"; "i")] | any' "$D"/c/*.json >/dev/null; then
  echo "FAIL: the later turn leaked into the packet"; exit 1
fi
echo "OK retry id=${id:0:8} packet=unchanged input_revision=$input_rev revision=$(jq -r .revision "$D"/c/*.json)"
rm -rf "$D"
