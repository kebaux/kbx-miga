// Usage: bun scripts/pilot-report.ts [--require-records N] [--require-days N] [--require-assessment FILE]
// Pilot report over the default store (`OMP_CAPTURE_DIR`, else `<agent dir>/captures`); no model calls.
// Prints the report, then one `FAIL: …` line per unmet requirement and exits 1 if any.
import * as fs from "node:fs";
import { type CaptureRecord, CAPTURE_STATES } from "../src/record";
import { listRecords, resolveId, resolveStoreDir } from "../src/store";

const USAGE = "usage: pilot-report.ts [--require-records N] [--require-days N] [--require-assessment FILE]";
const FLAGS = ["--require-records", "--require-days", "--require-assessment"];
const ASSESSMENT_MIN_ROWS = 10;

const args = process.argv.slice(2);
const opts: { [flag: string]: string } = {};
for (let i = 0; i < args.length; i += 2) {
	if (!FLAGS.includes(args[i]) || args[i + 1] === undefined) {
		console.error(`FAIL: bad argument ${args[i]}\n${USAGE}`);
		process.exit(2);
	}
	opts[args[i]] = args[i + 1];
}
const count = (flag: string): number | null => {
	if (opts[flag] === undefined) return null;
	const n = Number(opts[flag]);
	if (!Number.isInteger(n) || n < 0) {
		console.error(`FAIL: ${flag} expects an integer >= 0\n${USAGE}`);
		process.exit(2);
	}
	return n;
};
const needRecords = count("--require-records");
const needDays = count("--require-days");

/** Nearest-rank percentile of an ascending array, or null when empty. */
const percentile = (sorted: readonly number[], p: number): number | null =>
	sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
const show = (n: number | null, unit: string) => (n === null ? "n/a" : `${n} ${unit}`);
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : "n/a");

const localDate = (iso: string) => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const packetBytes = (r: CaptureRecord) =>
	r.source_packet.parts.reduce((n, part) => n + part.segments.reduce((m, s) => m + Buffer.byteLength(s.text), 0), 0);

const dir = resolveStoreDir();
const { records, invalid } = await listRecords(dir);
const total = records.length;

const byState = new Map(CAPTURE_STATES.map(s => [s, 0]));
for (const r of records) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);

const dates = new Map<string, number>();
for (const r of records) dates.set(localDate(r.captured_at), (dates.get(localDate(r.captured_at)) ?? 0) + 1);

// `last_error` holds the latest failed attempt and is cleared when an extraction succeeds.
const errors = new Map<string, number>();
for (const r of records) if (r.last_error) errors.set(r.last_error.class, (errors.get(r.last_error.class) ?? 0) + 1);
const failed = [...errors.values()].reduce((a, b) => a + b, 0);
const pendingRaw = records.filter(r => r.state === "raw" && !r.last_error).length;

const bytes = records.map(packetBytes).sort((a, b) => a - b);
const freeze = records.map(r => r.timing.publish_ms).sort((a, b) => a - b);
const emptyRequest = records.filter(r => r.request_text.trim() === "").length;

