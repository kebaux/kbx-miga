import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyFailure, applyProposal, ExtractionError } from "../src/extract";
import { applyNote, type CaptureRecord } from "../src/record";
import { renderMarkdown } from "../src/render";
import { exportRecord, listRecords, publishRecord, readRecord, resolveId, updateGuarded } from "../src/store";
import fixture from "./fixtures/record-v1-ready.json";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.chmodSync(root, 0o700);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
const tempRoot = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-capture-test-"));
	roots.push(root);
	return root;
};
const record = (): CaptureRecord => ({ ...structuredClone(fixture as CaptureRecord), id: crypto.randomUUID() });

describe("publishRecord", () => {
	test("published record reopens and validates, private, with no temp left", async () => {
		const dir = path.join(tempRoot(), "captures");
		const r = record();
		const file = await publishRecord(dir, r);

		expect(file).toBe(path.join(dir, `${r.id}.json`));
		expect(await readRecord(file)).toEqual(r);
		expect(fs.readdirSync(dir)).toEqual([`${r.id}.json`]);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	});

	test("unwritable store throws and leaves no file (A14)", async () => {
		const root = tempRoot();
		fs.chmodSync(root, 0o500);
		await expect(publishRecord(path.join(root, "store"), record())).rejects.toThrow(/EACCES/);
		expect(fs.readdirSync(root)).toEqual([]);
	});

	test("write failure after the temp exists removes the temp and publishes nothing", async () => {
		const dir = tempRoot();
		const r = record();
		fs.mkdirSync(path.join(dir, `${r.id}.json`)); // rename onto a directory fails
		await expect(publishRecord(dir, r)).rejects.toThrow();
		expect(fs.readdirSync(dir)).toEqual([`${r.id}.json`]);
	});

	test("invalid record is refused before anything is written", async () => {
		const dir = path.join(tempRoot(), "captures");
		await expect(publishRecord(dir, { ...record(), state: "archived" } as any)).rejects.toThrow(/state/);
		expect(fs.existsSync(dir)).toBe(false);
	});

	test("path with spaces and Unicode works (A14)", async () => {
		const dir = path.join(tempRoot(), "my captures", "Lernnotizen — 学习 ✓");
		const r = { ...record(), request_text: "wörld  ✓ 学习" };
		const file = await publishRecord(dir, r);
		expect((await readRecord(file)).request_text).toBe("wörld  ✓ 学习");
	});
});

describe("updateGuarded (AD3)", () => {
	const now = "2026-10-18T03:00:00.000Z";
	const proposal = {
		outcome: "ready" as const,
		topic: "New topic",
		situation: "s",
		trigger: null,
		question: "q?",
		relevance: null,
		evidence_ids: ["s1"],
		missing_context: null,
	};

	test("failed retry of a ready record keeps prior extraction", async () => {
		const dir = tempRoot();
		const r = record();
		await publishRecord(dir, r);
		const next = await updateGuarded(dir, r.id, current => applyFailure(current, r.revision, new ExtractionError("aborted", "timed out"), now));
		const onDisk = await readRecord(path.join(dir, `${r.id}.json`));
		expect(onDisk).toEqual(next as CaptureRecord);
		expect(onDisk).toMatchObject({ revision: r.revision + 1, state: "ready", extraction: r.extraction });
		expect(onDisk.last_error).toEqual({ at: now, class: "aborted", message: "timed out" });
	});

	test("note during in-flight extraction makes the stale proposal discard (A11)", async () => {
		const dir = tempRoot();
		const r = { ...record(), revision: 1, state: "raw" as const, extraction: null, user_note: null };
		await publishRecord(dir, r);
		// Extraction started at revision 1; the user's note lands before its proposal.
		await updateGuarded(dir, r.id, current => applyNote(current, "I meant the ack ordering", now));
		const result = await updateGuarded(dir, r.id, current =>
			applyProposal(current, { inputRevision: 1, proposal, provider: "p", model: "m", now }),
		);
		expect(result).toBeNull();
		expect(await readRecord(path.join(dir, `${r.id}.json`))).toMatchObject({
			revision: 2,
			state: "raw",
			extraction: null,
			user_note: { text: "I meant the ack ordering", updated_at: now, updated_revision: 2 },
		});
	});

	test("a mutator cannot skip or reuse a revision", async () => {
		const dir = tempRoot();
		const r = record();
		await publishRecord(dir, r);
		await expect(updateGuarded(dir, r.id, current => ({ ...current, revision: current.revision + 2 }))).rejects.toThrow(/revision/);
		expect((await readRecord(path.join(dir, `${r.id}.json`))).revision).toBe(r.revision);
	});
});

