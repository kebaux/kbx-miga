// Canonical capture record, schema v1 (plan AD1; brief §8).
// Evidence (request_text, origin, source_packet) is immutable after first publish;
// interpretation lives only under `extraction`.

export const SCHEMA_VERSION = 1;

// Source budgets (plan "Defaults adopted"). `coverage.policy` names this set; bump its
// version whenever a constant changes. Per-part limits are UTF-16 chars (segment offsets
// use the same unit); packet limits are UTF-8 bytes of saved segment text. The in-flight
// reply has no separate cap: it is read once at capture and cut like any other part.
export const PART_MAX_CHARS = 8 * 1024;
export const PART_HEAD_CHARS = 4 * 1024;
export const TAIL_MAX_PARTS = 40;
export const TAIL_MAX_BYTES = 64 * 1024;
export const PACKET_MAX_PARTS = 60;
export const PACKET_MAX_BYTES = 96 * 1024;
export const MODEL_INPUT_MAX_BYTES = 120 * 1024;
export const MODEL_MAX_TOKENS = 2000;

export type CaptureState = "raw" | "ready" | "needs_context";
export const CAPTURE_STATES: readonly CaptureState[] = ["raw", "ready", "needs_context"];

export type PartKind =
	| "user_message"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "bash_execution"
	| "python_execution"
	| "custom_message"
	| "compaction_summary"
	| "branch_summary";
export const PART_KINDS: readonly PartKind[] = [
	"user_message",
	"assistant_message",
	"tool_call",
	"tool_result",
	"bash_execution",
	"python_execution",
	"custom_message",
	"compaction_summary",
	"branch_summary",
];

/** "user" means OMP attributed the content to the user, not proven human authorship. */
export type Authorship = "user" | "agent" | "unknown";
export type Completeness = "complete" | "truncated" | "partial";

/** A run of the original text starting at UTF-16 offset `start`. Separate segments are never contiguous quotes. */
export interface Segment {
	start: number;
	text: string;
}

export interface SourcePart {
	/** `s<n>` for branch parts, `p<n>` for capture-owned partial parts. */
	id: string;
	entry_id: string | null;
	original_role: string;
	kind: PartKind;
	authorship: Authorship;
	attribution: string | null;
	tool: { name: string; call_id: string; is_error: boolean } | null;
	completeness: Completeness;
	/** UTF-16 length of the original text before truncation and redaction. */
	original_chars: number;
	segments: Segment[];
}

export interface Coverage {
	policy: string;
	boundary: { kind: "root" | "reset_boundary" | "compaction"; entry_id: string | null };
	eligible_parts: number;
	retained_parts: number;
	/** `before_part` is the retained part id following the gap, or null for a gap at the end. */
	omitted: { before_part: string | null; count: number }[];
	truncated_parts: number;
	excluded: { thinking: number; images: number; synthetic: number; other: number };
	partial_included: boolean;
}

export interface SourcePacket {
	coverage: Coverage;
	parts: SourcePart[];
}

export interface Origin {
	harness: "omp";
	session_id: string;
	session_file: string | null;
	cwd: string;
	leaf_id: string | null;
}

export interface Extraction {
	input_revision: number;
	prompt_version: number;
	extracted_at: string;
	provider: string;
	model: string;
	topic: string | null;
	situation: string | null;
	trigger: string | null;
	question: string | null;
	relevance: string | null;
	evidence_ids: string[];
	missing_context: string | null;
}

export interface UserNote {
	text: string;
	updated_at: string;
	updated_revision: number;
}

export interface LastError {
	at: string;
	class: string;
	message: string;
}

export interface CaptureRecord {
	schema_version: typeof SCHEMA_VERSION;
	id: string;
	revision: number;
	captured_at: string;
	request_text: string;
	origin: Origin;
	/** Milliseconds from command dispatch until the record was frozen for publication. */
	timing: { publish_ms: number };
	source_packet: SourcePacket;
	state: CaptureState;
	extraction: Extraction | null;
	user_note: UserNote | null;
	last_error: LastError | null;
}

/**
 * Next record with the user's note (brief D08): a separately attributed annotation at the
 * next revision. Evidence and any earlier interpretation stay; the view marks the latter as
 * predating the note, and an in-flight extraction from the old revision is discarded.
 */
export function applyNote(current: CaptureRecord, text: string, now: string): CaptureRecord {
	const revision = current.revision + 1;
	return { ...current, revision, user_note: { text, updated_at: now, updated_revision: revision } };
}

