// node --test tests/sweep.test.mjs
//
// These test one function — extractAnswer — because it is the only place a
// fabricated answer can enter the pipeline. Everything downstream trusts that
// a string in the answers map came from a model that finished talking.
//
// The graders are gradecore's problem and have their own suite. This is the
// seam where an infrastructure failure gets to impersonate a model output.

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractAnswer } from "../tools/extract-answer.mjs";

/** Minimal stand-in for a settled AgentSession. */
const session = (stopReason, text, content) => ({
	messages: [
		{
			role: "assistant",
			stopReason,
			content: content ?? [{ type: "text", text }],
			errorMessage: undefined,
		},
	],
	getLastAssistantText: () => text,
});

test("a completed answer comes through unchanged", () => {
	const { text, stopReason } = extractAnswer(session("stop", "Astana"));
	assert.equal(text, "Astana");
	assert.equal(stopReason, "stop");
});

test("a truncated answer is refused, not graded", () => {
	// The dangerous case. "Asta" for a task expecting "Astana" reads as a model
	// that got the capital wrong; the paired sign test then counts it as a
	// directional loss and an infrastructure failure becomes a claim about model
	// capability. Empty answers were already blocked — this one looks real.
	assert.throws(
		() => extractAnswer(session("length", "Asta")),
		/truncated at the output-token cap/,
	);
});

test("an errored or aborted request is refused", () => {
	assert.throws(() => extractAnswer(session("error", "")), /request error/);
	assert.throws(() => extractAnswer(session("aborted", "")), /request aborted/);
});

test("whitespace is not an answer", () => {
	// gradecore treats a MISSING answer as a loud error and a present one as
	// gradeable. "   " would be graded — and fail — making a crashed run look
	// like a bad model.
	assert.throws(() => extractAnswer(session("stop", "   ")), /produced no text/);
});

test("a tool-assisted answer is refused even when the text looks perfect", () => {
	// Tools are off, and the suite file with every expected value is in this
	// repo. An answer produced by reading a file is not an answer to the
	// question, and it is exactly the answer that would look best.
	const withToolCall = session("stop", "Astana", [
		{ type: "toolCall", name: "read" },
		{ type: "text", text: "Astana" },
	]);
	assert.throws(() => extractAnswer(withToolCall), /issued a tool call \(read\)/);
});

test("a transcript with no assistant message is refused", () => {
	assert.throws(
		() => extractAnswer({ messages: [{ role: "user", content: [] }], getLastAssistantText: () => undefined }),
		/no assistant message/,
	);
});
