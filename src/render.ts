// Read-only views of a record (plan task 4.2): Markdown is generated on demand, never stored.
// Evidence text comes from the saved packet, never from the model (brief D06).
import * as path from "node:path";
import type { CaptureRecord, SourcePart } from "./record";

const LIST_LABEL_MAX = 80;

const shortId = (record: CaptureRecord) => record.id.slice(0, 8).toUpperCase();
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * Saved text shown verbatim: a fenced block whose fence is longer than any backtick run in
 * the text, so nothing inside (headings, quotes, emphasis, fences) is parsed as Markdown.
 */
export function fenced(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}

/** Model- or provider-written text as one inert line: whitespace collapsed, Markdown punctuation escaped. */
const inline = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>#|~]/g, "\\$&");

function partHeading(part: SourcePart): string {
	const bits = [part.id, part.kind.replaceAll("_", " ")];
	if (part.tool) bits.push(`${inline(part.tool.name)} (call ${inline(part.tool.call_id)}${part.tool.is_error ? ", failed" : ""})`);
	bits.push(`by ${part.authorship}`);
	if (part.completeness === "truncated") bits.push(`truncated (${part.original_chars} chars)`);
	else if (part.completeness === "partial") bits.push(`partial: reply still being written (${part.original_chars} chars)`);
	return `### ${bits.join(" · ")}`;
}

function partBody(part: SourcePart): string {
	return part.segments
		.map((s, i, all) => {
			if (i === 0) return fenced(s.text);
			const prev = all[i - 1];
			const gap = Math.max(0, s.start - prev.start - prev.text.length);
			return `_[… ${gap} chars omitted …]_\n\n${fenced(s.text)}`;
		})
		.join("\n\n");
}

/** Full view: request, note, interpretation (labelled inferred), cited evidence, coverage, last error. */
export function renderMarkdown(record: CaptureRecord): string {
	const out: string[] = [];
	const { extraction: x, user_note: note, source_packet: packet } = record;
	out.push(`# Capture ${shortId(record)} · ${record.state.replace("_", " ")}`);
	out.push(`Captured ${utc(record.captured_at)} · project \`${path.basename(record.origin.cwd)}\` · revision ${record.revision}`);

	out.push("## Your request");
	out.push(record.request_text ? fenced(record.request_text) : "_(no text: bare /capture)_");

	if (note) {
		out.push("## Your note");
		out.push(fenced(note.text));
		out.push(`_Added at revision ${note.updated_revision}, ${utc(note.updated_at)}._`);
	}

	out.push("## Interpretation (inferred, not verified)");
	if (!x) out.push("_Pending: no interpretation yet._");
	else {
		if (note && x.input_revision < note.updated_revision)
			out.push(
				`_This interpretation predates your latest note (extracted from revision ${x.input_revision}; note at revision ${note.updated_revision}). Run /capture-retry to refresh it._`,
			);
		if (record.state === "needs_context" && x.missing_context) out.push(`**Missing context:** ${inline(x.missing_context)}`);
		const fields: [string, string | null][] = [
			["Topic", x.topic],
			["Question", x.question],
			["Situation", x.situation],
			["Trigger", x.trigger],
			["Relevance", x.relevance],
		];
		const present = fields.filter(([, v]) => v !== null && v.trim() !== "");
		if (present.length > 0) out.push(present.map(([k, v]) => `- **${k}:** ${inline(v as string)}`).join("\n"));
		if (record.state === "ready" && x.missing_context) out.push(`**Gaps noted:** ${inline(x.missing_context)}`);
		out.push(
			`_Extracted by ${inline(x.provider)}/${inline(x.model)} at ${utc(x.extracted_at)} from revision ${x.input_revision} (prompt v${x.prompt_version})._`,
		);
	}

	out.push("## Evidence");
	const cited = new Set(x?.evidence_ids ?? []);
	const parts = packet.parts.filter(p => cited.has(p.id));
	if (parts.length === 0)
		out.push(`_No interpretation cites evidence yet. ${packet.parts.length} saved part(s) are in the record (/capture-export ${shortId(record)} json)._`);
	for (const part of parts) out.push(partHeading(part), partBody(part));

	const c = packet.coverage;
	out.push("## Coverage");
	out.push(
		[
			`- Policy \`${c.policy}\`; window starts at ${c.boundary.kind === "root" ? "the session root" : `${c.boundary.kind.replace("_", " ")} ${c.boundary.entry_id}`}`,
			`- ${c.retained_parts} of ${c.eligible_parts} eligible parts kept; ${c.omitted.reduce((n, o) => n + o.count, 0)} omitted; ${c.truncated_parts} truncated`,
			`- Excluded: ${c.excluded.thinking} thinking, ${c.excluded.images} images, ${c.excluded.synthetic} synthetic, ${c.excluded.other} other`,
			`- In-flight reply included: ${c.partial_included ? "yes" : "no"}`,
		].join("\n"),
	);

	if (record.last_error) {
		out.push("## Last error");
		out.push(`\`${record.last_error.class}\` at ${utc(record.last_error.at)}: ${inline(record.last_error.message)}`);
	}
	return `${out.join("\n\n")}\n`;
}

/** One line: short id, local capture time, project, state, topic (or the request). */
export function renderListRow(record: CaptureRecord): string {
	const d = new Date(record.captured_at);
	const pad = (n: number) => String(n).padStart(2, "0");
	const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const raw = (record.extraction?.topic ?? record.request_text).replace(/\s+/g, " ").trim() || "(bare capture)";
	const label = raw.length > LIST_LABEL_MAX ? `${raw.slice(0, LIST_LABEL_MAX - 1)}…` : raw;
	return [shortId(record), when, path.basename(record.origin.cwd), record.state, label].join("  ");
}
