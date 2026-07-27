/**
 * extract-answer.mjs — the one place a fabricated answer can enter the pipeline.
 *
 * Deliberately imports NOTHING. Everything downstream trusts that a string in the
 * answers map came from a model that finished talking, and that invariant should
 * be testable by anyone who clones this repo — not only on a machine with the Pi
 * agent installed globally. CI caught exactly that: the tests passed locally and
 * failed on a clean checkout, because this logic lived in the file that imports
 * the SDK.
 *
 * Takes a session-shaped object: { messages, getLastAssistantText() }.
 */

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
