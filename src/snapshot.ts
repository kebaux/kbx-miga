// Source acquisition: eligible-window selection (mirrors OMP's /clear and compaction
// rules) and normalization of session entries into source parts.
import type { CompactionEntry, MessageUpdateEvent, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
	type Authorship,
	type Coverage,
	PACKET_MAX_BYTES,
	PACKET_MAX_PARTS,
	PART_HEAD_CHARS,
	PART_MAX_CHARS,
	type PartKind,
	type Segment,
	type SourcePacket,
	type SourcePart,
	TAIL_MAX_BYTES,
	TAIL_MAX_PARTS,
} from "./record";
import { redact } from "./redact";

/** Names task 2.1's selection and the budget constants in record.ts. */
export const SELECTION_POLICY = "tail+anchors/v1";

export type Boundary = Coverage["boundary"];
export type Excluded = Coverage["excluded"];
export type DraftPart = Omit<SourcePart, "id">;

export interface EligibleWindow {
	boundary: Boundary;
	/** Entries in branch order; a governing compaction entry comes first and stands for its summary. */
	entries: SessionEntry[];
}

/**
 * Replicates the emission window of `session-context.ts:479-600` (18.12.1) over a
 * `getBranch()` path: the latest `reset_boundary` after the latest compaction wins;
 * otherwise the latest compaction contributes its summary, its kept tail and everything
 * after it; otherwise the whole path.
 *
 * Deliberate differences from OMP: the kept tail starts at `firstKeptEntryId`, else after
 * `providerReplayThroughEntryId` regardless of provider — the union of what the transcript
 * shows and what the model saw. The `experimental-context-rollover` re-sent request
 * (`session-context.ts:558-570`) is not recovered: accepted gap for an opt-in feature.
 */
export function selectEligible(branch: readonly SessionEntry[]): EligibleWindow {
	let resetIdx = -1;
	let compactionIdx = -1;
	branch.forEach((entry, i) => {
		if (entry.type === "reset_boundary") resetIdx = i;
		else if (entry.type === "compaction") compactionIdx = i;
	});

	if (resetIdx >= 0 && resetIdx > compactionIdx) {
		return {
			boundary: { kind: "reset_boundary", entry_id: branch[resetIdx].id },
			entries: branch.slice(resetIdx + 1),
		};
	}
	if (compactionIdx >= 0) {
		const compaction = branch[compactionIdx] as CompactionEntry;
		const firstKeptIdx = branch.findIndex((e, i) => i < compactionIdx && e.id === compaction.firstKeptEntryId);
		const replayThroughIdx = compaction.providerReplayThroughEntryId
			? branch.findIndex((e, i) => i < compactionIdx && e.id === compaction.providerReplayThroughEntryId)
			: -1;
		const keptStart = firstKeptIdx >= 0 ? firstKeptIdx : replayThroughIdx >= 0 ? replayThroughIdx + 1 : compactionIdx;
		return {
			boundary: { kind: "compaction", entry_id: compaction.id },
			entries: [compaction, ...branch.slice(keptStart, compactionIdx), ...branch.slice(compactionIdx + 1)],
		};
	}
	return { boundary: { kind: "root", entry_id: null }, entries: [...branch] };
}

type Block = { type: string; text?: string };

/** Joins text blocks; counts image blocks. */
function textOf(content: string | readonly Block[], excluded: Excluded): string {
	if (typeof content === "string") return content;
	const texts: string[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text ?? "");
		else if (block.type === "image") excluded.images++;
		else excluded.other++;
	}
	return texts.join("\n");
}

function authorshipOf(attribution: string | undefined): Authorship {
	return attribution === "user" ? "user" : attribution === "agent" ? "agent" : "unknown";
}

/** ASCII token characters: a cut inside a run of these may split a credential. */
const isTokenChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_+/=.-]/.test(ch);
const EDGE_RUN_MAX = 64;

