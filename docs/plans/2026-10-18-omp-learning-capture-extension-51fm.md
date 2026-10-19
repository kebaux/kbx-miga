# OMP `/capture` Learning-Capture Extension

**Date:** 2026-10-18
**ID:** 51fm
**Summary:** Ship a native OMP 18.12.1 extension where `/capture <free text>` durably freezes the user's request and the active branch's evidence into one canonical JSON record, acknowledges with `Captured 7F2A.`, extracts a learning question through one tool-less explicit-context model call, and exposes list/show/note/retry/export inside OMP — then validate it in a personal pilot.
**Progress doc:** `docs/progress/2026-10-18-omp-learning-capture-extension-51fm.md`
**Beads epic:** `kbx-miga-tc2` (phases `kbx-miga-tc2.1` … `kbx-miga-tc2.6`, each depending on the previous)
<!-- planned: c4c60cf · branch: main -->

> **Executing this plan:** work one phase at a time — the `execute-plan` skill owns the loop.
> A phase is done when its verification contract runs green: run the command, read the output,
> do not infer. Status and dependencies live in Beads; verification evidence, gotchas, and
> deviations go in the progress doc.
>
> **Check this plan against git before trusting it.** The watermark above is the commit this plan
> was written against. Run `git rev-list --count c4c60cf..HEAD` and `git branch --show-current`.
> A different branch or many intervening commits means the plan may describe code that no longer
> exists — reconcile first, then execute. A plan is a claim about the repo, not evidence about it.
>
> **Check the harness too.** Every API claim below was verified against `omp/18.12.1`. Run
> `omp --version`; if it is not `omp/18.12.1`, re-verify the "Verified environment" table before Phase 1.

---

## Context and Motivation

The product input is `OMP_Capture_Implementation_Brief.md` v1.0 (decision baseline 2026-10-17; copy at `/Users/kbouw/Downloads/OMP_Capture_Implementation_Brief.md`). It is authoritative for product intent, the record contract (§8), the extraction contract (§7), and acceptance scenarios A01–A16 (§12). This plan does not restate those sections; it operationalizes them against the installed harness and records where verification refined them.

**Problem.** While coding with an agent, the user meets something worth understanding later. Continuing the task wins in the moment, and writing down a concept name loses the situation that made it matter. `/capture` must preserve the user's words plus the episode's evidence first, then infer a provisional topic and question without interrupting the main agent.

**Repository state.** Greenfield: one commit (`c4c60cf bd init`), Beads initialized, no code, no git remote.

### Verified environment (2026-10-18)

| Item | Value | How verified |
|---|---|---|
| OMP | `omp/18.12.1`, compiled binary `~/.local/bin/omp`, macOS arm64 (darwin 27.0.0) | `omp --version` |
| Source at installed tag | `github.com/can1357/oh-my-pi` tag `v18.12.1`, commit `291e055` (cloned to `/tmp/omp-src-18.12.1`) | `git clone --branch v18.12.1` |
| Bun | 1.3.14 | `bun --version` |
| Dev typings | `@oh-my-pi/pi-coding-agent`, `pi-ai`, `pi-utils` all `18.12.1` on npm; `typescript@7.0.2`, `@types/bun@1.4.3` | trial `bun add -d -E …` exit 0; `tsc -p .` on a probe using every API below → exit 0 |
| Configured model | `modelRoles.default: anthropic/claude-opus-5-5:medium`; Anthropic and Codex both routed via headroom proxy `http://127.0.0.1:8787` (`models.yml` baseUrl); OAuth credentials | read `~/.omp/agent/config.yml`, `models.yml` (no secrets read) |
| Session corpus | 734 sessions; file bytes p50 2.2 MB, p90 9.9 MB, max 40 MB; message text p90 ≈ 1.4 K (user), 2.2 K (assistant), 20 K (tool result), max 51 K | `find … -exec stat` percentiles; `jq` over 6 sessions |

### Capability findings that shape this plan

Runtime-verified (throwaway probe extension loaded with `omp --no-session -e probe.ts -p "/probecap  hello  wörld :)"`, exit 0):
- A user `.ts` extension imports `completeSimple` from `@oh-my-pi/pi-ai` and `withFileLock`/`getAgentDir` from `@oh-my-pi/pi-utils` inside the compiled binary; `withFileLock` acquired.
- An extension command runs in print mode **without a model call**; `ctx.mode === "print"`, `ctx.agent.kind === "main"`, `ctx.model` = `anthropic/claude-opus-5-5`, `ctx.modelRegistry.resolver` and `ctx.ui.custom`/`ctx.ui.editor` are functions.
- Args are split at the first space: `"/probecap  hello  wörld :)"` → `" hello  wörld :)"` (inner/leading whitespace after the separator and Unicode preserved).
- `withFileLock` from npm `pi-utils@18.12.1` also works under plain `bun` outside OMP, so lock tests can run under `bun test`.

Verified by reading the 18.12.1 source (paths relative to `packages/coding-agent/src/` unless noted):
- Extension commands dispatch before streaming/steer logic and never enter the conversation (`session/agent-session.ts:7574-7580`; TUI `modes/controllers/input-controller.ts:1208-1228`). During compaction the command is queued and runs after (`input-controller.ts:1196-1206`).
- With a child transcript focused, OMP refuses `/capture` before it reaches the extension (`input-controller.ts:1442-1460`) — the brief's routing concern is closed by the harness; `/capture` always sees the main session.
- TUI submit trims the whole input and (by default) expands emoticons before dispatch (`packages/tui/src/components/editor.ts:3531-3540`; `input-controller.ts:961-963`). `request_text` is therefore defined as **the argument string the handler receives**.
- `ctx.sessionManager.getBranch()` returns a copied root→leaf path of all entry types (`session/session-manager.ts:3748`, copy at `:648-654`). It **does not** apply `/clear`: `reset_boundary` entries remain on the path; exclusion lives in `session/session-context.ts:355, 479-600`.
- The in-flight assistant reply is **not** in `getBranch()`; it is persisted only at `message_end` (`session-manager.ts:866-889`). `message_update` events carry `{message, assistantMessageEvent}` with a live, uncloned message (`extensibility/extensions/lifecycle-mirror.ts:138-139`).
- `/new`, resume and fork reuse the same `SessionManager` and only emit `session_switch` (`agent-session.ts:10249-10256`): identity and branch must be copied synchronously before any `await`.
- Command handlers get **no abort signal and no timeout**; a rejected detached promise is process-fatal (`docs/extensions.md:398-419`). Module state is shared across the main session and subagent bindings (`docs/extensions.md:67`).
- `ctx.ui.notify(msg, "info")` renders a dim, non-persisted line; `"error"` stops the working animation mid-stream (`modes/interactive-mode.ts:7637-7646`). In print mode notify is a no-op.
- `completeSimple(model, context, options)` (`packages/ai/src/stream.ts:1509`) with `apiKey: ctx.modelRegistry.resolver(model, sessionId)` (`config/model-registry.ts:3358`) reuses stored OAuth/API-key credentials with refresh, plus `models.yml` baseUrl/headers. OMP's own `/annotate` uses this exact pattern (`extensibility/custom-commands/bundled/annotate/text-summary.ts:10-37`). Direct calls bypass the settings-aware wrapper (settings timeouts, `before_provider_request` hooks), so the extension sets its own deadline.
- With no `context.tools`, Anthropic sends `tools: []` under OAuth (`packages/ai/src/providers/anthropic.ts:5290-5312`) and Codex omits tools (`openai-codex-responses.ts:1597-1605`); only `cursor-agent` forces native tools. `toolChoice: "none"` is accepted by `SimpleStreamOptions` (typecheck verified).
- `withFileLock(path, fn)` takes an OS lock on `${path}.lock`, released on process exit (`packages/utils/src/file-lock.ts:31-88`).
- `--trusted-extension <abs path>` loads one extension and makes load failure fatal (`main.ts:2354-2377`) — the safe smoke-test harness (no fall-through to a model prompt). `--session-dir`, `--continue`, `--no-extensions`, `--mode rpc` exist (`omp --help`).
- Symlinked extension directories under `~/.omp/agent/extensions/` are discovered (`discovery/helpers.ts:783`, `discoverLinkedExtensionModuleFiles`).
- `attribution: "user"` is set on typed prompts (observed in a real session) **and** is the default for extension `sendUserMessage` (`agent-session.ts:8711`): it means "OMP attributes this to the user", not proven human authorship.
- `redactSensitiveCredentials` in `pi-ai` is not root-exported and is inert unless credential redaction is switched on (`packages/ai/src/providers/transform-messages.ts:644-670`). `redactMemorySecrets` from `@oh-my-pi/pi-coding-agent/memory-backend/redact` (`memory-backend/redact.ts:11-145`) covers AWS, GitHub, Slack, npm, keyword-prefixed secrets (incl. `sk-`/`token=`) and JWTs, and **resolves inside the compiled binary** (probe 2026-10-18: `key [REDACTED] and token=[REDACTED] and Bearer abcdef…`, exit 0). It does not cover `Bearer` tokens or PEM blocks.

