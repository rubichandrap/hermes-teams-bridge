import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../types";
import {
	extractLatestAssistantText,
	getLatestAssistantActivity,
	hasNoReply,
	hasToolCall,
	parseMessage,
} from "./parser";

const INSTRUCTION =
	"📋 Reply with ONE final message. No narration, no planning, no NO_REPLY for questions.";

function entry(role: string, content: string): SessionEntry {
	return {
		type: "message",
		id: "1",
		message: { role, content },
	};
}

const ENRICHED = [
	INSTRUCTION,
	"",
	"[TEAMS_META]",
	"conversationId: conv-1",
	"teamsMessageId: msg-1",
	"senderName: Tester",
	"[/TEAMS_META]",
	"",
	"What is the weather today?",
].join("\n");

function partsEntry(id: string, parts: unknown[]): SessionEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: parts },
	};
}

function thinkingPart(text: string): Record<string, unknown> {
	return { type: "thinking", thinking: text };
}

function textPart(text: string): Record<string, unknown> {
	return { type: "text", text };
}

function toolCallPart(): Record<string, unknown> {
	return { type: "toolCall", id: "c1", name: "web_search" };
}

describe("extractLatestAssistantText", () => {
	it("skips mid-turn narration messages that carry tool calls", () => {
		const entries = [
			partsEntry("narr-1", [
				thinkingPart("hmm"),
				textPart("Coba cek dulu."),
				toolCallPart(),
			]),
			partsEntry("final-1", [
				thinkingPart("done"),
				textPart("Ini jawaban finalnya."),
			]),
		];
		const result = extractLatestAssistantText(entries);
		expect(result?.text).toBe("Ini jawaban finalnya.");
		expect(result?.entryId).toBe("final-1");
	});

	it("returns null when only narration remains", () => {
		const entries = [
			partsEntry("narr-1", [textPart("Coba cek dulu."), toolCallPart()]),
		];
		expect(extractLatestAssistantText(entries)).toBeNull();
	});

	it("keeps plain string-content assistant messages working", () => {
		const result = extractLatestAssistantText([
			entry("assistant", "plain answer"),
		]);
		expect(result?.text).toBe("plain answer");
	});
});

describe("hasNoReply", () => {
	it("ignores narration when deciding NO_REPLY", () => {
		const entries = [
			partsEntry("narr-1", [textPart("Coba cek dulu."), toolCallPart()]),
			entry("assistant", "NO_REPLY"),
		];
		expect(hasNoReply(entries)).toBe(true);
	});

	it("is false while only narration exists", () => {
		const entries = [
			partsEntry("narr-1", [textPart("Coba cek dulu."), toolCallPart()]),
		];
		expect(hasNoReply(entries)).toBe(false);
	});
});

describe("getLatestAssistantActivity", () => {
	it("returns the most recent assistant timestamp regardless of content", () => {
		const entries = [
			{
				...partsEntry("a1", [toolCallPart()]),
				timestamp: "2026-08-05T00:00:01.000Z",
			},
			{
				...partsEntry("a2", [textPart("x")]),
				timestamp: "2026-08-05T00:00:02.000Z",
			},
		];
		expect(getLatestAssistantActivity(entries)).toBe(
			"2026-08-05T00:00:02.000Z",
		);
	});
});

