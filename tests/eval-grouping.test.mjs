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
