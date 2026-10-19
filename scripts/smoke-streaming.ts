// A07 live smoke (real model calls): /capture during a streaming reply records the in-flight
// text as a `p1` partial part, does not inject a user message, and does not disturb the reply;
// a /capture after a finished reply does not repeat it as a stale p1.
// Usage: bun scripts/smoke-streaming.ts   → prints `OK partial=1 main=completed injected=0 stale=0`
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { readRecord } from "../src/store";

const TIMEOUT_MS = 240_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-capture-stream-"));
const storeDir = path.join(root, "c");
const client = new RpcClient({
	command: ["omp"],
	cwd: root,
	sessionDir: path.join(root, "s"),
	env: { OMP_CAPTURE_DIR: storeDir },
	args: ["--no-extensions", "--trusted-extension", path.resolve(import.meta.dir, "../extension/index.ts")],
});

async function run(): Promise<string> {
	await client.start();
	const results = new Map<string, RpcPromptResultFrame>();
	const done = Promise.withResolvers<void>();
	let essayId: string | undefined;
	let captureId: Promise<string> | undefined;
	const check = async () => {
		try {
			if (essayId && captureId && results.has(essayId) && results.has(await captureId)) done.resolve();
		} catch (error) {
			done.reject(error);
		}
	};
	client.onPromptResult(result => {
		if (result.id) results.set(result.id, result);
		void check();
	});
	let updates = 0;
	client.onEvent(event => {
		if (event.type === "message_update") updates++;
		if (captureId || event.type !== "message_update" || event.message.role !== "assistant") return;
		if (!event.message.content.some(block => block.type === "text" && block.text.length > 0)) return;
		captureId = client.prompt("/capture the idempotency part");
		captureId.catch(error => done.reject(error));
	});
	essayId = await client.prompt("Write 500 words on idempotent job processing.");
	await done.promise;

	const essay = results.get(essayId);
	const capture = results.get(await (captureId as Promise<string>));
	if (essay?.status !== "completed") throw new Error(`essay prompt status=${essay?.status} ${essay?.error?.message ?? ""}`);
	if (capture?.agentInvoked !== false) throw new Error(`capture prompt agentInvoked=${capture?.agentInvoked}`);

	const records = async () => {
		const files = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).filter(f => f.endsWith(".json") && !f.startsWith(".")) : [];
		return Promise.all(files.map(f => readRecord(path.join(storeDir, f))));
	};
	const [record, ...extra] = await records();
	if (!record || extra.length > 0) throw new Error(`expected 1 record, found ${extra.length + (record ? 1 : 0)}`);
	const partial = record.source_packet.parts.filter(p => p.id === "p1" && p.completeness === "partial").length;
	if (partial !== 1 || !record.source_packet.coverage.partial_included) throw new Error(`record ${record.id} has no p1 partial part`);

	const injected = (await client.getMessages()).filter(
		m => m.role === "user" && JSON.stringify(m.content).includes("/capture"),
	).length;
	if (injected !== 0) throw new Error(`${injected} /capture user message(s) in the conversation`);

	// After a reply has ended, a capture must not repeat it as a stale p1: OMP delivers late
	// queued message_update events after message_end. A short turn plus a settle wait scaled to
	// its update count reproduces that ordering (observed 3/3 on the unfixed buffer).
	const resultOf = (id: string) =>
		new Promise<RpcPromptResultFrame>(resolve => {
			const off = client.onPromptResult(result => {
				if (result.id === id) (off(), resolve(result));
			});
			const seen = results.get(id);
			if (seen) (off(), resolve(seen));
		});
	const updatesBefore = updates;
	await resultOf(await client.prompt("Count from 1 to 40, one number per line, nothing else."));
	await Bun.sleep(Math.max(3000, (updates - updatesBefore) * 200));
	await resultOf(await client.prompt("/capture after the reply"));
	const second = (await records()).find(r => r.request_text === "after the reply");
	if (!second) throw new Error("post-reply capture wrote no record");
	if (second.source_packet.coverage.partial_included) throw new Error(`post-reply record ${second.id} repeats the reply as p1`);
	return `OK partial=${partial} main=${essay.status} injected=${injected} stale=0`;
}

try {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
	console.log(await Promise.race([run(), deadline.promise]).finally(() => clearTimeout(timer)));
	await client.stop();
	fs.rmSync(root, { recursive: true, force: true });
} catch (error) {
	console.error(`FAIL: ${error instanceof Error ? error.message : String(error)} (artifacts: ${root})`);
	console.error(client.getStderr().slice(-2000));
	await client.stop().catch(() => {});
	process.exit(1);
}
