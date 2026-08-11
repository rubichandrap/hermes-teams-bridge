import type {
	ConversationMessage,
	SessionEntry,
	TeamsMetadata,
} from "../types";

/**
 * Session parsing utilities
 * SRP: Parse and extract data from Hermes sessions
 */

export function getMessageText(msg: Record<string, unknown>): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter(
			(part): part is { type: string; text: string } =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

/**
 * True when the message carries a tool call. An assistant message that
 * still invokes tools is mid-turn narration, never a final response.
 *
 * Hermes marks such messages with a non-empty `tool_calls` column or
 * `finish_reason = "tool_calls"`; OpenClaw encoded them as content parts of
 * type "toolCall". Both shapes are checked so the parser stays portable.
 */
export function hasToolCall(msg: Record<string, unknown>): boolean {
	const toolCalls = msg.toolCalls;
	if (typeof toolCalls === "string" && toolCalls.length > 0) return true;
	if (msg.finishReason === "tool_calls") return true;

	const content = msg.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "toolCall",
	);
}

export function parseTeamsMetadataFromText(text: string): TeamsMetadata | null {
	if (!text) return null;

	const blockMatch = text.match(/\[TEAMS_META\]([\s\S]*?)\[\/TEAMS_META\]/i);
	if (!blockMatch) return null;

	const meta: TeamsMetadata = {};
	for (const rawLine of blockMatch[1]!.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (match) {
			const key = match[1]!;
			const value = match[2]!;
			meta[key.trim()] = value.trim();
		}
	}

	return meta;
}

export const INJECTION_MARKER_CONTEXT = "📜";
export const INJECTION_MARKER_INSTRUCTION = "📋";
export const INJECTION_TOPICS_PREFIX = "Topics:";

export function buildInjectedContext(
	contextRef: string,
	instruction: string,
): string {
	return [contextRef, instruction].filter(Boolean).join("\n\n");
}

export function hasTeamsMetadata(entries: SessionEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const strings = collectStrings(entry);
		if (strings.some((s) => /\[TEAMS_META\][\s\S]*?\[\/TEAMS_META\]/i.test(s)))
			return true;
	}
	return false;
}

export function extractTeamsMetadata(entries: SessionEntry[]): TeamsMetadata {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry?.type !== "message") continue;

		const strings = collectStrings(entry);
		for (const text of strings) {
			if (/\[TEAMS_META\][\s\S]*?\[\/TEAMS_META\]/i.test(text)) {
				const meta = parseTeamsMetadataFromText(text);
				if (meta?.conversationId && meta?.teamsMessageId) return meta;
			}
		}
	}
	return {};
}

export function extractLatestAssistantText(
	entries: SessionEntry[],
): { text: string; entryId: string; timestamp: string | null } | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;

		const msg = entry.message ?? {};
		if (msg.role !== "assistant") continue;
		if (hasToolCall(msg)) continue;

		const text = getMessageText(msg).trim();
		if (text && text !== "NO_REPLY") {
			return {
				text,
				entryId: entry.id ?? `idx-${i}`,
				timestamp: msg.timestamp ?? entry.timestamp ?? null,
			};
		}
	}
	return null;
}

export function hasNoReply(entries: SessionEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;

		const msg = entry.message ?? {};
		if (msg.role !== "assistant") continue;
		if (hasToolCall(msg)) continue;

		const text = getMessageText(msg).trim();
		if (text === "NO_REPLY") return true;
		if (text) return false;
	}
	return false;
}

/**
 * Timestamp of the most recent assistant activity (any kind, including
 * thinking/tool-call entries). Used to keep long agentic turns alive
 * against the response-timeout window.
 */
export function getLatestAssistantActivity(
	entries: SessionEntry[],
): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;

		const msg = entry.message ?? {};
		if (msg.role !== "assistant") continue;

		return msg.timestamp ?? entry.timestamp ?? null;
	}
	return null;
}

