# Execution Evidence: OMP `/capture` Learning-Capture Extension

**Plan:** `docs/plans/2026-10-18-omp-learning-capture-extension-51fm.md`
**Beads epic:** `kbx-miga-tc2` — Beads, not this file, determines work status.
**Last updated:** 2026-10-18 (Phase 1 verified)

## Compatibility check (brief M0) — completed during planning

**Source revision:** `c4c60cf` (no product code yet)
**Harness:** `omp/18.12.1`, Bun 1.3.14, macOS arm64; OMP source tag `v18.12.1` (`291e055`)

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| `omp --version` | `omp/18.12.1` | 0 | 2026-10-18 |
| `git clone --depth 1 --branch v18.12.1 https://github.com/can1357/oh-my-pi.git /tmp/omp-src-18.12.1` | HEAD `291e055` | 0 | 2026-10-18 |
| `omp --no-session -e /tmp/omp-capture-probe/probe.ts -p "/probecap  hello  wörld :)"` (throwaway probe, deleted) | `{"stage":"handler","args":"\" hello  wörld :)\"","completeSimple":"function","lock":"ok","sessionId":"string","leafId":"a803da61","branchLen":2,"model":"anthropic/claude-opus-5-5","resolver":"function","mode":"print","agentKind":"main","uiCustom":"function","uiEditor":"function"}` — no model call | 0 | 2026-10-18 |
| `bun add -d -E @oh-my-pi/pi-coding-agent@18.12.1 @oh-my-pi/pi-ai@18.12.1 @oh-my-pi/pi-utils@18.12.1 typescript @types/bun` (scratch dir) | 117 packages; `typescript@7.0.2`, `@types/bun@1.4.3`; 2 postinstalls blocked (onnxruntime-node, protobufjs) | 0 | 2026-10-18 |
| `tsc -p .` on a probe using `ExtensionAPI`, `ExtensionCommandContext`, `SessionEntry`, `completeSimple` (`toolChoice:"none"`, `disableReasoning`, `signal`), `modelRegistry.resolver`, `withFileLock`, `getAgentDir`, `pi.on("message_update"/"session_shutdown")` | no diagnostics | 0 | 2026-10-18 |
| `bun lock.ts` (`withFileLock` from npm `pi-utils` outside OMP) | `locked-ok` | 0 | 2026-10-18 |
| Session size percentiles over `~/.omp/agent/sessions/*/*.jsonl` | `n=734 p50=2199266 p90=9889155 max=39944317` | 0 | 2026-10-18 |
| Fitness import check (bundle-based) against a scratch file with a multi-line type import, `node:fs`, and `pathe` | flagged only `pathe` | 0 | 2026-10-18 |
| Phase 1 red instrument (exact plan command) | `omp exit=1`, `contract exit=1`, `error: Trusted extension must be an existing module file: …/extension/index.ts` | 1 | 2026-10-18 |
| `omp --no-session --no-extensions --trusted-extension /tmp/omp-review-probe/probe.ts -p "/probered"` (review probe: `redactMemorySecrets` via `@oh-my-pi/pi-coding-agent/memory-backend/redact`, deleted) | `key [REDACTED] and token=[REDACTED] and Bearer abcdefghijklmnopqrstuvwxyz0123456789` — subpath import resolves in the binary; Bearer not covered | 0 | 2026-10-18 |
| Widened import allowlist regex against `@oh-my-pi/pi-coding-agent/memory-backend/redact`, `@oh-my-pi/pi-coding-agent`, `pathe`, `fs` | flagged only `pathe` | 0 | 2026-10-18 |

### Capability note

The brief's section 10 checks:
1. **`/capture` unclaimed, registers, runs while streaming:** No collision exists. Dispatch was verified by reading the source; the print-mode command ran. Mid-stream TUI behaviour is still to be observed in the Phase 1 manual check and the Phase 2 RPC smoke.
2. **Correct main session and branch, including the reset boundary:** The command context is always the main session (child-focused transcripts are refused). `getBranch()` does not apply `/clear`, so the plan replicates `session-context.ts:479-600`.
3. **Streaming text:** It is not in the branch. The policy is a `message_update` buffer, kept as a partial part.
4. **Explicit-context call without tools or a new login:** `completeSimple` with `modelRegistry.resolver` is verified by reading and typecheck. The live round trip through headroom is still unobserved; the Phase 3 smoke covers it, including the `onPayload` tools check.
5. **Routing, credentials and headers preserved:** baseUrl and `models.yml` headers travel on `Model`. Settings-wrapper timeouts and hooks are bypassed, so the extension sets its own deadline.
6. **Completion, cancel, timeout and shutdown:** `stopReason` covers `error` and `aborted`. There is no command signal, so jobs get their own `AbortController` and `session_shutdown` aborts them.
7. **Store publishes and reopens on the actual filesystem:** the `wx` + `sync` + `rename` pattern was read in `settings.ts:3567-3585`. It is exercised in Phase 1.

### Gotchas, Insights, and Deviations

- The TUI trims and emoticon-expands input before command dispatch, so `request_text` means "the argument the handler received". This is a deviation from the brief's "exact text typed" wording and will be documented in the README limitations.
- `attribution: "user"` is also the default for extension `sendUserMessage`, so it is not proof of human authorship. The schema field is `authorship`, and its value `"user"` means "OMP-attributed".
- In print mode, a detached extraction would be killed when the process exits. The plan therefore awaits extraction in `ctx.mode === "print"`.
- `--trusted-extension` makes a load failure fatal, which keeps red-state smoke runs from falling through to a model prompt. Running a not-yet-registered command with plain `-e` would send it to the model.

## Phase 1: Walking skeleton — `/capture` publishes a raw record

