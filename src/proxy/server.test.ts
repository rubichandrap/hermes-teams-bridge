import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	DispatchResult,
	DispatchService,
} from "../dispatcher/turn-dispatcher";
import type { BridgeConfig } from "../types";
import { checkProxyAuth, startProxyServer } from "./server";

const TEAMS_MESSAGE =
	"[TEAMS_META]\nconversationId: conv-1\nteamsMessageId: msg-1\nsenderName: Tester\nsenderUserId: u-1\n[/TEAMS_META]\n\nhello";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		flow2Url: "https://example.com/flow2",
		proxyMode: true,
		proxyPort: 0,
		signature: "[SIG]",
		lookbackMinutes: 10,
		responseTimeoutSeconds: 1,
		responseSettleMs: 1,
		timeoutFallbackMessage: "timeout",
		hermesBin: "fake-hermes",
		dbPath: "/tmp/state.db",
		sessionPollMs: 2000,
		resetCommands: ["/reset"],
		agents: {
			main: { flow2Url: "https://example.com/flow2", signature: "[SIG]" },
		},
		...overrides,
	};
}

function fakeDispatcher(
	result: DispatchResult,
): DispatchService & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		dispatch: vi.fn(async (...args: unknown[]) => {
			calls.push(args);
			return result;
		}) as DispatchService["dispatch"],
	};
}

function post(
	server: http.Server,
	body: unknown,
	auth?: string,
): Promise<{ status: number; body: string }> {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const data = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: address.port,
				path: "/teams-proxy",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(data),
					...(auth && { Authorization: auth }),
				},
			},
			(res) => {
				let out = "";
				res.on("data", (c) => {
					out += c.toString();
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: out }),
				);
			},
		);
		req.on("error", reject);
		req.end(data);
	});
}

describe("startProxyServer", () => {
	const servers: http.Server[] = [];

	afterEach(() => {
		for (const server of servers) {
			server.close();
		}
		servers.length = 0;
	});

	async function start(
		config: BridgeConfig,
		dispatcher: DispatchService,
	): Promise<http.Server> {
		const server = startProxyServer(config, dispatcher);
		if (!server) throw new Error("server not started");
		servers.push(server);
		if (!server.listening) {
			await new Promise<void>((resolve) => {
				server.once("listening", () => resolve());
			});
		}
		return server;
	}

	it("returns null when proxy mode is disabled", () => {
		expect(
			startProxyServer(
				makeConfig({ proxyMode: false }),
				fakeDispatcher({ ok: true }),
			),
		).toBeNull();
	});

	it("dispatches the parsed conversation and message", async () => {
		const dispatcher = fakeDispatcher({ ok: true });
		const server = await start(makeConfig(), dispatcher);

		const res = await post(server, { agentId: "main", message: TEAMS_MESSAGE });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ status: "queued", agentId: "main" });

		expect(dispatcher.calls).toHaveLength(1);
		expect(dispatcher.calls[0]?.[0]).toBe("main");
		expect(dispatcher.calls[0]?.[1]).toBe("conv-1");
		expect(dispatcher.calls[0]?.[2]).toBe(TEAMS_MESSAGE);
	});

	it("defaults the agent to main", async () => {
		const dispatcher = fakeDispatcher({ ok: true });
		const server = await start(makeConfig(), dispatcher);

		const res = await post(server, { message: TEAMS_MESSAGE });
		expect(res.status).toBe(200);
		expect(dispatcher.calls[0]?.[0]).toBe("main");
	});

	it("returns 502 when dispatch fails", async () => {
		const dispatcher = fakeDispatcher({ ok: false, error: "boom" });
		const server = await start(makeConfig(), dispatcher);

		const res = await post(server, { agentId: "main", message: TEAMS_MESSAGE });
		expect(res.status).toBe(502);
		expect(JSON.parse(res.body)).toEqual({ error: "boom" });
	});

	it("reports reset commands as status reset", async () => {
		const dispatcher = fakeDispatcher({ ok: true, reset: true });
		const server = await start(makeConfig(), dispatcher);

		const res = await post(server, { agentId: "main", message: TEAMS_MESSAGE });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ status: "reset", agentId: "main" });
	});

	it("rejects messages without a conversation id", async () => {
		const dispatcher = fakeDispatcher({ ok: true });
		const server = await start(makeConfig(), dispatcher);

		const res = await post(server, {
			agentId: "main",
			message: "no metadata here",
		});
		expect(res.status).toBe(400);
		expect(dispatcher.calls).toHaveLength(0);
	});

	it("rejects unknown agents and empty messages", async () => {
		const dispatcher = fakeDispatcher({ ok: true });
		const server = await start(makeConfig(), dispatcher);

		expect(
			(await post(server, { agentId: "ghost", message: TEAMS_MESSAGE })).status,
		).toBe(400);
		expect(
			(await post(server, { agentId: "main", message: "   " })).status,
		).toBe(400);
		expect(dispatcher.calls).toHaveLength(0);
	});

	it("rejects requests without the bearer token when configured", async () => {
		const dispatcher = fakeDispatcher({ ok: true });
		const server = await start(
			makeConfig({ proxyToken: "s3cret" }),
			dispatcher,
		);

		expect(
			(await post(server, { agentId: "main", message: TEAMS_MESSAGE })).status,
		).toBe(401);
		expect(
			(
				await post(
					server,
					{ agentId: "main", message: TEAMS_MESSAGE },
					"Bearer s3cret",
				)
			).status,
		).toBe(200);
		expect(dispatcher.calls).toHaveLength(1);
	});
});

describe("checkProxyAuth", () => {
	const TOKEN = "s3cret-token";

	it("accepts Bearer-prefixed tokens", () => {
		expect(checkProxyAuth(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
	});

	it("accepts bare tokens", () => {
		expect(checkProxyAuth(TOKEN, TOKEN)).toBe(true);
	});

	it("accepts Bearer with surrounding whitespace", () => {
		expect(checkProxyAuth(`  Bearer ${TOKEN}  `, TOKEN)).toBe(true);
	});

	it("rejects missing headers", () => {
		expect(checkProxyAuth(undefined, TOKEN)).toBe(false);
	});

	it("rejects wrong tokens", () => {
		expect(checkProxyAuth(`Bearer wrong`, TOKEN)).toBe(false);
		expect(checkProxyAuth(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
	});

	it("rejects empty token config", () => {
		expect(checkProxyAuth(`Bearer ${TOKEN}`, "")).toBe(false);
	});
});
