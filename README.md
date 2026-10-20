# omp-capture

An [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) extension for saving the moments in a coding session you want to understand later.

Type `/capture <what you want to revisit>` at any point, including while the agent is still replying. The extension saves your words and the evidence from the current session branch to a local JSON record. It then shows `Captured 7F2A.`. In the background, one model call proposes a topic and a learning question, using only the saved record.

Nothing is sent to the conversation. The agent is not interrupted, steered or given a new task.

Built and verified against **OMP 18.12.1** (macOS arm64, Bun 1.3.14).

## Install

The extension is a directory symlinked into OMP's extensions folder. It then loads in every OMP session started afterwards:

```bash
git clone <this repo> ~/Development/kbx-miga   # or wherever it lives
cd ~/Development/kbx-miga
bun install                                     # dev typings only; there are no runtime dependencies
mkdir -p ~/.omp/agent/extensions
ln -sfn "$PWD" ~/.omp/agent/extensions/capture
```

To check it is loaded:

```bash
cd /tmp && OMP_CAPTURE_DIR=$(mktemp -d) omp --no-session -p "/capture install check"   # prints: Captured XXXX.
```

The check saves a throwaway record in a temp store. It also makes one model call: print-mode `/capture` waits for extraction.

To uninstall, remove the symlink: `rm ~/.omp/agent/extensions/capture`. The records you saved stay in the store.

OMP loads extensions once, when a session starts, straight from this working copy. Restart open sessions after installing, and after any pull, edit or branch switch here; until then they keep running the code they started with.

## Where records live

| Setting | Default | Change with |
|---|---|---|
| Store directory | `~/.omp/agent/captures/` (mode `0700`; each record is `<uuid>.json`, mode `0600`) | `OMP_CAPTURE_DIR=/path` |
| Extraction deadline | 90 s | `OMP_CAPTURE_TIMEOUT_MS=<positive ms>` |
| Provider-payload check (debugging only) | off | `OMP_CAPTURE_DEBUG_PAYLOAD=/path/file.json` writes only the `tools`/`tool_choice` the provider received |

Each capture is one self-contained JSON file (schema v1). It holds your request, where it came from (session id and file, cwd, leaf entry), the source packet, the interpretation, your note, and any last error.

The request, origin and packet are evidence: they never change after the first save. Only the interpretation, your note, and `last_error` (a short, redacted diagnostic when extraction fails) change, and every change raises the record's `revision`. Exports go to `<store>/exports/`.

## Commands

| Command | What it does |
|---|---|
| `/capture <free text>` | Saves your words and this branch's evidence, then shows `Captured XXXX.`. A bare `/capture` also works: the view then shows *(no text: bare /capture)*, and the inferred subject is labelled *inferred, not verified* like every interpretation. |
| `/capture-list [n]` | Newest first (default 20): short id, local time, project, state, topic or request. |
| `/capture-show <id>` | The full record: your request and note, the interpretation (labelled *inferred, not verified*), the cited evidence verbatim, coverage, and the last error. In the TUI it opens in a scrollable overlay (↑↓, PgUp/PgDn; Esc or `q` closes it). |
| `/capture-note <id> <text>` | Adds or replaces your note. An earlier interpretation is then marked as predating it. |
| `/capture-retry <id>` | Re-interprets from the **saved** record only, never the live conversation, using the session's current model. A failed retry keeps the previous interpretation. |
| `/capture-export <id> [md\|json]` | Writes a snapshot to `<store>/exports/<SHORT>-r<revision>.<ext>`. The JSON is a byte copy of the record. Editing or deleting an export never changes the record. |

An `<id>` is any unique prefix of at least 4 hex characters, in either case. A prefix that matches two records is rejected, and the error lists both.

A record's `state` is one of:
- `raw`: saved, with no interpretation yet, or the extraction failed (see `last_error`).
- `ready`: a learning question and its situation were identified.
- `needs_context`: the evidence wasn't enough to say what you meant. The record explains what is missing; add a note and retry.

## What goes into a capture

