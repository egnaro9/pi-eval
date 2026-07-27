/**
 * /eval — run a frozen task suite against the CURRENTLY LOADED pi config and
 * grade it with fixed predicates.
 *
 * Pi is aggressively extensible, which means its users change config constantly:
 * a new extension, a different model, a rewritten prompt template. There is no
 * instrument that says whether any of it helped. This is the first half of one.
 *
 * DESIGN NOTES, because the shape is deliberate:
 *
 * - Each task runs in its own `pi -p` PROCESS, not in this session. A suite run
 *   inside the live session would inherit that session's context, so task N
 *   would be graded on a conversation task N-1 had already polluted. A fresh
 *   process is the cheapest honest isolation available.
 *
 * - Grading shells out to gradecli. This extension contains no grading logic on
 *   purpose: gradecore is the single grader shared by a live drift board and a
 *   live crash test, and the byte-identical suite_hash between them is a
 *   load-bearing claim. A second implementation in TypeScript would quietly
 *   falsify it.
 *
 * - The run record stores a CONFIG FINGERPRINT (model, thinking level, active
 *   tools, suite hash). A score with no record of what produced it cannot be
 *   compared to anything later, which is the whole point of the exercise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pi is ESM ("type": "module") and loads extensions through jiti, so __dirname
// is not reliably defined. Resolve from import.meta.url instead.
const HERE = dirname(fileURLToPath(import.meta.url));
const GRADECLI = join(HERE, "..", "skills", "grade", "scripts", "gradecli.py");

interface Task {
	id: string;
	prompt: string;
	grader: string;
	[k: string]: unknown;
}

const RUN_DIR = ".pi-eval/runs";

/**
 * Group run records by the CONFIG that produced them, preserving input order.
 *
 * Running /eval three times without changing anything is not three configs, it
 * is three measurements of one — and those repetitions are what make it possible
 * to tell a real difference from a config disagreeing with itself. Runs of
 * different suites are never pooled: the suite hash is part of the key, because
 * a delta across different questions means nothing.
 *
 * Pure and exported so the keying can be tested without a Pi session; the bug
 * this guards against (two configs silently pooled as repetitions of one) would
 * be invisible in the output.
 */
export function groupRunsByConfig(
	records: Array<{ path: string; record: Record<string, any> | null }>,
): string[][] {
	const groups = new Map<string, string[]>();
	for (const { path, record } of records) {
		if (!record) continue; // a half-written record is not a measurement
		const fp = record.fingerprint ?? {};
		const key = JSON.stringify({
			modelRef: fp.modelRef ?? null,
			thinkingLevel: fp.thinkingLevel ?? null,
			activeTools: fp.activeTools ?? null,
			suite: record.suite_hash ?? null,
		});
		const list = groups.get(key);
		if (list) list.push(path);
		else groups.set(key, [path]);
	}
	return [...groups.values()];
}
const DEFAULT_SUITE = "eval-suite.json";

