#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
test -f extension/index.ts || { echo 'FAIL: extension/index.ts missing'; exit 1; }
n=$(find extension src -name '*.ts' | wc -l | tr -d ' ')
[ "$n" -ge 3 ] || { echo "FAIL: only $n source files under extension/ src/"; exit 1; }
fail=0
# D01: capture never injects into, steers, or side-turns the conversation
if grep -rnE '\b(sendMessage|sendUserMessage|appendEntry|runEphemeralTurn|steer|followUp)\s*\(' extension src; then
  echo 'FAIL: conversation-injection API used'; fail=1; fi
# D03/D04: model calls only in src/extract.ts (absent before Phase 3 is fine)
bad=$(grep -rlE '\b(completeSimple|streamSimple)\b' extension src | grep -v '^src/extract\.ts$')
[ -z "$bad" ] || { echo "FAIL: model call outside src/extract.ts: $bad"; fail=1; }
if [ -f src/extract.ts ] && grep -nE '^\s*tools\s*:' src/extract.ts; then echo 'FAIL: tools passed to extractor'; fail=1; fi
# Runtime imports limited to node builtins and pi packages bundled in the omp binary (pi-coding-agent
# subpaths verified to resolve at runtime). Inspect the bundle, not the source: bun drops type-only
# imports (incl. multi-line) and rewrites `node:fs` to `fs`. Kept in review: live smokes only exercise
# code paths they run; this catches a stray import in any module.
out=$(mktemp -d)
bun build extension/index.ts --target bun --packages external --outdir "$out" >/dev/null \
  || { echo 'FAIL: bun build extension/index.ts'; exit 1; }
bad=$(grep -hoE '(from|import)[[:space:]]*\(?"[^"]+"' "$out"/*.js | grep -oE '"[^"]+"' | tr -d '"' | sort -u \
  | bun -e 'import { isBuiltin } from "node:module"; for (const s of (await Bun.stdin.text()).split("\n").filter(Boolean)) if (!isBuiltin(s) && !/^@oh-my-pi\/pi-(ai|utils|tui|coding-agent(\/.+)?)$/.test(s)) console.log(s)')
[ -z "$bad" ] || { echo "FAIL: disallowed runtime import: $bad"; fail=1; }
[ "$fail" -eq 0 ] && echo 'invariants: ok'
exit $fail
