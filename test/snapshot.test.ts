import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	PACKET_MAX_BYTES,
	PACKET_MAX_PARTS,
	PART_HEAD_CHARS,
	PART_MAX_CHARS,
	type SourcePacket,
	validateRecord,
} from "../src/record";
import { buildPacket, partialReply } from "../src/snapshot";

// Real OMP SessionManager (in-memory storage), so getBranch() semantics are the harness's own.
const session = () => SessionManager.inMemory("/work/order-worker");
const now = Date.now();
const user = (content: unknown, extra: object = {}): any => ({ role: "user", content, attribution: "user", timestamp: now, ...extra });
const assistant = (content: unknown[]): any => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: now,
});
const text = (t: string) => ({ type: "text", text: t });
const texts = (sm: SessionManager) => buildPacket(sm.getBranch()).parts.map(p => p.segments.map(s => s.text).join(""));

describe("buildPacket", () => {
	test("pre-clear entries are excluded", () => {
		const sm = session();
		sm.appendMessage(user("old question"));
		sm.appendMessage(assistant([text("old answer")]));
		const boundaryId = sm.appendResetBoundary();
		sm.appendMessage(user("why the worker ran twice"));

		const packet = buildPacket(sm.getBranch());
		expect(packet.parts.map(p => p.segments[0].text)).toEqual(["why the worker ran twice"]);
		expect(packet.coverage.boundary).toEqual({ kind: "reset_boundary", entry_id: boundaryId });
		expect(packet.coverage.omitted).toEqual([]);
	});

	test("compaction keeps summary + kept tail only", () => {
		const sm = session();
		sm.appendMessage(user("summarized away"));
		sm.appendMessage(assistant([text("also summarized")]));
		const keptId = sm.appendMessage(user("kept question"));
		sm.appendMessage(assistant([text("kept answer")]));
		const compactionId = sm.appendCompaction("SUMMARY of the early work", undefined, keptId, 1000);
		sm.appendMessage(user("after compaction"));

		const packet = buildPacket(sm.getBranch());
		expect(texts(sm)).toEqual(["SUMMARY of the early work", "kept question", "kept answer", "after compaction"]);
		expect(packet.parts[0]).toMatchObject({ kind: "compaction_summary", entry_id: compactionId, completeness: "complete" });
		expect(packet.coverage.boundary).toEqual({ kind: "compaction", entry_id: compactionId });
	});

	test("a /clear after the latest compaction wins over it", () => {
		const sm = session();
		const keptId = sm.appendMessage(user("kept"));
		sm.appendCompaction("SUMMARY", undefined, keptId, 1000);
		sm.appendMessage(user("pre-clear"));
		sm.appendResetBoundary();
		sm.appendMessage(user("post-clear"));
		expect(texts(sm)).toEqual(["post-clear"]);
	});

	test("abandoned sibling branch never appears (A06)", () => {
		const sm = session();
		sm.appendMessage(user("shared start"));
		const forkPoint = sm.appendMessage(assistant([text("shared answer")]));
		sm.appendMessage(user("ABANDONED direction"));
		sm.appendMessage(assistant([text("ABANDONED answer")]));
		sm.branch(forkPoint);
		sm.appendMessage(user("chosen direction"));

		expect(texts(sm)).toEqual(["shared start", "shared answer", "chosen direction"]);
	});

	test("thinking and images excluded and counted; tool call/result pairing kept", () => {
		const sm = session();
		sm.appendMessage(user([text("look at this screenshot"), { type: "image", data: "AAAA", mimeType: "image/png" }]));
		sm.appendMessage(
			assistant([
				{ type: "thinking", thinking: "private reasoning" },
				text("Reading the loop."),
				{ type: "redactedThinking", data: "opaque" },
				{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "src/loop.ts" } },
			]),
		);
		sm.appendMessage({ role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [text("loop body")], isError: false, timestamp: now } as any);
		sm.appendMessage(user("continue", { synthetic: true }));

		const packet = buildPacket(sm.getBranch());
		expect(packet.coverage.excluded).toEqual({ thinking: 2, images: 1, synthetic: 1, other: 0 });
		expect(packet.parts.map(p => [p.id, p.kind, p.authorship, p.segments[0].text, p.tool])).toEqual([
			["s1", "user_message", "user", "look at this screenshot", null],
			["s2", "assistant_message", "agent", "Reading the loop.", null],
			["s3", "tool_call", "agent", '{"path":"src/loop.ts"}', { name: "read", call_id: "toolu_1", is_error: false }],
			["s4", "tool_result", "unknown", "loop body", { name: "read", call_id: "toolu_1", is_error: false }],
		]);
		expect(JSON.stringify(packet)).not.toContain("private reasoning");
	});

	test("over-budget branch keeps the newest tail and records the omitted count honestly", () => {
		const sm = session();
		for (let i = 1; i <= 50; i++) sm.appendMessage(user(`message ${i}`));

		const packet = buildPacket(sm.getBranch());
		expect(packet.coverage).toMatchObject({ eligible_parts: 50, retained_parts: 40, omitted: [{ before_part: "s1", count: 10 }] });
		expect(packet.parts[0].segments[0].text).toBe("message 11");
		expect(packet.parts.at(-1)?.segments[0].text).toBe("message 50");
	});

	test("an empty session yields an empty, valid packet with root boundary", () => {
		const packet = buildPacket(session().getBranch());
		expect(packet.parts).toEqual([]);
		expect(packet.coverage.boundary).toEqual({ kind: "root", entry_id: null });
		const record = {
			schema_version: 1,
			id: crypto.randomUUID(),
			revision: 1,
			captured_at: new Date().toISOString(),
			request_text: "",
			origin: { harness: "omp", session_id: "x", session_file: null, cwd: "/", leaf_id: null },
			timing: { publish_ms: 0 },
			source_packet: packet,
			state: "raw",
			extraction: null,
			user_note: null,
			last_error: null,
		};
		expect(validateRecord(record)).toMatchObject({ ok: true });
	});
});

