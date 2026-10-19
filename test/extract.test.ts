import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	applyFailure,
	applyProposal,
	buildPromptInput,
	ExtractionError,
	PROMPT_VERSION,
	type Proposal,
	validateProposal,
} from "../src/extract";
import { type CaptureRecord, MODEL_INPUT_MAX_BYTES, validateRecord } from "../src/record";
import fixture from "./fixtures/record-v1-ready.json";

const record = (): CaptureRecord => structuredClone(fixture as CaptureRecord);
const packet = record().source_packet;

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}
const ready: Proposal = {
	outcome: "ready",
	topic: "Idempotency in worker retries",
	situation: "The worker restarts mid-job and the assistant proposed an idempotency key.",
	trigger: "The assistant's idempotency-key proposal.",
	question: "How does an idempotency key stop a redelivered job from repeating its effects?",
	relevance: "Understanding the proposed recovery design.",
	evidence_ids: ["s1", "s4"],
	missing_context: null,
};
const text = (t: string) => ({ type: "text" as const, text: t });
const json = (o: unknown) => [text(JSON.stringify(o))];
const rejection = (message: AssistantMessage) => {
	const result = validateProposal(message, packet);
	if (result.ok) throw new Error("expected rejection");
	return result.error.kind;
};

describe("buildPromptInput", () => {
	test("prompt contains only saved-record data", () => {
		const r = record();
		const input = buildPromptInput(r);
		const parsed = JSON.parse(input);
		expect(Object.keys(parsed).sort()).toEqual(["coverage", "parts", "request_text", "user_note"]);
		expect(parsed.request_text).toBe(r.request_text);
		expect(parsed.user_note).toBe(r.user_note?.text);
		expect(parsed.coverage).toEqual(r.source_packet.coverage);
		expect(parsed.parts.map((p: { id: string }) => p.id)).toEqual(["s1", "s2", "s3", "s4"]);
		expect(Object.keys(parsed.parts[0]).sort()).toEqual(["authorship", "completeness", "id", "kind", "text", "tool"]);
		// Truncated segments are joined with an explicit omission marker, never as one quote.
		expect(parsed.parts[2].text).toBe(
			"export async function runLoop(queue: Queue) {\n[… 11907 chars omitted …]\n  await queue.ack(job.id); // after side effects",
		);
		for (const live of [r.origin.session_id, r.origin.cwd, r.origin.leaf_id as string, r.id, "captured_at", "extraction"])
			expect(input).not.toContain(live);
	});

	test("input over the model budget is an operational error, not a call", () => {
		const r = record();
		r.source_packet.parts[0].segments = [{ start: 0, text: "x".repeat(MODEL_INPUT_MAX_BYTES) }];
		expect(() => buildPromptInput(r)).toThrow(ExtractionError);
		try {
			buildPromptInput(r);
		} catch (error) {
			expect((error as ExtractionError).kind).toBe("input_too_large");
		}
	});
});

describe("validateProposal (A09, A15)", () => {
	test("accepts raw JSON ready and a single fenced needs_context block", () => {
		expect(validateProposal(reply(json(ready)), packet)).toEqual({ ok: true, proposal: ready });
		const needs: Proposal = { ...ready, outcome: "needs_context", question: null, evidence_ids: [], missing_context: "Which job is meant is unclear." };
		const fenced = reply([{ type: "thinking", thinking: "…" }, text(`\`\`\`json\n${JSON.stringify(needs)}\n\`\`\``)]);
		expect(validateProposal(fenced, packet)).toEqual({ ok: true, proposal: needs });
	});

	test.each([
		["error", "provider_error"],
		["aborted", "aborted"],
		["length", "truncated_output"],
		["toolUse", "invalid_output"],
	] as const)("stopReason %s is rejected as %s even with valid JSON", (stop, kind) => {
		expect(rejection(reply(json(ready), stop))).toBe(kind);
	});

	test("a toolCall block is rejected even when stopReason is stop", () => {
		expect(rejection(reply([...json(ready), { type: "toolCall", id: "c1", name: "bash", arguments: {} }]))).toBe("invalid_output");
	});

	test.each([
		["malformed JSON", [text('{"outcome": "ready",')]],
		["prose around JSON", [text(`Here you go: ${JSON.stringify(ready)}`)]],
		["two fenced blocks", [text(`\`\`\`json\n${JSON.stringify(ready)}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``)]],
		["unknown key", json({ ...ready, confidence: 0.9 })],
		["missing key", json({ ...ready, relevance: undefined })],
		["invented evidence id", json({ ...ready, evidence_ids: ["s1", "s9"] })],
		["unknown outcome", json({ ...ready, outcome: "maybe" })],
		["over-long topic", json({ ...ready, topic: "t".repeat(121) })],
		["ready without a question", json({ ...ready, question: "  " })],
		["ready without evidence", json({ ...ready, evidence_ids: [] })],
		["needs_context without explanation", json({ ...ready, outcome: "needs_context", missing_context: null })],
	])("%s is rejected as invalid_output", (_name, content) => {
		expect(rejection(reply(content as AssistantMessage["content"]))).toBe("invalid_output");
	});
});

describe("applying results", () => {
	const meta = { inputRevision: 2, provider: "anthropic", model: "claude-opus-5-5", now: "2026-10-18T03:00:00.000Z" };

	test("a proposal publishes at the next revision and clears last_error", () => {
		const r = { ...record(), last_error: { at: meta.now, class: "aborted", message: "x" } };
		const next = applyProposal(r, { ...meta, proposal: { ...ready, outcome: "needs_context", missing_context: "unclear" } });
		expect(next).toMatchObject({ revision: 3, state: "needs_context", last_error: null });
		expect(next?.extraction).toMatchObject({ input_revision: 2, prompt_version: PROMPT_VERSION, provider: "anthropic", missing_context: "unclear" });
		expect(validateRecord(next)).toMatchObject({ ok: true });
	});

	test("a proposal whose input revision is no longer current is discarded", () => {
		expect(applyProposal(record(), { ...meta, inputRevision: 1, proposal: ready })).toBeNull();
	});

	test("a failure keeps state and extraction; the diagnostic is bounded and redacted", () => {
		const r = record();
		const error = new ExtractionError("provider_error", `401 for key AKIAIOSFODNN7EXAMPLE ${"z".repeat(900)}`);
		const next = applyFailure(r, r.revision, error, meta.now);
		expect(next?.state).toBe("ready");
		expect(next?.extraction).toEqual(r.extraction);
		expect(next?.revision).toBe(r.revision + 1);
		expect(next?.last_error?.class).toBe("provider_error");
		expect(next?.last_error?.message.length).toBeLessThanOrEqual(500);
		expect(next?.last_error?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(validateRecord(next)).toMatchObject({ ok: true });
	});

	test("a stale job's failure is discarded instead of overwriting newer state", () => {
		expect(applyFailure(record(), 1, new ExtractionError("aborted", "late"), meta.now)).toBeNull();
	});
});