export function extractConversationHistory(
	entries: SessionEntry[],
): ConversationMessage[] {
	const messages: ConversationMessage[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;

		const msg = entry.message ?? {};
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const rawText = getMessageText(msg).trim();
		if (!rawText || rawText === "NO_REPLY") continue;

		let metadata: TeamsMetadata | undefined;
		let text = rawText;

		if (role === "user") {
			const parsed = parseMessage(rawText);
			text = parsed.text;
			if (Object.keys(parsed.metadata).length > 0) metadata = parsed.metadata;
		}

		const ts = msg.timestamp ?? entry.timestamp ?? null;
		const dedupKey = `${role}|${text.substring(0, 100)}|${ts}`;
		if (seen.has(dedupKey)) continue;

		seen.add(dedupKey);
		messages.push({
			role,
			text,
			timestamp: ts,
			entryId: entry.id ?? `idx-${i}`,
			...(metadata && { metadata }),
		});
	}

	return messages;
}

export function isReplyMessage(metadata: TeamsMetadata): boolean {
	const hasRef = String(metadata.hasMessageReference ?? "").toLowerCase();
	if (hasRef === "true") return true;

	const hasAttachments =
		Number.parseInt(String(metadata.hasAttachments), 10) || 0;
	if (hasAttachments > 0) return true;

	if (
		metadata.replyToMessageId &&
		metadata.replyToMessageId !== metadata.teamsMessageId
	) {
		return true;
	}
	if (metadata.replyToId && metadata.replyToId !== metadata.teamsMessageId) {
		return true;
	}

	return false;
}

function stripTeamsMeta(text: string): string {
	return String(text ?? "")
		.replace(/\[TEAMS_META\][\s\S]*?\[\/TEAMS_META\]/i, "")
		.trim();
}

function stripOpenClawWebhookWrapper(text: string): string {
	let value = String(text ?? "");

	const endIdx = value.indexOf("<<<END_EXTERNAL_UNTRUSTED_CONTENT");
	if (endIdx >= 0) {
		value = value.slice(0, endIdx).trim();

		const sepIdx = value.indexOf("---\n");
		if (sepIdx >= 0) value = value.slice(sepIdx + 4).trim();
	}

	return value;
}

function stripHtml(html: string): string {
	return String(html ?? "")
		.replace(/<attachment[\s\S]*?<\/attachment>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
			const codePoint = Number.parseInt(n, 16);
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return `&#x${n};`;
			}
		})
		.replace(/&#(\d+);/g, (_, n) => {
			const codePoint = Number.parseInt(n, 10);
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return `&#${n};`;
			}
		})
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+/g, " ")
		.trim();
}

function stripInjectedContext(text: string): string {
	const lines = String(text ?? "").split("\n");
	const result: string[] = [];
	let lastLineWasMarker = false;
	let stripping = true;

	for (const line of lines) {
		const trimmed = line.trim();
		if (stripping) {
			if (trimmed === "") {
				lastLineWasMarker = false;
				continue;
			}

			if (trimmed.startsWith("📜") || trimmed.startsWith("📋")) {
				lastLineWasMarker = true;
				continue;
			}

			if (lastLineWasMarker && trimmed.startsWith("Topics:")) continue;

			stripping = false;
		}

		result.push(line);
	}

	return result.join("\n").trim();
}

export function parseMessage(raw: string): {
	text: string;
	metadata: TeamsMetadata;
} {
	const text = stripInjectedContext(
		stripHtml(stripOpenClawWebhookWrapper(stripTeamsMeta(raw))),
	);
	const metadata = parseTeamsMetadataFromText(raw) ?? {};
	return { text, metadata };
}

// ─── Helper ──────────────────────────────────────────────────────────────

function collectStrings(value: unknown, output: string[] = []): string[] {
	if (typeof value === "string") {
		output.push(value);
		return output;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, output);
		return output;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectStrings(item, output);
	}
	return output;
}