- **Only the current session branch, and only what OMP itself would show you:**
  - Entries before a `/clear` are excluded.
  - After a compaction, the record holds the compaction summary, the kept tail and everything after it.
  - Abandoned sibling branches never appear.
- **Recent turns, plus older ones that mention words from your request.** The packet keeps the newest parts (up to 40 parts or 64 KB). It then adds older parts containing your request's words, quoted phrases or file paths, each together with the part just before it. The whole packet stays within 60 parts or 96 KB.
- **Long parts are cut, not rewritten.** A part over 8 K characters keeps its first and last 4 K characters as two separate segments, with the offset of each. A gap is never presented as one continuous quote.
- **A reply that is still being written is included** as a `partial` part.
- **Excluded and counted, never copied:**
  - thinking blocks
  - images
  - system and synthetic messages
- **Secrets are redacted before saving:**
  - AWS, GitHub, Slack, npm and Google keys
  - keyword secrets joined by `-` or `_`, such as `sk-…`, `secret_…`, `token_…` and `password-…`, including after `token=` (`token=sk-…`)
  - JWTs
  - `Bearer` tokens
  - PEM private keys

## Known limitations

- **"Your words" means the text the command receives.** The TUI trims your input and expands emoticons before `/capture` sees it.
- **The in-flight reply can lag the screen.** It is whatever OMP had streamed to extensions when you pressed Enter.
- **During a compaction, `/capture` waits** and runs after it.
- **`/capture` is refused** while a child agent's transcript is focused. Return to the main session first.
- **Extraction uses your session's current model and credentials,** and any proxy you have configured in `models.yml` (headroom here). There is no separate model or login.
- **An unreachable provider fails as `aborted`, not `provider_error`.** OMP keeps retrying the connection until the extraction deadline, so the failure is recorded only when it expires (90 s by default).
- **In print (`-p`) and `--mode json` runs, `/capture` and `/capture-retry` wait for the model call before exiting.** Otherwise the process would exit and kill it. In the TUI and over RPC it runs in the background.
- **A SIGTERM skips cleanup.** OMP exits without its shutdown hook, for example when an RPC client stops it. An extraction still in flight then leaves the record `raw` with no `last_error`, which looks the same as one still running. Use `/capture-retry`.
- **Concurrent edits from two OMP windows.** Every change is locked and checked against the record's revision, and a result whose starting revision is out of date is discarded rather than merged. If a retry in one window races a failed extraction from another, the retry is discarded. Run it again.
- **A cut can split a very long secret.** A cut that lands inside a token run of up to 64 characters moves to the edge of that run, so it doesn't split a credential. A longer token, such as a JWT or a fine-grained GitHub token, cut more than 64 characters in, can leave an unredacted fragment at the cut edge.
- **Secrets in plain `key=value` form are not redacted.** For example `token=abc123…`, `password=…` and `API_KEY: …`, unless the value itself matches one of the patterns above. Text you paste into a session is saved as-is.
- **Records are as private as the session files they copy from.** Back up or delete `~/.omp/agent/captures/` as you would `~/.omp/agent/sessions/`.

## Development

```bash
bun install
bun test                          # unit tests (record, snapshot, redaction, extraction, store, render)
bun run typecheck                 # tsc -p .
scripts/check-invariants.sh       # no conversation injection; model calls only in src/extract.ts; no runtime deps
```

Live checks, which make real model calls through your configured provider:

```bash
bun scripts/smoke-streaming.ts    # /capture mid-stream keeps a partial reply; nothing is injected
scripts/smoke-extract.sh          # ready / needs_context / timeout → raw with last_error; no tools offered
scripts/smoke-sessions.sh         # two concurrent sessions → two records with their own identities
scripts/smoke-retry.sh            # retry after the conversation moves on reuses the saved packet
scripts/scenarios.sh              # acceptance scenarios A01–A16
```

To try an unreleased copy without touching the installed one: `omp --no-extensions --trusted-extension "$PWD/extension/index.ts" …`.

The design, decisions and verification history are in `docs/plans/` and `docs/progress/`.
