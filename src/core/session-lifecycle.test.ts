import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStore, TeamSessionRef } from "../store/hermes-store";
import type {
	BridgeConfig,
	ErrorCategory,
	Flow2Payload,
	SessionEntry,
} from "../types";
import type { SessionLifecycle } from "./session-lifecycle";
import { computeBackoff } from "./session-lifecycle";

interface HttpsCall {
	body: string;
}

/**
 * Test store backed by the same .jsonl fixture files the original OpenClaw
 * harness wrote — keeps every test's session-writing helper unchanged.
 */
class FileBackedStore implements SessionStore {
	constructor(private readonly dir: string) {}

	readSessionEntries(sessionId: string): SessionEntry[] | null {
		const file = path.join(this.dir, `${sessionId}.jsonl`);
		if (!fs.existsSync(file)) return null;
		try {
			return fs
				.readFileSync(file, "utf-8")
				.split("\n")
				.filter((l) => l.trim())
				.map((line) => JSON.parse(line) as SessionEntry);
		} catch {
			return null;
		}
	}

	listSessionsWithTeamsMeta(_sinceMs: number): TeamSessionRef[] {
		return [];
	}

	close(): void {}
}

function makeUserEntry(content = "Hello there"): Record<string, unknown> {
	return {
		type: "message",
		id: "u1",
		timestamp: "2026-08-05T00:00:00.000Z",
		message: {
			role: "user",
			content: `[TEAMS_META]\nconversationId: conv-1\nteamsMessageId: msg-1\nsenderName: Tester\nsenderUserId: u-1\n[/TEAMS_META]\n\n${content}`,
		},
	};
}

function makeAssistantEntry(text: string): Record<string, unknown> {
	return {
		type: "message",
		id: "ai-1",
		timestamp: "2026-08-05T00:00:01.000Z",
		message: { role: "assistant", content: text },
	};
}

function makePartsEntry(
	id: string,
	parts: Array<Record<string, unknown>>,
	timestamp = "2026-08-05T00:00:01.000Z",
): Record<string, unknown> {
	return {
		type: "message",
		id,
		timestamp,
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
	return {
		type: "toolCall",
		id: "call-1",
		name: "web_search",
		arguments: { query: "x" },
	};
}

function writeSessionFile(
	sessionsDir: string,
	sessionId: string,
	entries: Array<Record<string, unknown>>,
): void {
	fs.writeFileSync(
		path.join(sessionsDir, `${sessionId}.jsonl`),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
}

function appendSessionFile(
	sessionsDir: string,
	sessionId: string,
	entry: Record<string, unknown>,
): void {
	fs.appendFileSync(
		path.join(sessionsDir, `${sessionId}.jsonl`),
		`${JSON.stringify(entry)}\n`,
	);
}

function writeSession(
	sessionsDir: string,
	sessionId: string,
	assistant: string,
): void {
	writeSessionFile(sessionsDir, sessionId, [
		makeUserEntry(),
		makeAssistantEntry(assistant),
	]);
}

function makeConfig(tmpDir: string): BridgeConfig {
	return {
		flow2Url: "https://example.com/flow2",
		proxyMode: false,
		proxyPort: 18790,
		signature: "[SIG]",
		lookbackMinutes: 10,
		maxContextMessages: 50,
		contextSummaryLength: 500,
		enrichResponses: false,
		contextMode: "conversation",
		contextMaxAgeDays: 30,
		responseTimeoutSeconds: 1,
		responseSettleMs: 1,
		timeoutFallbackMessage:
			"⏱️ AI is still processing and exceeded the {seconds} second time limit. Please resend your question...",
		hermesBin: "hermes",
		dbPath: path.join(tmpDir, "state.db"),
		sessionPollMs: 2000,
		resetCommands: ["/reset"],
		agents: {
			main: {
				flow2Url: "https://example.com/flow2",
				signature: "[SIG]",
			},
		},
	};
}

interface Flow2Response {
	statusCode: number;
	body?: string;
}

function mockHttpsRequest(
	respond: (
		call: HttpsCall,
		index: number,
		emit: (response: Flow2Response) => void,
	) => void,
): { calls: HttpsCall[] } {
	const calls: HttpsCall[] = [];
	vi.spyOn(https, "request").mockImplementation((_opts, cb) => {
		const call: HttpsCall = { body: "" };
		const req = {
			on: vi.fn(),
			write: vi.fn((chunk: Buffer | string) => {
				call.body += chunk.toString();
			}),
			end: vi.fn(),
			destroy: vi.fn(),
		};
		calls.push(call);
		const emit = (response: Flow2Response): void => {
			const res = {
				statusCode: response.statusCode,
				headers: {},
				on: vi.fn((event: string, cb2: (chunk?: Buffer) => void) => {
					if (event === "data") cb2(Buffer.from(response.body ?? ""));
					if (event === "end") cb2();
					return res;
				}),
			};
			(cb as (r: unknown) => void)(res);
		};
		respond(call, calls.length - 1, emit);
		return req as unknown as ReturnType<typeof https.request>;
	});
	return { calls };
}

function mockFlow2Success(
	gate?: () => Promise<void>,
	onComplete?: () => void,
): { calls: HttpsCall[] } {
	return mockHttpsRequest((_call, _index, emit) => {
		setTimeout(async () => {
			if (gate) await gate();
			emit({ statusCode: 200, body: "OK" });
			onComplete?.();
		}, 0);
	});
}

function mockFlow2Sequence(responses: Flow2Response[]): { calls: HttpsCall[] } {
	return mockHttpsRequest((_call, index, emit) => {
		emit(responses[Math.min(index, responses.length - 1)]!);
	});
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

interface ForwardedEntry {
	ts: number;
	sessionId: string;
	entryId: string;
	textPreview: string;
}

interface RetryRecord {
	ts: number;
	count: number;
	lastError: string;
	category: ErrorCategory;
}

interface TestState {
	forwarded: Record<string, ForwardedEntry>;
	forwardedByMessageId: Record<string, ForwardedEntry>;
	retries: Record<string, RetryRecord>;
}

function readStateFile(tmpDir: string): Partial<TestState> {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(tmpDir, "state.json"), "utf-8"),
		) as Partial<TestState>;
	} catch {
		return {};
	}
}

