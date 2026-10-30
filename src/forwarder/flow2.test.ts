import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { SessionEntry } from "../types";
import {
	categorizeError,
	categorizeHttpError,
	extractOriginalUserMessage,
	postToFlow2,
	resetBreakerState,
} from "./flow2";
import * as httpAgent from "./http-agent";

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

const UNENRICHED = [
	"[TEAMS_META]",
	"conversationId: conv-1",
	"teamsMessageId: msg-1",
	"senderName: Tester",
	"[/TEAMS_META]",
	"",
	"Hello there",
].join("\n");

const ENCODED = [
	"&#128203; Reply with ONE final message",
	"",
	"[TEAMS_META]",
	"conversationId: conv-1",
	"teamsMessageId: msg-1",
	"[/TEAMS_META]",
	"",
	"body text",
].join("\n");

function requestSpy(): MockInstance<typeof https.request> {
	const existing = vi.mocked(https.request);
	if ("mock" in existing) return existing;
	return vi.spyOn(https, "request");
}

function mockHttpsResponse(
	statusCode: number,
	body: string,
	headers: Record<string, string> = {},
): void {
	const req = {
		on: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
	};
	const res = {
		statusCode,
		headers,
		on: vi.fn((event: string, cb: (chunk?: Buffer) => void) => {
			if (event === "data") {
				cb(Buffer.from(body, "utf-8"));
			}
			if (event === "end") {
				cb();
			}
			return res;
		}),
	};
	requestSpy().mockImplementation((_opts, cb) => {
		const callback = cb as (res: unknown) => void;
		callback(res);
		return req as unknown as ReturnType<typeof https.request>;
	});
}

function mockHttpsError(err: Error): void {
	const req = {
		on: vi.fn((event: string, cb: (err?: Error) => void) => {
			if (event === "error") cb(err);
			return req;
		}),
		write: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
	};
	requestSpy().mockImplementation(() => {
		return req as unknown as ReturnType<typeof https.request>;
	});
}

function mockHttpsResponseGated(
	statusCode: number,
	body: string,
	gate: () => Promise<void>,
): void {
	const req = {
		on: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
	};
	const res = {
		statusCode,
		headers: {},
		on: vi.fn((event: string, cb: (chunk?: Buffer) => void) => {
			if (event === "data") {
				cb(Buffer.from(body, "utf-8"));
			}
			if (event === "end") {
				void gate().then(() => cb());
			}
			return res;
		}),
	};
	requestSpy().mockImplementation((_opts, cb) => {
		const callback = cb as (res: unknown) => void;
		callback(res);
		return req as unknown as ReturnType<typeof https.request>;
	});
}

describe("categorizeError", () => {
	it("classifies ENOTFOUND as transient", () => {
		const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
			code: "ENOTFOUND",
		});
		const result = categorizeError(err);
		expect(result.code).toBe("ENOTFOUND");
		expect(result.category).toBe("transient");
	});

	it("classifies ECONNREFUSED as transient", () => {
		const err = Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		});
		const result = categorizeError(err);
		expect(result.code).toBe("ECONNREFUSED");
		expect(result.category).toBe("transient");
	});

	it("classifies ECONNRESET as transient", () => {
		const err = Object.assign(new Error("read ECONNRESET"), {
			code: "ECONNRESET",
		});
		const result = categorizeError(err);
		expect(result.category).toBe("transient");
	});

	it("classifies ETIMEDOUT as transient", () => {
		const err = Object.assign(new Error("connect ETIMEDOUT"), {
			code: "ETIMEDOUT",
		});
		const result = categorizeError(err);
		expect(result.category).toBe("transient");
	});

	it("defaults unknown errors to transient", () => {
		const result = categorizeError(new Error("something weird"));
		expect(result.category).toBe("transient");
	});

	it("preserves error message", () => {
		const result = categorizeError(
			Object.assign(new Error("custom message"), { code: "ENOTFOUND" }),
		);
		expect(result.message).toBe("custom message");
	});
});

