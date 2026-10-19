import { describe, expect, test } from "bun:test";
import { validateRecord } from "../src/record";
import fixture from "./fixtures/record-v1-ready.json";

const clone = (): any => structuredClone(fixture);

function errorsOf(record: unknown): string[] {
	const result = validateRecord(record);
	return result.ok ? [] : result.errors;
}

describe("validateRecord", () => {
	test("accepts the complete v1 ready fixture", () => {
		expect(errorsOf(clone())).toEqual([]);
	});

	test("rejects an unknown state", () => {
		const r = clone();
		r.state = "archived";
		expect(errorsOf(r)).toContainEqual(expect.stringMatching(/^state:/));
	});

	test.each(["request_text", "origin", "source_packet"])("rejects a record missing evidence field %s", field => {
		const r = clone();
		delete r[field];
		expect(errorsOf(r)).toContainEqual(expect.stringMatching(new RegExp(`^${field}`)));
	});

	test("rejects an evidence id that is not in the packet", () => {
		const r = clone();
		r.extraction.evidence_ids = ["s1", "s9"];
		expect(errorsOf(r)).toEqual(['extraction.evidence_ids: "s9" is not a part in the packet']);
	});

	test("rejects a raw record that carries an extraction, and a ready record without one", () => {
		const raw = clone();
		raw.state = "raw";
		expect(errorsOf(raw)).toEqual(["extraction: must be null for state raw"]);
		const ready = clone();
		ready.extraction = null;
		expect(errorsOf(ready)).toEqual(["extraction: required for state ready"]);
	});

	test("rejects a truncated part presented as one continuous segment", () => {
		const r = clone();
		r.source_packet.parts[2].segments = [r.source_packet.parts[2].segments[0]];
		expect(errorsOf(r)).toEqual(["source_packet.parts[2].segments: truncated part needs at least two segments"]);
	});

	test("rejects an omission gap pointing at a part that does not exist", () => {
		const r = clone();
		r.source_packet.coverage.omitted = [{ before_part: "s7", count: 1 }];
		expect(errorsOf(r)).toHaveLength(1);
	});

	test("rejects coverage counts and revisions that contradict the record", () => {
		const counts = clone();
		counts.source_packet.coverage.retained_parts = 99;
		expect(errorsOf(counts)).toEqual(["source_packet.coverage.retained_parts: expected 4 (parts in packet)"]);
		const revisions = clone();
		revisions.extraction.input_revision = 3;
		revisions.user_note.updated_revision = 3;
		expect(errorsOf(revisions)).toEqual([
			"extraction.input_revision: exceeds revision",
			"user_note.updated_revision: exceeds revision",
		]);
	});
});