function readFailedFile(tmpDir: string): Record<string, ForwardedEntry> {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(tmpDir, "failed.json"), "utf-8"),
		) as Record<string, ForwardedEntry>;
	} catch {
		return {};
	}
}

async function waitForForwarded(
	tmpDir: string,
	key: string,
): Promise<TestState> {
	await waitFor(() => readStateFile(tmpDir).forwarded?.[key] !== undefined);
	return readStateFile(tmpDir) as TestState;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

async function pumpTimers(ms: number): Promise<void> {
	let remaining = ms;
	while (remaining > 0) {
		const step = Math.min(250, remaining);
		await vi.advanceTimersByTimeAsync(step);
		remaining -= step;
	}
}

function seedRetries(
	tmpDir: string,
	retries: Record<string, RetryRecord>,
): void {
	fs.writeFileSync(
		path.join(tmpDir, "state.json"),
		JSON.stringify({ forwarded: {}, forwardedByMessageId: {}, retries }),
	);
}

const atCapRetry = (): RetryRecord => ({
	ts: Date.now(),
	count: 3,
	lastError: "boom",
	category: "transient",
});

async function makeSeededLifecycle(
	tmpDir: string,
	config: BridgeConfig,
	retries: Record<string, RetryRecord>,
): Promise<SessionLifecycle> {
	seedRetries(tmpDir, retries);
	vi.resetModules();
	const sm = await import("../state/manager.js");
	sm.loadState();
	const mod = await import("./session-lifecycle.js");
	return new mod.SessionLifecycle(
		config,
		new FileBackedStore(path.join(tmpDir, "sessions")),
	);
}

describe("SessionLifecycle harness", () => {
	let tmpDir: string;
	let origCwd: string;
	let origHome: string | undefined;
	let lifecycle: SessionLifecycle;
	let config: BridgeConfig;
	let sessionsDir: string;

	beforeEach(async () => {
		origCwd = process.cwd();
		origHome = process.env.HOME;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lifecycle-"));
		sessionsDir = path.join(tmpDir, "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "contexts"), { recursive: true });
		process.env.HOME = tmpDir;
		process.chdir(tmpDir);
		vi.resetModules();
		config = makeConfig(tmpDir);
		const mod = await import("./session-lifecycle.js");
		lifecycle = new mod.SessionLifecycle(
			config,
			new FileBackedStore(sessionsDir),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		process.chdir(origCwd);
		if (origHome === undefined) process.env.HOME = undefined;
		else process.env.HOME = origHome;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("forwards exactly one POST with the correct payload", async () => {
		writeSession(sessionsDir, "s1", "Hello from AI!");
		const { calls } = mockFlow2Success();
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		await sleep(10);
		expect(calls).toHaveLength(1);

		const body = JSON.parse(calls[0]!.body) as Flow2Payload;
		expect(body.message).toBe("[SIG]\n\nHello from AI!");
		expect(body.conversationId).toBe("conv-1");
		expect(body.teamsMessageId).toBe("msg-1");
		expect(body.senderName).toBe("Tester");
		expect(body.senderUserId).toBe("u-1");
		expect(body.originalMessage).toBe("Re: Hello there");

		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(state.forwardedByMessageId["msg-1"]).toBeDefined();
		expect(fs.existsSync(path.join(tmpDir, "failed.json"))).toBe(false);

		const context = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "contexts", "conv-1.json"), "utf-8"),
		);
		expect(context.conversationId).toBe("conv-1");
		expect(context.messages).toHaveLength(2);
	});

	it("forwards only the final answer, skipping mid-turn narration", async () => {
		writeSessionFile(sessionsDir, "s1", [
			makeUserEntry(),
			makePartsEntry("intermediate-1", [
				thinkingPart("hmm"),
				textPart("Coba cek dulu."),
				toolCallPart(),
			]),
			makePartsEntry("final-1", [
				thinkingPart("done"),
				textPart("Ini jawaban finalnya."),
			]),
		]);
		const { calls } = mockFlow2Success();
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		await sleep(10);
		expect(calls).toHaveLength(1);

		const body = JSON.parse(calls[0]!.body) as Flow2Payload;
		expect(body.message).toBe("[SIG]\n\nIni jawaban finalnya.");

		const state = await waitForForwarded(tmpDir, "main::s1::final-1");
		expect(state.forwarded["main::s1::intermediate-1"]).toBeUndefined();
	});

	it("records NO_REPLY as forwarded with no POST", async () => {
		writeSession(sessionsDir, "s1", "NO_REPLY");
		const { calls } = mockFlow2Success();
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		expect(calls).toHaveLength(0);

		const state = await waitForForwarded(tmpDir, "main::s1::no_reply");
		const entry = state.forwarded["main::s1::no_reply"];
		expect(entry?.entryId).toBe("no_reply");
		expect(entry?.textPreview).toBe("NO_REPLY");
	});

	it("dedups a double scan to a single POST", async () => {
		writeSession(sessionsDir, "s1", "Only once");
		const { calls } = mockFlow2Success();
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		await waitForForwarded(tmpDir, "main::s1::ai-1");

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await sleep(50);
		expect(calls).toHaveLength(1);
	});

	it("stop() drains in-flight work before resolving and ignores later scans", async () => {
		writeSession(sessionsDir, "s1", "Slow reply");
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls } = mockFlow2Success(
			() => gate,
			() => {
				order.push("post-complete");
			},
		);

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		expect(order).toEqual([]);

		void lifecycle.stop().then(() => {
			order.push("stop-resolved");
		});
		await sleep(20);
		expect(order).toEqual([]);

		release();
		await waitFor(() => order.length === 2);
		expect(order).toEqual(["post-complete", "stop-resolved"]);

		await lifecycle.stop();
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await sleep(30);
		expect(calls).toHaveLength(1);
		expect(order).toEqual(["post-complete", "stop-resolved"]);

		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(state.forwarded["main::s1::ai-1"]).toBeDefined();
	});

	it("emits timeout fallback on window expiry and suppresses the late reply", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		writeSessionFile(sessionsDir, "s1", [makeUserEntry()]);
		const { calls } = mockFlow2Sequence([{ statusCode: 200 }]);

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.setSystemTime(new Date("2026-08-05T00:00:00.500Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		expect(calls).toHaveLength(0);

		vi.setSystemTime(new Date("2026-08-05T00:00:02.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.useRealTimers();

		const state = await waitForForwarded(tmpDir, "main::s1::timeout");
		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0]!.body) as Flow2Payload;
		expect(body.message).toContain("⏱️ AI is still processing");
		expect(state.forwarded["main::s1::timeout"]?.entryId).toBe("timeout");
		expect(state.forwardedByMessageId["msg-1"]?.entryId).toBe("timeout");

		appendSessionFile(
			sessionsDir,
			"s1",
			makeAssistantEntry("Late real answer"),
		);
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await sleep(50);
		expect(calls).toHaveLength(1);
		expect(readStateFile(tmpDir).forwarded?.["main::s1::ai-1"]).toBeUndefined();
	});

	it("keeps a long agentic turn alive on assistant activity, then forwards the final answer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		writeSessionFile(sessionsDir, "s1", [
			makeUserEntry(),
			makePartsEntry(
				"work-1",
				[thinkingPart("start"), toolCallPart()],
				"2026-08-05T00:00:00.000Z",
			),
		]);
		const { calls } = mockFlow2Sequence([{ statusCode: 200 }]);

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.setSystemTime(new Date("2026-08-05T00:00:00.500Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);

		appendSessionFile(
			sessionsDir,
			"s1",
			makePartsEntry(
				"work-2",
				[thinkingPart("still working"), toolCallPart()],
				"2026-08-05T00:00:02.000Z",
			),
		);
		vi.setSystemTime(new Date("2026-08-05T00:00:02.500Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		expect(calls).toHaveLength(0);

		appendSessionFile(
			sessionsDir,
			"s1",
			makePartsEntry(
				"final-1",
				[textPart("Akhirnya kelar.")],
				"2026-08-05T00:00:03.000Z",
			),
		);
		vi.setSystemTime(new Date("2026-08-05T00:00:03.500Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();

		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0]!.body) as Flow2Payload;
		expect(body.message).toBe("[SIG]\n\nAkhirnya kelar.");

		const state = await waitForForwarded(tmpDir, "main::s1::final-1");
		expect(state.forwarded["main::s1::timeout"]).toBeUndefined();
	});

	it("sends the configured timeout fallback message with {seconds} substituted", async () => {
		config.timeoutFallbackMessage = "Still working after {seconds}s, wait!";
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		writeSessionFile(sessionsDir, "s1", [makeUserEntry()]);
		const { calls } = mockFlow2Sequence([{ statusCode: 200 }]);

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.setSystemTime(new Date("2026-08-05T00:00:02.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.useRealTimers();

		await waitForForwarded(tmpDir, "main::s1::timeout");
		const body = JSON.parse(calls[0]!.body) as Flow2Payload;
		expect(body.message).toContain("Still working after 1s, wait!");
	});

	it("forwards the security warning instead of the response when blocked", async () => {
		writeSessionFile(sessionsDir, "s1", [
			makeUserEntry("Please rm -rf /tmp/folder"),
			makeAssistantEntry("Here is the answer"),
		]);
		const { calls } = mockFlow2Sequence([{ statusCode: 200 }]);
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		await sleep(10);
		expect(calls).toHaveLength(1);

		const body = JSON.parse(calls[0]!.body) as Flow2Payload;
		expect(body.message).toContain("SECURITY ALERT");
		expect(body.message).not.toContain("Here is the answer");
		expect(body.originalMessage).toBe("");

		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(state.forwarded["main::s1::ai-1"]?.textPreview).toBe(
			"DANGEROUS_BLOCKED",
		);
	});

	it("retries a transient failure on a timer and succeeds on the second attempt", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);
		expect(readStateFile(tmpDir).forwarded?.["main::s1::ai-1"]).toBeUndefined();

		await vi.advanceTimersByTimeAsync(10_000);
		vi.useRealTimers();

		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(calls).toHaveLength(2);
		expect(state.forwarded["main::s1::ai-1"]?.entryId).toBe("ai-1");
		expect(state.forwarded["main::s1::ai-1"]?.textPreview).toBe("Retry me");
		expect(state.retries?.["main::s1::ai-1"]).toBeUndefined();
		expect(state.retries?.["msg-1"]).toBeUndefined();
	});

	it("marks a permanent failure as failed with no retry", async () => {
		writeSession(sessionsDir, "s1", "Never deliver");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 400, body: "Bad Request" },
		]);
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		await waitFor(() => fs.existsSync(path.join(tmpDir, "failed.json")));

		const failed = readFailedFile(tmpDir);
		expect(failed["main::s1::ai-1"]).toBeDefined();
		expect(failed["msg-1"]).toBeDefined();
		expect(readStateFile(tmpDir).retries?.["main::s1::ai-1"]).toBeUndefined();
		expect(readStateFile(tmpDir).forwarded?.["main::s1::ai-1"]).toBeUndefined();

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await sleep(50);
		expect(calls).toHaveLength(1);
	});

	it("attempt-time guard: message at retry cap is marked failed and never posted", async () => {
		writeSession(sessionsDir, "s1", "Hello from AI!");
		const { calls } = mockFlow2Success();
		const lc = await makeSeededLifecycle(tmpDir, config, {
			"main::s1::ai-1": atCapRetry(),
		});
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => fs.existsSync(path.join(tmpDir, "failed.json")));
		await sleep(10);
		expect(calls).toHaveLength(0);

		const failed = readFailedFile(tmpDir);
		expect(failed["main::s1::ai-1"]).toBeDefined();
		expect(failed["msg-1"]).toBeDefined();
		expect(readStateFile(tmpDir).retries?.["main::s1::ai-1"]?.count).toBe(3);

		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await sleep(10);
		expect(calls).toHaveLength(0);
	});

	it("attempt-time guard runs before the backoff sleep", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		writeSession(sessionsDir, "s1", "Hello from AI!");
		const { calls } = mockFlow2Success();
		const lc = await makeSeededLifecycle(tmpDir, config, {
			"main::s1::ai-1": atCapRetry(),
		});
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(5);
		vi.useRealTimers();
		await waitFor(() => fs.existsSync(path.join(tmpDir, "failed.json")));
		expect(calls).toHaveLength(0);
		expect(readFailedFile(tmpDir)["main::s1::ai-1"]).toBeDefined();
		expect(readStateFile(tmpDir).retries?.["main::s1::ai-1"]?.count).toBe(3);
	});

	it("retry count never exceeds the cap across repeated scan cycles", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 500, body: "boom" },
			{ statusCode: 500, body: "boom" },
		]);

		for (let i = 0; i < 7; i++) {
			vi.useFakeTimers();
			lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
			await pumpTimers(60_000);
			vi.useRealTimers();
			await sleep(10);
		}

		const state = readStateFile(tmpDir);
		expect(calls.length).toBeLessThanOrEqual(3);
		expect(state.retries?.["main::s1::ai-1"]?.count).toBeLessThanOrEqual(3);
		expect(state.retries?.["msg-1"]?.count).toBeLessThanOrEqual(3);
		expect(readFailedFile(tmpDir)["main::s1::ai-1"]).toBeDefined();
	});

	it("attempt-time guard applies to the timeout fallback path", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		writeSessionFile(sessionsDir, "s1", [makeUserEntry()]);
		const { calls } = mockFlow2Sequence([{ statusCode: 200 }]);
		const lc = await makeSeededLifecycle(tmpDir, config, {
			"main::s1::timeout": atCapRetry(),
		});
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.setSystemTime(new Date("2026-08-05T00:00:02.000Z"));
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(10);
		vi.useRealTimers();
		await waitFor(() => fs.existsSync(path.join(tmpDir, "failed.json")));
		expect(calls).toHaveLength(0);
		expect(readFailedFile(tmpDir)["main::s1::timeout"]).toBeDefined();
		expect(readFailedFile(tmpDir)["msg-1"]).toBeDefined();
		expect(readStateFile(tmpDir).retries?.["main::s1::timeout"]?.count).toBe(3);
	});

	it("attempt-time guard applies to the security-blocked warning path", async () => {
		writeSessionFile(sessionsDir, "s1", [
			makeUserEntry("Please rm -rf /tmp/folder"),
			makeAssistantEntry("Here is the answer"),
		]);
		const { calls } = mockFlow2Sequence([{ statusCode: 200 }]);
		const lc = await makeSeededLifecycle(tmpDir, config, {
			"main::s1::ai-1": atCapRetry(),
		});
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => fs.existsSync(path.join(tmpDir, "failed.json")));
		await sleep(10);
		expect(calls).toHaveLength(0);
		expect(readFailedFile(tmpDir)["main::s1::ai-1"]).toBeDefined();
	});

	it("resends the exact failed payload on a timer, ignoring newer session content", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		appendSessionFile(sessionsDir, "s1", {
			...makeAssistantEntry("Newer answer"),
			id: "ai-2",
		});
		await vi.advanceTimersByTimeAsync(10_000);
		vi.useRealTimers();

		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(calls).toHaveLength(2);
		const body = JSON.parse(calls[1]!.body) as Flow2Payload;
		expect(body.message).toBe("[SIG]\n\nRetry me");
		expect(state.forwarded["main::s1::ai-1"]?.textPreview).toBe("Retry me");
	});

	it("settle path skips a message with a pending retry timer", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		vi.setSystemTime(new Date("2026-08-05T00:00:00.500Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000);
		vi.useRealTimers();
		await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(calls).toHaveLength(2);
	});

	it("in-flight gate: concurrent scans produce a single POST per message", async () => {
		writeSession(sessionsDir, "s1", "Only once");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls } = mockFlow2Success(() => gate);

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await waitFor(() => calls.length === 1);
		for (let i = 0; i < 5; i++) {
			lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		}
		await sleep(50);
		expect(calls).toHaveLength(1);

		release();
		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(calls).toHaveLength(1);
		expect(state.forwarded["main::s1::ai-1"]).toBeDefined();
	});

	it("breaker-open results re-arm the retry without consuming the budget", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		seedRetries(tmpDir, {
			"main::s1::ai-1": {
				ts: Date.now(),
				count: 1,
				lastError: "boom",
				category: "transient",
			},
		});
		vi.resetModules();
		const sm = await import("../state/manager.js");
		sm.loadState();
		const flow2 = await import("../forwarder/flow2.js");
		flow2.resetBreakerState();
		const mod = await import("./session-lifecycle.js");
		const lc = new mod.SessionLifecycle(
			config,
			new FileBackedStore(path.join(tmpDir, "sessions")),
		);
		const metadata = {
			conversationId: "conv-1",
			teamsMessageId: "msg-1",
			senderName: "Tester",
			senderUserId: "u-1",
		};
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 500, body: "boom" },
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		await flow2.postToFlow2(
			"opener-1",
			metadata,
			"",
			"https://example.com/flow2",
			"[SIG]",
		);
		await flow2.postToFlow2(
			"opener-2",
			metadata,
			"",
			"https://example.com/flow2",
			"[SIG]",
		);
		expect(calls).toHaveLength(2);

		writeSession(sessionsDir, "s1", "Hello from AI!");
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(15_001);
		expect(calls).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(15_001);
		expect(calls).toHaveLength(3);
		await sm.flushStateAndWait();
		expect(readStateFile(tmpDir).retries?.["main::s1::ai-1"]?.count).toBe(2);

		await pumpTimers(45_000);
		vi.useRealTimers();
		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(calls).toHaveLength(4);
		expect(state.forwarded["main::s1::ai-1"]).toBeDefined();
	});

	it("newer AI content forwards while an older message's retry is pending", async () => {
		writeSession(sessionsDir, "s1", "Older reply");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		appendSessionFile(sessionsDir, "s1", {
			...makeAssistantEntry("Newer reply"),
			id: "ai-2",
		});
		vi.setSystemTime(new Date("2026-08-05T00:00:00.500Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(2);
		const body = JSON.parse(calls[1]!.body) as Flow2Payload;
		expect(body.message).toBe("[SIG]\n\nNewer reply");

		await vi.advanceTimersByTimeAsync(10_000);
		vi.useRealTimers();
		await sleep(20);
		expect(calls).toHaveLength(2);
	});

	it("stop() cancels pending retry timers; no resend fires after shutdown", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		await lifecycle.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		vi.useRealTimers();
		await sleep(20);
		expect(calls).toHaveLength(1);
	});

	it("stop() waits for an in-flight retry post; nothing posts after shutdown", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls } = mockHttpsRequest((_call, index, emit) => {
			if (index === 0) {
				emit({ statusCode: 500, body: "boom" });
				return;
			}
			setTimeout(async () => {
				await gate;
				emit({ statusCode: 200, body: "OK" });
			}, 0);
		});

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);

		let stopResolved = false;
		void lifecycle.stop().then(() => {
			stopResolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(stopResolved).toBe(false);

		release();
		await vi.advanceTimersByTimeAsync(1);
		expect(stopResolved).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await sleep(20);
		expect(calls).toHaveLength(2);
	});

	it("a retry failing during stop() schedules no new timer after shutdown", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls } = mockHttpsRequest((_call, index, emit) => {
			if (index === 0) {
				emit({ statusCode: 500, body: "boom" });
				return;
			}
			setTimeout(async () => {
				await gate;
				emit({ statusCode: 500, body: "still down" });
			}, 0);
		});

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);

		const stopPromise = lifecycle.stop();
		release();
		await stopPromise;
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await sleep(20);
		expect(calls).toHaveLength(2);
	});

	it("restart resumes retries from the persisted count without double-scheduling", async () => {
		writeSession(sessionsDir, "s1", "Retry me");
		const lc = await makeSeededLifecycle(tmpDir, config, {
			"main::s1::ai-1": {
				ts: Date.now(),
				count: 1,
				lastError: "boom",
				category: "transient",
			},
		});
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		vi.useFakeTimers();
		lc.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await pumpTimers(60_000);
		vi.useRealTimers();

		const state = await waitForForwarded(tmpDir, "main::s1::ai-1");
		expect(calls).toHaveLength(2);
		expect(state.forwarded["main::s1::ai-1"]).toBeDefined();
		expect(state.retries?.["main::s1::ai-1"]).toBeUndefined();
	});

	it("retries the timeout fallback on a timer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		writeSessionFile(sessionsDir, "s1", [makeUserEntry()]);
		const { calls } = mockFlow2Sequence([
			{ statusCode: 500, body: "boom" },
			{ statusCode: 200 },
		]);

		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		vi.setSystemTime(new Date("2026-08-05T00:00:02.000Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		vi.setSystemTime(new Date("2026-08-05T00:00:03.200Z"));
		lifecycle.scanSessions([{ agentId: "main", sessionId: "s1" }]);
		await vi.advanceTimersByTimeAsync(50);
		expect(calls).toHaveLength(1);

		await pumpTimers(20_000);
		vi.useRealTimers();
		const state = await waitForForwarded(tmpDir, "main::s1::timeout");
		expect(calls).toHaveLength(2);
		const body = JSON.parse(calls[1]!.body) as Flow2Payload;
		expect(body.message).toContain("⏱️ AI is still processing");
		expect(state.forwarded["main::s1::timeout"]).toBeDefined();
	});
});

