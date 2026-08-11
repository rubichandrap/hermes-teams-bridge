import { describe, expect, it } from "vitest";
import {
	INJECTION_MARKER_CONTEXT,
	INJECTION_MARKER_INSTRUCTION,
	INJECTION_TOPICS_PREFIX,
	buildInjectedContext,
	parseMessage,
} from "../session/parser";
import type { ConversationMessage } from "../types";
import { buildContextReference, getConversationTopics } from "./md-writer";

function msg(role: "user" | "assistant", text: string): ConversationMessage {
	return { role, text, timestamp: null, entryId: "1" };
}

describe("getConversationTopics", () => {
	it("passes short clean text through unchanged", () => {
		expect(getConversationTopics([msg("user", "hi there")])).toEqual([
			"hi there",
		]);
	});

	it("truncates long text with ellipsis at 50 chars", () => {
		const long = "x".repeat(120);
		expect(getConversationTopics([msg("user", long)])).toEqual([
			`${"x".repeat(50)}...`,
		]);
	});

	it("does not truncate text of exactly 50 chars", () => {
		const fifty = "x".repeat(50);
		expect(getConversationTopics([msg("user", fifty)])).toEqual([fifty]);
	});

	it("is pure truncation — inline cleanup is gone", () => {
		const dirty =
			"[TEAMS_META]\nconversationId: c\n[/TEAMS_META]\n<b>hi</b>\n---\npayload";
		expect(getConversationTopics([msg("user", dirty)])).toEqual([
			`${dirty.substring(0, 50)}...`,
		]);
	});

	it("falls back to (empty) for blank text", () => {
		expect(getConversationTopics([msg("user", "  ")])).toEqual(["(empty)"]);
	});

	it("trims before truncating — padded long text is not lost", () => {
		const padded = `${" ".repeat(60)}hello`;
		expect(getConversationTopics([msg("user", padded)])).toEqual(["hello"]);
	});

	it("skips assistant messages", () => {
		const topics = getConversationTopics([
			msg("assistant", "reply"),
			msg("user", "q1"),
			msg("user", "q2"),
		]);
		expect(topics).toEqual(["q1", "q2"]);
	});

	it("limits to the most recent maxTopics", () => {
		const messages = Array.from({ length: 7 }, (_, i) => msg("user", `q${i}`));
		expect(getConversationTopics(messages, 3)).toEqual(["q4", "q5", "q6"]);
	});
});

describe("topic preview length for saved conversation MD", () => {
	it("truncates long text with ellipsis at 80 chars", () => {
		const long = "y".repeat(120);
		expect(getConversationTopics([msg("user", long)], 10, 80)).toEqual([
			`${"y".repeat(80)}...`,
		]);
	});
});

describe("buildContextReference", () => {
	it("builds the block with exported marker constants", () => {
		const ref = buildContextReference("conv-1", [msg("user", "hello")]);
		expect(ref).toBe(
			`${INJECTION_MARKER_CONTEXT} [1 msgs] Context: ~/.openclaw/workspace/memory/teams-conversations/conv-1.md\n${INJECTION_TOPICS_PREFIX} hello\n`,
		);
	});

	it("returns empty when every topic is empty", () => {
		expect(buildContextReference("conv-1", [msg("user", "  ")])).toBe("");
	});

	it("returns empty when there are no messages", () => {
		expect(buildContextReference("conv-1", [])).toBe("");
	});

	it("round-trips through the seam: builder output strips back to the payload", () => {
		const ref = buildContextReference("conv-1", [
			msg("user", "What is the weather?"),
		]);
		const instruction = `${INJECTION_MARKER_INSTRUCTION} Reply with ONE final message.`;
		const enriched = buildInjectedContext(ref, instruction);
		const payload = [
			"[TEAMS_META]",
			"conversationId: conv-1",
			"teamsMessageId: msg-1",
			"[/TEAMS_META]",
			"",
			"Hello there",
		].join("\n");
		const result = parseMessage(`${enriched}\n\n${payload}`);
		expect(result.text).toBe("Hello there");
	});
});