describe("categorizeHttpError", () => {
	it("classifies 502 with NoResponse body as server-busy", () => {
		expect(categorizeHttpError(502, '{"error":{"code":"NoResponse"}}')).toBe(
			"server-busy",
		);
	});

	it("classifies 503 as server-busy when NoResponse present", () => {
		expect(categorizeHttpError(503, "NoResponse from upstream")).toBe(
			"server-busy",
		);
	});

	it("classifies 504 as server-busy when NoResponse present", () => {
		expect(categorizeHttpError(504, "upstream NoResponse")).toBe("server-busy");
	});

	it("classifies plain 502 as transient", () => {
		expect(categorizeHttpError(502, "Bad Gateway")).toBe("transient");
	});

	it("classifies 429 as server-busy", () => {
		expect(categorizeHttpError(429, "Too Many Requests")).toBe("server-busy");
	});

	it("classifies other 5xx as transient", () => {
		expect(categorizeHttpError(500, "Internal Server Error")).toBe("transient");
		expect(categorizeHttpError(501, "Not Implemented")).toBe("transient");
	});

	it("classifies 4xx as permanent", () => {
		expect(categorizeHttpError(400, "Bad Request")).toBe("permanent");
		expect(categorizeHttpError(401, "Unauthorized")).toBe("permanent");
		expect(categorizeHttpError(404, "Not Found")).toBe("permanent");
	});
});

describe("extractOriginalUserMessage", () => {
	it("returns the user's text with Re: prefix for an instruction-prefixed session", () => {
		const result = extractOriginalUserMessage([
			entry("assistant", "Let me check"),
			entry("user", ENRICHED),
			entry("assistant", "Here is the answer"),
		]);
		expect(result).toBe("Re: What is the weather today?");
	});

	it("returns the user's text with Re: prefix for an un-enriched session", () => {
		const result = extractOriginalUserMessage([
			entry("user", UNENRICHED),
			entry("assistant", "Hello!"),
		]);
		expect(result).toBe("Re: Hello there");
	});

	it("strips entity-encoded instruction markers", () => {
		const result = extractOriginalUserMessage([
			entry("user", ENCODED),
			entry("assistant", "OK"),
		]);
		expect(result).toBe("Re: body text");
	});

	it("passes meta-less plain messages through without claiming them", () => {
		const result = extractOriginalUserMessage([
			entry("user", "plain hello"),
			entry("user", ENRICHED),
			entry("assistant", "OK"),
		]);
		expect(result).toBe("Re: What is the weather today?");
	});

	it("returns empty when no meta-bearing user message exists", () => {
		const result = extractOriginalUserMessage([
			entry("user", "plain hello"),
			entry("assistant", "OK"),
		]);
		expect(result).toBe("");
	});

	it("returns empty for an empty session", () => {
		expect(extractOriginalUserMessage([])).toBe("");
	});
});

