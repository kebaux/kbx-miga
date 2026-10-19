#!/usr/bin/env bash
# A12 live smoke (plan task 4.8): two OMP sessions capturing at the same time into one store
# produce two records with distinct ids, each carrying its own session's identity.
# Extraction is cut short (OMP_CAPTURE_TIMEOUT_MS=1); this checks identity, not interpretation.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
ext="$repo/extension/index.ts"
D=$(mktemp -d /tmp/omp-capture-sessions.XXXX)
cd "$D"
run() {
  local status=0
  "$@" 2>>"$D/omp.err" >/dev/null || status=$?
  [ "$status" -eq 0 ] || { echo "FAIL: $1 exited $status; see $D/omp.err"; exit 1; }
}

# Seed two sessions with different words, so a capture holding the other session's content is detectable.
word_a=ALPHA; word_b=BRAVO
run omp --session-dir "$D/a" --no-extensions --no-tools -p "Reply with the single word $word_a."
run omp --session-dir "$D/b" --no-extensions --no-tools -p "Reply with the single word $word_b."

# Capture concurrently into one store.
pids=()
for s in a b; do
  OMP_CAPTURE_DIR="$D/c" OMP_CAPTURE_TIMEOUT_MS=1 omp --session-dir "$D/$s" --continue --no-extensions \
    --trusted-extension "$ext" -p "/capture same phrase" >/dev/null 2>>"$D/omp.err" &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid" || { echo "FAIL: a concurrent capture exited nonzero; see $D/omp.err"; exit 1; }; done

bun "$repo/scripts/assert-record.ts" "$D/c" --count 2 --request "same phrase"
ids=$(jq -r .id "$D"/c/*.json | sort -u | wc -l | tr -d ' ')
[ "$ids" -eq 2 ] || { echo "FAIL: expected 2 distinct ids, got $ids"; exit 1; }
for s in a b; do
  if [ "$s" = a ]; then own=$word_a; other=$word_b; else own=$word_b; other=$word_a; fi
  header=$(jq -r 'select(.type=="session") | .id' "$D/$s"/*.jsonl)
  rec=$(jq -r --arg sid "$header" --arg dir "$D/$s/" \
    'select(.origin.session_id == $sid and (.origin.session_file | startswith($dir))) | input_filename' "$D"/c/*.json)
  [ -n "$rec" ] || { echo "FAIL: no record carries session $s ($header)"; exit 1; }
  text=$(jq -r '[.source_packet.parts[].segments[].text] | join("\n")' "$rec")
  grep -q "$own" <<<"$text" || { echo "FAIL: session $s record lacks its own word $own"; exit 1; }
  if grep -q "$other" <<<"$text"; then echo "FAIL: session $s record contains the other session's word $other"; exit 1; fi
  echo "session $s $header -> $(basename "$rec" | cut -c1-8) (has $own, not $other)"
done
echo "OK sessions=2 records=2 distinct=2 isolated=2"
rm -rf "$D"