const packetBytes = (p: SourcePacket) =>
	p.parts.reduce((n, part) => n + part.segments.reduce((m, s) => m + Buffer.byteLength(s.text), 0), 0);
const joined = (p: SourcePacket) => p.parts.map(part => part.segments.map(s => s.text).join(""));

describe("tail+anchors/v1 selection", () => {
	// 5 old turns, the subject at turn 3, then 50 unrelated turns pushing it out of the tail.
	const anchoredSession = () => {
		const sm = session();
		sm.appendMessage(user("set up the queue consumer"));
		sm.appendMessage(assistant([text("Consumer wired to the orders queue.")]));
		sm.appendMessage(user("it crashed, what now"));
		sm.appendMessage(assistant([text("I suggest adding an idempotency key on the order write so redelivery is harmless.")]));
		sm.appendMessage(user("ok do it"));
		for (let i = 1; i <= 50; i++) sm.appendMessage(user(`unrelated styling tweak ${i}`));
		return sm;
	};

	test("earlier anchored subject is retained with its predecessor (A04)", () => {
		const packet = buildPacket(anchoredSession().getBranch(), "that idempotency thing from earlier");
		const t = joined(packet);
		expect(t.slice(0, 2)).toEqual([
			"it crashed, what now",
			"I suggest adding an idempotency key on the order write so redelivery is harmless.",
		]);
		expect(t.at(-1)).toBe("unrelated styling tweak 50");
		expect(packet.coverage.policy).toBe("tail+anchors/v1");
		// 55 eligible: 2 anchored + 40 tail retained; gaps before s1 (2), before the tail (11).
		expect(packet.coverage).toMatchObject({
			eligible_parts: 55,
			retained_parts: 42,
			omitted: [
				{ before_part: "s1", count: 2 },
				{ before_part: "s3", count: 11 },
			],
		});
	});

	test("bare request uses tail only", () => {
		const packet = buildPacket(anchoredSession().getBranch(), "");
		expect(packet.parts).toHaveLength(40);
		expect(joined(packet)[0]).toBe("unrelated styling tweak 11");
	});

	test("compaction summary is always retained, even when the tail is full", () => {
		const sm = session();
		const kept = sm.appendMessage(user("kept"));
		sm.appendCompaction("SUMMARY", undefined, kept, 1000);
		for (let i = 1; i <= 45; i++) sm.appendMessage(user(`after ${i}`));
		const packet = buildPacket(sm.getBranch(), "");
		expect(packet.parts[0]).toMatchObject({ id: "s1", kind: "compaction_summary" });
		expect(packet.parts).toHaveLength(41);
	});

	test("budgets never exceeded on the 38 MB-session shape", () => {
		const sm = session();
		const big = "x".repeat(200_000);
		for (let i = 0; i < 875; i++) {
			sm.appendMessage(user(`retry the worker job ${i}`));
			sm.appendMessage(
				assistant([text(`worker retry analysis ${i} ${"y".repeat(1500)}`), { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "run worker" } }]),
			);
			sm.appendMessage({ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [text(`worker ${big}`)], isError: false, timestamp: now } as any);
		}
		const inFlight = { ...assistant([text("z".repeat(50_000))]), timestamp: now + 1 };
		const packet = buildPacket(sm.getBranch(), "why did the worker retry", inFlight);
		expect(packet.coverage.eligible_parts).toBe(3501);
		expect(packet.parts.length).toBeLessThanOrEqual(PACKET_MAX_PARTS);
		expect(packetBytes(packet)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
		const gaps = packet.coverage.omitted.reduce((n, o) => n + o.count, 0);
		expect(gaps + packet.parts.length).toBe(3501);
	});

	test("truncated tool result keeps two segments with offsets and kind (A08)", () => {
		const sm = session();
		const output = `HEAD${"a".repeat(20_000)}TAIL`;
		sm.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [text(output)], isError: true, timestamp: now } as any);
		const [part] = buildPacket(sm.getBranch(), "").parts;
		expect(part).toMatchObject({
			kind: "tool_result",
			completeness: "truncated",
			original_chars: output.length,
			tool: { name: "read", call_id: "c1", is_error: true },
		});
		expect(part.segments.map(s => [s.start, s.text.length])).toEqual([
			[0, PART_HEAD_CHARS],
			[output.length - PART_HEAD_CHARS, PART_HEAD_CHARS],
		]);
		expect(part.segments[0].text.startsWith("HEAD")).toBe(true);
		expect(part.segments[1].text.endsWith("TAIL")).toBe(true);
		expect(output.length).toBeGreaterThan(PART_MAX_CHARS);
	});

	test("agent-originated content keeps agent authorship and original roles (A05)", () => {
		const sm = session();
		sm.appendMessage(user("Parent asks: summarize the failure", { attribution: "agent" }));
		sm.appendCustomMessageEntry("advisor-note", "Consider the ack ordering.", true);
		sm.appendMessage(assistant([text("Possibly the ack happens before the write — not confirmed.")]));
		const parts = buildPacket(sm.getBranch(), "").parts;
		expect(parts.map(p => [p.original_role, p.kind, p.authorship, p.attribution])).toEqual([
			["user", "user_message", "agent", "agent"],
			["custom", "custom_message", "agent", "agent"],
			["assistant", "assistant_message", "agent", null],
		]);
	});

	test("secrets are redacted in saved segments, original_chars kept", () => {
		const sm = session();
		const secret = "use key AKIAIOSFODNN7EXAMPLE now";
		sm.appendMessage(user(secret));
		const [part] = buildPacket(sm.getBranch(), "").parts;
		expect(part.segments[0].text).toBe("use key [REDACTED] now");
		expect(part.original_chars).toBe(secret.length);
	});
});