describe("postToFlow2", () => {
	const metadata = {
		conversationId: "test-conv",
		teamsMessageId: "test-msg-1",
		senderName: "Tester",
		senderUserId: "u-1",
	};

	beforeEach(() => {
		vi.spyOn(httpAgent, "getHttpsAgent").mockReturnValue({} as https.Agent);
		resetBreakerState();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns permanent error when flow2Url is empty", async () => {
		const result = await postToFlow2("text", metadata, "orig", "", "[sig]");
		expect(result.forwarded).toBe(false);
		expect(result.category).toBe("permanent");
	});

	it("returns permanent error when metadata is missing", async () => {
		const result = await postToFlow2(
			"text",
			{},
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(false);
		expect(result.category).toBe("permanent");
	});

	it("returns forwarded=true on 2xx", async () => {
		mockHttpsResponse(200, "OK");
		const result = await postToFlow2(
			"text",
			metadata,
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(true);
		expect(result.httpCode).toBe(200);
	});

	it("treats a 202 Power Automate waiting-run error as server-busy", async () => {
		mockHttpsResponse(
			202,
			JSON.stringify({
				properties: {
					status: "Waiting",
					error: {
						code: "WorkflowMaximumWaitingRunCountExceeded",
						message: "Disable concurrency control to resolve this.",
					},
				},
			}),
		);
		const result = await postToFlow2(
			"text",
			metadata,
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(false);
		expect(result.httpCode).toBe(202);
		expect(result.category).toBe("server-busy");
		expect(result.error).toContain("WorkflowMaximumWaitingRunCountExceeded");
	});

	it("returns server-busy on 502 with NoResponse", async () => {
		mockHttpsResponse(502, '{"error":{"code":"NoResponse"}}');
		const result = await postToFlow2(
			"text",
			metadata,
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(false);
		expect(result.category).toBe("server-busy");
	});

	it("returns transient on 500", async () => {
		mockHttpsResponse(500, "Internal Server Error");
		const result = await postToFlow2(
			"text",
			metadata,
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(false);
		expect(result.category).toBe("transient");
	});

	it("returns permanent on 4xx", async () => {
		mockHttpsResponse(403, "Forbidden");
		const result = await postToFlow2(
			"text",
			metadata,
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(false);
		expect(result.category).toBe("permanent");
	});

	it("returns transient on network error", async () => {
		mockHttpsError(
			Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
		);
		const result = await postToFlow2(
			"text",
			metadata,
			"orig",
			"https://example.com/api",
			"[sig]",
		);
		expect(result.forwarded).toBe(false);
		expect(result.category).toBe("transient");
	});
});

describe("circuit breaker", () => {
	const metadata = {
		conversationId: "breaker-conv",
		teamsMessageId: "breaker-msg-1",
		senderName: "Tester",
		senderUserId: "u-1",
	};

	beforeEach(() => {
		vi.spyOn(httpAgent, "getHttpsAgent").mockReturnValue({} as https.Agent);
		resetBreakerState();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function httpsCallCount(): number {
		return vi.mocked(https.request).mock.calls.length;
	}

	it("opens after two consecutive transient failures", async () => {
		mockHttpsResponse(500, "boom");
		await postToFlow2("a", metadata, "", "https://breaker-open.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-open.test", "[s]");
		const before = httpsCallCount();

		const result = await postToFlow2(
			"c",
			metadata,
			"",
			"https://breaker-open.test",
			"[s]",
		);
		expect(httpsCallCount()).toBe(before);
		expect(result.forwarded).toBe(false);
		expect(result.breakerOpen).toBe(true);
		expect(result.category).toBe("server-busy");
	});

	it("keeps returning breakerOpen with no network I/O while open", async () => {
		mockHttpsResponse(500, "boom");
		await postToFlow2("a", metadata, "", "https://breaker-open2.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-open2.test", "[s]");
		const before = httpsCallCount();

		await postToFlow2("c", metadata, "", "https://breaker-open2.test", "[s]");
		await postToFlow2("d", metadata, "", "https://breaker-open2.test", "[s]");
		expect(httpsCallCount()).toBe(before);
	});

	it("allows one probe post after the cooldown; success closes the breaker", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		mockHttpsResponse(500, "boom");
		await postToFlow2("a", metadata, "", "https://breaker-close.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-close.test", "[s]");

		vi.setSystemTime(new Date("2026-08-05T00:00:31.000Z"));
		mockHttpsResponse(200, "OK");
		const probe = await postToFlow2(
			"c",
			metadata,
			"",
			"https://breaker-close.test",
			"[s]",
		);
		expect(probe.forwarded).toBe(true);
		expect(probe.breakerOpen).toBeUndefined();

		const before = httpsCallCount();
		mockHttpsResponse(500, "boom");
		const afterClose = await postToFlow2(
			"d",
			metadata,
			"",
			"https://breaker-close.test",
			"[s]",
		);
		expect(httpsCallCount()).toBe(before + 1);
		expect(afterClose.breakerOpen).toBeUndefined();
	});

	it("reopens on a failed probe", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		mockHttpsResponse(500, "boom");
		await postToFlow2("a", metadata, "", "https://breaker-reopen.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-reopen.test", "[s]");

		vi.setSystemTime(new Date("2026-08-05T00:00:31.000Z"));
		const probe = await postToFlow2(
			"c",
			metadata,
			"",
			"https://breaker-reopen.test",
			"[s]",
		);
		expect(probe.forwarded).toBe(false);
		expect(probe.breakerOpen).toBeUndefined();

		const before = httpsCallCount();
		const after = await postToFlow2(
			"d",
			metadata,
			"",
			"https://breaker-reopen.test",
			"[s]",
		);
		expect(httpsCallCount()).toBe(before);
		expect(after.breakerOpen).toBe(true);
	});

	it("resets the failure streak on success", async () => {
		mockHttpsResponse(500, "boom");
		for (let i = 0; i < 4; i++) {
			await postToFlow2(
				`f${i}`,
				metadata,
				"",
				"https://breaker-streak.test",
				"[s]",
			);
			mockHttpsResponse(200, "OK");
			await postToFlow2(
				`s${i}`,
				metadata,
				"",
				"https://breaker-streak.test",
				"[s]",
			);
			mockHttpsResponse(500, "boom");
		}

		const result = await postToFlow2(
			"x",
			metadata,
			"",
			"https://breaker-streak.test",
			"[s]",
		);
		expect(result.breakerOpen).toBeUndefined();
		expect(httpsCallCount()).toBe(9);
	});

	it("never trips on permanent failures", async () => {
		mockHttpsResponse(400, "Bad Request");
		await postToFlow2("a", metadata, "", "https://breaker-perm.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-perm.test", "[s]");
		const before = httpsCallCount();

		const result = await postToFlow2(
			"c",
			metadata,
			"",
			"https://breaker-perm.test",
			"[s]",
		);
		expect(httpsCallCount()).toBe(before + 1);
		expect(result.forwarded).toBe(false);
		expect(result.breakerOpen).toBeUndefined();
	});

	it("allows only one probe post per cooldown cycle", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		mockHttpsResponse(500, "boom");
		await postToFlow2("a", metadata, "", "https://breaker-probe2.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-probe2.test", "[s]");

		vi.setSystemTime(new Date("2026-08-05T00:00:31.000Z"));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mockHttpsResponseGated(200, "OK", () => gate);
		const probe = postToFlow2(
			"c",
			metadata,
			"",
			"https://breaker-probe2.test",
			"[s]",
		);
		const blocked = await postToFlow2(
			"d",
			metadata,
			"",
			"https://breaker-probe2.test",
			"[s]",
		);
		expect(blocked.breakerOpen).toBe(true);
		expect(httpsCallCount()).toBe(3);

		release();
		const result = await probe;
		expect(result.forwarded).toBe(true);
		expect(result.breakerOpen).toBeUndefined();

		const before = httpsCallCount();
		mockHttpsResponse(200, "OK");
		const after = await postToFlow2(
			"e",
			metadata,
			"",
			"https://breaker-probe2.test",
			"[s]",
		);
		expect(httpsCallCount()).toBe(before + 1);
		expect(after.breakerOpen).toBeUndefined();
	});

	it("keeps breakers independent per Flow 2 URL", async () => {
		mockHttpsResponse(500, "boom");
		await postToFlow2("a", metadata, "", "https://breaker-a.test", "[s]");
		await postToFlow2("b", metadata, "", "https://breaker-a.test", "[s]");

		const other = await postToFlow2(
			"c",
			metadata,
			"",
			"https://breaker-b.test",
			"[s]",
		);
		expect(other.breakerOpen).toBeUndefined();

		const before = httpsCallCount();
		const same = await postToFlow2(
			"d",
			metadata,
			"",
			"https://breaker-a.test",
			"[s]",
		);
		expect(httpsCallCount()).toBe(before);
		expect(same.breakerOpen).toBe(true);
	});
});