describe("listing and lookup", () => {
	const withId = (id: string, captured_at: string): CaptureRecord => ({ ...record(), id, captured_at });
	const a = withId("aaaa1111-0000-4000-8000-000000000001", "2026-10-18T01:00:00.000Z");
	const b = withId("aaaa2222-0000-4000-8000-000000000002", "2026-10-18T03:00:00.000Z");
	const c = withId("bbbb3333-0000-4000-8000-000000000003", "2026-10-18T02:00:00.000Z");

	test("temp, lock, export and invalid files are ignored; newest first", async () => {
		const dir = tempRoot();
		for (const r of [a, b, c]) await publishRecord(dir, r);
		fs.writeFileSync(path.join(dir, `.${a.id}.abc.tmp`), "{partial");
		fs.writeFileSync(path.join(dir, `${a.id}.json.lock`), "");
		fs.mkdirSync(path.join(dir, "exports"));
		fs.writeFileSync(path.join(dir, "exports", "AAAA1111-r2.json"), "{}");
		fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
		const { records, invalid } = await listRecords(dir);
		expect(records.map(r => r.id)).toEqual([b.id, c.id, a.id]);
		expect(invalid).toEqual(["broken.json"]);
	});

	test("a missing store lists nothing", async () => {
		expect(await listRecords(path.join(tempRoot(), "never-created"))).toEqual({ records: [], invalid: [] });
	});

	test("ambiguous prefix rejected (A12); unique prefix resolves case-insensitively", () => {
		expect(() => resolveId([a, b, c], "aaaa")).toThrow("Ambiguous capture id aaaa: AAAA1111, AAAA2222");
		expect(resolveId([a, b, c], "AAAA2").id).toBe(b.id);
		expect(resolveId([a, b, c], "bbbb3333-0000").id).toBe(c.id);
		expect(() => resolveId([a, b, c], "cccc")).toThrow("No capture matches cccc");
		expect(() => resolveId([a, b, c], "aa")).toThrow(/at least 4/);
		expect(() => resolveId([a, b, c], "zzzz")).toThrow(/at least 4/);
	});

	test("editing or deleting an export leaves the record unchanged (A16)", async () => {
		const dir = tempRoot();
		const r = record();
		const file = await publishRecord(dir, r);
		const before = fs.readFileSync(file);
		const json = await exportRecord(dir, r.id, "json", renderMarkdown);
		const md = await exportRecord(dir, r.id, "md", renderMarkdown);
		expect(path.basename(json)).toBe(`${r.id.slice(0, 8).toUpperCase()}-r${r.revision}.json`);
		expect(fs.readFileSync(json)).toEqual(before);
		expect(fs.readFileSync(md, "utf8")).toBe(renderMarkdown(r));
		expect(fs.statSync(md).mode & 0o777).toBe(0o600);
		fs.writeFileSync(md, "edited by hand");
		fs.rmSync(json);
		expect(fs.readFileSync(file)).toEqual(before);
		expect((await listRecords(dir)).records.map(x => x.id)).toEqual([r.id]);
	});
});

describe("killed-process recovery (A13)", () => {
	const repo = path.resolve(import.meta.dir, "..");
	/**
	 * Runs `code` in a child bun, waits for it to print READY, then SIGKILLs it. The child's
	 * long sleep only holds its lock or temp file open until the kill; nothing waits on it.
	 */
	async function killAfterReady(code: string): Promise<void> {
		const child = Bun.spawn(["bun", "-e", code], { cwd: repo, stdout: "pipe", stderr: "inherit" });
		const reader = child.stdout.getReader();
		let out = "";
		while (!out.includes("READY")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`child exited before READY: ${out}`);
			out += new TextDecoder().decode(value);
		}
		child.kill("SIGKILL");
		await child.exited;
	}

	test("a lock held by a killed process is released; the next writer acquires within 1 s", async () => {
		const dir = tempRoot();
		const r = record();
		const file = await publishRecord(dir, r);
		await killAfterReady(
			`import { withFileLock } from "@oh-my-pi/pi-utils"; await withFileLock(${JSON.stringify(file)}, async () => { console.log("READY"); await Bun.sleep(60_000); });`,
		);
		const started = performance.now();
		const next = await updateGuarded(dir, r.id, current => applyNote(current, "after the crash", "2026-10-18T03:00:00.000Z"));
		expect(performance.now() - started).toBeLessThan(1000);
		expect(next?.revision).toBe(r.revision + 1);
	});

	test("a kill between temp write and rename leaves the previous record readable and the temp unlisted", async () => {
		const dir = tempRoot();
		const r = record();
		const file = await publishRecord(dir, r);
		const temp = path.join(dir, `.${r.id}.dead.tmp`);
		await killAfterReady(
			`import * as fs from "node:fs/promises"; const h = await fs.open(${JSON.stringify(temp)}, "wx", 0o600); await h.writeFile('{"half":'); await h.sync(); console.log("READY"); await Bun.sleep(60_000);`,
		);
		expect(fs.existsSync(temp)).toBe(true);
		expect(await readRecord(file)).toEqual(r);
		expect((await listRecords(dir)).records.map(x => x.id)).toEqual([r.id]);
		// The next writer still publishes; the stray temp is neither renamed nor counted.
		const next = await updateGuarded(dir, r.id, current => applyNote(current, "after the crash", "2026-10-18T03:00:00.000Z"));
		expect(await readRecord(file)).toEqual(next as CaptureRecord);
		expect(fs.readFileSync(temp, "utf8")).toBe('{"half":');
		expect(fs.readdirSync(dir).filter(n => n.endsWith(".json"))).toEqual([`${r.id}.json`]);
	});
});