export type ValidationResult = { ok: true; record: CaptureRecord } | { ok: false; errors: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART_ID_RE = /^[sp][1-9][0-9]*$/;

type Obj = { [key: string]: unknown };

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNat(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isIso(v: unknown): v is string {
	return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** Hand-written structural validation (runs outside OMP, where `pi.zod` is not injected). */
export function validateRecord(input: unknown): ValidationResult {
	const errors: string[] = [];
	const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
	const str = (o: Obj, k: string, path: string) => {
		if (typeof o[k] !== "string") err(`${path}.${k}`, "expected string");
	};
	const strOrNull = (o: Obj, k: string, path: string) => {
		if (o[k] !== null && typeof o[k] !== "string") err(`${path}.${k}`, "expected string or null");
	};

	if (!isObj(input)) return { ok: false, errors: ["record: expected object"] };
	const r = input;

	if (r.schema_version !== SCHEMA_VERSION) err("schema_version", `expected ${SCHEMA_VERSION}`);
	if (typeof r.id !== "string" || !UUID_RE.test(r.id)) err("id", "expected lowercase UUID");
	if (!isNat(r.revision) || r.revision < 1) err("revision", "expected integer >= 1");
	if (!isIso(r.captured_at)) err("captured_at", "expected ISO timestamp");
	if (typeof r.request_text !== "string") err("request_text", "expected string");

	if (!isObj(r.origin)) err("origin", "expected object");
	else {
		const o = r.origin;
		if (o.harness !== "omp") err("origin.harness", 'expected "omp"');
		str(o, "session_id", "origin");
		strOrNull(o, "session_file", "origin");
		str(o, "cwd", "origin");
		strOrNull(o, "leaf_id", "origin");
	}

	if (!isObj(r.timing) || !isNat(r.timing.publish_ms)) err("timing.publish_ms", "expected integer >= 0");

	const partIds = new Set<string>();
	if (!isObj(r.source_packet)) err("source_packet", "expected object");
	else {
		const p = r.source_packet;
		if (!Array.isArray(p.parts)) err("source_packet.parts", "expected array");
		else p.parts.forEach((part, i) => validatePart(part, `source_packet.parts[${i}]`, partIds, err));
		if (!isObj(p.coverage)) err("source_packet.coverage", "expected object");
		else validateCoverage(p.coverage, partIds, err);
	}

	if (typeof r.state !== "string" || !CAPTURE_STATES.includes(r.state as CaptureState))
		err("state", `expected one of ${CAPTURE_STATES.join("|")}`);

	if (r.extraction === null) {
		if (r.state === "ready" || r.state === "needs_context") err("extraction", `required for state ${r.state}`);
	} else if (!isObj(r.extraction)) err("extraction", "expected object or null");
	else {
		const e = r.extraction;
		if (r.state === "raw") err("extraction", "must be null for state raw");
		if (!isNat(e.input_revision) || e.input_revision < 1) err("extraction.input_revision", "expected integer >= 1");
		else if (isNat(r.revision) && e.input_revision > r.revision) err("extraction.input_revision", "exceeds revision");
		if (!isNat(e.prompt_version)) err("extraction.prompt_version", "expected integer");
		if (!isIso(e.extracted_at)) err("extraction.extracted_at", "expected ISO timestamp");
		str(e, "provider", "extraction");
		str(e, "model", "extraction");
		for (const k of ["topic", "situation", "trigger", "question", "relevance", "missing_context"])
			strOrNull(e, k, "extraction");
		if (!Array.isArray(e.evidence_ids)) err("extraction.evidence_ids", "expected array");
		else
			for (const id of e.evidence_ids)
				if (typeof id !== "string" || !partIds.has(id))
					err("extraction.evidence_ids", `${JSON.stringify(id)} is not a part in the packet`);
	}

	if (r.user_note !== null) {
		if (!isObj(r.user_note)) err("user_note", "expected object or null");
		else {
			str(r.user_note, "text", "user_note");
			if (!isIso(r.user_note.updated_at)) err("user_note.updated_at", "expected ISO timestamp");
			if (!isNat(r.user_note.updated_revision)) err("user_note.updated_revision", "expected integer");
			else if (isNat(r.revision) && r.user_note.updated_revision > r.revision)
				err("user_note.updated_revision", "exceeds revision");
		}
	}

	if (r.last_error !== null) {
		if (!isObj(r.last_error)) err("last_error", "expected object or null");
		else {
			if (!isIso(r.last_error.at)) err("last_error.at", "expected ISO timestamp");
			str(r.last_error, "class", "last_error");
			if (typeof r.last_error.message !== "string" || r.last_error.message.length > 500)
				err("last_error.message", "expected string of at most 500 chars");
		}
	}

	return errors.length === 0 ? { ok: true, record: r as unknown as CaptureRecord } : { ok: false, errors };
}

function validatePart(part: unknown, path: string, ids: Set<string>, err: (p: string, m: string) => void): void {
	if (!isObj(part)) return err(path, "expected object");
	if (typeof part.id !== "string" || !PART_ID_RE.test(part.id)) err(`${path}.id`, "expected s<n> or p<n>");
	else if (ids.has(part.id)) err(`${path}.id`, `duplicate ${part.id}`);
	else ids.add(part.id);
	if (part.entry_id !== null && typeof part.entry_id !== "string") err(`${path}.entry_id`, "expected string or null");
	if (typeof part.original_role !== "string") err(`${path}.original_role`, "expected string");
	if (!PART_KINDS.includes(part.kind as PartKind)) err(`${path}.kind`, "unknown kind");
	if (!["user", "agent", "unknown"].includes(part.authorship as string)) err(`${path}.authorship`, "unknown authorship");
	if (part.attribution !== null && typeof part.attribution !== "string")
		err(`${path}.attribution`, "expected string or null");
	if (part.tool !== null) {
		const t = part.tool;
		if (!isObj(t) || typeof t.name !== "string" || typeof t.call_id !== "string" || typeof t.is_error !== "boolean")
			err(`${path}.tool`, "expected {name, call_id, is_error} or null");
	}
	if (!["complete", "truncated", "partial"].includes(part.completeness as string))
		err(`${path}.completeness`, "unknown completeness");
	if (!isNat(part.original_chars)) err(`${path}.original_chars`, "expected integer >= 0");
	if (!Array.isArray(part.segments) || part.segments.length === 0) return err(`${path}.segments`, "expected nonempty array");
	let next = 0;
	part.segments.forEach((s, i) => {
		if (!isObj(s) || !isNat(s.start) || typeof s.text !== "string")
			return err(`${path}.segments[${i}]`, "expected {start, text}");
		// Strictly increasing starts only: redaction (Phase 2) may change segment lengths.
		if (s.start < next) err(`${path}.segments[${i}].start`, "segment starts must strictly increase");
		next = s.start + 1;
	});
	if (part.completeness === "truncated" && part.segments.length < 2)
		err(`${path}.segments`, "truncated part needs at least two segments");
}

function validateCoverage(c: Obj, ids: Set<string>, err: (p: string, m: string) => void): void {
	const path = "source_packet.coverage";
	if (typeof c.policy !== "string" || c.policy === "") err(`${path}.policy`, "expected nonempty string");
	const b = c.boundary;
	if (!isObj(b) || !["root", "reset_boundary", "compaction"].includes(b.kind as string))
		err(`${path}.boundary`, "expected {kind: root|reset_boundary|compaction, entry_id}");
	else if (b.kind === "root" ? b.entry_id !== null : typeof b.entry_id !== "string")
		err(`${path}.boundary.entry_id`, "null for root, string otherwise");
	for (const k of ["eligible_parts", "retained_parts", "truncated_parts"])
		if (!isNat(c[k])) err(`${path}.${k}`, "expected integer >= 0");
	if (c.retained_parts !== ids.size) err(`${path}.retained_parts`, `expected ${ids.size} (parts in packet)`);
	if (isNat(c.eligible_parts) && c.eligible_parts < ids.size) err(`${path}.eligible_parts`, "fewer than retained parts");
	if (!Array.isArray(c.omitted)) err(`${path}.omitted`, "expected array");
	else
		c.omitted.forEach((o, i) => {
			if (!isObj(o) || !isNat(o.count) || o.count < 1 || (o.before_part !== null && !ids.has(o.before_part as string)))
				err(`${path}.omitted[${i}]`, "expected {before_part: packet part id|null, count >= 1}");
		});
	const x = c.excluded;
	if (!isObj(x) || !["thinking", "images", "synthetic", "other"].every(k => isNat(x[k])))
		err(`${path}.excluded`, "expected {thinking, images, synthetic, other} counts");
	if (typeof c.partial_included !== "boolean") err(`${path}.partial_included`, "expected boolean");
}
