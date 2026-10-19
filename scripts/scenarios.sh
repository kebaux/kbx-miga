#!/usr/bin/env bash
# Acceptance scenarios A01–A16 (brief §12) on the installed harness (plan task 5.1).
# Prints one line per scenario: `A<nn> PASS|FAIL|REVIEW <evidence>`; exits 1 if any FAILs, or if a
# REVIEW scenario lacks a recorded cold-review PASS in the progress doc naming its current records.
# Real model calls (smokes + semantic seeds). Semantic records persist in $SCENARIO_OUT (default
# .scenarios/) and are reused so a recorded verdict stays bound to the record it judged;
# SCENARIOS_FRESH=1 reseeds them (their verdicts must then be recorded again).
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
OUT="${SCENARIO_OUT:-$repo/.scenarios}"
PROGRESS="$repo/docs/progress/2026-10-18-omp-learning-capture-extension-51fm.md"
ext="$repo/extension/index.ts"
TMP=$(mktemp -d /tmp/omp-capture-scenarios.XXXX)
failed=0

say() { # say <id> <PASS|FAIL|REVIEW> <evidence>
  echo "$1 $2 $3"
  [ "$2" = FAIL ] && failed=1
  return 0
}
# unit <regex>: true when the test-name regex matches ≥ 1 test and none fail (no match exits 1).
unit() { bun test -t "$1" >"$TMP/unit.log" 2>&1; }
units() { grep -oE '^ *[0-9]+ pass' "$TMP/unit.log" | tr -d ' '; }

echo "# running live smokes (real model calls) …" >&2
scripts/smoke-extract.sh >"$TMP/extract.log" 2>&1; extract=$?
bun scripts/smoke-streaming.ts >"$TMP/stream.log" 2>&1; stream=$?
scripts/smoke-sessions.sh >"$TMP/sessions.log" 2>&1; sessions=$?
scripts/smoke-retry.sh >"$TMP/retry.log" 2>&1; retry=$?
last_ok() { grep -E "$2" "$TMP/$1.log" | tail -1; }

PROMPT_VERSION=$(bun -e 'import { PROMPT_VERSION } from "./src/extract"; console.log(PROMPT_VERSION)')

