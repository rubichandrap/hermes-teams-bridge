import https from "node:https";
import { getMessageText, parseMessage } from "../session/parser";
import type {
	ErrorCategory,
	ForwardResult,
	SessionEntry,
	TeamsMetadata,
} from "../types";
import { debug, error } from "../utils/logger";
import { getHttpsAgent } from "./http-agent";

const TRANSIENT_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"EPIPE",
	"ECONNREFUSED",
]);

const REQUEST_TIMEOUT_MS = 100_000;

const BREAKER_FAILURE_THRESHOLD = 2;
export const BREAKER_COOLDOWN_MS = 30_000;

interface BreakerState {
	status: "closed" | "open";
	streak: number;
	openedAt: number;
	probeInFlight: boolean;
}

const breakers = new Map<string, BreakerState>();

function getBreaker(key: string): BreakerState {
	let breaker = breakers.get(key);
	if (!breaker) {
		breaker = {
			status: "closed",
			streak: 0,
			openedAt: 0,
			probeInFlight: false,
		};
		breakers.set(key, breaker);
	}
	return breaker;
}

export function resetBreakerState(): void {
	breakers.clear();
}

function recordBreakerFailure(
	breaker: BreakerState,
	category: ErrorCategory,
): void {
	breaker.probeInFlight = false;
	if (category === "permanent") {
		breaker.status = "closed";
		breaker.streak = 0;
		return;
	}
	if (breaker.status === "open") {
		breaker.openedAt = Date.now();
		return;
	}
	breaker.streak += 1;
	if (breaker.streak >= BREAKER_FAILURE_THRESHOLD) {
		breaker.status = "open";
		breaker.openedAt = Date.now();
	}
}

interface CategorizedError {
	message: string;
	code: string;
	category: ErrorCategory;
}

export async function postToFlow2(
	text: string,
	metadata: TeamsMetadata,
	originalMessage: string,
	flow2Url: string,
	signature: string,
): Promise<ForwardResult> {
	if (!flow2Url) {
		return {
			forwarded: false,
			error: "flow2Url not set",
			category: "permanent",
		};
	}

	const payload = {
		message: `${signature}\n\n${text}`,
		conversationId: metadata.conversationId ?? "",
		teamsMessageId: metadata.teamsMessageId ?? "",
		senderName: metadata.senderName ?? "",
		senderUserId: metadata.senderUserId ?? "",
		originalMessage,
	};

	debug(
		`Flow 2 payload: ${JSON.stringify({
			message: `${payload.message.substring(0, 60)}...`,
			conversationId: payload.conversationId,
			teamsMessageId: payload.teamsMessageId,
			originalMessageLen: payload.originalMessage.length,
		})}`,
	);

	if (!payload.conversationId || !payload.teamsMessageId) {
		return {
			forwarded: false,
			error: "Missing Teams metadata",
			category: "permanent",
		};
	}
	const breaker = getBreaker(flow2Url);
	const cooldownElapsed = Date.now() - breaker.openedAt >= BREAKER_COOLDOWN_MS;
	if (
		breaker.status === "open" &&
		(!cooldownElapsed || breaker.probeInFlight)
	) {
		return {
			forwarded: false,
			category: "server-busy",
			error: "breaker open",
			breakerOpen: true,
		};
	}
	if (breaker.status === "open") {
		breaker.probeInFlight = true;
	}

	try {
		const response = await sendHttpsRequest(flow2Url, JSON.stringify(payload));
		if (response.statusCode >= 200 && response.statusCode < 300) {
			const paError = powerAutomateError(response.body);
			if (paError) {
				recordBreakerFailure(breaker, "server-busy");
				return {
					forwarded: false,
					httpCode: response.statusCode,
					error: `Power Automate: ${paError}`,
					category: "server-busy",
				};
			}
			breaker.status = "closed";
			breaker.streak = 0;
			breaker.probeInFlight = false;
			return {
				forwarded: true,
				httpCode: response.statusCode,
				category: "transient",
			};
		}
		const category = categorizeHttpError(response.statusCode, response.body);
		recordBreakerFailure(breaker, category);
		return {
			forwarded: false,
			httpCode: response.statusCode,
			error: response.body || `HTTP ${response.statusCode}`,
			category,
		};
	} catch (err) {
		const categorized = categorizeError(err);
		recordBreakerFailure(breaker, categorized.category);
		error(
			`Flow 2 fetch failed [${categorized.category}/${categorized.code}]: ${categorized.message}`,
		);
		return {
			forwarded: false,
			error: categorized.message,
			category: categorized.category,
		};
	}
}

interface HttpResponse {
	statusCode: number;
	body: string;
}

function powerAutomateError(body: string): string | null {
	try {
		const data = JSON.parse(body) as {
			properties?: { error?: { code?: unknown; message?: unknown } };
		};
		const err = data.properties?.error;
		if (!err || typeof err.code !== "string" || !err.code) return null;
		return typeof err.message === "string" && err.message
			? `${err.code}: ${err.message}`
			: err.code;
	} catch {
		return null;
	}
}

function sendHttpsRequest(url: string, body: string): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch (e) {
			clearTimeout(timer);
			reject(new Error(`Invalid URL: ${url}`));
			return;
		}

		const req = https.request(
			{
				method: "POST",
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || 443,
				path: parsedUrl.pathname + parsedUrl.search,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body).toString(),
				},
				agent: getHttpsAgent(),
				timeout: REQUEST_TIMEOUT_MS,
				signal: controller.signal,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					clearTimeout(timer);
					resolve({
						statusCode: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf-8"),
					});
				});
				res.on("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
			},
		);

		req.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		req.on("timeout", () => {
			clearTimeout(timer);
			req.destroy(new Error("request timeout"));
		});

		req.write(body);
		req.end();
	});
}

export function categorizeError(err: unknown): CategorizedError {
	const e = err as Error & { code?: string; name?: string };
	const code = e.code ?? e.name ?? "UNKNOWN";
	const category: ErrorCategory = TRANSIENT_CODES.has(code)
		? "transient"
		: "transient";
	return {
		message: e.message || "fetch failed",
		code,
		category,
	};
}

export function categorizeHttpError(
	status: number,
	body: string,
): ErrorCategory {
	if (status === 502 || status === 503 || status === 504) {
		if (/NoResponse/i.test(body)) return "server-busy";
		return "transient";
	}
	if (status === 429) return "server-busy";
	if (status >= 500) return "transient";
	return "permanent";
}

export function extractOriginalUserMessage(entries: SessionEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;

		const msg = entry.message ?? {};
		if (msg.role !== "user") continue;

		const rawText = getMessageText(msg);
		if (!rawText || !/\[TEAMS_META\]/i.test(rawText)) continue;

		const parsed = parseMessage(rawText);

		if (parsed.text) return `Re: ${parsed.text}`;
	}

	return "";
}