**Beads phase issue:** `kbx-miga-tc2.1`
**Class:** standard. **Source revision:** `c4c60cf` plus uncommitted Phase 1 work. The tree has no commit yet, so verification ran against the working tree. Pre-existing untracked `docs/` and `.beads/issues.jsonl` were in the baseline.
**Phase-local delta:** 13 new files plus 3 lines in `.gitignore`. The baseline snapshot is `/tmp/kbx-miga-phase1-baseline` (temporary).

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| Red instrument, run before any code (exact plan command, then `echo "contract exit=$?"; grep -m1 '^error:' …`) | `omp exit=1`, `contract exit=1`, `error: Trusted extension must be an existing module file: /Users/kbouw/Development/kbx-miga/extension/index.ts` | 1 | 2026-10-18 |
| `bun add -d -E …` (task 1.1 list) | 117 packages; `bun.lock` saved; 2 postinstalls blocked (same as planning) | 0 | 2026-10-18 |
| Primary contract (`/capture why the worker ran twice`, `--trusted-extension`), final state | `omp exit=0` / `Captured 2319.` / `OK 2319c8fa-de91-4f24-bb19-af5156139772 state=raw parts=0` / `contract exit=0` | 0 | 2026-10-18 |
| `bun test` (final state) | `22 pass, 0 fail, 41 expect() calls`, 3 files | 0 | 2026-10-18 |
| Read-only store (A14), final state | prints only `Capture failed: EACCES: permission denied, mkdir '/tmp/omp-capture-ro/store'`; `ls -A` prints nothing | 0 (`ls`) | 2026-10-18 |
| `bun run typecheck` | `tsc -p .`, no diagnostics | 0 | 2026-10-18 |
| `scripts/check-invariants.sh` | no output | 0 | 2026-10-18 |
| `check-invariants.sh` with a probe file calling `pi.sendUserMessage(` / with `import "pathe"` prepended to `extension/index.ts` (both reverted) | `FAIL: conversation-injection API used` / `FAIL: disallowed runtime import: pathe` | 1 / 1 | 2026-10-18 |
| `ln -sfn "$PWD" ~/.omp/agent/extensions/capture` (created `~/.omp/agent/extensions/`), then the install contract from `/tmp` with no `-e` | `Captured C9FF.` | 0 | 2026-10-18 |
| Primary contract re-run with the global symlink installed as well as `--trusted-extension` | `Captured 6153.`, `OK … state=raw parts=0`. Exactly 1 record and no duplicate-command warning | 0 | 2026-10-18 |
| Throwaway: copy of a real 1.6 MB session with a compaction, `omp --session-dir <tmp> --continue --trusted-extension … -p "/capture the compaction thing"` | `Captured E709.`, `OK … state=raw parts=31`, boundary `compaction`, `eligible_parts:158, omitted:[{before_part:"s1",count:127}], excluded.thinking:49`. Kinds: tool_call, tool_result (with tool name and call_id), assistant_message, user_message. The only appended session line was `custom/session_exit`, with no message | 0 | 2026-10-18 |
| **Manual TUI check:** real `omp` TUI in a pty (`--session-dir /tmp/omp-tui-check/s`), a 2500-word prompt, then `/capture why this approach` typed while the reply was streaming | `Captured 1ADF.` appeared under the streaming text, above `Esc Working…`, and the reply kept streaming to completion. The transcript holds only 2 user and 2 assistant messages; `grep -c 'why this approach'` on the session file = 0. The record `1adfcc19…` validates with parts `[user_message, assistant_message, user_message]`. The in-flight reply is absent, which is correct for Phase 1; the Phase 2 partial buffer adds it | — | 2026-10-18 |

The TUI check ran before the review fixes. Those fixes touched only validator checks, fixture numbers, and a doc comment. The primary and install contracts re-ran green on the final state.

### Review (cold `reviewer` subagent, phase-local delta)

0 critical, 0 warning, 7 suggestions. Verdict: ship as-is.