# meets <record> <check-json>: the record has an allowed state, no last_error, and every required part shape.
meets() {
  jq -e --argjson c "$2" '. as $r
    | ($c.state // [$r.state] | index($r.state) != null)
    and $r.last_error == null
    and (($c.parts // []) | all(. as $p | any($r.source_packet.parts[]; .kind == $p.kind and .completeness == $p.completeness)))' \
    "$1" >/dev/null 2>&1
}

# semantic <A0n>: for every case, reuse its record only if it was made by the current prompt and still
# meets its check (else reseed), then require a PASS verdict row in the progress doc that names every
# current record's short id. A missing or empty spec is a FAIL, never a pass with zero records.
semantic() {
  local id=$1 lower json cases name dir rec check ids="" paths="" bad=""
  lower=$(echo "$id" | tr 'A-Z' 'a-z')
  json="test/scenarios/$lower.json"
  cases=$(jq -r '.cases[].name' "$json" 2>/dev/null)
  if [ -z "$cases" ]; then say "$id" FAIL "no cases in $json"; return; fi
  for name in $cases; do
    dir="$OUT/$id/$name"
    check=$(jq -c --arg n "$name" '.cases[] | select(.name == $n) | .check' "$json")
    rec=$(ls "$dir"/c/*.json 2>/dev/null | head -1)
    if [ -z "$rec" ] || [ -n "${SCENARIOS_FRESH:-}" ] \
      || [ "$(jq -r '.extraction.prompt_version // empty' "$rec")" != "$PROMPT_VERSION" ] || ! meets "$rec" "$check"; then
      echo "# seeding $id/$name …" >&2
      rec=$(bun scripts/seed-scenario.ts "$json" "$name" "$dir" 2>"$TMP/seed.log") || { bad="$bad $name:seed($(grep -v '^ *at ' "$TMP/seed.log" | tail -1))"; continue; }
    fi
    meets "$rec" "$check" || bad="$bad $name:$(jq -r '"state=\(.state) last_error=\(.last_error.class // "none")"' "$rec")"
    ids="$ids $(basename "$rec" | cut -c1-8 | tr 'a-f' 'A-F')"
    paths="$paths $rec"
  done
  if [ -n "$bad" ]; then say "$id" FAIL "check failed:$bad"; return; fi
  local row verdict=PASS
  row=$(grep -E "^\| $id \|" "$PROGRESS" | tail -1)
  case "$row" in *"| PASS"*) ;; *) verdict=missing ;; esac
  for s in $ids; do case "$row" in *"$s"*) ;; *) verdict=missing ;; esac; done
  echo "$id REVIEW records:$ids verdict=$verdict paths:$paths"
  [ "$verdict" = PASS ] || failed=1
}

semantic A01

semantic A02

# A03: a bare /capture on an empty branch is saved and receipted; its interpretation is labelled inferred.
a03="$TMP/a03"
a03_err=$(cd "$TMP" && OMP_CAPTURE_DIR="$a03" omp --no-session --no-extensions --trusted-extension "$ext" -p "/capture" 2>&1 >/dev/null)
if grep -qE '^Captured [0-9A-F]{4}\.$' <<<"$a03_err" \
  && a03_ok=$(bun scripts/assert-record.ts "$a03" --request "" --state needs_context --last-error none) \
  && unit "interpretation is labelled pending, needs-context, or predating a later note"; then
  say A03 PASS "bare /capture receipted ($(grep -E '^Captured' <<<"$a03_err")); $a03_ok; render labels interpretation as inferred: unit $(units)"
else say A03 FAIL "bare capture receipt/record/render check failed: $(tail -1 <<<"$a03_err")"; fi

if unit "earlier anchored subject is retained with its predecessor"; then say A04 PASS "unit $(units)"
else say A04 FAIL "unit test failed"; fi

if unit "agent-originated content keeps agent authorship and original roles"; then semantic A05
else say A05 FAIL "attribution unit test failed"; fi

if unit "pre-clear entries are excluded|abandoned sibling branch never appears|a /clear after the latest compaction wins" && [ $sessions -eq 0 ]; then
  say A06 PASS "unit $(units) (pre-clear, abandoned branch); other session isolated: $(last_ok sessions '^OK sessions')"
else say A06 FAIL "unit or smoke-sessions (exit=$sessions) failed"; fi

if [ $stream -eq 0 ]; then say A07 PASS "$(last_ok stream '^OK partial')"
else say A07 FAIL "smoke-streaming exit=$stream: $(tail -1 "$TMP/stream.log")"; fi

if unit "truncated tool result keeps two segments with offsets and kind|compaction keeps summary \+ kept tail only|model text cannot forge headings"; then semantic A08
else say A08 FAIL "truncation/compaction unit tests failed"; fi

if unit "validateProposal \(A09, A15\)|a failure keeps state and extraction" && [ $extract -eq 0 ] && grep -q 'last_error=aborted' "$TMP/extract.log"; then
  say A09 PASS "unit $(units) (error/aborted/malformed rejected, failure keeps state); live: $(last_ok extract 'last_error=aborted')"
else say A09 FAIL "unit or smoke-extract (exit=$extract) failed"; fi

if [ $retry -eq 0 ]; then say A10 PASS "$(last_ok retry '^OK retry')"
else say A10 FAIL "smoke-retry exit=$retry: $(tail -1 "$TMP/retry.log")"; fi

if unit "note during in-flight extraction makes the stale proposal discard"; then say A11 PASS "unit $(units)"
else say A11 FAIL "unit test failed"; fi

if unit "ambiguous prefix rejected" && [ $sessions -eq 0 ]; then say A12 PASS "unit $(units); $(last_ok sessions '^OK sessions')"
else say A12 FAIL "unit or smoke-sessions (exit=$sessions) failed"; fi

if unit "killed-process recovery"; then say A13 PASS "unit $(units) (SIGKILLed lock holder; kill between temp write and rename)"
else say A13 FAIL "unit tests failed"; fi

ro="$TMP/ro"; mkdir -p "$ro"; chmod 0500 "$ro"
ro_out=$(OMP_CAPTURE_DIR="$ro/store" omp --no-session --no-extensions --trusted-extension "$ext" -p "/capture x" 2>&1 | grep -E 'Captured|Capture failed')
if unit "\(A14\)" && [ -z "$(ls -A "$ro")" ] && case "$ro_out" in "Capture failed:"*) ! grep -q Captured <<<"$ro_out";; *) false;; esac; then
  say A14 PASS "unit $(units) (spaces+Unicode path, unwritable store); live: '$ro_out', nothing written"
else say A14 FAIL "unit or read-only store check failed: '$ro_out'"; fi
chmod 0700 "$ro"

if unit "validateProposal \(A09, A15\)|rejects an evidence id that is not in the packet"; then say A15 PASS "unit $(units) (invented ids, tool calls, length/aborted/error rejected)"
else say A15 FAIL "unit tests failed"; fi

# A16: with the provider unreachable, view/export still work; a retry (the only model path besides /capture) cannot succeed.
dead="$TMP/dead-agent"; store="$TMP/a16"; mkdir -p "$dead"
printf 'providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n' >"$dead/models.yml"
OMP_CAPTURE_DIR="$store" OMP_CAPTURE_TIMEOUT_MS=1 omp --no-session --no-extensions --trusted-extension "$ext" -p "/capture a16 view check" >/dev/null 2>&1
a16id=$(ls "$store"/*.json 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null | cut -c1-8)
offline() { PI_CODING_AGENT_DIR="$dead" ANTHROPIC_API_KEY=sk-ant-dummy OMP_CAPTURE_DIR="$store" OMP_CAPTURE_TIMEOUT_MS=5000 \
  omp --no-session --no-extensions --trusted-extension "$ext" --model anthropic/claude-opus-5-5 -p "$1" 2>&1; }
a16ok=1
[ -n "$a16id" ] || a16ok=0
offline "/capture-list" | grep -q "^$(echo "$a16id" | tr 'a-f' 'A-F')" || a16ok=0
offline "/capture-show $a16id" | grep -q '^# Capture ' || a16ok=0
offline "/capture-export $a16id md" | grep -q 'Exported' || a16ok=0
offline "/capture-retry $a16id" | grep -qF 'failed (aborted)' || a16ok=0
if [ $a16ok -eq 1 ] && unit "editing or deleting an export leaves the record unchanged"; then
  say A16 PASS "provider unreachable: list/show/export ok, retry failed as expected; unit $(units) (export edits/deletes leave record unchanged)"
else say A16 FAIL "offline view/export check or unit test failed"; fi

rm -rf "$TMP"
exit $failed
