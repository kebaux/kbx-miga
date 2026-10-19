// Seeds one semantic-scenario case (plan task 5.2) and captures it (real model calls).
// Usage: bun scripts/seed-scenario.ts <scenario.json> <case-name> <out-dir>
// The episode runs in a fresh temp working directory outside any repository, so no project
// files or context files shape it. A case's `tools` list is the only tools the seeding agent
// gets (default: none). Prompts and compaction run over OMP's RPC client (print-mode /compact
// does not compact); the capture runs as `omp --continue -p "/capture …"`, which waits for
// extraction like a user's print-mode capture. A case's optional `config` is passed to the
// seeding session only, as an `omp --config` overlay. Writes <out-dir>/s (session) and
// <out-dir>/c (capture store) and prints the record path; on failure <out-dir> is removed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

type Step = { prompt: string } | { compact: true } | { capture: string };
interface ScenarioCase {
	name: string;
	steps: Step[];
	tools?: string[];
	config?: object;
}

const [file, caseName, out] = process.argv.slice(2);
if (!file || !caseName || !out) throw new Error("usage: seed-scenario.ts <scenario.json> <case-name> <out-dir>");
const scenario: { cases: ScenarioCase[] } = JSON.parse(fs.readFileSync(file, "utf8"));
const spec = scenario.cases.find(c => c.name === caseName);
if (!spec) throw new Error(`${file}: no case ${caseName}`);
const last = spec.steps.at(-1);
if (spec.steps.filter(s => "capture" in s).length !== 1 || !last || !("capture" in last))
	throw new Error(`${caseName}: exactly one capture, as the last step`);
const capture = last.capture;

fs.rmSync(out, { recursive: true, force: true });
const sessionDir = path.join(out, "s");
const storeDir = path.join(out, "c");
fs.mkdirSync(sessionDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scenario-work-"));
const ext = path.resolve(import.meta.dir, "../extension/index.ts");
const seedArgs = ["--no-extensions", ...(spec.tools?.length ? ["--tools", spec.tools.join(",")] : ["--no-tools"])];
if (spec.config) {
	const overlay = path.join(out, "seed-config.yml");
	fs.writeFileSync(overlay, JSON.stringify(spec.config)); // JSON is valid YAML
	seedArgs.push("--config", overlay);
}

try {
	const client = new RpcClient({ command: ["omp"], cwd: work, sessionDir, args: seedArgs });
	await client.start();
	try {
		for (const step of spec.steps.slice(0, -1)) {
			if ("prompt" in step) await client.promptAndWait(step.prompt, undefined, 240_000);
			else if ("compact" in step) await client.compact();
		}
	} finally {
		await client.stop();
	}

	const run = Bun.spawnSync(
		["omp", "--session-dir", sessionDir, "--continue", "--no-extensions", "--trusted-extension", ext, "-p", `/capture ${capture}`],
		{ cwd: work, env: { ...process.env, OMP_CAPTURE_DIR: storeDir }, stdout: "ignore", stderr: "pipe" },
	);
	const stderr = run.stderr.toString();
	if (run.exitCode !== 0 || !/^Captured [0-9A-F]{4}\.$/m.test(stderr))
		throw new Error(`${caseName}: capture failed (exit ${run.exitCode}): ${stderr.slice(-500)}`);
	const records = fs.readdirSync(storeDir).filter(f => f.endsWith(".json") && !f.startsWith("."));
	if (records.length !== 1) throw new Error(`${caseName}: expected 1 record, found ${records.length}`);
	console.log(path.join(storeDir, records[0]));
} catch (error) {
	fs.rmSync(out, { recursive: true, force: true });
	throw error;
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
