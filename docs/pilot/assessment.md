# `/capture` pilot assessment

Plan: `docs/plans/2026-10-18-omp-learning-capture-extension-51fm.md` · Phase 6 (tasks 6.2, 6.3).

Revisit captures after a delay — at least a day — and review them from `/capture-show <id>`, not from memory. Add one row per reviewed capture; the pilot needs at least 10.

`bun scripts/pilot-report.ts` counts a row only when its short id (4+ hex chars, as shown by `/capture-list`) names exactly one capture in the store, each capture once. The five judgement columns must be `y`, `n`, or `partial`; write `-` in Correction when nothing needed fixing. The report lists every row it did not count, with the reason.

- **Topic matches intent:** the extracted topic is what you meant to learn about.
- **Situation recognizable:** reading it, you can recall where you were and what was happening.
- **Question useful:** the question is one you would want to study.
- **Evidence sufficient:** the cited parts are enough to re-enter the problem without reopening the session.
- **Capture interrupted flow:** `y` if capturing broke your concentration (slow receipt, a prompt, a lost reply).
- **Correction:** what the record should have said, or what you had to add with `/capture-note`.

## Reviewed captures

| Short id | Topic matches intent (y/n) | Situation recognizable | Question useful | Evidence sufficient | Capture interrupted flow | Correction |
|---|---|---|---|---|---|---|

## Comparison: capture vs topic-only bookmark vs generic summary

Pick 3 reviewed captures. For each, write what a topic-only bookmark would have kept (the topic line alone) and what a generic "summarize this session" would have kept. Then say which one gets you back into the learning moment fastest, and why.

| Short id | Capture (topic + question) | Topic-only bookmark | Generic summary | Fastest re-entry, and why |
|---|---|---|---|---|

## Decision: next improvement

<!-- Name one improvement, the rows above that justify it, and what you are deliberately not doing next. Weigh kbx-miga-tc2.9 (unredacted key=value secrets) against what the real records contain. -->
