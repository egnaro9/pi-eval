// node --test tests/eval-grouping.test.mjs
//
// /eval:compare picks what to compare by grouping recorded runs by config. The
// failure this guards against is silent: two DIFFERENT configs pooled as
// repetitions of one would make a real difference vanish into "no task
// separates them", and nothing in the output would say so.

import assert from "node:assert/strict";
import { test } from "node:test";

import { groupRunsByConfig } from "../extensions/eval.ts";

const rec = (over = {}) => ({
	suite_hash: "abc123",
	fingerprint: {
		modelRef: "anthropic/claude-haiku-4-5",
		thinkingLevel: "medium",
		activeTools: [],
		...(over.fingerprint ?? {}),
	},
	...(over.suite_hash ? { suite_hash: over.suite_hash } : {}),
});

const rows = (...specs) => specs.map(([path, r]) => ({ path, record: r }));

test("identical configs are one group, in input order", () => {
	const g = groupRunsByConfig(rows(["r3", rec()], ["r2", rec()], ["r1", rec()]));
	assert.deepEqual(g, [["r3", "r2", "r1"]]);
});

test("a different thinking level is a different config", () => {
	const g = groupRunsByConfig(rows(
		["a1", rec()],
		["b1", rec({ fingerprint: { thinkingLevel: "off" } })],
	));
	assert.equal(g.length, 2);
});

test("a different model is a different config", () => {
	const g = groupRunsByConfig(rows(
		["a", rec()],
		["b", rec({ fingerprint: { modelRef: "anthropic/claude-sonnet-4-6" } })],
	));
	assert.equal(g.length, 2);
});

test("a different tool set is a different config", () => {
	// Tools change what a model can do; pooling these would average two
	// different capabilities and call the result one measurement.
	const g = groupRunsByConfig(rows(
		["a", rec()],
		["b", rec({ fingerprint: { activeTools: ["read"] } })],
	));
	assert.equal(g.length, 2);
});

test("runs of different suites are never pooled as repetitions", () => {
	// A delta across different questions means nothing, and averaging across
	// them means less than nothing.
	const g = groupRunsByConfig(rows(
		["a", rec()],
		["b", rec({ suite_hash: "different" })],
	));
	assert.equal(g.length, 2);
});

test("an unparseable record is skipped, not counted as a config", () => {
	const g = groupRunsByConfig(rows(["ok", rec()], ["broken", null]));
	assert.deepEqual(g, [["ok"]]);
});

test("records missing a fingerprint group together rather than crashing", () => {
	const g = groupRunsByConfig(rows(["a", { suite_hash: "abc123" }], ["b", { suite_hash: "abc123" }]));
	assert.deepEqual(g, [["a", "b"]]);
});


// ---------------------------------------------------------------------------
// A source-level check, on purpose: the invariant it guards is security-shaped
// and the call site is inside a Pi session that cannot be unit-tested here.
//
// Demonstrated exploitable before the fix. Same prompt, same model:
//   pi -p            -> "PINEAPPLE-7731"   (it opened the file)
//   pi -p --no-tools -> could not
// Every suite in this repo ships its own answer key, so a task answered by
// reading the suite scores full marks and looks like the best answer there is.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "eval.ts"),
	"utf8",
);

test("/eval spawns every task with --no-tools", () => {
	const call = SRC.match(/\[\s*"-p"[^\]]*\]/s);
	assert.ok(call, "could not find the pi -p argv in eval.ts");
	assert.match(call[0], /"--no-tools"/,
		"a task must not be able to answer by reading the suite file");
});

test("the run summary does not report session tools as the task's tools", () => {
	// It printed "4 tools active" for runs whose tasks had none.
	assert.doesNotMatch(SRC, /activeTools\.length\} tools active/);
});