describe("computeBackoff", () => {
	describe("transient category", () => {
		it("returns at least 500ms (floor) for retry 0", () => {
			const delay = computeBackoff("transient", 0);
			expect(delay).toBeGreaterThanOrEqual(500);
		});

		it("scales exponentially with retry count", () => {
			const d0 = computeBackoff("transient", 0);
			const d1 = computeBackoff("transient", 1);
			const d2 = computeBackoff("transient", 2);
			expect(d1).toBeGreaterThan(d0);
			expect(d2).toBeGreaterThan(d1);
		});

		it("caps at 8000ms for high retry counts", () => {
			for (let i = 0; i < 50; i++) {
				const delay = computeBackoff("transient", 10);
				expect(delay).toBeLessThanOrEqual(8500);
			}
		});

		it("applies jitter within ±500ms of base", () => {
			const samples = Array.from({ length: 50 }, () =>
				computeBackoff("transient", 1),
			);
			const min = Math.min(...samples);
			const max = Math.max(...samples);
			const base = 2000;
			expect(min).toBeGreaterThanOrEqual(Math.max(500, base - 500));
			expect(max).toBeLessThanOrEqual(base + 500);
		});

		it("stays positive for any retry count", () => {
			for (let i = 0; i < 20; i++) {
				expect(computeBackoff("transient", i)).toBeGreaterThan(0);
			}
		});
	});

	describe("server-busy category", () => {
		it("returns at least 30000ms for retry 0", () => {
			const delay = computeBackoff("server-busy", 0);
			expect(delay).toBeGreaterThanOrEqual(30000);
		});

		it("scales with retry count", () => {
			const d0 = computeBackoff("server-busy", 0);
			const d1 = computeBackoff("server-busy", 1);
			const d2 = computeBackoff("server-busy", 2);
			expect(d1).toBeGreaterThan(d0);
			expect(d2).toBeGreaterThan(d1);
		});

		it("caps at 120000ms for high retry counts", () => {
			for (let i = 0; i < 50; i++) {
				const delay = computeBackoff("server-busy", 10);
				expect(delay).toBeLessThanOrEqual(120000);
			}
		});

		it("applies small jitter within 5000ms", () => {
			const samples = Array.from({ length: 50 }, () =>
				computeBackoff("server-busy", 0),
			);
			const min = Math.min(...samples);
			const max = Math.max(...samples);
			expect(max - min).toBeLessThanOrEqual(5000);
		});
	});

	describe("permanent category", () => {
		it("returns a value (caller should not retry anyway)", () => {
			const d = computeBackoff("permanent", 0);
			expect(typeof d).toBe("number");
			expect(d).toBeGreaterThanOrEqual(0);
		});
	});
});
