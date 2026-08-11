import fs from "node:fs";
import path from "node:path";
import type { ContextData, ConversationMessage } from "../types";
import { debug, info, warn } from "../utils/logger";
import { sanitizeId } from "../utils/sanitize";

const CONTEXTS_DIR = path.join(process.cwd(), "contexts");

export { sanitizeId };

export function loadContext(conversationId: string): ContextData | null {
	const safeId = sanitizeId(conversationId);
	const file = path.join(CONTEXTS_DIR, `${safeId}.json`);

	try {
		const data = fs.readFileSync(file, "utf-8");
		return JSON.parse(data) as ContextData;
	} catch {
		return null;
	}
}

export function saveContext(conversationId: string, data: ContextData): void {
	const safeId = sanitizeId(conversationId);
	const file = path.join(CONTEXTS_DIR, `${safeId}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}

export function clearContext(conversationId: string): void {
	const safeId = sanitizeId(conversationId);
	const file = path.join(CONTEXTS_DIR, `${safeId}.json`);
	if (fs.existsSync(file)) {
		fs.unlinkSync(file);
		debug(`Cleared context for ${conversationId}`);
	}
}

export function ensureDirectory(): void {
	if (!fs.existsSync(CONTEXTS_DIR)) {
		fs.mkdirSync(CONTEXTS_DIR, { recursive: true });
		info(`Created contexts directory: ${CONTEXTS_DIR}`);
	}
}

export function cleanupOldContexts(maxAgeDays: number): void {
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

	try {
		for (const file of fs.readdirSync(CONTEXTS_DIR)) {
			if (!file.endsWith(".json")) continue;

			const stat = fs.statSync(path.join(CONTEXTS_DIR, file));
			if (stat.mtimeMs < cutoff) {
				fs.unlinkSync(path.join(CONTEXTS_DIR, file));
				debug(`Cleaned old context: ${file}`);
			}
		}
	} catch (err) {
		warn(`Context cleanup failed: ${(err as Error).message}`);
	}
}

export function updateContext(
	conversationId: string,
	messages: ConversationMessage[],
	maxContextMessages: number,
): void {
	let contextData = loadContext(conversationId);

	if (!contextData) {
		contextData = {
			conversationId,
			firstSeen: new Date().toISOString(),
			lastUpdated: new Date().toISOString(),
			messages: [],
			summary: "",
		};
	}

	const existingIds = new Set(contextData.messages.map((m) => m.entryId));
	const newMessages = messages.filter((m) => !existingIds.has(m.entryId));

	if (newMessages.length > 0) {
		contextData.messages.push(...newMessages);

		if (contextData.messages.length > maxContextMessages) {
			contextData.messages = contextData.messages.slice(-maxContextMessages);
		}

		contextData.lastUpdated = new Date().toISOString();
		contextData.summary = generateSummary(contextData.messages);
		saveContext(conversationId, contextData);

		debug(
			`Context updated for ${conversationId}: +${newMessages.length} messages`,
		);
	}
}

function generateSummary(messages: ConversationMessage[]): string {
	if (!messages?.length) return "";

	const lines: string[] = [];
	const firstUser = messages.find((m) => m.role === "user");

	if (firstUser) {
		const preview =
			firstUser.text.substring(0, 80) +
			(firstUser.text.length > 80 ? "..." : "");
		lines.push(`Started with: "${preview}"`);
	}

	const lastMessages = messages.slice(-6);
	if (lastMessages.length > 0 && messages.length > 1) {
		lines.push("Recent:");
		for (const msg of lastMessages) {
			const prefix = msg.role === "user" ? "👤" : "🤖";
			const short =
				msg.text.substring(0, 60) + (msg.text.length > 60 ? "..." : "");
			lines.push(`  ${prefix} ${short}`);
		}
	}

	let summary = lines.join("\n");
	if (summary.length > 500) {
		summary = summary.substring(0, 500) + "...";
	}

	return summary;
}