function loadSuite(path: string): Task[] {
	const raw = JSON.parse(readFileSync(path, "utf8"));
	const tasks: Task[] = Array.isArray(raw) ? raw : raw.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		throw new Error(`${path} has no tasks`);
	}
	for (const t of tasks) {
		if (!t.id || !t.prompt || !t.grader) {
			throw new Error(`task ${JSON.stringify(t.id ?? "?")} needs id, prompt and grader`);
		}
	}
	return tasks;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("eval", {
		description: "Run a frozen suite against this config and grade it deterministically",

		handler: async (args, ctx) => {
			const suitePath = args.trim() || DEFAULT_SUITE;

			if (!existsSync(suitePath)) {
				ctx.ui.notify(
					`No suite at ${suitePath}. Pass a path: /eval path/to/suite.json`,
					"error",
				);
				return;
			}

			let tasks: Task[];
			try {
				tasks = loadSuite(suitePath);
			} catch (e) {
				ctx.ui.notify(`${(e as Error).message}`, "error");
				return;
			}

			// ctx.model is a Model OBJECT ({id, provider, name, ...}), not a string,
			// and it is `Model<any> | undefined`. Stringifying it yielded
			// "[object Object]" and every task died with "Model not found" -- the
			// error surfaced correctly, but only because a real run was tried.
			// `pi -p --model` wants the qualified "provider/id" form: bare "haiku"
			// resolves to amazon-bedrock and fails.
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is selected — pick one with /model first.", "error");
				return;
			}
			const modelRef = `${model.provider}/${model.id}`;

			// The fingerprint. Captured BEFORE the run, so a config change midway
			// cannot be silently attributed to the wrong setup. Stored as fields
			// rather than the whole Model object, which carries pricing and header
			// detail that would churn the record for no comparison value.
			const fingerprint = {
				model: { id: model.id, provider: model.provider, name: model.name },
				modelRef,
				thinkingLevel: ctx.thinkingLevel,
				// The tools available to each TASK, which is what affects a score — not
				// this session's tools. Each task runs in its own `pi -p --no-tools`
				// process. Recording the session's toolset here read as though the tasks
				// had them, and the run summary printed "4 tools active" for runs where
				// the tasks had none.
				taskTools: [] as string[],
				sessionTools: pi.getActiveTools().slice().sort(),
				suitePath,
				taskCount: tasks.length,
			};

			ctx.ui.notify(
				`Running ${tasks.length} tasks on ${modelRef} — one process each, no shared context.`,
				"info",
			);

			// ---- collect answers -------------------------------------------------
			const answers: Record<string, string> = {};
			const failures: string[] = [];

			for (const [i, task] of tasks.entries()) {
				const r = await pi.exec(
					"pi",
					// --no-tools is not optional. Every suite file in this repo contains
					// its own answer key, and `pi -p` enables read/bash/edit/write by
					// default — so without this a task can be answered by opening the
					// suite instead of by reasoning, and that answer looks like the best
					// one. tools/sweep.mjs asserts the same invariant at runtime.
					["-p", "--no-tools", "--model", modelRef, task.prompt],
					{ signal: ctx.signal, timeout: 180_000 },
				);

				if (r.code !== 0 || r.killed) {
					// A crashed task is NOT a zero. Scoring it as a failure would make
					// a broken harness look like a bad model, which is the exact
					// confusion this tool exists to prevent.
					failures.push(`${task.id}: ${r.killed ? "timed out" : r.stderr.trim().slice(0, 120)}`);
					continue;
				}
				answers[task.id] = r.stdout.trim();
				ctx.ui.notify(`  ${i + 1}/${tasks.length}  ${task.id}`, "info");
			}

			if (failures.length) {
				ctx.ui.notify(
					`${failures.length} task(s) never produced an answer — not grading a partial run:\n  ${failures.join("\n  ")}`,
					"error",
				);
				return;
			}

			// ---- grade -----------------------------------------------------------
			// pi.exec has no stdin option (ExecOptions is signal/timeout/cwd only),
			// so the answers go through a temp file rather than a pipe. Passing "-"
			// here would hang the grader waiting on a stdin that never arrives.
			const answersPath = join(tmpdir(), `pi-eval-answers-${process.pid}-${Date.now()}.json`);
			writeFileSync(answersPath, JSON.stringify(answers));

			let graded;
			try {
				graded = await pi.exec(
					"python3",
					[GRADECLI, "run", suitePath, "--answers", answersPath],
					{ signal: ctx.signal, timeout: 60_000 },
				);
			} finally {
				rmSync(answersPath, { force: true });
			}

			// gradecli exits 1 when a task failed and 2 when the spec was wrong.
			// Only the second is our problem.
			if (graded.code === 2) {
				ctx.ui.notify(`grading failed: ${graded.stderr.trim()}`, "error");
				return;
			}

			let result: Record<string, unknown>;
			try {
				result = JSON.parse(graded.stdout);
			} catch {
				ctx.ui.notify(`grader returned unparseable output: ${graded.stdout.slice(0, 200)}`, "error");
				return;
			}

			// ---- record ----------------------------------------------------------
			const record = { fingerprint, ...result };
			mkdirSync(RUN_DIR, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const out = join(RUN_DIR, `${stamp}.json`);
			writeFileSync(out, JSON.stringify(record, null, 2));

			const pct = ((result.score as number) * 100).toFixed(1);
			ctx.ui.notify(
				`${result.passed}/${result.n} passed · score ${pct}% · suite ${String(result.suite_hash)}\n` +
					`model ${modelRef} · tools disabled for every task\n` +
					`saved ${out} — compare two runs with /eval:compare`,
				(result.failed as number) === 0 ? "info" : "warning",
			);
		},
	});

	// -----------------------------------------------------------------------
	// /eval:compare — the part a leaderboard skips.
	//
	// Two runs are compared TASK BY TASK, ties discarded, and the result is an
	// exact sign test. The verdict refuses to call a winner when the number of
	// tasks that actually separated the configs is too small for ANY split to
	// reach significance -- "cannot tell" and "the same" are different findings.
	//
	// The arithmetic lives in gradecore (paired.py), cross-checked against
	// never-touch-ai's harness_core.js to 1e-12. Reimplementing it here would
	// have been the second copy of an exact test, which is how two surfaces end
	// up disagreeing about what "better" means.
	// -----------------------------------------------------------------------
	pi.registerCommand("eval:compare", {
		description: "Paired sign test between two runs — says so when the suite cannot decide",

		handler: async (args, ctx) => {
			const [argA, argB] = args.trim().split(/\s+/).filter(Boolean);

			let a = argA;
			let b = argB;
			let repA: string[] = [];
			let repB: string[] = [];

			// One path used to fall through to auto-discovery, silently comparing two
			// runs the user never named — and since the output labels runs by config
			// rather than by filename, nothing in the result revealed the substitution.
			if (argA && !argB) {
				ctx.ui.notify(
					"/eval:compare takes two run files, or none.\n" +
						"  /eval:compare                    compare the two most recent configs\n" +
						"  /eval:compare <runA> <runB>      compare these two",
					"error",
				);
				return;
			}

			if (!a || !b) {
				if (!existsSync(RUN_DIR)) {
					ctx.ui.notify("No runs yet — /eval writes one each time it grades.", "error");
					return;
				}
				// Group every recorded run by its CONFIG, newest first. Running /eval
				// three times without changing anything is not three configs, it is
				// three measurements of one — and those repetitions are what make it
				// possible to tell a real difference from a config disagreeing with
				// itself. Grouping here means the user gets repeated measures by
				// running /eval more times, with no flag to discover.
				const files = readdirSync(RUN_DIR)
					.filter((f) => f.endsWith(".json"))
					.sort()
					.reverse()
					.map((f) => join(RUN_DIR, f));

				const configs = groupRunsByConfig(
					files.map((path) => {
						try {
							return { path, record: JSON.parse(readFileSync(path, "utf8")) };
						} catch {
							return { path, record: null };
						}
					}),
				);
				if (configs.length < 2) {
					const n = configs[0]?.length ?? 0;
					ctx.ui.notify(
						`Only one configuration has been measured (${n} run${n === 1 ? "" : "s"}). ` +
							"Change something — the model, the thinking level, an extension — and /eval again.",
						"error",
					);
					return;
				}

				[a, ...repA] = configs[0];
				[b, ...repB] = configs[1];

				if (repA.length && !repB.length) repA = [];
				if (repB.length && !repA.length) repB = [];
				if (!repA.length || !repB.length) {
					ctx.ui.notify(
						"Comparing single runs. Run /eval a few more times on each config — " +
							"with two or more per side this switches to repeated measures and can " +
							"discard tasks a config is not self-consistent on.",
						"warning",
					);
				}
			}

			const argv = [GRADECLI, "compare", a, b];
			if (repA.length && repB.length) {
				argv.push("--rep-a", ...repA, "--rep-b", ...repB);
			}

			const res = await pi.exec("python3", argv, {
				signal: ctx.signal,
				timeout: 30_000,
			});

			// exit 2 is a refusal (mismatched suites), not a verdict.
			if (res.code === 2) {
				ctx.ui.notify(res.stderr.trim(), "error");
				return;
			}

			let out: Record<string, unknown>;
			try {
				out = JSON.parse(res.stdout);
			} catch {
				ctx.ui.notify(`comparison failed: ${res.stdout.slice(0, 200)}`, "error");
				return;
			}

			const lines = [
				String(out.verdict),
				"",
				`${out.a}  vs  ${out.b}`,
			];
			if (out.mode === "repeated") {
				lines.push(
					`${out.reps_a}x vs ${out.reps_b}x · ${out.wins_a}\u2013${out.wins_b} on ${out.informative} informative task(s), ` +
						`${out.ties} tied, ${out.unstable} unstable · p=${Number(out.p).toFixed(3)}`,
					// The floor a finding has to clear. Printing the verdict without it
					// invites reading a within-config wobble as a between-config result.
					`noise floor: ${Number(out.noise_floor_a).toFixed(2)} vs ${Number(out.noise_floor_b).toFixed(2)} ` +
						`informative task(s) from each config compared with ITSELF`,
				);
			} else {
				lines.push(
					`${out.wins_a}\u2013${out.wins_b} on ${out.informative} informative task(s), ${out.ties} tied · p=${Number(out.p).toFixed(3)}`,
				);
			}
			if (out.underpowered) {
				lines.push(
					`This suite needs ${out.tasks_needed_for_any_verdict} tasks that disagree before any result can reach p<${out.alpha}.`,
				);
			}
			ctx.ui.notify(lines.join("\n"), out.decisive ? "info" : "warning");
		},
	});
}