/**
 * Saved form of one text: whole if within PART_MAX_CHARS, else a head and a tail segment of
 * about PART_HEAD_CHARS each. A cut inside a token run of ≤ EDGE_RUN_MAX chars moves outward
 * to the run's edge, so a credential is never split (redaction runs later on whole tokens);
 * otherwise a cut never splits a surrogate pair. Offsets are into the original text.
 */
function segmentsOf(text: string): Segment[] {
	if (text.length <= PART_MAX_CHARS) return [{ start: 0, text }];
	let headEnd = PART_HEAD_CHARS;
	if (isTokenChar(text[headEnd - 1]) && isTokenChar(text[headEnd])) {
		let j = headEnd;
		while (j < text.length && isTokenChar(text[j]) && j - headEnd < EDGE_RUN_MAX) j++;
		if (!isTokenChar(text[j])) headEnd = j;
	} else if (text.charCodeAt(headEnd - 1) >= 0xd800 && text.charCodeAt(headEnd - 1) <= 0xdbff) headEnd--;
	let tailStart = text.length - PART_HEAD_CHARS;
	if (isTokenChar(text[tailStart - 1]) && isTokenChar(text[tailStart])) {
		let k = tailStart;
		while (isTokenChar(text[k - 1]) && tailStart - k < EDGE_RUN_MAX) k--;
		if (!isTokenChar(text[k - 1])) tailStart = k;
	} else if (text.charCodeAt(tailStart) >= 0xdc00 && text.charCodeAt(tailStart) <= 0xdfff) tailStart++;
	// Moved cuts can meet on texts just over the limit: keep the part whole rather than quote twice.
	if (headEnd >= tailStart) return [{ start: 0, text }];
	return [
		{ start: 0, text: text.slice(0, headEnd) },
		{ start: tailStart, text: text.slice(tailStart) },
	];
}

function draft(
	entryId: string,
	originalRole: string,
	kind: PartKind,
	authorship: Authorship,
	attribution: string | undefined,
	text: string,
	tool: DraftPart["tool"] = null,
): DraftPart {
	const segments = segmentsOf(text);
	return {
		entry_id: entryId,
		original_role: originalRole,
		kind,
		authorship,
		attribution: attribution ?? null,
		tool,
		completeness: segments.length > 1 ? "truncated" : "complete",
		original_chars: text.length,
		segments,
	};
}

/**
 * Maps one eligible entry to zero or more draft parts, counting what it excludes.
 * Authorship: assistant → agent; otherwise `attribution` "user" → user, "agent" → agent,
 * absent → unknown. Summaries are harness/model-written → agent.
 */