describe("parseMessage", () => {
	it("preserves the user's payload text through an enriched message", () => {
		const result = parseMessage(ENRICHED);
		expect(result.text).toBe("What is the weather today?");
		expect(result.metadata.conversationId).toBe("conv-1");
		expect(result.metadata.teamsMessageId).toBe("msg-1");
		expect(result.metadata.senderName).toBe("Tester");
	});

	it("recovers the payload from the instruction-prefixed message (round-trip)", () => {
		const payload = [
			"[TEAMS_META]",
			"conversationId: conv-1",
			"teamsMessageId: msg-1",
			"[/TEAMS_META]",
			"",
			"Hello there",
		].join("\n");
		const injected = `${INSTRUCTION}\n\n${payload}`;
		const result = parseMessage(injected);
		expect(result.text).toBe("Hello there");
		expect(result.metadata.conversationId).toBe("conv-1");
	});

	it("passes plain meta-less text through unchanged", () => {
		const result = parseMessage("hi there");
		expect(result.text).toBe("hi there");
		expect(result.metadata).toEqual({});
	});

	it("keeps payloads without the instruction block unchanged", () => {
		const result = parseMessage("hello\n---\nworld");
		expect(result.text).toBe("hello\n---\nworld");
	});

	it("decodes entity-encoded instruction markers before stripping them", () => {
		const encoded = [
			"&#128203; Reply with ONE final message",
			"",
			"[TEAMS_META]",
			"conversationId: conv-1",
			"teamsMessageId: msg-1",
			"[/TEAMS_META]",
			"",
			"body text",
		].join("\n");
		const result = parseMessage(encoded);
		expect(result.text).toBe("body text");
	});

	it("keeps marker-looking text inside the payload body", () => {
		const withQuote = [
			INSTRUCTION,
			"",
			"[TEAMS_META]",
			"conversationId: conv-1",
			"teamsMessageId: msg-1",
			"[/TEAMS_META]",
			"",
			"I said 📜 and 📋 in my message",
		].join("\n");
		const result = parseMessage(withQuote);
		expect(result.text).toBe("I said 📜 and 📋 in my message");
	});

	it("strips repeated instruction lines", () => {
		const repeated = [
			INSTRUCTION,
			"📋 Reply with ONE final message",
			"",
			"[TEAMS_META]",
			"conversationId: conv-1",
			"teamsMessageId: msg-1",
			"[/TEAMS_META]",
			"",
			"payload",
		].join("\n");
		const result = parseMessage(repeated);
		expect(result.text).toBe("payload");
	});

	it("keeps a payload that opens with Topics:", () => {
		const ambiguous = [
			INSTRUCTION,
			"",
			"[TEAMS_META]",
			"conversationId: conv-1",
			"teamsMessageId: msg-1",
			"[/TEAMS_META]",
			"",
			"Topics: what the user actually typed",
		].join("\n");
		const result = parseMessage(ambiguous);
		expect(result.text).toBe("Topics: what the user actually typed");
	});

	it("returns empty metadata for bare mentions", () => {
		const result = parseMessage("no meta here");
		expect(result.text).toBe("no meta here");
		expect(Object.keys(result.metadata)).toHaveLength(0);
	});
});

describe("Hermes store message shapes", () => {
	it("detects mid-turn narration via tool_calls or finish_reason", () => {
		expect(
			hasToolCall({ toolCalls: '[{"id":"call-1"}]', finishReason: null }),
		).toBe(true);
		expect(hasToolCall({ toolCalls: null, finishReason: "tool_calls" })).toBe(
			true,
		);
		expect(
			hasToolCall({ toolCalls: null, finishReason: "stop", content: "final" }),
		).toBe(false);
		expect(hasToolCall({ content: "plain text" })).toBe(false);
	});

	it("extracts the final assistant text, skipping tool_calls rows", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				message: {
					role: "user",
					content: "[TEAMS_META]\nconversationId: c\n[/TEAMS_META]\n\nhello",
				},
			},
			{
				type: "message",
				id: "2",
				message: {
					role: "assistant",
					content: "Let me check that.",
					toolCalls: "[]",
					finishReason: "tool_calls",
				},
			},
			{
				type: "message",
				id: "3",
				message: {
					role: "assistant",
					content: "Here is the final answer.",
					toolCalls: null,
					finishReason: "stop",
				},
			},
		];
		const latest = extractLatestAssistantText(entries);
		expect(latest?.text).toBe("Here is the final answer.");
		expect(latest?.entryId).toBe("3");
	});

	it("treats NO_REPLY sentinel from Hermes rows as silent", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "1",
				message: {
					role: "user",
					content: "[TEAMS_META]\nconversationId: c\n[/TEAMS_META]\n\nhello",
				},
			},
			{
				type: "message",
				id: "2",
				message: {
					role: "assistant",
					content: "NO_REPLY",
					toolCalls: null,
					finishReason: "stop",
				},
			},
		];
		expect(extractLatestAssistantText(entries)).toBeNull();
		expect(hasNoReply(entries)).toBe(true);
	});
});