---

## Scope Boundary

### What We're Doing
- One extension package in this repo, installed by symlink, registering `/capture` and five management commands.
- Deterministic capture: freeze identity + post-boundary active-branch evidence + optional in-flight reply, publish a `raw` schema-v1 record atomically, then show the receipt.
- One bounded explicit-context extraction per attempt, validated before publication.
- Management in OMP: list, show, note, retry, export; cross-process mutation guard with revision checks.
- Scenario validation of A01–A16 on the installed harness; README setup guide; personal pilot support.

### What We're NOT Doing
- Codex, Claude Code, upstream Pi, MCP adapters, or any harness abstraction — brief §2: OMP only until the pilot validates the experience.
- A standalone CLI for management — chosen surface is OMP-native (see Architecture Decisions); a second surface would need its own locking and could not retry without OMP credentials.
- `runEphemeralTurn` or any second extraction path — it sends live session context, breaking the frozen-input boundary (`agent-session.ts:11481-11655`).
- Writing capture data into the OMP session (`appendEntry`, custom messages) — the store is canonical; session annotations are deferred.
- Historical/global session search, embeddings, topic grouping, indexing, dedup by topic — pilot scans a small directory.
- Learning content, quizzes, reminders, spaced repetition, notifications — capture is separated from learning.
- Automatic replay of pending extractions at startup — retry is explicit (brief D07).
- Reading repository files to enrich evidence — a path in the packet is a locator only (brief §6).
- Directory fsync / power-loss guarantees — the promise covers completed, reopenable writes and process interruption (brief §9).

---

## Architecture Decisions

### AD1 — Canonical record contract: one schema-v1 JSON file per capture
**Choice:** `<store>/<uuid>.json`, one file per encounter, authoritative for request, origin, packet, extraction, note, and status. Evidence (`request_text`, `origin`, `source_packet`) is immutable after first publish; interpretation lives only under `extraction`. Source parts store text as **segments** (`[{start, text}]`) so a truncated part can never be read as one continuous quote. Markdown is rendered on demand. The exact shape is the brief's §8 table plus the refinements in Phase 1 task 1.3.
**Alternatives considered:** SQLite store (brief D05 rejects a second persistence system before value is shown); OMP session custom entries (not durable-acknowledged, `appendEntry` returns `void`); a flat `text` field per part (brief example) — loses truncation honesty.
**Rationale:** independently inspectable, movable, recoverable records; listing is a directory scan; evidence/interpretation separation is structural, not conventional.
**Reversibility:** one-way.
**Cost of being wrong:** every pilot record (target 20–30) carries schema v1; a field change after Phase 1 requires a reader that accepts v1 plus a migration script and re-validation of all records, and every renderer/validator test fixture changes. `schema_version` exists so this is a migration, not data loss.
**Revisit trigger:** the pilot shows a consumer (learning session) needs fields v1 cannot derive, or segment granularity proves unreadable.

### AD2 — Extraction: one `completeSimple` call over saved context only
**Choice:** `completeSimple(model, {systemPrompt, messages:[one user message built only from the saved record]}, {apiKey: ctx.modelRegistry.resolver(model, sessionId), disableReasoning: true, toolChoice: "none", maxTokens: 2000, signal})`, no `tools` key. Model is resolved per attempt: `ctx.model` of the invoking command (captured at dispatch for `/capture`; the then-current model for `/capture-retry`). Accept only `stopReason === "stop"` with no `toolCall` blocks.
**Alternatives considered:** `ctx.runEphemeralTurn({tools:false})` — inherits live context and session hooks; a separate provider/API key — violates D04.
**Rationale:** reproducible input boundary for retries; reuses the user's OAuth + headroom routing; matches OMP's own `/annotate` pattern.
**Reversibility:** two-way.
**Revisit trigger:** a provider in the user's config ignores `tools: []`/`toolChoice`, or headroom routing requires the settings-aware wrapper.

### AD3 — Cross-process mutation guard
**Choice:** every record mutation runs inside `withFileLock(<store>/<uuid>.json, …)` as read → check `revision === expected` → publish `revision + 1`. The lock is never held across model inference. Extraction publishes only if the record's revision still equals `extraction.input_revision`; otherwise the proposal is discarded.
**Alternatives considered:** in-memory mutex (fails across OMP instances, brief §9); `mkdir`/pid lock files (needs stale-lock recovery code the OS lock gives for free).
**Rationale:** OS-backed, auto-released on process death, already shipped in OMP and usable from tests.
**Reversibility:** two-way.
**Revisit trigger:** a non-OMP writer appears (e.g. a future CLI without `pi-utils`).

### AD4 — Management surface: OMP slash commands (user-approved default)
**Choice:** `/capture-list [n]`, `/capture-show <id>`, `/capture-note <id> <text>`, `/capture-retry <id>`, `/capture-export <id> [md|json]`. TUI output uses a `ctx.ui.custom` overlay with `Markdown` from `@oh-my-pi/pi-tui`; print mode writes to stdout. `/capture` itself takes no subcommands.
**Alternatives considered:** standalone Bun CLI (no access to OMP credentials for retry; separate lock path); hybrid CLI + OMP (two surfaces, brief asks for one).
**Rationale:** same runtime gives credentials, lock, and model resolution; non-model commands still work when the provider is down.
**Reversibility:** two-way.
**Revisit trigger:** the pilot shows the user wants to browse captures outside an OMP session.

### Defaults adopted (user-approved 2026-10-18 — "use the defaults")