export function normalizeEntry(entry: SessionEntry, excluded: Excluded): DraftPart[] {
	switch (entry.type) {
		case "compaction":
			return [draft(entry.id, "compactionSummary", "compaction_summary", "agent", undefined, entry.summary)];
		case "branch_summary":
			return entry.summary ? [draft(entry.id, "branchSummary", "branch_summary", "agent", undefined, entry.summary)] : [];
		case "custom_message": {
			const text = textOf(entry.content, excluded);
			return text ? [draft(entry.id, "custom", "custom_message", authorshipOf(entry.attribution), entry.attribution, text)] : [];
		}
		case "message":
			break;
		default:
			return [];
	}

	const m = entry.message;
	switch (m.role) {
		case "user": {
			if (m.synthetic) {
				excluded.synthetic++;
				return [];
			}
			const text = textOf(m.content, excluded);
			return text ? [draft(entry.id, "user", "user_message", authorshipOf(m.attribution), m.attribution, text)] : [];
		}
		case "developer":
			excluded.synthetic++;
			return [];
		case "assistant": {
			if (m.retryRecovery) return [];
			// Preserve block order: consecutive text blocks form one part; each tool call is its own part.
			const parts: DraftPart[] = [];
			let texts: string[] = [];
			const flush = () => {
				const text = texts.join("\n");
				if (text) parts.push(draft(entry.id, "assistant", "assistant_message", "agent", undefined, text));
				texts = [];
			};
			for (const block of m.content) {
				if (block.type === "text") texts.push(block.text);
				else if (block.type === "toolCall") {
					flush();
					parts.push(
						draft(entry.id, "assistant", "tool_call", "agent", undefined, JSON.stringify(block.arguments), {
							name: block.name,
							call_id: block.id,
							is_error: false,
						}),
					);
				} else if (block.type === "thinking" || block.type === "redactedThinking") excluded.thinking++;
				else if (block.type === "image") excluded.images++;
				else excluded.other++;
			}
			flush();
			return parts;
		}
		case "toolResult":
			return [
				draft(entry.id, "toolResult", "tool_result", authorshipOf(m.attribution), m.attribution, textOf(m.content, excluded), {
					name: m.toolName,
					call_id: m.toolCallId,
					is_error: m.isError,
				}),
			];
		case "bashExecution": {
			excluded.images += m.images?.length ?? 0;
			const text = `$ ${m.command}\n${m.output}${m.cancelled ? "\n[cancelled]" : m.exitCode ? `\n[exit ${m.exitCode}]` : ""}`;
			return [draft(entry.id, "bashExecution", "bash_execution", "unknown", undefined, text)];
		}
		case "pythonExecution": {
			const text = `${m.code}\n--- output ---\n${m.output}${m.cancelled ? "\n[cancelled]" : m.exitCode ? `\n[exit ${m.exitCode}]` : ""}`;
			return [draft(entry.id, "pythonExecution", "python_execution", "unknown", undefined, text)];
		}
		case "custom":
		case "hookMessage": {
			const text = textOf(m.content, excluded);
			return text ? [draft(entry.id, m.role, "custom_message", authorshipOf(m.attribution), m.attribution, text)] : [];
		}
		default:
			excluded.other++;
			return [];
	}
}

/**
 * Partial-reply reducer over a live `message_update` message: the assistant's text blocks.
 * Call synchronously at capture time; the result is copied text.
 */
export function partialReply(message: MessageUpdateEvent["message"]): string | null {
	if (message.role !== "assistant") return null;
	return message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n") || null;
}

const STOPWORDS: Record<string, true> = Object.fromEntries(
	(
		"that this thing things stuff about what which when where there their them they then than with from into " +
		"have been were will would could should does doing done just like also some something more most much very " +
		"really earlier before after again here please want need know think mean meant said says your yours " +
		"why how part bit whole those these other only even still each same"
	)
		.split(" ")
		.map(word => [word, true as const]),
);

