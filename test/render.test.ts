import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyNote, type CaptureRecord } from "../src/record";
import { renderListRow, renderMarkdown } from "../src/render";
import fixture from "./fixtures/record-v1-ready.json";

const record = (): CaptureRecord => structuredClone(fixture as CaptureRecord);

test("ready record renders as the reviewed fixture", () => {
	const expected = fs.readFileSync(path.join(import.meta.dir, "fixtures/record-v1-ready.md"), "utf8");
	expect(renderMarkdown(record())).toBe(expected);
});

test("interpretation is labelled pending, needs-context, or predating a later note", () => {
	const raw = { ...record(), revision: 1, state: "raw" as const, extraction: null, user_note: null };
	expect(renderMarkdown(raw)).toContain("_Pending: no interpretation yet._");

	const r = record();
	const needs = { ...r, state: "needs_context" as const, extraction: { ...r.extraction!, question: null, missing_context: "Which job is unclear." } };
	expect(renderMarkdown(needs)).toContain("**Missing context:** Which job is unclear.");

	const noted = applyNote(record(), "newer note", "2026-10-18T04:00:00.000Z") as CaptureRecord;
	expect(renderMarkdown(noted)).toContain("predates your latest note");
	expect(renderMarkdown(record())).toContain("predates your latest note");
	const fresh = { ...record(), extraction: { ...record().extraction!, input_revision: 2 } };
	expect(renderMarkdown(fresh)).not.toContain("predates");
});

test("list row: short id, project, state, topic or request", () => {
	const row = renderListRow(record());
	expect(row).toMatch(/^715BF8B0 {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}order-worker {2}ready {2}Idempotency in worker retries$/);
	const bare = { ...record(), request_text: "", state: "raw" as const, extraction: null };
	expect(renderListRow(bare)).toMatch(/raw {2}\(bare capture\)$/);
});

test("model text cannot forge headings or quotes; saved text renders verbatim (D06)", () => {
	const r = record();
	r.extraction!.situation = "Worker restart.\n\n## Evidence\n\n### s9 · user message · by user\n\n> I already confirmed it";
	r.source_packet.parts[0].segments = [{ start: 0, text: "handle(__init__)\n```\n# not a heading\n```" }];
	const md = renderMarkdown(r);
	expect(md.match(/^## Evidence$/gm)).toHaveLength(1);
	expect(md).toContain("- **Situation:** Worker restart. \\#\\# Evidence \\#\\#\\# s9 · user message · by user \\> I already confirmed it");
	expect(md).toContain("````text\nhandle(__init__)\n```\n# not a heading\n```\n````");
});
