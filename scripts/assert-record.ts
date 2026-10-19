// Usage: bun scripts/assert-record.ts <dir> [--count N] [--request TEXT] [--state S] [--min-parts N] [--last-error CLASS|none]
// Asserts <dir> holds exactly N record files (default 1; dotfiles and *.lock ignored), each valid
// schema v1, and checks the given fields. Prints `OK <id> state=<s> parts=<n>[ last_error=<class>]` per record.
import * as fs from "node:fs";
import * as path from "node:path";
import { readRecord } from "../src/store";

const fail = (reason: string): never => {
	console.error(`FAIL: ${reason}`);
	process.exit(1);
};

const [dir, ...rest] = process.argv.slice(2);
const USAGE = "usage: assert-record.ts <dir> [--count N] [--request TEXT] [--state S] [--min-parts N] [--last-error CLASS|none]";
if (!dir) fail(USAGE);
const opts: { [flag: string]: string } = {};
for (let i = 0; i < rest.length; i += 2) {
	const flag = rest[i];
	if (!["--count", "--request", "--state", "--min-parts", "--last-error"].includes(flag) || rest[i + 1] === undefined)
		fail(`bad argument ${flag}`);
	opts[flag] = rest[i + 1];
}

if (!fs.existsSync(dir)) fail(`${dir} does not exist`);
const files = fs.readdirSync(dir).filter(f => !f.startsWith(".") && f.endsWith(".json"));
const want = Number(opts["--count"] ?? 1);
if (files.length !== want) fail(`expected ${want} record(s) in ${dir}, found ${files.length}`);

for (const file of files) {
	const record = await readRecord(path.join(dir, file)).catch((error: Error) => fail(error.message));
	if (file !== `${record.id}.json`) fail(`${file}: name does not match id ${record.id}`);
	if (opts["--request"] !== undefined && record.request_text !== opts["--request"])
		fail(`${record.id}: request_text ${JSON.stringify(record.request_text)} != ${JSON.stringify(opts["--request"])}`);
	if (opts["--state"] !== undefined && record.state !== opts["--state"])
		fail(`${record.id}: state=${record.state}, expected ${opts["--state"]}`);
	const parts = record.source_packet.parts.length;
	if (opts["--min-parts"] !== undefined && parts < Number(opts["--min-parts"]))
		fail(`${record.id}: ${parts} parts < ${opts["--min-parts"]}`);
	const lastError = record.last_error?.class ?? "none";
	if (opts["--last-error"] !== undefined && lastError !== opts["--last-error"])
		fail(`${record.id}: last_error=${lastError} (${record.last_error?.message ?? ""}), expected ${opts["--last-error"]}`);
	console.log(`OK ${record.id} state=${record.state} parts=${parts}${record.last_error ? ` last_error=${lastError}` : ""}`);
}