describe("partial reply (A07)", () => {
	test("reducer keeps the assistant's text blocks only", () => {
		expect(partialReply(user("hi"))).toBeNull();
		expect(partialReply(assistant([{ type: "thinking", thinking: "hmm" }]))).toBeNull();
		expect(partialReply(assistant([text("Idempotency "), { type: "thinking", thinking: "x" }, text("means")]))).toBe("Idempotency \nmeans");
	});

	test("in-flight reply becomes p1 partial after branch parts, with its real head and tail", () => {
		const sm = session();
		sm.appendMessage(user("write the essay"));
		const long = `START${"b".repeat(40_000)}END`;
		const packet = buildPacket(sm.getBranch(), "", { ...assistant([text(long)]), timestamp: now + 1 });
		const p1 = packet.parts.at(-1);
		expect(p1).toMatchObject({ id: "p1", entry_id: null, kind: "assistant_message", completeness: "partial", authorship: "agent", original_chars: long.length });
		expect(p1?.segments.map(s => s.start)).toEqual([0, long.length - PART_HEAD_CHARS]);
		expect(p1?.segments[0].text.startsWith("START")).toBe(true);
		expect(p1?.segments[1].text.endsWith("END")).toBe(true);
		expect(packet.coverage).toMatchObject({ partial_included: true, eligible_parts: 2, retained_parts: 2 });
		expect(validateRecord({ ...minimalRecord(), source_packet: packet })).toMatchObject({ ok: true });
	});

	test("a reply already persisted in the branch is not repeated as p1", () => {
		const sm = session();
		sm.appendMessage(user("count to 3"));
		const reply = assistant([text("1\n2\n3")]);
		sm.appendMessage(reply);
		const packet = buildPacket(sm.getBranch(), "", reply);
		expect(packet.parts.map(p => p.id)).toEqual(["s1", "s2"]);
		expect(packet.coverage.partial_included).toBe(false);
	});
});

