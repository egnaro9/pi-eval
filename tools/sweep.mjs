#!/usr/bin/env node
/**
 * sweep.mjs — headless suite runner for pi-eval.
 *
 *   node tools/sweep.mjs --suite suites/discriminating-41.json \
 *                        --model anthropic/claude-haiku-4-5 \
 *                        --out runs/haiku.json
 *
 * Optional: --limit N   run only the first N tasks (cheap smoke test)
 *           --concurrency N   parallel tasks (default 1)
 *           --thinking LEVEL  thinking level passed to model resolution
 *           --cwd DIR         session discovery root (default: a fresh temp dir)
 *           --timeout MS      per-task wall clock; 0 = off (default)
 *
 * Writes two files:
 *   <out>            a FLAT { "<task id>": "<answer text>" } map — exactly what
 *                    `gradecli run <suite> --answers <out>` consumes
 *                    (skills/grade/scripts/gradecli.py cmd_run: `answers[tid]`,
 *                    with a missing id raising "no answer supplied for task").
 *   <out>.meta.json  run provenance: model ref, suite path, task count,
 *                    per-task latency, and every error.
 *
 * Design rules this file enforces, each one a failure this project already hit:
 *
 *  1. FRESH SESSION PER TASK (SessionManager.inMemory) so no task can see
 *     another task's transcript.
 *  2. TOOLS OFF (noTools: "all"). A suite task is a question to a model, not an
 *     agent run; an answer produced by a tool call measures the wrong thing.
 *     Asserted at runtime via getActiveToolNames(), not assumed.
 *  3. NO FABRICATED ANSWERS. A task whose response is missing OR truncated at the
 *     output-token cap gets NO key in the output. gradecore deliberately treats a
 *     missing answer as a loud error; writing "" would silently convert a crashed
 *     run into a bad score. A TRUNCATED answer is worse — "Asta" for a task
 *     expecting "Astana" reads as a model that got the capital wrong, and in a
 *     paired sign test that is a directional loss, laundering an infrastructure
 *     failure into a claim about model capability.
 *  4. NO process.exit(). The run disposes every session and lets the event loop
 *     drain. If it hangs, a watchdog prints the live handles so the hang can be
 *     fixed rather than papered over.
 *
 * stdout stays empty. All human-facing output goes to stderr.
 * Exit 0 = every attempted task produced an answer. Exit 1 = at least one did not.
 * Exit 2 = usage / configuration error (nothing was run, nothing was written).
 */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ModelRuntime,
	SessionManager,
	createAgentSession,
	resolveCliModel,
} from "@earendil-works/pi-coding-agent";

const SWEEP_VERSION = 1;
const USAGE = `usage: node tools/sweep.mjs --suite <suite.json> --model <provider/id> --out <answers.json>
              [--limit N] [--concurrency N] [--thinking LEVEL] [--cwd DIR] [--timeout MS]`;

const log = (line) => process.stderr.write(`${line}\n`);

class UsageError extends Error {}

/** Temp discovery root this run created, if any; removed on every exit path. */
let tempCwd = null;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

