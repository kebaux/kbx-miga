// OMP extension: `/capture <free text>` freezes the request and the active branch's
// evidence into one schema-v1 record, publishes it, shows `Captured XXXX.`, then runs one
// tool-less extraction over the saved record in the background. Management commands
// (/capture-list, -show, -note, -retry, -export) work on the same guarded store.
import type { ExtensionAPI, ExtensionCommandContext, MessageUpdateEvent } from "@oh-my-pi/pi-coding-agent";
import { type ExtractionJob, type ExtractionOutcome, extractAndPublish } from "../src/extract";
import { applyNote, type CaptureRecord, SCHEMA_VERSION } from "../src/record";
import { fenced, renderListRow, renderMarkdown } from "../src/render";
import { buildPacket } from "../src/snapshot";
import { exportRecord, type Listing, listRecords, publishRecord, resolveId, resolveStoreDir, updateGuarded } from "../src/store";
import { MarkdownPager } from "./viewer";

const LIST_DEFAULT = 20;

export default function captureExtension(pi: ExtensionAPI): void {
	const say = (ctx: ExtensionCommandContext, message: string, type: "info" | "warning") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else process.stderr.write(`${message}\n`);
	};

	/** TUI: scrollable overlay. Print: stdout. Other UI modes (rpc owns stdout): a notification. No UI (json): stderr. */
	const present = async (ctx: ExtensionCommandContext, markdown: string, plain = markdown) => {
		if (ctx.mode === "tui")
			await ctx.ui.custom<void>((tui, theme, _keys, done) => new MarkdownPager(tui, theme, markdown, () => done()), {
				overlay: true,
			});
		else if (ctx.mode === "print") process.stdout.write(plain.endsWith("\n") ? plain : `${plain}\n`);
		else if (ctx.hasUI) ctx.ui.notify(plain, "info");
		else process.stderr.write(plain.endsWith("\n") ? plain : `${plain}\n`);
	};

	/** Splits `args` into words; null when the count is outside [min, max]. */
	const words = (args: string, min: number, max: number): string[] | null => {
		const list = args.trim().split(/\s+/).filter(Boolean);
		return list.length >= min && list.length <= max ? list : null;
	};

	// In-flight reply slot, per binding (not module scope: module state is shared with subagent
	// bindings). Holds the latest in-flight assistant message (update payloads are immutable
	// snapshots); /capture reads it synchronously. OMP delivers message_update through a queue
	// but message_end directly, so a late update for an ended message must not refill the slot.
	let streaming: MessageUpdateEvent["message"] | null = null;
	let endedAt: number | undefined;
	pi.on("message_update", event => {
		if (event.message.role === "assistant" && event.message.timestamp !== endedAt) streaming = event.message;
	});
	pi.on("message_end", event => {
		if (event.message.role !== "assistant") return;
		endedAt = event.message.timestamp;
		streaming = null;
	});

	// Extraction jobs of this binding, keyed by capture id. Session shutdown aborts them and
	// waits (OMP bounds shutdown handlers) so each abort lands as `last_error` on the record.
	const jobs = new Map<string, { controller: AbortController; done: Promise<ExtractionOutcome | null> }>();
	pi.on("session_shutdown", async () => {
		for (const job of jobs.values()) job.controller.abort(new Error("session shutdown"));
		await Promise.allSettled([...jobs.values()].map(job => job.done));
	});

	/** Starts one extraction from `inputRevision`; resolves to its outcome, or null when even the failure could not be stored. */
	const startJob = (job: Omit<ExtractionJob, "signal">): Promise<ExtractionOutcome | null> => {
		const controller = new AbortController();
		const started = performance.now();
		const done = extractAndPublish({ ...job, signal: controller.signal })
			.then(result => {
				pi.logger.info("capture: extraction", { id: job.id, ...result, ms: Math.round(performance.now() - started) });
				return result;
			})
			.catch(error => {
				pi.logger.error("capture: extraction could not record its result", { id: job.id, error: shortReason(error) });
				return null;
			})
			.finally(() => jobs.delete(job.id));
		jobs.set(job.id, { controller, done });
		return done;
	};
	// Print and json modes exit when the command returns, which would kill a detached job.
	const exitsOnReturn = (ctx: ExtensionCommandContext) => ctx.mode === "print" || ctx.mode === "json";

	/** Resolves `<id>` against the store, or reports why not and returns null. */
	const lookup = async (ctx: ExtensionCommandContext, dir: string, prefix: string): Promise<CaptureRecord | null> => {
		try {
			return resolveId((await listRecords(dir)).records, prefix);
		} catch (error) {
			say(ctx, shortReason(error), "warning");
			return null;
		}
	};

	pi.registerCommand("capture", {
		description: "Save what you want to revisit, with this session's evidence",
		handler: async (args, ctx) => {
			const started = performance.now();
			let record: CaptureRecord;
			let storeDir: string;
			let model: ExtractionJob["model"];
			let apiKey: ExtractionJob["apiKey"];
			try {
				// Freeze identity and branch before any await: /new, resume and fork reuse
				// this SessionManager and would otherwise change what we read.
				const sm = ctx.sessionManager;
				const origin = {
					harness: "omp" as const,
					session_id: sm.getSessionId(),
					session_file: sm.getSessionFile() ?? null,
					cwd: ctx.cwd,
					leaf_id: sm.getLeafId(),
				};
				const branch = sm.getBranch();
				storeDir = resolveStoreDir();
				// AD2: the extraction model is the invoking session's model at dispatch.
				model = ctx.model;
				apiKey = model && ctx.modelRegistry.resolver(model, origin.session_id);
				const capturedAt = new Date().toISOString();
				const sourcePacket = buildPacket(branch, args, streaming);
				record = {
					schema_version: SCHEMA_VERSION,
					id: crypto.randomUUID(),
					revision: 1,
					captured_at: capturedAt,
					request_text: args,
					origin,
					timing: { publish_ms: Math.round(performance.now() - started) },
					source_packet: sourcePacket,
					state: "raw",
					extraction: null,
					user_note: null,
					last_error: null,
				};
			} catch (error) {
				pi.logger.error("capture: snapshot failed", { error: String(error) });
				say(ctx, `Capture failed: ${shortReason(error)}`, "warning");
				return;
			}

			try {
				await publishRecord(storeDir, record);
			} catch (error) {
				pi.logger.error("capture: publish failed", { id: record.id, error: shortReason(error) });
				say(ctx, `Capture failed: ${shortReason(error)}`, "warning");
				return;
			}
			pi.logger.debug("capture: published", {
				id: record.id,
				state: record.state,
				publish_ms: record.timing.publish_ms,
				parts: record.source_packet.parts.length,
			});
			const short = record.id.slice(0, 4).toUpperCase();
			say(ctx, `Captured ${short}.`, "info");

			const done = startJob({ dir: storeDir, id: record.id, inputRevision: record.revision, model, apiKey });
			// Print and json runs wait anyway, so they report what the extraction left on the record;
			// the TUI and RPC stay silent after `Captured` (nothing interrupts the session).
			if (exitsOnReturn(ctx)) {
				const result = await done;
				if (!result) say(ctx, `Extraction ${short} could not save its result.`, "warning");
				else if (result.outcome === "published") say(ctx, `Extraction ${short}: ${result.state.replace("_", " ")}.`, "info");
				else if (result.outcome === "failed") say(ctx, `Extraction ${short} failed (${result.kind}): ${result.message}`, "warning");
				else say(ctx, `Extraction ${short} discarded: the capture changed while it ran.`, "warning");
			}
		},
	});

	pi.registerCommand("capture-list", {
		description: `List saved captures, newest first: /capture-list [n] (default ${LIST_DEFAULT})`,
		handler: async (args, ctx) => {
			const dir = resolveStoreDir();
			const arg = words(args, 0, 1);
			if (!arg || (arg[0] !== undefined && !/^[1-9][0-9]*$/.test(arg[0])))
				return say(ctx, `Usage: /capture-list [n] (n a positive whole number; default ${LIST_DEFAULT})`, "warning");
			const limit = arg[0] ? Number(arg[0]) : LIST_DEFAULT;
			let listing: Listing;
			try {
				listing = await listRecords(dir);
			} catch (error) {
				return say(ctx, `Capture list failed: ${shortReason(error)}`, "warning");
			}
			const rows = listing.records.slice(0, limit).map(renderListRow);
			const notes = [
				listing.records.length > limit ? `${listing.records.length - limit} older capture(s) not shown.` : "",
				listing.invalid.length > 0 ? `Skipped ${listing.invalid.length} unreadable file(s): ${listing.invalid.join(", ")}` : "",
			].filter(Boolean);
			const plain = [rows.length > 0 ? rows.join("\n") : `No captures in ${dir}.`, ...notes].join("\n");
			const markdown = [
				`# Captures (${listing.records.length})`,
				rows.length > 0 ? fenced(rows.join("\n")) : `_No captures in ${dir}._`,
				...notes.map(n => `_${n}_`),
				"_Open one with /capture-show <id>._",
			].join("\n\n");
			await present(ctx, markdown, plain);
		},
	});

	pi.registerCommand("capture-show", {
		description: "Show a capture: /capture-show <id>",
		handler: async (args, ctx) => {
			const arg = words(args, 1, 1);
			if (!arg) return say(ctx, "Usage: /capture-show <id>", "warning");
			const record = await lookup(ctx, resolveStoreDir(), arg[0]);
			if (record) await present(ctx, renderMarkdown(record));
		},
	});

	pi.registerCommand("capture-note", {
		description: "Add or replace your note on a capture: /capture-note <id> <text>",
		handler: async (args, ctx) => {
			const prefix = args.trim().split(/\s+/)[0] ?? "";
			const text = args.trim().slice(prefix.length).trim();
			if (!prefix || !text) return say(ctx, "Usage: /capture-note <id> <text>", "warning");
			const dir = resolveStoreDir();
			const record = await lookup(ctx, dir, prefix);
			if (!record) return;
			try {
				const next = await updateGuarded(dir, record.id, current => applyNote(current, text, new Date().toISOString()));
				say(ctx, `Noted ${record.id.slice(0, 4).toUpperCase()} (revision ${next?.revision}). Run /capture-retry to re-interpret.`, "info");
			} catch (error) {
				say(ctx, `Note failed: ${shortReason(error)}`, "warning");
			}
		},
	});

	pi.registerCommand("capture-retry", {
		description: "Re-run extraction from the saved record only: /capture-retry <id>",
		handler: async (args, ctx) => {
			// AD2: the then-current session model, frozen before any await.
			const model = ctx.model;
			const apiKey = model && ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId());
			const arg = words(args, 1, 1);
			if (!arg) return say(ctx, "Usage: /capture-retry <id>", "warning");
			const dir = resolveStoreDir();
			const record = await lookup(ctx, dir, arg[0]);
			if (!record) return;
			const short = record.id.slice(0, 4).toUpperCase();
			if (jobs.has(record.id)) return say(ctx, `Extraction for ${short} is already running.`, "warning");
			say(ctx, `Retrying ${short} from revision ${record.revision}.`, "info");
			const done = startJob({ dir, id: record.id, inputRevision: record.revision, model, apiKey }).then(result => {
				if (!result) say(ctx, `Retry ${short} could not save its result.`, "warning");
				else if (result.outcome === "published") say(ctx, `Retry ${short}: ${result.state.replace("_", " ")}.`, "info");
				else if (result.outcome === "failed") say(ctx, `Retry ${short} failed (${result.kind}); the previous interpretation is kept.`, "warning");
				else say(ctx, `Retry ${short} discarded: the capture changed while it ran.`, "warning");
			});
			if (exitsOnReturn(ctx)) await done;
		},
	});

	pi.registerCommand("capture-export", {
		description: "Export a snapshot of a capture: /capture-export <id> [md|json] (default md)",
		handler: async (args, ctx) => {
			const arg = words(args, 1, 2);
			const [prefix, format = "md"] = arg ?? [];
			if (!prefix || (format !== "md" && format !== "json")) return say(ctx, "Usage: /capture-export <id> [md|json]", "warning");
			const dir = resolveStoreDir();
			const record = await lookup(ctx, dir, prefix);
			if (!record) return;
			try {
				const target = await exportRecord(dir, record.id, format, renderMarkdown);
				say(ctx, `Exported ${record.id.slice(0, 4).toUpperCase()} to ${target}`, "info");
			} catch (error) {
				say(ctx, `Export failed: ${shortReason(error)}`, "warning");
			}
		},
	});
}

function shortReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}