/** Anchor terms of a request: quoted substrings, path-like tokens, and lowercase words ≥ 4 chars minus stopwords. */
export function anchorTerms(request: string): string[] {
	const terms = new Set<string>();
	for (const m of request.matchAll(/"([^"]+)"|“([^”]+)”|`([^`]+)`/g)) terms.add((m[1] ?? m[2] ?? m[3]).trim().toLowerCase());
	for (const raw of request.split(/\s+/)) {
		const token = raw.replace(/^[("'`[<“]+|[)"'`\]>,;:!?.”]+$/g, "");
		if (token.includes("/") || /\.[a-z0-9]{1,8}$/i.test(token)) terms.add(token.toLowerCase());
	}
	for (const word of request.toLowerCase().split(/[^\p{L}\p{N}_]+/u))
		if (word.length >= 4 && !STOPWORDS[word]) terms.add(word);
	terms.delete("");
	return [...terms];
}

const bytesOf = (part: DraftPart) => part.segments.reduce((n, s) => n + Buffer.byteLength(s.text), 0);

/**
 * Builds the source packet from a frozen `getBranch()` copy (policy `tail+anchors/v1`):
 * 1. tail: newest eligible parts (after the in-flight reply, if any) until TAIL_MAX_PARTS / TAIL_MAX_BYTES;
 * 2. anchors: if the request has terms, older parts containing a term are retained with their
 *    immediate predecessor, newest first, until PACKET_MAX_PARTS / PACKET_MAX_BYTES;
 * 3. the window's compaction summary is always retained.
 * Retained parts keep branch order as s1…sN; the in-flight reply follows as p1 unless the
 * branch already holds that message (same timestamp). Only retained segments are redacted;
 * budgets are measured before redaction, which never lengthens text.
 */
export function buildPacket(
	branch: readonly SessionEntry[],
	requestText = "",
	inFlight: MessageUpdateEvent["message"] | null = null,
): SourcePacket {
	const window = selectEligible(branch);
	const excluded: Excluded = { thinking: 0, images: 0, synthetic: 0, other: 0 };
	const eligible = window.entries.flatMap(entry => normalizeEntry(entry, excluded));
	const persisted =
		inFlight !== null &&
		branch.some(e => e.type === "message" && e.message.role === "assistant" && e.message.timestamp === inFlight.timestamp);
	const partialText = inFlight && !persisted ? partialReply(inFlight) : null;
	const p1: SourcePart | null = partialText === null ? null : {
		id: "p1",
		entry_id: null,
		original_role: "assistant",
		kind: "assistant_message",
		authorship: "agent",
		attribution: null,
		tool: null,
		completeness: "partial",
		original_chars: partialText.length,
		segments: segmentsOf(partialText),
	};
	const keep = new Set<number>();
	let count = 0;
	let bytes = 0;
	if (window.boundary.kind === "compaction" && eligible[0]?.kind === "compaction_summary") {
		keep.add(0);
		count++;
		bytes += bytesOf(eligible[0]);
	}

	let tailCount = p1 ? 1 : 0;
	let tailBytes = p1 ? bytesOf(p1) : 0;
	let tailStart = eligible.length;
	for (let i = eligible.length - 1; i >= 0 && !keep.has(i); i--) {
		const size = bytesOf(eligible[i]);
		if (tailCount >= TAIL_MAX_PARTS || tailBytes + size > TAIL_MAX_BYTES) break;
		keep.add(i);
		tailCount++;
		tailBytes += size;
		tailStart = i;
	}
	count += tailCount;
	bytes += tailBytes;

	const terms = requestText.trim() ? anchorTerms(requestText) : [];
	for (let i = tailStart - 1; i >= 0 && terms.length > 0; i--) {
		if (keep.has(i)) continue;
		const haystack = eligible[i].segments.map(s => s.text).join("\n").toLowerCase();
		if (!terms.some(term => haystack.includes(term))) continue;
		const add = i > 0 && !keep.has(i - 1) ? [i, i - 1] : [i];
		const size = add.reduce((n, j) => n + bytesOf(eligible[j]), 0);
		if (count + add.length > PACKET_MAX_PARTS || bytes + size > PACKET_MAX_BYTES) break;
		for (const j of add) keep.add(j);
		count += add.length;
		bytes += size;
	}

	const parts: SourcePart[] = [];
	const omitted: Coverage["omitted"] = [];
	let gap = 0;
	for (let i = 0; i < eligible.length; i++) {
		if (!keep.has(i)) {
			gap++;
			continue;
		}
		const id = `s${parts.length + 1}`;
		if (gap > 0) omitted.push({ before_part: id, count: gap });
		gap = 0;
		parts.push({ id, ...eligible[i] });
	}
	if (gap > 0) omitted.push({ before_part: p1 ? "p1" : null, count: gap });
	if (p1) parts.push(p1);
	for (const part of parts) part.segments = part.segments.map(s => ({ start: s.start, text: redact(s.text) }));

	return {
		coverage: {
			policy: SELECTION_POLICY,
			boundary: window.boundary,
			eligible_parts: eligible.length + (p1 ? 1 : 0),
			retained_parts: parts.length,
			omitted,
			truncated_parts: parts.filter(p => p.completeness === "truncated").length,
			excluded,
			partial_included: p1 !== null,
		},
		parts,
	};
}