/** ThinkingLevel union, pi-agent-core/dist/types.d.ts:254. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const KNOWN_FLAGS = new Set([
	"suite",
	"model",
	"out",
	"limit",
	"concurrency",
	"thinking",
	"cwd",
	"timeout",
	"help",
]);

function parseArgs(argv) {
	const flags = Object.create(null);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			throw new UsageError(`unexpected positional argument ${JSON.stringify(arg)}`);
		}
		const eq = arg.indexOf("=");
		let key;
		let value;
		if (eq !== -1) {
			key = arg.slice(2, eq);
			value = arg.slice(eq + 1);
		} else {
			key = arg.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				value = "true";
			} else {
				value = next;
				i++;
			}
		}
		// An unknown flag is fatal on purpose: a typo'd --limitt that was silently
		// ignored would quietly run (and bill) the whole suite.
		if (!KNOWN_FLAGS.has(key)) throw new UsageError(`unknown flag --${key}`);
		flags[key] = value;
	}
	return flags;
}

function requireFlag(flags, name) {
	const v = flags[name];
	if (typeof v !== "string" || v === "" || v === "true") {
		throw new UsageError(`--${name} is required`);
	}
	return v;
}

function positiveInt(flags, name, fallback) {
	if (flags[name] === undefined) return fallback;
	const n = Number(flags[name]);
	if (!Number.isInteger(n) || n < 1) {
		throw new UsageError(`--${name} must be a positive integer, got ${JSON.stringify(flags[name])}`);
	}
	return n;
}

function nonNegativeInt(flags, name, fallback) {
	if (flags[name] === undefined) return fallback;
	const n = Number(flags[name]);
	if (!Number.isInteger(n) || n < 0) {
		throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(flags[name])}`);
	}
	return n;
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

/** Accepts both shapes gradecli accepts: {tasks:[…]} or a bare list. */
async function loadTasks(suitePath) {
	let raw;
	try {
		raw = await readFile(suitePath, "utf8");
	} catch (err) {
		throw new UsageError(`cannot read suite ${suitePath}: ${err.message}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new UsageError(`suite ${suitePath} is not valid JSON: ${err.message}`);
	}
	const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		throw new UsageError(`suite ${suitePath} has no tasks (expected {tasks:[…]} or a bare list)`);
	}

	const seen = new Set();
	tasks.forEach((task, index) => {
		const id = task?.id;
		if (typeof id !== "string" || id.trim() === "") {
			throw new UsageError(`task #${index} has no string "id"`);
		}
		// Duplicate ids would collapse in the answers map and silently drop a task.
		if (seen.has(id)) throw new UsageError(`duplicate task id ${JSON.stringify(id)}`);
		seen.add(id);
		if (typeof task?.prompt !== "string" || task.prompt.trim() === "") {
			throw new UsageError(`task ${JSON.stringify(id)} has no non-empty string "prompt"`);
		}
	});
	return tasks;
}

// ---------------------------------------------------------------------------
// answer extraction
// ---------------------------------------------------------------------------

/**
 * Pull the finished answer off a settled session.
 * Returns { text, stopReason } or throws — never returns "".
 * Exported so the "no empty answers" rule can be unit-tested directly.
 */
export function extractAnswer(session) {
	// session.messages is the LIVE array; scan it backwards without mutating.
	const messages = session.messages;
	let last;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			last = messages[i];
			break;
		}
	}
	if (!last) throw new Error("no assistant message in transcript");

	const stopReason = last.stopReason;
	if (stopReason === "error" || stopReason === "aborted") {
		throw new Error(last.errorMessage || `request ${stopReason}`);
	}
	// Cut off at the output-token cap. This is an infrastructure failure wearing
	// the costume of an answer, and it is more dangerous than an empty response:
	// "Asta" for a task expecting "Astana" grades as a model that got the capital
	// wrong. In a paired sign test that is a directional loss, so a truncated run
	// is laundered into a claim about model capability. Refuse it here.
	if (stopReason === "length") {
		throw new Error('response truncated at the output-token cap (stop_reason "length")');
	}

	// Tools are disabled, so a tool call means the run was not the run we think
	// it was. Refuse the answer rather than grade a tool-assisted one.
	for (const message of messages) {
		if (message?.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "toolCall") {
				throw new Error(`assistant issued a tool call (${block.name}) despite noTools:"all"`);
			}
		}
	}

	// Built-in extractor: joins "text" blocks, skips aborted-empty messages,
	// and returns undefined (never "") when the trimmed result is empty.
	const text = session.getLastAssistantText();
	if (typeof text !== "string" || text.trim() === "") {
		throw new Error("assistant produced no text");
	}
	// Usage is what makes "did that help, or did it just cost more?" answerable.
	// A config change that buys +1 task for 3x the tokens is a bad trade, and a
	// score-only report cannot show that. `reasoning` is a SUBSET of `output`,
	// not an addition to it (pi-ai types.d.ts:258).
	return { text, stopReason, usage: last.usage };
}

// ---------------------------------------------------------------------------
// one task = one session
// ---------------------------------------------------------------------------