| Default | Value | Change by |
|---|---|---|
| Management surface | OMP slash commands (AD4) | — |
| Extraction model | The invoking session's current model (`ctx.model`); today `anthropic/claude-opus-5-5` via headroom | Revisit if pilot latency/cost is poor; alternative is the `advisor` role (`claude-sonnet-5:medium`) |
| Store location | `~/.omp/agent/captures/` (`getAgentDir()` + `captures`), dir `0700`, files `0600` | env `OMP_CAPTURE_DIR` (resolved once per invocation) |
| Install | symlink `~/.omp/agent/extensions/capture` → this repo root (`package.json` `omp.extensions`); loads in every OMP session | remove the symlink |
| Partial reply policy | hold the latest in-flight assistant message from `message_update` and read its text at `/capture`; include it as `completeness: "partial"`. Late updates for a message that has already ended are ignored, and a reply already in the branch is never repeated (amended 2026-10-18, Phase 2) | — |
| Source budgets | per part 8 K UTF-16 chars (head 4 K + tail 4 K chars when truncated; up to about 24 KB of UTF-8); tail pass ≤ 40 parts / 64 KB; whole packet ≤ 60 parts / 96 KB of UTF-8. The in-flight reply has no separate cap and is cut like any other part (amended 2026-10-18, Phase 2: was "8 KB" per part plus a 32 KB tail-kept partial buffer) | constants in `src/record.ts`; tune from pilot packet sizes |
| Model input / output | ≤ 120 KB serialized prompt; `maxTokens: 2000` (Codex ignores maxTokens) | constants |
| Extraction deadline | 90 s via `AbortSignal.timeout`, combined with the job controller | env `OMP_CAPTURE_TIMEOUT_MS` |

Budget rationale: p90 message text is ≤ 2.2 K for user/assistant and ≈ 20 K for tool results; 8 KB keeps every p90 conversational part whole and the meaningful head/tail of large tool output; 96 KB ≈ 25 K tokens keeps one extraction cheap on Opus.

---

## Non-Functional Baseline

- **Auth model:** single local user. No new credentials: extraction uses OMP's stored credentials via `ctx.modelRegistry.resolver`. Records are as private as the session JSONL they copy from (`0600`).
- **Secrets:** never persist API keys, resolver output, or headers. Before publish, every segment passes through `redactMemorySecrets` plus two local patterns (`Bearer <token>`, PEM private-key blocks); all replacements use the marker `[REDACTED]`. `credential_pin` entries are excluded. `last_error` is ≤ 500 chars and passed through the same redaction.
- **Logging:** `pi.logger` gets capture id, state transitions, durations, and error class only — never packet text, request text, or provider payloads.

---

## Phase 1: Walking skeleton — `/capture` publishes a raw record

**Goal:** In the real OMP binary, `/capture <text>` writes exactly one valid schema-v1 `raw` record (correct identity, post-boundary branch parts, honest coverage) via atomic publish and then emits the receipt; storage failure emits no success receipt.
**Estimated effort:** M (1–2 sessions)
**Beads phase issue:** `kbx-miga-tc2.1`
**Scenarios:** A03, A06 (boundary part), A13 (pre-publication), A14

### Tasks

