// Record store: one `<uuid>.json` per capture, published atomically (plan AD1, task 1.5) and
// mutated only under the cross-process record lock (plan AD3, task 3.4).
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, withFileLock } from "@oh-my-pi/pi-utils";
import { type CaptureRecord, validateRecord } from "./record";

/** `OMP_CAPTURE_DIR`, else `<agent dir>/captures`. Pure: the directory is created on publish. */
export function resolveStoreDir(): string {
	return process.env.OMP_CAPTURE_DIR || path.join(getAgentDir(), "captures");
}

/**
 * Validates, writes a private temp file in `dir`, fsyncs it, then renames it onto
 * `<id>.json` (creating or replacing it). A live record is never truncated; on failure the
 * temp file is removed and the error rethrown. Replacement goes through `updateGuarded`.
 */
export async function publishRecord(dir: string, record: CaptureRecord): Promise<string> {
	const result = validateRecord(record);
	if (!result.ok) throw new Error(`invalid record: ${result.errors.join("; ")}`);
	const body = `${JSON.stringify(record, null, 2)}\n`;

	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const target = path.join(dir, `${record.id}.json`);
	const temp = path.join(dir, `.${record.id}.${randomBytes(6).toString("hex")}.tmp`);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temp, "wx", 0o600);
		await handle.writeFile(body, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temp, target);
	} catch (error) {
		await handle?.close().catch(() => {});
		await fs.unlink(temp).catch(() => {});
		throw error;
	}
	return target;
}

export async function readRecord(file: string): Promise<CaptureRecord> {
	const result = validateRecord(JSON.parse(await fs.readFile(file, "utf8")));
	if (!result.ok) throw new Error(`${file}: ${result.errors.join("; ")}`);
	return result.record;
}

/**
 * Writes a snapshot of record `id` to `<dir>/exports/<SHORT>-r<revision>.<format>` and returns
 * its path. The canonical file is read once, so the name always matches the content: JSON is
 * a byte copy of those bytes, Markdown is `render` of the record they hold. Never touches the record.
 */
export async function exportRecord(
	dir: string,
	id: string,
	format: "md" | "json",
	render: (record: CaptureRecord) => string,
): Promise<string> {
	const bytes = await fs.readFile(path.join(dir, `${id}.json`));
	const result = validateRecord(JSON.parse(bytes.toString("utf8")));
	if (!result.ok) throw new Error(`${id}: ${result.errors.join("; ")}`);
	const record = result.record;
	const target = path.join(dir, "exports", `${record.id.slice(0, 8).toUpperCase()}-r${record.revision}.${format}`);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await fs.writeFile(target, format === "json" ? bytes : render(record), { mode: 0o600 });
	await fs.chmod(target, 0o600);
	return target;
}

/** The store's valid records, newest first, plus the names of skipped unreadable files. */
export interface Listing {
	records: CaptureRecord[];
	invalid: string[];
}

/**
 * Every valid record in `dir`, newest first. Only `*.json` files count (temp files are
 * dot-prefixed, locks end in `.lock`, exports live in a subdirectory); unreadable or invalid
 * files are skipped and named in `invalid`. A store that does not exist yet is empty.
 */
export async function listRecords(dir: string): Promise<Listing> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], invalid: [] };
		throw error;
	}
	const records: CaptureRecord[] = [];
	const invalid: string[] = [];
	for (const name of names.filter(n => n.endsWith(".json") && !n.startsWith(".")).sort()) {
		try {
			records.push(await readRecord(path.join(dir, name)));
		} catch {
			invalid.push(name);
		}
	}
	records.sort((a, b) => b.captured_at.localeCompare(a.captured_at));
	return { records, invalid };
}

/** The one record whose id starts with `prefix` (case-insensitive, ≥ 4 hex chars); throws a user-facing message otherwise. */
export function resolveId(records: readonly CaptureRecord[], prefix: string): CaptureRecord {
	const wanted = prefix.trim().toLowerCase();
	if (!/^[0-9a-f][0-9a-f-]{3,}$/.test(wanted) || wanted.replaceAll("-", "").length < 4)
		throw new Error(`Capture id needs at least 4 hex characters, got "${prefix.trim()}"`);
	const matches = records.filter(r => r.id.startsWith(wanted));
	if (matches.length === 0) throw new Error(`No capture matches ${prefix.trim()}`);
	if (matches.length > 1)
		throw new Error(`Ambiguous capture id ${prefix.trim()}: ${matches.map(r => r.id.slice(0, 8).toUpperCase()).join(", ")}`);
	return matches[0];
}

/** Evidence is immutable after first publish (plan AD1). */
const EVIDENCE_KEYS = ["schema_version", "id", "captured_at", "request_text", "origin", "source_packet"] as const;

/**
 * Read → mutate → publish under an OS lock on `<id>.json.lock` (released on process death).
 * `mutate` returns the next record at exactly `revision + 1`, or null to discard. Never call
 * it around model inference: the lock is held only for read and publish.
 */
export async function updateGuarded(
	dir: string,
	id: string,
	mutate: (current: CaptureRecord) => CaptureRecord | null,
): Promise<CaptureRecord | null> {
	const file = path.join(dir, `${id}.json`);
	return withFileLock(file, async () => {
		const current = await readRecord(file);
		const next = mutate(current);
		if (next === null) return null;
		if (next.revision !== current.revision + 1)
			throw new Error(`${id}: update must publish revision ${current.revision + 1}, got ${next.revision}`);
		const changed = EVIDENCE_KEYS.filter(k => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
		if (changed.length > 0) throw new Error(`${id}: evidence is immutable (${changed.join(", ")})`);
		await publishRecord(dir, next);
		return next;
	});
}