async function runTask(task, ctx) {
	const startedAt = Date.now();
	const record = { id: task.id, ok: false, latency_ms: 0 };
	let session;
	try {
		const created = await createAgentSession({
			cwd: ctx.cwd,
			model: ctx.model,
			modelRuntime: ctx.modelRuntime,
			thinkingLevel: ctx.thinkingLevel,
			noTools: "all", // hard requirement: a task is a question, not an agent run
			sessionManager: SessionManager.inMemory(ctx.cwd), // fresh + never persisted
			// Extensions are deliberately NOT bound (no session.bindExtensions):
			// an extension could add tools, rewrite context, or hold the process open.
		});
		session = created.session;

		const activeTools = session.getActiveToolNames();
		if (activeTools.length > 0) {
			throw new Error(`tools are active (${activeTools.join(", ")}) despite noTools:"all"`);
		}

		// prompt() resolves only after the whole run settles (all turns, retries,
		// auto-compaction). No polling, no event listener needed.
		const settled = session.prompt(task.prompt);
		settled.catch(() => {}); // keep a rejection from going unhandled if the race loses

		if (ctx.timeoutMs > 0) {
			let timer;
			try {
				await Promise.race([
					settled,
					new Promise((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`timed out after ${ctx.timeoutMs}ms`)),
							ctx.timeoutMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		} else {
			await settled;
		}

		const { text, stopReason, usage } = extractAnswer(session);
		record.ok = true;
		record.answer = text;
		record.stop_reason = stopReason;
		record.answer_chars = text.length;
		if (usage) {
			record.usage = {
				input: usage.input,
				output: usage.output,
				reasoning: usage.reasoning ?? null,
				total_tokens: usage.totalTokens,
				cost_usd: usage.cost?.total ?? null,
			};
		}
	} catch (err) {
		record.error = err instanceof Error ? err.message : String(err);
	} finally {
		record.latency_ms = Date.now() - startedAt;
		// dispose() aborts retry/compaction/bash/agent, detaches listeners and frees
		// per-session resources. It is the only teardown AgentSession has.
		try {
			session?.dispose();
		} catch (err) {
			record.dispose_error = err instanceof Error ? err.message : String(err);
		}
	}
	return record;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
	const flags = parseArgs(argv);
	if (flags.help !== undefined) {
		log(USAGE);
		return 0;
	}

	const suitePath = resolve(requireFlag(flags, "suite"));
	const modelRef = requireFlag(flags, "model");
	const outPath = resolve(requireFlag(flags, "out"));
	const metaPath = `${outPath}.meta.json`;
	const timeoutMs = nonNegativeInt(flags, "timeout", 0);

	// An unvalidated --thinking would be silently ignored/clamped, and the run would
	// be recorded under a level it never used.
	if (flags.thinking !== undefined && !THINKING_LEVELS.has(flags.thinking)) {
		throw new UsageError(
			`--thinking must be one of ${[...THINKING_LEVELS].join(", ")}, got ${JSON.stringify(flags.thinking)}`,
		);
	}

	const allTasks = await loadTasks(suitePath);
	const limit = positiveInt(flags, "limit", allTasks.length);
	const tasks = allTasks.slice(0, limit);
	const concurrency = Math.min(positiveInt(flags, "concurrency", 1), tasks.length);

	// Resolve the model against ~/.pi/agent/auth.json. Offline: create() does not
	// refresh catalogs over the network unless explicitly allowed.
	const modelRuntime = await ModelRuntime.create();
	// resolveCliModel takes the thinking level from a "model:level" PATTERN, not
	// from a separate argument. Passing it as cliThinking silently did nothing:
	// resolved.thinkingLevel came back undefined for every level, the session fell
	// back to the settings default, and a --thinking off run recorded medium. That
	// produced a config comparison of one config against itself.
	const resolved = resolveCliModel({ cliModel: modelRef, modelRuntime });
	if (resolved.error || !resolved.model) {
		throw new UsageError(resolved.error ?? `could not resolve model ${modelRef}`);
	}
	if (resolved.warning) log(`sweep: warning: ${resolved.warning}`);
	const model = resolved.model;
	const canonicalRef = `${model.provider}/${model.id}`;
	// resolveCliModel pattern-matches, so the thing that ran may not be the thing
	// that was asked for. Say so loudly — an eval record with the wrong model ref
	// is worse than no record.
	if (canonicalRef.toLowerCase() !== modelRef.toLowerCase()) {
		log(`sweep: warning: --model ${modelRef} resolved to ${canonicalRef}`);
	}
	if (!modelRuntime.hasConfiguredAuth(model.provider)) {
		throw new UsageError(
			`no credentials for provider ${model.provider} (expected an entry in ~/.pi/agent/auth.json)`,
		);
	}

	// Session discovery root. Default to an empty temp dir so the repo's own
	// AGENTS.md / skills / extensions cannot leak into an eval prompt.
	let cwd;
	if (flags.cwd === undefined) {
		cwd = await mkdtemp(join(tmpdir(), "pi-eval-sweep-"));
		tempCwd = cwd; // cleaned up by runCli, on the error path too
	} else {
		if (flags.cwd === "true") throw new UsageError("--cwd needs a directory");
		cwd = resolve(flags.cwd);
		const info = await stat(cwd).catch(() => null);
		if (!info?.isDirectory()) throw new UsageError(`--cwd ${cwd} is not a directory`);
	}

	// An explicit --thinking wins over anything the pattern carried.
	const requestedThinking = flags.thinking ?? resolved.thinkingLevel;
	const ctx = { cwd, model, modelRuntime, thinkingLevel: requestedThinking, timeoutMs };

	// Preflight: build one throwaway session and prove tools really are off before
	// spending money on the suite. No network call is made here.
	let effectiveThinking;
	let observedTools = null;
	{
		const probe = await createAgentSession({
			cwd,
			model,
			modelRuntime,
			thinkingLevel: requestedThinking,
			noTools: "all",
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			const active = probe.session.getActiveToolNames();
			if (active.length > 0) {
				throw new UsageError(`preflight: tools are active (${active.join(", ")}) despite noTools:"all"`);
			}
			effectiveThinking = probe.session.thinkingLevel;
			observedTools = active;
			// The guard that would have caught the bug above. A thinking level that
			// silently differs from the one asked for turns a config comparison into
			// a config compared with itself, and the result LOOKS like a real finding
			// ("no difference") instead of an error. Fail before spending money.
			if (requestedThinking !== undefined && effectiveThinking !== requestedThinking) {
				throw new UsageError(
					`preflight: asked for thinking=${requestedThinking} but the session `
					+ `resolved to ${effectiveThinking}. Refusing to run — a run labelled `
					+ `with a config it did not use is worse than no run.`,
				);
			}
		} finally {
			probe.session.dispose();
		}
	}

	log(
		`sweep: ${canonicalRef} | thinking=${effectiveThinking} | ${tasks.length}/${allTasks.length} tasks | concurrency=${concurrency}` +
			(timeoutMs > 0 ? ` | timeout=${timeoutMs}ms` : ""),
	);
	log(`sweep: suite ${suitePath}`);

	const startedAt = new Date();
	const records = new Array(tasks.length);
	let cursor = 0;
	let completed = 0;

	const worker = async () => {
		for (;;) {
			const index = cursor++;
			if (index >= tasks.length) return;
			const record = await runTask(tasks[index], ctx);
			records[index] = record;
			completed++;
			const tag = `[${String(completed).padStart(String(tasks.length).length)}/${tasks.length}]`;
			if (record.ok) {
				log(`${tag} ${record.id}  ${record.latency_ms}ms  ${record.answer_chars} chars`);
			} else {
				log(`${tag} ${record.id}  ${record.latency_ms}ms  ERROR: ${record.error}`);
			}
		}
	};

	await Promise.all(Array.from({ length: concurrency }, worker));
	const finishedAt = new Date();

	// Assemble in suite order so the answers file is stable regardless of
	// completion order under --concurrency.
	const answers = {};
	const taskMeta = [];
	const failedIds = [];
	for (const record of records) {
		if (record.ok) {
			answers[record.id] = record.answer;
		} else {
			failedIds.push(record.id);
		}
		const entry = {
			id: record.id,
			ok: record.ok,
			latency_ms: record.latency_ms,
		};
		if (record.ok) {
			entry.stop_reason = record.stop_reason;
			entry.answer_chars = record.answer_chars;
			if (record.usage) entry.usage = record.usage;
		} else {
			entry.error = record.error;
			if (record.stop_reason) entry.stop_reason = record.stop_reason;
		}
		if (record.dispose_error) entry.dispose_error = record.dispose_error;
		taskMeta.push(entry);
	}

	const latencies = taskMeta.map((t) => t.latency_ms).sort((a, b) => a - b);
	const meta = {
		sweep_version: SWEEP_VERSION,
		model_requested: modelRef,
		model: canonicalRef,
		model_provider: model.provider,
		model_id: model.id,
		model_api: model.api,
		thinking_level: effectiveThinking,
		// The observed result of getActiveToolNames(), not a claim. A hardcoded
		// "none" would print the same string whatever actually happened, so it
		// would not be evidence for anyone auditing an archived run later.
		tools_requested: "all disabled (noTools: all)",
		tools_observed: observedTools,
		suite: suitePath,
		suite_task_count: allTasks.length,
		tasks_attempted: tasks.length,
		limit: limit < allTasks.length ? limit : null,
		concurrency,
		timeout_ms: timeoutMs || null,
		cwd,
		answers_path: outPath,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		wall_ms: finishedAt.getTime() - startedAt.getTime(),
		answered: taskMeta.length - failedIds.length,
		errored: failedIds.length,
		errored_ids: failedIds,
		latency_ms_median: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null,
		latency_ms_max: latencies.length ? latencies[latencies.length - 1] : null,
		// Totals over ANSWERED tasks only. A task that errored produced no answer,
		// so folding its partial spend into a per-answer cost would understate what
		// each usable result actually cost.
		usage_total: (() => {
			const u = taskMeta.filter((t) => t.usage).map((t) => t.usage);
			if (!u.length) return null;
			const sum = (k) => u.reduce((n, x) => n + (x[k] ?? 0), 0);
			return {
				tasks_with_usage: u.length,
				input: sum("input"),
				output: sum("output"),
				reasoning: u.some((x) => x.reasoning !== null) ? sum("reasoning") : null,
				total_tokens: sum("total_tokens"),
				cost_usd: Number(sum("cost_usd").toFixed(6)),
			};
		})(),
		tasks: taskMeta,
	};

	await mkdir(dirname(outPath), { recursive: true });
	// The primary file stays a flat id -> answer map. Nothing else goes in it.
	await writeFile(outPath, `${JSON.stringify(answers, null, 2)}\n`, "utf8");
	await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

	log(`sweep: wrote ${outPath} (${Object.keys(answers).length} answers)`);
	log(`sweep: wrote ${metaPath}`);
	if (limit < allTasks.length) {
		log(
			`sweep: NOTE --limit ${limit} of ${allTasks.length}; gradecli run will reject this answers file ` +
				`("no answer supplied") until every task in the suite has an answer`,
		);
	}
	if (failedIds.length > 0) {
		log(`sweep: FAILED ${failedIds.length}/${tasks.length}: ${failedIds.join(", ")}`);
		return 1;
	}
	log(`sweep: OK ${tasks.length}/${tasks.length} answered in ${meta.wall_ms}ms`);
	return 0;
}

async function runCli() {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (err) {
		if (err instanceof UsageError) {
			log(`sweep: ${err.message}`);
			log(USAGE);
			process.exitCode = 2;
		} else {
			log(`sweep: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			process.exitCode = 1;
		}
	} finally {
		if (tempCwd) await rm(tempCwd, { recursive: true, force: true }).catch(() => {});
	}

	// Every session is disposed and every write is flushed, so the process should
	// now drain on its own. It is not force-exited: a hang here is a real bug (a
	// leaked socket, timer or child process), and this reports the culprit instead
	// of hiding it. The timer is unref'd, so it never keeps the process alive.
	const watchdog = setTimeout(() => {
		const handles = process.getActiveResourcesInfo?.() ?? ["<unavailable>"];
		log(`sweep: still running 20s after finishing — live handles: ${handles.join(", ")}`);
		log("sweep: this is a teardown bug, not a reason to add process.exit()");
	}, 20_000);
	watchdog.unref();
}

// Run only when invoked as a program, so a test can import extractAnswer without
// launching a sweep. The fallback keeps this correct on Node versions without
// import.meta.main, and never silently no-ops when this IS the program.
async function invokedDirectly() {
	if (typeof import.meta.main === "boolean") return import.meta.main;
	if (!process.argv[1]) return true;
	try {
		return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
	} catch {
		return true;
	}
}

if (await invokedDirectly()) {
	await runCli();
}