describe("truncation edges", () => {
	test("a credential straddling the head cut is kept whole and redacted, not split", () => {
		const sm = session();
		const key = "AKIAIOSFODNN7EXAMPLE";
		const body = `${"word ".repeat(818)}x${key} ${"tail ".repeat(2000)}`; // key spans offset 4096
		expect(body.indexOf(key)).toBeLessThan(PART_HEAD_CHARS);
		expect(body.indexOf(key) + key.length).toBeGreaterThan(PART_HEAD_CHARS);
		sm.appendMessage(user(body));
		const [part] = buildPacket(sm.getBranch(), "").parts;
		expect(part.completeness).toBe("truncated");
		expect(part.segments[0].text.endsWith("x[REDACTED]")).toBe(true);
		expect(JSON.stringify(part)).not.toContain("AKIAIOSF");
	});

	test("a token run spanning both cuts on a just-over-limit text keeps the part whole", () => {
		const sm = session();
		const half = (PART_MAX_CHARS + 1 - 40) / 2; // 8193 chars, 40-char run straddling both cuts
		const body = `${" ".repeat(Math.floor(half))}${"Q".repeat(40)}${" ".repeat(Math.ceil(half))}`;
		expect(body.length).toBe(PART_MAX_CHARS + 1);
		sm.appendMessage(user(body));
		const [part] = buildPacket(sm.getBranch(), "").parts;
		expect(part.completeness).toBe("complete");
		expect(part.segments).toEqual([{ start: 0, text: body }]);
	});
});

function minimalRecord() {
	return {
		schema_version: 1,
		id: crypto.randomUUID(),
		revision: 1,
		captured_at: new Date().toISOString(),
		request_text: "",
		origin: { harness: "omp", session_id: "x", session_file: null, cwd: "/", leaf_id: null },
		timing: { publish_ms: 0 },
		source_packet: null as unknown,
		state: "raw",
		extraction: null,
		user_note: null,
		last_error: null,
	};
}