Applied:
- Cross-field validator checks (#4), with a test.
- Fixture offsets corrected (#5).
- `selectEligible` doc comment now states where it deliberately differs from OMP (#3).

Applied as plan amendments:
- The rollover gap is now accepted in the 1.4 as-built note (#2).
- The meaning of `publish_ms` is stated in 1.3 and 6.1 (#6).
- Copying `ctx.model` moved to task 3.5 (#7).

### Gotchas, Insights, and Deviations

- **Deviation:** `.gitignore` gained `node_modules/`, which no task names. It is required by 1.1, because `bun add` creates `node_modules/` in the repo root.
- **Deviation (1.5):** `resolveStoreDir()` is pure, and the directory is created inside `publishNew(dir, record)`. This lets the store dir be resolved in the synchronous freeze block. The plan is amended.
- **Deviation (1.6):** `ctx.model` is not copied yet, because there is no reader before Phase 3. Task 3.5 is amended to copy it in the freeze block.
- **Insight:** the Phase 1 tail has no per-part cap. If the newest part is over 64 KB, the packet has 0 parts and `omitted:[{before_part:null,…}]` (reviewer probe). Phase 2.2's 8 KB cap removes this case. Phase 2 should include a test that an oversized newest part still leaves a non-empty packet.
- **Insight:** the real `SessionManager.inMemory` from npm `pi-coding-agent@18.12.1` works under plain `bun test`. Snapshot tests therefore use OMP's own `getBranch()`/`branch()`/`appendCompaction()`/`appendResetBoundary()` instead of hand-built entry chains.
- **Gotcha:** with `--continue` in print mode, OMP prints the last assistant message of the resumed session to stdout after the command runs. This is not a model call; the session file only gained `session_exit`.
- **Gotcha:** the global symlink and `--trusted-extension` can both be active without a duplicate `/capture` registration warning, and exactly one record was written. Later `--trusted-extension` smokes stay valid while the install is present.

## Phase 2: Faithful, bounded source packet

**Beads phase issue:** `kbx-miga-tc2.2`
**Class:** standard. **Source revision:** `c4c60cf` plus uncommitted Phases 1–2; verification ran against the working tree.
**Phase-local delta:** compared with the Phase 1 end state (`/tmp/kbx-miga-phase2-baseline`, temporary): 3 new files (`src/redact.ts`, `scripts/smoke-streaming.ts`, `test/redact.test.ts`) and 4 modified (`extension/index.ts`, `src/record.ts`, `src/snapshot.ts`, `test/snapshot.test.ts`).

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| Red: `bun test test/snapshot.test.ts` after writing the Phase 2 tests, before any implementation | `SyntaxError: Export named 'PARTIAL_MAX_CHARS' not found in module …/src/record.ts`, `0 pass, 1 fail`. This failed at import, unlike the predicted per-case failures; the plan is corrected | 1 | 2026-10-18 |
| Red: `bun scripts/smoke-streaming.ts` against the Phase 1 tree (baseline snapshot with `node_modules` linked in) | `FAIL: record bce2ea1c-… has no p1 partial part` | 1 | 2026-10-18 |
| `omp --no-session --no-extensions --trusted-extension … -p "/capture compose check"` | `Captured 1ECC.`, `OK … state=raw`: the two flags work together | 0 | 2026-10-18 |
| Red for review C1: the same smoke against the pre-fix Phase 2 tree (`/tmp/kbx-miga-phase2-after`), after the post-reply check was added | `FAIL: post-reply record 0b836f83-… repeats the reply as p1` | 1 | 2026-10-18 |
| Reviewer's `/tmp/p2review/race-control.ts` (count to 40, settle wait, `/capture`), 3 runs each | before the fix: `partial_included: true` ×3; after: `partial_included: false` ×3 | 0 | 2026-10-18 |
| Green: `bun test test/snapshot.test.ts` (final) | `19 pass, 0 fail, 56 expect() calls` | 0 | 2026-10-18 |
| Green: `bun scripts/smoke-streaming.ts` (final; real model calls; run green 3 times across the fix iterations) | `OK partial=1 main=completed injected=0 stale=0` | 0 | 2026-10-18 |
| Green: `bun test && bun run typecheck && scripts/check-invariants.sh` (final) | `36 pass, 0 fail, 92 expect() calls` across 4 files; `tsc` printed nothing; invariants printed nothing | 0 / 0 / 0 | 2026-10-18 |
| Phase 1 regression: main contract and install contract (final) | `Captured B50D.` / `OK b50de4eb-… state=raw parts=0`; install `Captured A098.` | 0 | 2026-10-18 |
| Kept smoke run (throwaway copy that keeps its artifacts) | `p1` came after `s1` (the user prompt): `assistant_message`, `partial`, 336 chars, one segment; `coverage.policy: tail+anchors/v1`, `partial_included: true` | 0 | 2026-10-18 |
| Freeze latency on the 38 MB-shaped session (reviewer's `perf.ts`) | about 3 ms warm (31 ms on the first, JIT run), against 49–76 ms before the redact-only-retained fix | 0 | 2026-10-18 |

### Review (cold `reviewer` subagent, two rounds)

**Round 1:** 1 critical, 2 warnings, 7 suggestions.
- **C1, stale duplicate `p1`.** OMP queues `message_update` events but delivers `message_end` directly, so a late update re-filled the slot. Fixed with an `endedAt` timestamp guard, a check that drops `p1` when the reply is already in the branch, and a regression check in the smoke test.
- **W1, PEM rules ate prose; W2, the Bearer rule ate prose.** Fixed with the reviewer's validated regexes, and the prose cases are now in the tests.
- **Suggestions:** S1 (cut edges moved to token-run edges), S2 (redact only retained parts), S4 (no 32 KB cap; `p1` keeps its real head and tail), S5 (smoke `check()` try/catch) and S6 (clear the slot only on assistant `message_end`) were fixed. S3 (budget units) and S7 (`last_error` redaction belongs to 3.4) became plan amendments.

**Round 2:** 0 critical, 1 warning, 2 suggestions.
- **W-new:** the S1 fix could make the head and tail segments overlap on texts just over the limit. Fixed by keeping such a part whole, with an 8,193-char test.
- **S-smoke:** the post-reply step had no timeout. Fixed with one deadline over the whole smoke run.
- **S1-residual:** declined, and recorded in plan 2.2 as an accepted limitation.

The reviewer also confirmed that "redaction never lengthens text" holds for every rule, and that a timestamp collision in the persisted check is negligible.

### Gotchas, Insights, and Deviations

- **Gotcha (OMP 18.12.1):** extensions receive `message_update` from a queue that is drained after the direct `message_end` (`agent-session.ts:3461-3512`). Any extension state set by `message_update` must ignore updates for a message whose `message_end` has already arrived. A capture made right after `prompt_result` does not hit this; a settle wait after a short turn does (3/3).
- **Deviation (2.5):** the slot stores the live message reference, not a per-token text copy, and has no 32 KB cap. Defaults table amended.
- **Deviation (2.2):** budget units are chars per part and bytes per packet. A part can be up to about 24 KB of UTF-8; by construction the packet stays ≤ 96 KB.
- **Insight:** a `--continue`d RPC session is not needed for A07. `RpcClient` with `--no-extensions --trusted-extension` gives a clean, single-extension harness in about 15 s per run.

## Phase 3: Bounded explicit-context extraction

**Beads phase issue:** `kbx-miga-tc2.3`
**Class:** standard. **Source revision:** `c4c60cf` plus uncommitted Phases 1–3; verification ran against the working tree.
**Phase-local delta:** compared with the Phase 2 end state (`/tmp/kbx-miga-phase3-baseline`, temporary): 3 new files (`src/extract.ts`, `scripts/smoke-extract.sh`, `test/extract.test.ts`) and 4 modified (`extension/index.ts`, `src/store.ts`, `scripts/assert-record.ts`, `test/store.test.ts`).

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| Red: `bun test test/extract.test.ts`, with the tests written before `src/extract.ts` existed | `error: Cannot find module '../src/extract'`, `0 pass, 1 fail`, as predicted | 1 | 2026-10-18 |
| Red: `scripts/smoke-extract.sh` against the Phase 2 tree | `FAIL: aa886d19-…: state=raw, expected ready`, as predicted | 1 | 2026-10-18 |
| Green: `bun test test/extract.test.ts` (final) | `23 pass, 0 fail, 45 expect() calls` | 0 | 2026-10-18 |
| Green: `scripts/smoke-extract.sh` (final; real model calls through headroom) | `OK 35989ba5-… state=ready parts=2` / `payload tools=none` / `OK 9790ffac-… state=needs_context parts=0` / `OK 35ec60d1-… state=raw parts=0 last_error=aborted`. A run before the review fixes gave the same results | 0 | 2026-10-18 |
| Provider payload recorded by `OMP_CAPTURE_DEBUG_PAYLOAD` (D04) | `{"tools":[],"tool_choice":{"type":"none"}}` | — | 2026-10-18 |
| Green: `bun test && bun run typecheck && scripts/check-invariants.sh` (final) | `62 pass, 0 fail, 144 expect() calls` across 5 files; `tsc` printed nothing; invariants printed nothing | 0 / 0 / 0 | 2026-10-18 |
| `smoke-extract.sh` with `omp` missing from `PATH` (S3 failure path) | `FAIL: omp exited 127; see …/omp.err` | 1 | 2026-10-18 |
| Shutdown abort, reviewer harness `/tmp/p3rev/expC.ts` (`/capture`, then a scratch `/bye` calling `ctx.shutdown()`) | before the fix: `rev 1 state raw last_error null`; after: `rev 2 state raw last_error {"class":"aborted",…}` | 0 | 2026-10-18 |
| Regressions (final): Phase 1 main check without `--state`, read-only store, install, and Phase 2 streaming smoke | `Captured 4307.` / `OK … state=needs_context`; read-only store prints only `Capture failed: EACCES…` and `ls` is empty; install `Captured 8649.`; `OK partial=1 main=completed injected=0 stale=0` | 0 | 2026-10-18 |
| **Manual check A01:** fresh cold `reviewer` given only `/tmp/a01-ready-record-v2.json`, from the final prompt | **PASS** on all five criteria. The situation attributes every s2 point to the agent ("The agent said…"); no advice is present. Minor note: the question's "how does an idempotency key prevent the duplicate side effect?" is slightly less neutral than s1's "what does an idempotency key do?" | — | 2026-10-18 |

### Review

**Code review (cold `reviewer`):** 0 critical, 3 warnings, 4 suggestions.
- **W1:** a session shutdown aborted the job but never recorded `last_error`. Fixed: the shutdown handler now awaits the aborted jobs. Verified before and after the fix (table above).
- **W2:** a stale job's failure could overwrite newer state. Fixed: `applyFailure` takes `inputRevision`, with a test. The cross-instance retry race this leaves is carried to task 4.5.
- **W3:** the Phase 1 check's `--state raw` no longer holds. Handled as a plan amendment.
- **Suggestions:** S1 (reject a nonpositive timeout), S2 (record the model that actually answered) and S3 (the smoke fails loudly) were applied. S4 (`--last-error` added to a Phase 1 file) is recorded as a deviation.

**First A01 review, before the prompt change:** PASS with slips. `relevance` stated s2's claims without attribution and generalised ("any queue-based worker"), and the question took over s2's framing ("safe"). This led to the prompt-rule tightening in plan 3.5's as-built note. The re-run is in the table above.

### Gotchas, Insights, and Deviations

- **Deviation (Phase 1 file):** `scripts/assert-record.ts` gained `--last-error CLASS|none` and prints `last_error=<class>` when one is set; task 3.6 needs it.
- **Deviation (3.5):** the job map stores `{controller, done}` rather than `{sessionId, controller}`.
- **Deviation (store API):** `publishNew` was renamed to `publishRecord`, since it also replaces records under `updateGuarded`. `updateGuarded` also refuses any change to the evidence fields (AD1) and any revision other than `+1`.
- **Gotcha:** since Phase 3, print mode waits for extraction, so every print-mode `/capture` makes a real model call and finishes `needs_context` or `ready`. Use `OMP_CAPTURE_TIMEOUT_MS=1` to get a `raw` record without spending a call.
- **Gotcha:** `RpcClient.stop()` sends SIGTERM, and OMP exits in about 16 ms without running `session_shutdown`. A job killed that way leaves `raw` with no `last_error`, the same as an extraction still in progress. This is OMP behaviour and outside the extension's control; the README limitations should mention it (task 5.3).
- **Insight:** with OAuth, Anthropic receives `tools: []` and `tool_choice: {type: "none"}`. The extraction call offers no tools in practice, not only in the code.
- **Insight:** the reconstructed baseline for this phase had to be repaired: the red run had copied the new `smoke-extract.sh` and `assert-record.ts` into the baseline snapshot. In future, copy red-run scripts into a scratch copy, never into the baseline.

## Phase 4: Management commands and recovery

**Beads phase issue:** `kbx-miga-tc2.4`
**Class:** standard. **Source revision:** `c4c60cf` plus uncommitted Phases 1–4; verification ran against the working tree.
**Phase-local delta:** compared with the Phase 3 end state (`/tmp/kbx-miga-phase4-baseline`, temporary): 6 new files (`extension/viewer.ts`, `src/render.ts`, `scripts/smoke-sessions.sh`, `scripts/smoke-retry.sh`, `test/render.test.ts`, `test/fixtures/record-v1-ready.md`) and 4 modified (`extension/index.ts`, `src/store.ts`, `src/record.ts`, `test/store.test.ts`).

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| Red: `bun test test/store.test.ts`, with the Phase 4 tests written before any implementation | failed at import (`applyNote`/`listRecords`/`resolveId` missing), `0 pass, 1 fail`, as predicted | 1 | 2026-10-18 |
| Green: `bun test test/store.test.ts` (final) | `14 pass, 0 fail, 42 expect() calls`. Includes A11 (a note discards a stale proposal), A12 (an ambiguous prefix is rejected), A13 (a lock held by a killed process is released and the next writer gets it in under 1 s; a temp file left by a killed writer is ignored, the old record stays intact and the next writer still publishes), and A16 (editing or deleting an export leaves the record unchanged) | 0 | 2026-10-18 |
| `OMP_CAPTURE_DIR=/tmp/omp-capture-smoke omp --no-session --no-extensions --trusted-extension … -p "/capture-list"` (final) | `43073A56  2026-10-19 09:50  kbx-miga  needs_context  why the worker ran twice`, exit=0; no model call | 0 | 2026-10-18 |
| Print-mode show, note, export, and argument errors (final) | show rendered the full record; `Noted 4307 (revision 3)`; `Exported 4307 to …/exports/43073A56-r3.json`, which is byte-identical (`cmp`) to the record; bad arguments got usage lines for list, show, retry and export | 0 | 2026-10-18 |
| `--mode json -p "/capture-list"` (review W1) | before the fix: no output; after: the row on stderr | 0 | 2026-10-18 |
| Green: `scripts/smoke-sessions.sh && scripts/smoke-retry.sh` (final; real model calls) | `session a 01a154e7-2d10-… -> ed07a490` / `session b 01a154e7-40d8-… -> 5343d3c1` / `OK sessions=2 records=2 distinct=2`; `OK retry id=4b4dd0ef packet=unchanged input_revision=2 revision=3` | 0 / 0 | 2026-10-18 |
| `jq` leak check, old and new form, against a record whose earlier segment contains a leak (review W4) | new form: `leak detected`; old form: `leak missed` | — | 2026-10-18 |
| Green: `bun test && bun run typecheck && scripts/check-invariants.sh` (final) | `72 pass, 0 fail, 178 expect() calls` across 6 files; `tsc` printed nothing; invariants printed nothing | 0 / 0 / 0 | 2026-10-18 |
| **Manual TUI check:** `/capture-show 43073a` in a real `omp` TUI (proc pty); then `/tmp/omp-tui4-drive.py` (python pty that sends a real ESC byte, then `/capture-list`) and its control without the ESC (final) | The overlay rendered the full record with `↑↓ PgUp PgDn scroll · Esc close · lines 1–34 of 35`, and `q` closed it. Driver: `overlay_opened=True esc_closed_then_list_opened=True transcript_messages=0`; control: `esc_closed_then_list_opened=False` | 0 | 2026-10-18 |
| Regressions (final): `smoke-extract.sh`, `smoke-streaming.ts`, read-only store, install | `state=ready` / `payload tools=none` / `needs_context` / `raw last_error=aborted`; `OK partial=1 main=completed injected=0 stale=0`; read-only store prints only `Capture failed: EACCES…` and `ls` is empty; install `Captured 8480.` | 0 | 2026-10-18 |

### Review (cold `reviewer`)

0 critical, 4 warnings, 5 suggestions. All were fixed and re-verified in the final run above:
- **W1:** json mode printed nothing. Fixed by routing output to stderr when there is no UI.
- **W2:** model-written text could forge an Evidence section. Fixed: model text is now one escaped line, with a test.
- **W3:** saved text was parsed as Markdown, for example `__init__` showed as bold. Fixed with verbatim fenced blocks; the fixture was regenerated and reviewed.
- **W4:** the retry smoke's leak check only tested the last segment. Fixed with `[…] | any`, shown above to detect a leak in an earlier segment.
- **S1:** list rows use the safe fence.
- **S2 and S3:** commands parse arguments strictly.
- **S4:** the export names its file from the bytes it actually read.
- **S5:** the second A13 test now also proves the next writer still publishes.

### Gotchas, Insights, and Deviations

- **Decision (4.5):** the default was taken because the user said "proceed": accept the cross-instance retry race and document it. It is recorded under Resolved Questions and in plan 5.3.
- **Deviation (API shape):**
  - `resolveId(records, prefix)` takes a listing.
  - `listRecords` returns invalid file names.
  - `exportRecord(dir, id, format, render)` lives in `src/store.ts` so it can be tested.
  - `applyNote` is in `src/record.ts`.
  - The pager is in a new file, `extension/viewer.ts`.
- **Gotcha (harness):** in this session the omp `proc://` pty writer turned a newline inside a write into an editor newline rather than a submit. It did not provably deliver an ESC byte, and its screen capture lags one input. Drive TUI key checks with a python pty instead (`/tmp/omp-tui4-drive.py`) and keep a negative control.
- **Gotcha (OMP):** a `--session-dir` run that only executes a slash command writes no session file (`origin.session_file` points to a path that does not exist yet). The two-session smoke seeds each session with one prompt first.
- **Insight:** `getMarkdownTheme` and `Markdown` are re-exported from the `@oh-my-pi/pi-coding-agent` root, and `matchesKey` comes from the `@oh-my-pi/pi-tui` root. Both are inside the invariant import allowlist.

## Phase 5: Full-workflow scenario validation

**Beads phase issue:** `kbx-miga-tc2.5`
**Class:** standard. **Source revision:** `c4c60cf` plus uncommitted Phases 1–5; verification ran against the working tree.
**Phase-local delta:** compared with the Phase 4 end state (`/tmp/kbx-miga-phase5-baseline`, temporary):
- New: `README.md`, `scripts/scenarios.sh`, `scripts/seed-scenario.ts`, `test/scenarios/a0{1,2,5,8}.json`.
- Modified: `src/extract.ts` (prompt hard-limit sentence, `PROMPT_VERSION` 2), `test/extract.test.ts`, `scripts/smoke-sessions.sh` (W2), `.gitignore` (`.scenarios/`).

### Scenario Results

| Scenario | Result | Evidence | Date |
|---|---|---|---|
| A01 | PASS | Cold review `ReviewA01b` of record C31C3453 (ready, prompt v2, neutral seed): the topic and question are supported by s1 and s2; the diagnosis and fix are attributed to the agent ("The agent attributed it to… and suggested…"); there is no lesson or advice. Minor note: "to prevent that" leans slightly toward the agent's framing | 2026-10-18 |
| A02 | PASS | Cold review `ReviewA02b`. Clear case, record 6D84AFAF: ready, with the single subject Postgres VACUUM and bloat (s1, s2). Ambiguous case, record 9AD6C1B7: needs_context; all interpretation fields are null; `missing_context` names flexbox (s1), VACUUM (s3) and Bloom filters (s5); the harness advisory note (s7) is neither cited nor obeyed; no purpose is invented | 2026-10-18 |
| A05 | PASS | Cold review `ReviewA05b` of record BA50D968: the hypothesis is hedged and attributed to the agent in every field ("The agent guessed…", "explicitly unverified hypothesis"), and the question is the user's. The user-role message with agent attribution is covered by the unit test "agent-originated content keeps agent authorship and original roles (A05)" | 2026-10-18 |
| A08 | PASS | Cold review `ReviewA08b`. Truncated case, record 0DAB9604: s3 is a bash `tool_result`, truncated, with 2 segments (4097 + [5700 omitted] + 4096 = 13893); the view shows the exact omission marker; `needs_context` is justified. Compaction case, record 77D8799C: s1 is `compaction_summary` by the agent, the boundary is `compaction`, and the interpretation says "per the compaction summary" and "not verbatim". Minor note: the situation attributes to the summary some facts that are actually in s2–s4 | 2026-10-18 |
| A03 | PASS | `scenarios.sh` (final): bare `/capture` receipted (`Captured 171A.`), `OK 171a29b9-… state=needs_context parts=0`, and the render unit test "interpretation is labelled pending…" | 2026-10-18 |
| A04 | PASS | Unit test "earlier anchored subject is retained with its predecessor (A04)" | 2026-10-18 |
| A06 | PASS | 3 unit tests (pre-clear entries, abandoned sibling branch, a /clear after compaction), plus `smoke-sessions.sh`: `OK sessions=2 records=2 distinct=2 isolated=2`, each packet holding its own seeded word and not the other's | 2026-10-18 |
| A07 | PASS | `smoke-streaming.ts`: `OK partial=1 main=completed injected=0 stale=0` | 2026-10-18 |
| A09 | PASS | 18 unit tests (validateProposal rejections; a failure keeps state) plus the live run `OK … state=raw parts=0 last_error=aborted` | 2026-10-18 |
| A10 | PASS | `smoke-retry.sh`: `OK retry id=22732ca5 packet=unchanged input_revision=2 revision=3`; the later turn did not leak into the packet | 2026-10-18 |
| A11 | PASS | Unit test "note during in-flight extraction makes the stale proposal discard (A11)" | 2026-10-18 |
| A12 | PASS | Unit test "ambiguous prefix rejected (A12)" plus `smoke-sessions.sh` (distinct ids, each with its own session identity) | 2026-10-18 |
| A13 | PASS | 2 unit tests: a SIGKILLed lock holder's lock is released and the next writer gets it in under 1 s; a kill between temp write and rename leaves the old record intact and the temp unlisted | 2026-10-18 |
| A14 | PASS | 2 unit tests (path with spaces and Unicode; unwritable store) plus the live check: only `Capture failed: EACCES…` is printed and nothing is written | 2026-10-18 |
| A15 | PASS | 18 unit tests: invented ids, tool calls, and `length`/`aborted`/`error` replies rejected | 2026-10-18 |
| A16 | PASS | Provider unreachable (`models.yml` pointing at `127.0.0.1:9`): list, show and export succeed and retry prints `failed (aborted)`. Unit test: editing or deleting an export leaves the record unchanged | 2026-10-18 |

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| Red: `scripts/scenarios.sh`, first run | A01/A02/A05 printed `REVIEW … verdict=missing`; A08 printed `FAIL check failed: truncated:state=raw last_error=invalid_output compaction:seed(… Nothing to compact (session too small))`. These became beads `kbx-miga-tc2.7` and `.8` | 1 | 2026-10-18 |
| Red: `SCENARIOS_FRESH=1 scripts/scenarios.sh` after the fixes and the W3 reseed | every mechanical check passed; the 4 semantic scenarios printed `verdict=missing` | 1 | 2026-10-18 |
| Verdict-gate probe | the A01 row with the correct id gives `verdict=PASS`; the same row checked against `DEADBEEF` gives `verdict=missing` | — | 2026-10-18 |
| Empty-spec probe (`semantic A99`) | `A99 FAIL no cases in test/scenarios/a99.json`, failed=1 | — | 2026-10-18 |
| Unreachable-provider probe (A16 construction) | list, show and export exit 0; retry printed `Retry 4307 failed (aborted)`; `last_error` `aborted` | 0 | 2026-10-18 |
| Green: `bun test && bun run typecheck && scripts/check-invariants.sh && scripts/scenarios.sh` (final) | `72 pass, 0 fail, 178 expect() calls`; `tsc` and invariants printed nothing; 16 scenario lines, 12 `PASS` and 4 `REVIEW … verdict=PASS` (output quoted in the Scenario Results table above) | 0 / 0 / 0 / 0 | 2026-10-18 |

### Review

**Code review (cold `reviewer`):** 0 critical, 3 warnings, 7 suggestions.
- **W1:** the README claimed `token=` secrets are redacted, but only keyword secrets joined by `-` or `_` are. Fixed: the README is reworded and lists the gap as a limitation; follow-up bead `kbx-miga-tc2.9`.
- **W2:** the A06 isolation check could not fail. Fixed: the two sessions are seeded with different words and each packet is checked both ways.
- **W3:** the seeds ran inside the repo with all tools enabled. Fixed: they run in a neutral temp directory with declared tools, and all records were reseeded and re-reviewed.
- **Suggestions applied:**
  - S1: an empty spec FAILs.
  - S2: a stale reused record is reseeded, and a failed seed cleans up.
  - S3: A16 requires `failed (aborted)`.
  - S4: A03 checks the receipt and the render label.
  - S5–S7: README wording corrected, plus an install check with no side effects.

**Semantic reviews (5.2):** two rounds, each with four fresh cold reviewers who saw only the record files. All passed in both rounds. The verdicts above are from round 2, on the neutral-seed records.

### Gotchas, Insights, and Deviations

- **Gotcha (OMP):** in print mode, `/compact` does not compact; it was answered as a prompt. Use `RpcClient.compact()`. Manual compaction also needs more than `compaction.keepRecentTokens` (default 20 K) of history; a `--config` overlay lowers it for seeding only.
- **Gotcha (OMP):** OMP will not start without a resolvable model and credentials, so "works without a model" means "works with the provider unreachable". A dead provider fails as `aborted` after the deadline, not as `provider_error`, because OMP keeps retrying the connection. This is in the README.
- **Gotcha:** seeded episodes must run outside the repo. With a repo cwd and all tools, the agent explored the repo and the packet captured it (review W3).
- **Deviation (5.1):** A08 is also a `REVIEW` scenario, as task 5.2 requires; 5.1 had listed only A01, A02 and A05.
- **Deviation:** `smoke-sessions.sh` (a Phase 4 file) changed for review W2.
- **Insight:** the two semantic rounds agreed even though the seeds changed, and every reviewer's notes were minor framing points. The interpretation quality is stable enough for the pilot to judge.

## Phase 6: Personal pilot

**Beads phase issue:** `kbx-miga-tc2.6`
**Class:** standard (6.1 adds an executable script). **Source revision:** `9eeee5c` (Phases 1–5, committed at the start of this phase) plus the uncommitted Phase 6 files `scripts/pilot-report.ts` and `docs/pilot/assessment.md`.

### Harness drift re-verification (omp 18.12.1 → 18.12.2)

The installed binary moved to `omp/18.12.2` after Phases 1–5 were verified on 18.12.1, so the full gate set ran again before the pilot. Every gate passed. `scenarios.sh` reused the reviewed semantic records C31C3453, 6D84AFAF, 9AD6C1B7, BA50D968, 0DAB9604 and 77D8799C, which are the ones cold-reviewed in Phase 5. Nothing was reseeded and no new reviews were needed. **The pilot proceeds on 18.12.2.** The dev dependencies stay pinned at 18.12.1; typecheck against those types passed, and the runtime checks ran in the 18.12.2 binary.

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| `bun test && bun run typecheck && scripts/check-invariants.sh && scripts/scenarios.sh` on `omp/18.12.2`, tree `9eeee5c` | `72 pass, 0 fail, 178 expect() calls`; `tsc` and the invariants printed nothing; 16 scenario lines: 12 `PASS` (A03 `Captured 0791.` needs_context; A07 `OK partial=1 main=completed injected=0 stale=0`; A09 live `last_error=aborted`; A10 `packet=unchanged input_revision=2 revision=3`; A14 `EACCES … nothing written`; A16 `retry failed as expected`) and 4 `REVIEW … verdict=PASS`. Wall time 104 s | 0 / 0 / 0 / 0 | 2026-10-19 |

### Verification Evidence

| Command/scenario | Actual output or artifact | Exit code | Date |
|---|---|---|---|
| Red: `bun scripts/pilot-report.ts --require-records 20 --require-days 3 --require-assessment docs/pilot/assessment.md` (real store `~/.omp/agent/captures`, which does not exist yet) | full report with `Records: 0` and `n/a` percentiles; `FAIL: 0 records (need 20)`, as predicted, then `FAIL: 0 distinct capture dates (need 3)`, `FAIL: 0 reviewed captures in assessment (need 10)`, `FAIL: assessment Decision section is empty`. Re-run after the review fixes gave the same result | 1 | 2026-10-19 |
| Report metrics on copies of the 6 scenario records (throwaway store; `captured_at` spread over 3 days) | `ready 4`, `needs_context 2`, 3 dates × 2, `Packet bytes: p50 946 B · p90 8342 B · max 8342 B`, `Freeze latency … p50 1 ms · p90 1 ms`, `Empty request_text: 0` | 0 | 2026-10-19 |
| Error-class breakdown (throwaway copies set to raw with `aborted`×2, `invalid_output`×1, and 1 with no error) | `Extraction failures …: 3 (50.0%)`, `aborted 2 (33.3%)`, `invalid_output 1 (16.7%)`, `raw, no error 1` | 0 | 2026-10-19 |
| Assessment gate matrix (throwaway store of 12 captures; filled copies of the template) | valid 10 rows → exit 0; the same file with CRLF → 0; backticked, dashed and escaped-pipe rows → 0; numbered `## 3. Decision` heading → 0. Failing cases: one id ×10 → `reviewed captures 1 (9 rows not counted)`, exit 1; `?` cells + `TBD` → 0 counted, exit 1; ids not in store → `No capture matches DEADBE00`, exit 1; untouched template → exit 1; template with unclosed comment → `decision written no`, exit 1 | — | 2026-10-19 |
| `bun run typecheck` after the fixes | no output | 0 | 2026-10-19 |

Green needs 6.3 (the user's ≥ 20 real captures over ≥ 3 days and ≥ 10 reviewed rows). Until then the phase stays open.

### Review (cold `reviewer`, phase-local delta: `scripts/pilot-report.ts`, `docs/pilot/assessment.md`)

0 critical, 3 warnings, 2 suggestions. Every metric was confirmed against the schema. All five findings were in the assessment parser; all were fixed and re-run in the gate matrix above.
- **W1:** CRLF files failed even when correctly filled, because `.` does not match `\r` in the heading regex. Fixed: lines are split on `\r?\n`.
- **W2:** the gate could pass falsely: one id repeated 10 times, or `?` placeholders, counted as 10 reviewed rows. Fixed: rows resolve through `resolveId` against the loaded store, each capture counts once, and judgement cells must be `y`, `n` or `partial`. The template states these rules.
- **W3:** backticked ids, escaped `\|` and dashed ids were rejected with no reason given. Fixed: all three are accepted, and every row not counted is listed with its reason.
- **S4:** an unclosed `<!--` counted as a written Decision. Fixed: an unclosed comment is stripped to the end of the file.
- **S5:** `## 3. Decision` was not found. Fixed: headings match by substring.

### Gotchas, Insights, and Deviations

- **Deviation:** Phases 1–5 were committed as one commit (`9eeee5c`) at the start of this phase, at the user's request. They could not be split by phase after the fact.
- **Insight:** the plan's gate said "≥ 10 reviewed rows" and did not define a reviewed row. The review showed that a format-only check passes a gate made of placeholders. The as-built definition is now in plan task 6.1.

## Resolved Questions

| Date | Question | Answer | Plan amended? |
|---|---|---|---|
| 2026-10-18 | Management surface: OMP slash commands or standalone CLI? | User: use defaults → OMP slash commands | AD4 |
| 2026-10-18 | Extraction model | User: use defaults → invoking session's `ctx.model` | AD2, Defaults table |
| 2026-10-18 | Store location and install | User: use defaults → `~/.omp/agent/captures/` (`OMP_CAPTURE_DIR` override); symlink into `~/.omp/agent/extensions/capture` | Defaults table, task 1.9 |
| 2026-10-18 | Cross-instance retry racing a failure (carried from the Phase 3 review into 4.5) | Default taken (user: "proceed with phase 4"): accept the race; stale proposals and failures are discarded; document it in the README limitations | Plan 4.5, 5.3 |

## Running Notes

### 2026-10-18
- Planning-only session; no product code written. The scratch dirs `/tmp/omp-capture-probe` and `/tmp/omp-capture-toolchain` were removed. `/tmp/omp-src-18.12.1` is kept as the source reference for execution and may be re-cloned from tag `v18.12.1` if it is gone.
- Overengineering review (`review-plan`, cold subagent) applied: 8 cuts, 2 kept — see the plan's Review Log. Schema v1 is now smaller (no `redactions`, `coverage.budgets`, `origin.project_label`, `origin.session_name`); task 2.3 reuses `redactMemorySecrets`, 2.6 uses `RpcClient`, 3.2/3.3 drop the injectable model call in favour of a pure `validateProposal`. Task numbering unchanged; no work had started.

### 2026-10-19 — pilot start
- `/capture-list` run from `/tmp` with no flags printed `No captures in /Users/kbouw/.omp/agent/captures.` (exit 0), so the symlink install loads globally. The real store still does not exist; listing does not create it.
- OMP loads extensions only at session start. The four OMP sessions running at handoff were compared against the last extension code change (19 Oct 13:45, `src/extract.ts`). Three predate it and must be restarted before the pilot, so that stale code doesn't write pilot records: pid 10930 has no extension; 26262 has the Phase 1 code, without fixes .7/.8; 61234 predates today's changes. Pid 88706, started 13:50, runs current code. The README now states the restart rule.
- **Pilot rule:** keep `kbx-miga` on the pilot commit until 6.3 is done. Any change here reaches every session restarted afterwards, and mixed code versions would skew the report.
- **Review session, later:** run `bun scripts/pilot-report.ts --require-records 20 --require-days 3 --require-assessment docs/pilot/assessment.md`. Read records with `/capture-show <id>` or directly from `~/.omp/agent/captures/*.json`. Scan saved segments for plain `key=value` secrets to decide `kbx-miga-tc2.9`. The judgement columns in `docs/pilot/assessment.md` are the user's to fill. An agent may propose a draft, but must not fill in the judgements.