- [ ] **1.1 — Toolchain manifest:** create `package.json` (`"name": "omp-capture"`, `"type": "module"`, `"private": true`, `"omp": {"extensions": ["./extension/index.ts"]}`, scripts `typecheck: tsc -p .`, `test: bun test`, `check: scripts/check-invariants.sh`) and pin dev deps exactly: `@oh-my-pi/pi-coding-agent@18.12.1 @oh-my-pi/pi-ai@18.12.1 @oh-my-pi/pi-utils@18.12.1 @oh-my-pi/pi-tui@18.12.1 typescript@7.0.2 @types/bun@1.4.3` via `bun add -d -E`. No runtime dependencies. Outcome: `bun install` exit 0, `bun.lock` committed.
- [ ] **1.2 — `tsconfig.json`:** `target ESNext`, `module Preserve`, `moduleResolution bundler`, `strict`, `noEmit`, `skipLibCheck`, `types ["bun"]`, include `extension src test scripts`. Outcome: `bun run typecheck` exit 0 on an empty `extension/index.ts` factory.
- [ ] **1.3 — Record types and validator (`src/record.ts`):** export `SCHEMA_VERSION = 1`, budget constants (Defaults table), and types per brief §8 with these refinements: `origin = {harness:"omp", session_id, session_file|null, cwd, leaf_id|null}`; `timing = {publish_ms}`; `SourcePart = {id:"s<n>"|"p<n>", entry_id|null, original_role, kind, authorship:"user"|"agent"|"unknown", attribution:string|null, tool:{name, call_id, is_error}|null, completeness:"complete"|"truncated"|"partial", original_chars, segments:[{start,text}]}`; `kind ∈ {user_message, assistant_message, tool_call, tool_result, bash_execution, python_execution, custom_message, compaction_summary, branch_summary}`; `coverage = {policy, boundary:{kind:"root"|"reset_boundary"|"compaction", entry_id|null}, eligible_parts, retained_parts, omitted:[{before_part, count}], truncated_parts, excluded:{thinking, images, synthetic, other}, partial_included}`. `coverage.policy` (e.g. `tail+anchors/v1`) names the budget constants; bump its version when they change. Export `validateRecord(unknown): Record | error list` (hand-written guards; no schema library — kept in review: `bun test` and `assert-record.ts` run outside OMP, where `pi.zod` is not injected). Outcome: `test/record.test.ts` accepts `test/fixtures/record-v1-ready.json` (a complete fixture mirroring brief §8's example with segments) and rejects unknown state, missing evidence fields, and an `evidence_ids` entry absent from the packet.
  **As built (2026-10-18):** the record type is `CaptureRecord` and the result is `{ok:true, record} | {ok:false, errors}`. `timing.publish_ms` means milliseconds from command dispatch until the record is frozen. It excludes mkdir, write, fsync, and rename, because a file cannot contain its own write time. The validator also enforces these rules: `raw` ⇔ `extraction === null`; `retained_parts === parts.length`; `eligible_parts ≥ retained_parts`; `extraction.input_revision` and `user_note.updated_revision` ≤ `revision`; segment `start`s strictly increase, so lengths stay free for Phase 2 redaction; and a `truncated` part has at least 2 segments. Phase 1 writes `coverage.policy: "tail/v1"`; Phase 2.1 replaces it with `tail+anchors/v1`.
- [ ] **1.4 — Boundary + normalization (`src/snapshot.ts`, first half):** `selectEligible(branch: SessionEntry[])` replicating `session-context.ts:479-600`: last `reset_boundary` after the last `compaction` → entries after it; else last `compaction` → its summary part + entries from `firstKeptEntryId` onward; else whole path. `normalizeEntry` maps entry/message discriminants to `kind`s: text blocks only from assistant content, `toolCall` blocks → `tool_call` parts (name + JSON args), `toolResult` → `tool_result` with `{name: toolName, call_id: toolCallId, is_error}`; excludes `thinking`/`redactedThinking`/images (counted), `developer` role and `synthetic: true` user messages (counted), all non-message entry types except `compaction`/`branch_summary`/`custom_message`. Authorship: `user` role + `attribution:"user"` → `"user"`; `attribution:"agent"` → `"agent"`; absent → `"unknown"`; assistant → `"agent"`. Outcome: tests in `test/snapshot.test.ts` — "pre-clear entries are excluded", "compaction keeps summary + kept tail only", "abandoned sibling branch never appears" (A06), "thinking and images excluded and counted".
  **As built (2026-10-18):**
  - Selection:
    - If `firstKeptEntryId` is absent, the kept tail starts after `providerReplayThroughEntryId`, whatever the provider. This deliberately takes everything the transcript shows plus everything the model saw.
    - The `experimental-context-rollover` re-sent request (`session-context.ts:558-570`) is not recovered. This is an accepted gap: the feature is opt-in.
  - Normalization:
    - `custom` and `hookMessage` message roles become `custom_message`.
    - Compaction and branch summaries get authorship `agent`, because a harness model wrote them.
    - Bash and python executions get authorship `unknown`. Their text is `$ cmd\n<output>` and `code\n--- output ---\n<output>`, with `[exit N]` or `[cancelled]` added when it applies.
    - Each assistant message is split into parts in block order. Consecutive text blocks become one part, and each tool call becomes its own part.
    - `retryRecovery` assistant turns are skipped.
    - These are counted under `excluded.other`: `fileMention` and unknown roles, and non-text/image/thinking content blocks such as server-tool and fallback markers.
  - `buildPacket(branch)` builds the Phase 1 tail: newest parts first, until 40 parts or 64 KB.
  - Tests use the real `SessionManager.inMemory`.
- [ ] **1.5 — Atomic store publish (`src/store.ts`, first half):** `resolveStoreDir()` (`OMP_CAPTURE_DIR` ?? `getAgentDir()/captures`), `mkdir -p` mode `0700`; `publishNew(record)`: `validateRecord` → serialize → open `.<uuid>.<rand>.tmp` with `wx`/`0600` in the store dir → write → `handle.sync()` → close → `fs.promises.rename` onto `<uuid>.json`; on any failure unlink the temp and rethrow. Never truncate a live file. `readRecord(path)` parses + validates. Outcome: tests "published record reopens and validates", "unwritable store throws and leaves no file", "path with spaces and Unicode works" (A14).
  **As built (2026-10-18):** `resolveStoreDir()` is pure, so it can run in the synchronous freeze block. The `mkdir -p 0700` happens inside `publishNew(dir, record)`, which returns the published path.
- [ ] **1.6 — `/capture` entry (`extension/index.ts`):** in the handler, synchronously (before any `await`) copy `args`, `ctx.sessionManager.getSessionId/getSessionFile/getLeafId/getBranch()`, `ctx.cwd`, `ctx.model`, store dir; allocate `crypto.randomUUID()`; build packet with `selectEligible` + `normalizeEntry` (whole eligible branch for now, newest-first until budget, omissions recorded); `publishNew`; then receipt `Captured <first 4 hex uppercase>.` via `ctx.ui.notify(…, "info")` when `ctx.hasUI`, else `process.stderr.write(… + "\n")`. On publish failure: `ctx.ui.notify("Capture failed: <short reason>", "warning")` / stderr, and no receipt. Whole handler wrapped in try/catch (handler errors are surfaced by OMP but must not escape detached). Outcome: Phase 1 contract green.
  **As built (2026-10-18):** `ctx.model` is not copied yet, because nothing reads it before Phase 3; task 3.5 now owns copying it. The packet is built inside the synchronous block. The handler has two catches: snapshot failures and publish failures each produce `Capture failed: …`.
- [ ] **1.7 — Invariant fitness function (`scripts/check-invariants.sh`):** create exactly the script in Verification below, `chmod +x`. Outcome: exits 0 on the tree, 1 when a forbidden API is introduced.
- [ ] **1.8 — Record assertion helper (`scripts/assert-record.ts`):** `bun scripts/assert-record.ts <dir> [--count N] [--request TEXT] [--state S] [--min-parts N]` — asserts the dir holds exactly N `.json` records (default 1, ignoring dotfiles/`.lock`), validates each with `validateRecord`, checks given fields; prints `OK <id> state=<s> parts=<n>`; exits 1 with the reason otherwise.
- [ ] **1.9 — Symlink install + TUI check:** `ln -sfn "$PWD" ~/.omp/agent/extensions/capture`. Outcome: the install contract below is green and the manual TUI check passes.

### Verification

- [ ] **`rm -rf /tmp/omp-capture-smoke && OMP_CAPTURE_DIR=/tmp/omp-capture-smoke omp --no-session --trusted-extension "$PWD/extension/index.ts" -p "/capture why the worker ran twice" 2>/tmp/omp-capture-smoke.err; echo "omp exit=$?"; grep -E '^Captured [0-9A-F]{4}\.$' /tmp/omp-capture-smoke.err && bun scripts/assert-record.ts /tmp/omp-capture-smoke --request "why the worker ran twice" --state raw`** `(red instrument)`
      **Red (observed 2026-10-18)** — exact command above, then `echo "contract exit=$?"; grep -m1 '^error:' /tmp/omp-capture-smoke.err`:
      ```
      omp exit=1
      contract exit=1
      error: Trusted extension must be an existing module file: /Users/kbouw/Development/kbx-miga/extension/index.ts
      ```
      The harness engaged (omp ran, loaded the trusted path, failed fatally) and no model call was made; the absent extension is the thing under test.
      **Green:** `omp exit=0`, a `Captured XXXX.` line, then `OK <uuid> state=raw parts=<n>`; final exit 0.
      **Amended 2026-10-18 (Phase 3):** since Phase 3, print mode waits for extraction to finish. The same command now ends with `needs_context` (or `ready`), so `--state raw` fails. When re-running this check (including Phase 5's `scenarios.sh`), drop `--state raw`. Green is now `OK <uuid> state=needs_context|ready parts=<n>`. The raw-only record path is still covered by `smoke-extract.sh` run 3 (`state=raw last_error=aborted`).
- [ ] **`bun test`** — **Red (predicted):** fails to resolve `src/record.ts`/`src/snapshot.ts`/`src/store.ts` imports. **Green:** all record/snapshot/store tests pass, exit 0.
- [ ] **`rm -rf /tmp/omp-capture-ro && mkdir -p /tmp/omp-capture-ro && chmod 0500 /tmp/omp-capture-ro && OMP_CAPTURE_DIR=/tmp/omp-capture-ro/store omp --no-session --trusted-extension "$PWD/extension/index.ts" -p "/capture x" 2>&1 | grep -E 'Captured|Capture failed'; ls -A /tmp/omp-capture-ro`** (A14 unavailable storage; the exit code belongs to `ls` — the printed output is the contract) — **Red (predicted):** trusted-extension load error, no `Capture failed` line. **Green:** prints only `Capture failed: …`, no `Captured` line, and `ls` prints nothing.
- [ ] **`bun run typecheck`** — **Green:** exit 0.
- [ ] **`scripts/check-invariants.sh`** — the fitness function guarding D01/D03/D04 and the zero-runtime-dependency rule for every later phase:
      ```bash
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
      exit $fail
      ```
      **Red (predicted):** `FAIL: extension/index.ts missing`, exit 1. **Green:** no output, exit 0.
- [ ] **`rm -rf /tmp/omp-capture-inst && cd /tmp && OMP_CAPTURE_DIR=/tmp/omp-capture-inst omp --no-session -p "/capture install check" 2>&1 | grep -E '^Captured'; cd - >/dev/null`** (global symlink discovery, no `-e`) — **Red (predicted):** no `Captured` line (the prompt would go to the model; run only after 1.9). **Green:** `Captured XXXX.`
- [ ] **Manual check:** in a real TUI session in any repo, start a long agent reply, type `/capture why this approach` mid-stream: a dim `Captured XXXX.` line appears, the agent keeps streaming, and no new user message appears in the transcript.

---

## Phase 2: Faithful, bounded source packet

**Goal:** The packet follows one inspectable selection policy under the budgets, preserves kinds/attribution/tool pairing, truncates with honest segments, and includes an in-flight reply as `partial` — proven by fixtures and one live streaming run.
**Estimated effort:** M
**Beads phase issue:** `kbx-miga-tc2.2`
**Scenarios:** A04, A05, A06, A07, A08

### Tasks

- [ ] **2.1 — Selection policy `tail+anchors/v1` (`src/snapshot.ts`):** (1) tail pass: newest eligible parts backward until 40 parts or 64 KB; (2) if `request_text` is nonempty, anchor terms = lowercase tokens ≥ 4 chars minus a fixed stopword list, plus quoted substrings and path-like tokens (`/`, `.` with extension); scan older eligible parts newest→oldest; a part matching any term is retained with its immediately preceding part; stop at 60 parts or 96 KB; (3) always retain the eligible window's `compaction_summary` part if present; (4) emit retained parts in original order, ids `s1…sN`, and `coverage.omitted` as `{before_part, count}` gaps. Outcome: tests "earlier anchored subject is retained with its predecessor" (A04), "bare request uses tail only", "budgets never exceeded on the 38 MB-session shape" (synthetic fixture of 3 500 parts).
- [ ] **2.2 — Per-part truncation:** parts over 8 KB keep segments `[{start:0, text: first 4 KB}, {start: len-4 KB, text: last 4 KB}]`, `completeness: "truncated"`, `original_chars`. Outcome: test "truncated tool result keeps two segments with offsets and kind" (A08).
  **As built (2026-10-18):**
  - Units are chars, not bytes: `PART_MAX_CHARS`/`PART_HEAD_CHARS`. Segment offsets use the same unit.
  - A cut that lands inside an ASCII token run of ≤ 64 chars moves outward to the edge of that run, so a credential is never split. Otherwise a cut never splits a surrogate pair.
  - Selection measures segment sizes before redaction.
  - If both moved cuts meet (a text just over the limit with one run across both cuts), the part stays whole and `complete`, so no text is quoted twice.
  - Accepted limitation: if a secret longer than 64 chars (a JWT signature, a fine-grained `github_pat_`) is cut more than 64 chars into it, the saved edge fragment is not redacted. A fragment cut mid-token is not a usable credential. Redacting the edge of every long run would destroy hashes, base64 and paths, and could make text longer.
- [ ] **2.3 — Redaction (`src/redact.ts`):** `redact(text)` = `redactMemorySecrets` (imported from `@oh-my-pi/pi-coding-agent/memory-backend/redact`) followed by the `Bearer <token>` and PEM-block patterns, all replaced with `[REDACTED]`; applied to every segment before publish and to `last_error`. Outcome: test "AWS key, `token=sk-…`, Bearer token and PEM block are replaced; ordinary text unchanged".
  **As built (2026-10-18):**
  - Redaction runs only on the retained parts, after selection; a `[REDACTED]` replacement is never longer than what it replaces.
  - `Bearer` only matches a token of ≥ 16 chars that includes a digit, so prose such as "Bearer authentication" is left alone.
  - A PEM block cut by truncation is redacted only when the text beside the marker looks like a key body.
  - Redaction of `last_error` belongs to task 3.4; no `last_error` writer exists before Phase 3.
- [ ] **2.4 — Attribution fidelity:** fixture with a user-role message carrying `attribution:"agent"`, a `custom_message` with default attribution, and an assistant tentative diagnosis. Outcome: test asserts authorship `agent`/`agent`/`agent` and original roles preserved (A05).
- [ ] **2.5 — Partial-reply buffer (`extension/index.ts`):** inside the factory closure (not module scope), `pi.on("message_update")` copies only text blocks of `event.message` when `role === "assistant"` into a single text slot (tail-capped 32 KB); cleared on `message_end`. `/capture` copies the slot synchronously; when nonempty, append part `p1` (`entry_id: null`, `kind: "assistant_message"`, `completeness: "partial"`), `coverage.partial_included = true`. Outcome: unit test of the buffer reducer; live contract below.
  **As built (2026-10-18), after a review critical:**
  - The slot holds a reference to the latest in-flight message instead of a text copy. `message_update` payloads are immutable snapshots, so `/capture` reduces it synchronously with `partialReply`.
  - OMP queues `message_update` to extensions but sends `message_end` directly (`agent-session.ts:3461-3512`). Without a guard, a late update re-filled the slot, and a later `/capture` repeated the finished reply as a stale `p1` (reproduced 3/3).
  - Fix: assistant `message_end` records `endedAt = message.timestamp`, and updates carrying that timestamp are ignored. Only assistant `message_end` clears the slot. `buildPacket` also drops `p1` when the branch already holds an assistant message with the same timestamp.
  - There is no 32 KB cap.
- [ ] **2.6 — RPC streaming smoke (`scripts/smoke-streaming.ts`):** use OMP's `RpcClient` (`@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client`, `rpc-client.ts:323`; options `command`, `args`, `env`, `sessionDir` at `:74-105`) — no hand-written JSONL driver. Start it with `command: ["omp"]`, `sessionDir: <tmp>`, `env: {OMP_CAPTURE_DIR: <tmp>/c}`, `args: ["--no-extensions", "--trusted-extension", <abs ext>]`; `prompt("Write 500 words on idempotent job processing.")`; on the first `message_update` from `onEvent`, `prompt("/capture the idempotency part")`; via `onPromptResult` require the capture prompt to report `agentInvoked: false` and the essay prompt `status: "completed"`; then assert one record whose packet contains a `p1` partial part and that `getMessages()` contains no `/capture` user message. Confirm `--no-extensions` + `--trusted-extension` compose before relying on it. Outcome: script exits 0.
  **As built (2026-10-18):** the smoke test also runs a "count from 1 to 40" turn, waits `max(3 s, updates × 200 ms)` and runs `/capture`, then asserts `partial_included === false`. This catches the stale-`p1` race: it failed on the unfixed buffer and passes on the fix. `--no-extensions` and `--trusted-extension` work together (verified).

### Verification

- [ ] **`bun test test/snapshot.test.ts`** `(red instrument)` — **Red (observed 2026-10-18):** the whole file failed at import (`Export named 'PARTIAL_MAX_CHARS' not found`) before any case ran, because the new constants were missing. This differed from the predicted per-case failures. **Green:** all snapshot tests pass, exit 0.
- [ ] **`bun scripts/smoke-streaming.ts`** (A07 and the stale-`p1` regression; real model calls) — **Red (observed against the Phase 1 tree):** `FAIL: record … has no p1 partial part`, exit 1. Against the unfixed Phase 2 buffer: `FAIL: post-reply record … repeats the reply as p1`. **Green:** `OK partial=1 main=completed injected=0 stale=0`, exit 0.
- [ ] **`bun test && bun run typecheck && scripts/check-invariants.sh`** — **Green:** all exit 0.

---

## Phase 3: Bounded explicit-context extraction

**Goal:** After the receipt, one tool-less extraction from the saved record publishes `ready` or `needs_context`; any operational failure leaves the receipt-backed record usable with a bounded `last_error`.
**Estimated effort:** M
**Beads phase issue:** `kbx-miga-tc2.3`
**Scenarios:** A01, A02, A03, A09, A15

### Tasks

- [ ] **3.1 — Prompt builder (`src/extract.ts`):** `PROMPT_VERSION = 1`; fixed system prompt encoding brief §7 rules 1–8 and the output schema; a single user message containing JSON `{request_text, user_note, coverage, parts:[{id, kind, authorship, tool, completeness, text}]}` where truncated segments are joined with `\n[… N chars omitted …]\n`; reject (operational error) if serialized input > 120 KB. Outcome: test "prompt contains only saved-record data" (compare against record fixture; no live-session fields).
- [ ] **3.2 — Model call:** per AD2, call `completeSimple` directly (no injectable model function) with `signal = AbortSignal.any([AbortSignal.timeout(OMP_CAPTURE_TIMEOUT_MS ?? 90000), job.controller.signal])`. If env `OMP_CAPTURE_DEBUG_PAYLOAD` is set, pass `onPayload` that writes only `{tools, tool_choice}` of the provider payload to that path (verification hook for D04; no content). Outcome: function returns `AssistantMessage` or a classified operational error; the live path is proven by 3.6.
- [ ] **3.3 — Proposal validation:** pure `validateProposal(message: AssistantMessage, packet)`: require `stopReason === "stop"` and no `toolCall`/server-tool blocks; take text blocks; accept raw JSON or exactly one fenced `json` block, nothing else; exact key set `{outcome, topic, situation, trigger, question, relevance, evidence_ids, missing_context}`; string fields nullable with caps (topic 120, situation 600, trigger/question/relevance/missing_context 400); `evidence_ids` ≤ 12, each in the packet; `ready` ⇒ nonempty question, situation, evidence_ids; `needs_context` ⇒ nonempty missing_context. Outcome: tests built from `AssistantMessage` fixtures for each rejection — `error`, `aborted`, `length`, `toolUse`/toolCall block, malformed JSON, unknown key, invented evidence id (A09, A15) — and acceptance of valid `ready` and `needs_context`.
- [ ] **3.4 — Publish result (`src/store.ts` `updateGuarded`):** implement AD3; extraction sets `state`, `extraction = {input_revision, prompt_version, extracted_at, provider, model, …fields}`, clears `last_error`; operational failure writes only `last_error = {at, class, message ≤ 500, redacted via src/redact.ts}` and keeps `state`/`extraction`. Outcome: tests "failed retry of a ready record keeps prior extraction", "stale input_revision is discarded".
- [ ] **3.5 — Job lifecycle (`extension/index.ts`):** factory-closure `Map<captureId, {sessionId, controller}>`; after the receipt, start extraction detached with `.catch` that records `last_error` and logs (never rethrows); `pi.on("session_shutdown")` aborts all jobs of this binding; in `ctx.mode === "print"` the handler awaits the job (otherwise process exit kills it). No second user-facing message on success. Copy `ctx.model` inside `/capture`'s synchronous freeze block, next to `origin` (Phase 1 deferred it; AD2 requires the model "captured at dispatch"). Outcome: live contracts below.
  **As built (2026-10-18):**
  - The job map is `Map<id, {controller, done}>`. Nothing reads a `sessionId`, so it is not stored.
  - `session_shutdown` aborts every job and then awaits them; OMP bounds shutdown handlers. Each abort therefore lands as `last_error: aborted`, which a review found was not happening before the fix.
  - `json` mode waits like print mode; rpc and tui run the job detached.
  - `model` and `apiKey` (`ctx.modelRegistry.resolver(model, sessionId)`) are captured in the synchronous freeze block.
  - `extraction.provider`/`model` record what actually answered (`message.provider`/`message.model`), not what was requested.
  - A stale failure is discarded, as a stale proposal is: `applyFailure` takes `inputRevision` and returns null when the record has moved on.
  - `OMP_CAPTURE_TIMEOUT_MS` must be a positive number; anything else falls back to 90 s.
  - Prompt rules 2 and 4 now also require the question to be framed as neutrally as the user asked it, and every field to attribute agent claims instead of stating them as fact. This was added after the first A01 cold review flagged unattributed claims in `relevance`.
- [ ] **3.6 — Live extraction smoke (`scripts/smoke-extract.sh`):** `D=$(mktemp -d)`; seed: `omp --session-dir "$D/s" --no-extensions -p "In 4 sentences: why can a job worker run the same job twice after a restart, and what does an idempotency key do?"`; capture: `OMP_CAPTURE_DIR="$D/c" OMP_CAPTURE_DEBUG_PAYLOAD="$D/payload.json" omp --session-dir "$D/s" --continue --no-extensions --trusted-extension "$PWD/extension/index.ts" -p "/capture that thing about the worker doing the job twice"`; then `bun scripts/assert-record.ts "$D/c" --state ready` and assert `payload.json` has `tools` absent or `[]` and `tool_choice` absent or none-equivalent. Second run with `/capture` (bare) on a `--no-session` empty branch asserts `--state needs_context` (A02/A03). Third run with `OMP_CAPTURE_TIMEOUT_MS=1` asserts `--state raw` and a `last_error` of class `aborted` (A09). Outcome: script exits 0 and prints the record path for the A01 cold review.

### Verification

- [ ] **`bun test test/extract.test.ts`** `(red instrument)` — **Red (observed 2026-10-18):** `Cannot find module '../src/extract'`, as predicted. **Green:** all validation and prompt tests pass, exit 0.
- [ ] **`scripts/smoke-extract.sh`** (real model calls) — **Red (observed against the Phase 2 tree):** `FAIL: … state=raw, expected ready`, as predicted. **Green:** `OK … state=ready`, `payload tools=none`, `OK … state=needs_context`, `OK … state=raw … last_error=aborted`, exit 0. `scripts/assert-record.ts` gained `--last-error CLASS|none` for this check. Every `omp` run in the script fails with `FAIL: omp exited N; see …/omp.err`.
- [ ] **`bun test && bun run typecheck && scripts/check-invariants.sh`** — **Green:** all exit 0.
- [ ] **Manual check (A01 semantic):** a cold `reviewer` agent, given only the smoke's `ready` record, confirms the topic/question/situation are supported by the cited parts, the assistant's suggestion stays attributed as a suggestion, and no lesson or advice is present.

---

## Phase 4: Management commands and recovery

**Goal:** List, show, note, retry, and export work in OMP through one guarded store, with stale-inference protection, short-ID ambiguity rejection, and proven recovery after a killed process.
**Estimated effort:** M
**Beads phase issue:** `kbx-miga-tc2.4`
**Scenarios:** A10, A11, A12, A13, A16

### Tasks

- [ ] **4.1 — Listing and lookup (`src/store.ts`):** `listRecords(dir)` reads `*.json` only (skips dotfiles, `.tmp`, `.lock`), skips invalid files with a counted warning, sorts by `captured_at` desc; `resolveId(prefix)` case-insensitive hex prefix ≥ 4 chars; ambiguous → error listing the 8-char prefixes of matches; none → not-found. Outcome: tests "ambiguous prefix rejected" (A12), "temp and lock files ignored".
  **As built (2026-10-18):**
  - `listRecords(dir)` returns `{records, invalid: names[]}`; a store that does not exist yet lists as empty.
  - `resolveId(records, prefix)` takes the listing and also accepts hyphenated UUID prefixes.
- [ ] **4.2 — Renderer (`src/render.ts`):** `renderMarkdown(record)` sections in order: request (verbatim, quoted), user note (prominent), interpretation (labelled "Inferred — not verified", with "predates your note" when `extraction.input_revision < user_note.updated_revision`, "pending" when null, missing-context explanation for `needs_context`), evidence (cited parts' segments rendered as separate quotes with kind/authorship/completeness labels), coverage summary, last error. `renderListRow` = short id, local time, project label (`basename(origin.cwd)`, computed here, not stored), state, topic ?? request. Outcome: fixture diff test against `test/fixtures/record-v1-ready.md`.
  **As built (2026-10-18), after review W2/W3:**
  - Saved text (the request, the note, every evidence segment) is rendered as a fenced `text` block, not a `>` quote. The fence is longer than any backtick run in the text, so it renders verbatim: no Markdown inside it is parsed.
  - Model- and provider-written text (interpretation fields, missing context, the model name, `last_error`, tool ids) is collapsed to one line with Markdown punctuation escaped, so it cannot forge a heading, a quote or an Evidence section.
  - `fenced()` is also used for the TUI list rows.
- [ ] **4.3 — `/capture-list` and `/capture-show`:** TUI → `ctx.ui.custom(… new Markdown(…) …, {overlay: true})` closed with Esc (confirm the `Markdown` constructor signature in `pi-tui/src/components/markdown.ts:210` before use); print mode → stdout. No model call on either path. Outcome: print-mode contract below.
  **As built (2026-10-18):**
  - The TUI shows a `MarkdownPager` overlay (`extension/viewer.ts`): ↑↓ PgUp PgDn Space scroll; Esc or q closes.
  - Output routing: print → stdout; tui → overlay; rpc (has a UI) → notify; json (no UI; stdout is the event stream) → stderr. The json route was review W1: notify is a no-op in json mode.
  - Every command checks its arguments strictly and answers with a usage line otherwise.
- [ ] **4.4 — `/capture-note <id> <text>`:** guarded update sets `user_note = {text, updated_at, updated_revision: revision+1}`; does not start inference. Outcome: test "note during in-flight extraction makes the stale proposal discard" (A11).
- [ ] **4.5 — `/capture-retry <id>`:** reads the saved record only (never the live branch); `input_revision = current revision`; refuses if a job for that id is active in this binding; schedules via the Phase 3 job path. Outcome: live A10 contract.
  **Decided 2026-10-18 (default, user said "proceed"):** accept the race. Failure writes keep bumping `revision`, and stale proposals and failures are both discarded. If a retry started in another OMP instance races a failure from this one, it is discarded and the user re-runs it. Task 5.3 lists this in the README limitations.
  **As built:**
  - Retry notifies its outcome (ready / needs context / failed with class / discarded).
  - `model` and `apiKey` are the invoking session's, frozen before the first await.
- [ ] **4.6 — `/capture-export <id> [md|json]`:** writes `<store>/exports/<SHORT>-r<revision>.<ext>` (JSON = byte copy of canonical file; md = `renderMarkdown`) and notifies the path; never mutates the record. Outcome: test "editing or deleting an export leaves the record unchanged" (A16).
  **As built (2026-10-18), after review S4:** `exportRecord(dir, id, format, render)` reads the canonical file once and names the export from the revision inside those bytes, so `…-rN` always matches its content. The JSON export is a byte copy of those bytes.
- [ ] **4.7 — Killed-process recovery test:** in `test/store.test.ts`, spawn a `bun` child that takes `withFileLock` on a record and sleeps; `SIGKILL` it; parent acquires within 1 s and publishes. Second case: child killed between temp write and rename leaves the previous complete record readable and the temp ignored by listing (A13).
- [ ] **4.8 — Two-session smoke (`scripts/smoke-sessions.sh`):** two concurrent `omp --session-dir <distinct> --no-extensions --trusted-extension … -p "/capture same phrase"` runs into one `OMP_CAPTURE_DIR`; assert two records, distinct ids, each `origin.session_id` matches its session dir's session (A12).
- [ ] **4.9 — Retry-after-drift smoke (`scripts/smoke-retry.sh`):** capture in a seeded session; record `sha256` of `source_packet`; add another prompt to the same session (`--continue`); run `/capture-retry <short>`; assert same id, identical packet hash, `extraction.input_revision` = revision before retry (A10).

### Verification

- [ ] **`bun test test/store.test.ts`** `(red instrument)` — **Red (observed 2026-10-18):** the file failed at import (missing `applyNote`/`listRecords`/`resolveId` exports), `0 pass, 1 fail`. This is consistent with the prediction. **Green:** all store tests pass, exit 0.
- [ ] **`OMP_CAPTURE_DIR=/tmp/omp-capture-smoke omp --no-session --no-extensions --trusted-extension "$PWD/extension/index.ts" -p "/capture-list"; echo "exit=$?"`** (no model path: listing must work even with the provider unreachable) — **Red (predicted):** without task 4.3 the text is not a registered command and OMP sends it to the model as an ordinary prompt — do not run before 4.3. **Green:** one row per record left by the Phase 1/3 smokes, `exit=0`.
- [ ] **`scripts/smoke-sessions.sh && scripts/smoke-retry.sh`** — **Green:** both print `OK`, exit 0.
- [ ] **`bun test && bun run typecheck && scripts/check-invariants.sh`** — **Green:** all exit 0.
- [ ] **Manual check:** in the TUI, `/capture-show <id>` opens a readable overlay that closes with Esc and adds nothing to the transcript. **As run:** the pty driver `/tmp/omp-tui4-drive.py` sends a real ESC byte and then opens `/capture-list`; the list overlay appears only if Esc closed the first. The control run without Esc is negative. The omp `proc://` pty writer could not be shown to deliver ESC, and its screen capture lags by one input.

---

## Phase 5: Full-workflow scenario validation

**Goal:** Every acceptance scenario A01–A16 has a recorded result from the installed harness, material failures are fixed, and setup guidance states the store path, install, and limitations.
**Estimated effort:** S–M
**Beads phase issue:** `kbx-miga-tc2.5`

### Tasks

- [ ] **5.1 — Scenario runner (`scripts/scenarios.sh`):** runs the automated scenario commands from Phases 1–4 in sequence, printing `A<nn> PASS|FAIL <evidence>` per scenario and exiting nonzero on any FAIL. Semantic scenarios (A01, A02, A05) print the record path and `REVIEW`.
  **As built (2026-10-18):**
  - `REVIEW` scenarios are A01, A02, A05 and A08. Each line names its records' short ids and says `verdict=PASS|missing`.
  - The runner fails when a verdict is missing. It finds the scenario's row in the progress doc's Scenario Results table, and the verdict counts only if that row says `PASS` and names every current record id. So a verdict is bound to the exact records it judged (a wrong id reads as `missing`).
  - Semantic records persist in `.scenarios/` (gitignored) and are reused only if their `prompt_version` matches `PROMPT_VERSION` and they still pass their mechanical check. Otherwise they are reseeded. `SCENARIOS_FRESH=1` forces a reseed.
  - A missing or empty spec is a FAIL.
  - A03 runs its own bare capture and checks the receipt.
  - A06 also requires each concurrent session's packet to hold its own seeded word and not the other's (`smoke-sessions.sh`).
  - A16 is proven against an unreachable provider: an isolated `PI_CODING_AGENT_DIR` whose `models.yml` points `anthropic` at `127.0.0.1:9`, with a dummy key. List, show and export succeed; `/capture-retry` must print `failed (aborted)`.
- [ ] **5.2 — Semantic review:** for A01, A02, A05, A08 build one representative seeded session each (scripted prompts committed under `test/scenarios/`), capture, and have a cold `reviewer` agent compare record vs packet without the extractor's reasoning; record verdicts in the progress doc.
  **As built (2026-10-18):**
  - `scripts/seed-scenario.ts` drives the episode over `RpcClient`; print-mode `/compact` does not compact. The capture runs as a print-mode `omp --continue`.
  - Each episode runs in a fresh temp working directory outside the repo, with only the tools its case lists (`bash` for A08/truncated; `--no-tools` otherwise). Review W3 found the earlier seeds ran inside the repo with all tools, so the A01 packet held a repo `glob` listing. Every record was reseeded and re-reviewed.
  - A case's `config` is passed as a `--config` overlay. A08/compaction uses `compaction.keepRecentTokens: 200`, because the default of 20 K refuses to compact a short episode.
  - The seed specs are `test/scenarios/a0{1,2,5,8}.json`.
  - The user-role-with-agent-attribution half of A05 can't be authored from the CLI; the unit test "agent-originated content keeps agent authorship and original roles (A05)" covers it.
- [ ] **5.3 — Setup guide (`README.md`):** install/uninstall symlink, store path + `OMP_CAPTURE_DIR`, `OMP_CAPTURE_TIMEOUT_MS`, command reference, and known limitations: request text is post-editor-normalization; partial reply may lag the screen; `/capture` waits during compaction and is refused in focused child transcripts; extraction uses the session model through headroom.
  **Also list (carried from Phases 3–4):**
  - A process killed by SIGTERM (for example `RpcClient.stop()`) skips `session_shutdown`, so its in-flight extraction leaves the record `raw` with no `last_error`.
  - A retry from a second OMP instance that races a failure from this one is discarded. Re-run it.
  - Print and json `/capture` wait for the model call.
- [ ] **5.4 — Fix material failures:** each FAIL in intent, provenance, durability, or interaction flow gets a Beads bug under `kbx-miga-tc2` and is fixed before this phase closes.
  **Done (2026-10-18):**
  - `kbx-miga-tc2.7`: the A08 extraction was rejected because `missing_context` ran over the 400-character cap. The prompt now states that the caps are hard limits, and `PROMPT_VERSION` went from 1 to 2. Validation still rejects over-limit output and does not repair it.
  - `kbx-miga-tc2.8`: the compaction seed was too small. Fixed with the `--config` overlay above.
  - Follow-up `kbx-miga-tc2.9`: plain `key=value` secrets are not redacted. It is recorded as a README limitation and left for the pilot to decide; it is not a material failure of an A-scenario.

### Verification

- [ ] **`scripts/scenarios.sh`** `(red instrument)` — **Red (observed 2026-10-18):**
  - First run: A01/A02/A05 printed `REVIEW … verdict=missing`. A08 printed `FAIL check failed: truncated:state=raw last_error=invalid_output compaction:seed(…)`, which surfaced `kbx-miga-tc2.7` and `.8`. Exit 1.
  - After the fixes and the W3 reseed, every mechanical check passed and the four semantic scenarios were `verdict=missing`, exit 1. That was the expected state until their verdicts were recorded.

  **Green:** 16 lines, each `PASS` or `REVIEW` with a matching reviewer verdict `PASS` in the progress doc, exit 0.
- [ ] **`bun test && bun run typecheck && scripts/check-invariants.sh`** — **Green:** all exit 0.

---

## Phase 6: Personal pilot

**Goal:** The user has used `/capture` in real work and decided what to improve next, based on recorded evidence rather than implementation completeness.
**Estimated effort:** user-paced, several days (agent work S)
**Beads phase issue:** `kbx-miga-tc2.6`

### Tasks

- [ ] **6.1 — Pilot report (`scripts/pilot-report.ts`):** reads the default store; prints count by state, distinct local capture dates, extraction failure rate by `last_error.class`, packet bytes p50/p90/max, `timing.publish_ms` p50/p90 (dispatch → frozen record; excludes write/fsync/rename — label it "freeze latency"), records with empty `request_text`. No model calls.
- [ ] **6.2 — Assessment template (`docs/pilot/assessment.md`):** one row per reviewed capture: short id, topic matches intent (y/n), situation recognizable, question useful, evidence sufficient, capture interrupted flow, correction; plus a comparison of 3 captures against a topic-only bookmark and a generic summary; and a "Decision: next improvement" section.
- [ ] **6.3 — Collect and review:** the user captures ~20–30 encounters over ≥ 3 days, revisits a sample after a delay, and fills the assessment. Agent support only on request.

### Verification

- [ ] **`bun scripts/pilot-report.ts --require-records 20 --require-days 3 --require-assessment docs/pilot/assessment.md`** `(red instrument)` — **Red (predicted):** `FAIL: 0 records (need 20)`, exit 1. **Green:** report printed, `assessment.md` has ≥ 10 reviewed rows and a nonempty Decision section, exit 0.

---

## Development Roadmap

### Topic grouping across encounters
**Why it matters:** repeated encounters with one concept may reveal a learning priority.
**Trigger for prioritization:** pilot assessment shows ≥ 3 records whose topics the user marks as the same concept.
**Rough complexity:** S

### Learning-session consumer
**Why it matters:** the record exists to seed later learning; the brief keeps teaching separate.
**Trigger for prioritization:** pilot Decision section names re-entry into learning as the next improvement.
**Rough complexity:** M

### Additional harness adapters (Codex, Claude Code)
**Why it matters:** captures from other harnesses.
**Trigger for prioritization:** the pilot validates capture usefulness and the user requests another harness.
**Rough complexity:** L

---

## References

- Brief: `/Users/kbouw/Downloads/OMP_Capture_Implementation_Brief.md` (§7 extraction contract, §8 record contract, §12 scenarios)
- OMP source at installed tag: `github.com/can1357/oh-my-pi` `v18.12.1` (`291e055`); key files cited inline
- OMP docs at tag: `docs/extensions.md`, `docs/extension-loading.md`, `docs/slash-command-internals.md`, `docs/session.md`, `docs/rpc.md`
- Reference pattern: `packages/coding-agent/src/extensibility/custom-commands/bundled/annotate/text-summary.ts`
- Beads: epic `kbx-miga-tc2`; phases `kbx-miga-tc2.1`–`.6`

---

## Review Log

### 2026-10-18 — Overengineering review
**Mode:** cold subagent (`review-plan`; scout with no planning context), graded in the authoring session; two load-bearing claims re-verified by execution (subpath import probe in the omp binary; `RpcClient` export at `package.json:424`).
**Plan type:** Internal tool
**Findings:** 8 cut, 0 deferred, 2 kept
- **Cut:** hand-written RPC JSONL driver in 2.6 — OMP's `RpcClient` does it.
- **Cut:** custom redaction pattern set in 2.3 — reuse `redactMemorySecrets`, add only Bearer + PEM.
- **Cut:** injectable `complete` parameter in 3.2 — one caller; test the pure `validateProposal` instead.
- **Cut:** per-part `redactions` count and `[REDACTED:<kind>]` labels — nothing reads them.
- **Cut:** `coverage.budgets` — implied by the `coverage.policy` version.
- **Cut:** `origin.project_label` — derived from `origin.cwd` at render time.
- **Cut:** `origin.session_name` — not in the brief's origin contract; no reader.
- **Cut:** `startedAt` in the partial-reply slot — never persisted or read.
- **Kept:** hand-written `validateRecord`/`validateProposal` instead of `pi.zod` — tests and `assert-record.ts` run outside OMP, where `pi.zod` is not injected; two shapes.
- **Kept:** bundle-based import check in `check-invariants.sh` — verification item; allowlist widened to `@oh-my-pi/pi-coding-agent(/…)?` so 2.3's reuse passes.