const out: string[] = [];
out.push(`Store: ${dir}`);
out.push(`Records: ${total}${invalid.length ? ` (${invalid.length} unreadable skipped: ${invalid.join(", ")})` : ""}`);
out.push("");
out.push("By state:");
for (const [state, n] of byState) out.push(`  ${state.padEnd(14)} ${n}`);
out.push("");
out.push(`Distinct local capture dates: ${dates.size}`);
for (const [date, n] of [...dates].sort()) out.push(`  ${date}  ${n}`);
out.push("");
out.push(`Extraction failures (current last_error, % of records): ${failed} (${pct(failed, total)})`);
for (const [cls, n] of [...errors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
	out.push(`  ${cls.padEnd(14)} ${n} (${pct(n, total)})`);
out.push(`  raw, no error  ${pendingRaw} (extraction in flight or interrupted; /capture-retry)`);
out.push("");
out.push(
	`Packet bytes: p50 ${show(percentile(bytes, 50), "B")} · p90 ${show(percentile(bytes, 90), "B")} · max ${show(bytes.at(-1) ?? null, "B")}`,
);
out.push(
	`Freeze latency (dispatch → record frozen; excludes write/fsync/rename): p50 ${show(percentile(freeze, 50), "ms")} · p90 ${show(percentile(freeze, 90), "ms")}`,
);
out.push(`Empty request_text: ${emptyRequest}`);

const failures: string[] = [];
if (needRecords !== null && total < needRecords) failures.push(`${total} records (need ${needRecords})`);
if (needDays !== null && dates.size < needDays) failures.push(`${dates.size} distinct capture dates (need ${needDays})`);

const assessmentPath = opts["--require-assessment"];
if (assessmentPath !== undefined) {
	const a = readAssessment(assessmentPath, records);
	out.push("");
	if (!a) {
		failures.push(`assessment ${assessmentPath} not found`);
	} else {
		out.push(`Assessment ${assessmentPath}:`);
		out.push(`  reviewed captures  ${a.reviewed} (${a.rejected.length} rows not counted)`);
		for (const why of a.rejected) out.push(`    ${why}`);
		out.push(`  comparison rows    ${a.comparisons}`);
		out.push(`  decision written   ${a.decision ? "yes" : "no"}`);
		if (a.reviewed < ASSESSMENT_MIN_ROWS) failures.push(`${a.reviewed} reviewed captures in assessment (need ${ASSESSMENT_MIN_ROWS})`);
		if (!a.decision) failures.push(`assessment Decision section is empty`);
	}
}

console.log(out.join("\n"));
for (const f of failures) console.error(`FAIL: ${f}`);
process.exit(failures.length ? 1 : 0);

/**
 * Reads the assessment's "Reviewed captures" and comparison tables and whether the
 * "Decision" section has any text outside HTML comments. A reviewed row names a capture
 * in the store (same id rules as `/capture-show`), uses y/n/partial in the five judgement
 * columns, and fills Correction; each capture counts once. Other rows are listed with the reason.
 */
function readAssessment(
	file: string,
	store: readonly CaptureRecord[],
): { reviewed: number; rejected: string[]; comparisons: number; decision: boolean } | null {
	if (!fs.existsSync(file)) return null;
	const text = fs
		.readFileSync(file, "utf8")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!--[\s\S]*$/, "");
	const sections = new Map<string, string[]>();
	let current = "";
	for (const line of text.split(/\r?\n/)) {
		const heading = /^##\s+(.*)$/.exec(line);
		if (heading) current = heading[1].trim().toLowerCase();
		else sections.set(current, [...(sections.get(current) ?? []), line]);
	}
	const section = (name: string) => [...sections].find(([heading]) => heading.includes(name))?.[1] ?? [];
	// Table body rows (header and `|---|` separator skipped); `\|` stays inside its cell.
	const rows = (lines: string[]) =>
		lines
			.map(l => l.trim())
			.filter(l => l.startsWith("|"))
			.slice(2)
			.map(l =>
				l
					.replace(/^\||(?<!\\)\|$/g, "")
					.split(/(?<!\\)\|/)
					.map(c => c.trim()),
			);

	const seen = new Set<string>();
	const rejected: string[] = [];
	rows(section("reviewed captures")).forEach((cells, i) => {
		const id = (cells[0] ?? "").replaceAll("`", "");
		const reject = (why: string) => rejected.push(`row ${i + 1} (${id || "no id"}): ${why}`);
		if (cells.length !== 7) return reject(`${cells.length} cells, expected 7`);
		let record: CaptureRecord;
		try {
			record = resolveId(store, id);
		} catch (error) {
			return reject((error as Error).message);
		}
		const bad = cells.slice(1, 6).findIndex(c => !/^(y|n|partial)$/i.test(c));
		if (bad !== -1) return reject(`column ${bad + 2} is "${cells[bad + 1]}", expected y, n or partial`);
		if (!cells[6]) return reject("Correction is empty (write - for none)");
		if (seen.has(record.id)) return reject("capture already reviewed in an earlier row");
		seen.add(record.id);
	});
	return {
		reviewed: seen.size,
		rejected,
		comparisons: rows(section("comparison")).length,
		decision: section("decision").some(l => l.trim() !== ""),
	};
}
