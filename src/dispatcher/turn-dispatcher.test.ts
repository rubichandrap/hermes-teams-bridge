import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRunner } from "../agent/runner";
import { SessionRegistry } from "../registry/session-registry";
import type { AgentConfig, BridgeConfig } from "../types";
import { TurnDispatcher } from "./turn-dispatcher";

interface SpawnCall {
	message: string;
	resumeSessionId?: string;
	completion: {
		sessionId?: string;
		exitCode: number | null;
	};
	release: () => void;
}

/**
 * Fake runner with manual completion control: spawn records the call and
 * resolves immediately, but the turn's `done` only resolves when the test
 * releases it — so in-flight state is fully deterministic.
 */
class FakeRunner implements TurnRunner {
	spawns: SpawnCall[] = [];
	renames: { sessionId: string; title: string }[] = [];

	spawn(
		_config: BridgeConfig,
		_agent: AgentConfig,
		message: string,
		opts?: { resumeSessionId?: string },
	): Promise<{
		ok: boolean;
		done: Promise<{ sessionId?: string; exitCode: number | null }>;
	}> {
		let release!: () => void;
		const completion: SpawnCall["completion"] = { exitCode: null };
		const done = new Promise<{ sessionId?: string; exitCode: number | null }>(
			(resolve) => {
				release = () => resolve(completion);
			},
		);
		const call: SpawnCall = {
			message,
			...(opts?.resumeSessionId && { resumeSessionId: opts.resumeSessionId }),
			completion,
			release,
		};
		this.spawns.push(call);
		return Promise.resolve({ ok: true, done });
	}

	rename(
		_config: BridgeConfig,
		_agent: AgentConfig,
		sessionId: string,
		title: string,
	): void {
		this.renames.push({ sessionId, title });
	}
}

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		flow2Url: "https://example.com/flow2",
		proxyMode: false,
		proxyPort: 18790,
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

function teamsMessage(text: string, conversationId = "conv-1"): string {
	return `[TEAMS_META]\nconversationId: ${conversationId}\nteamsMessageId: msg-1\nsenderName: Tester\nsenderUserId: u-1\n[/TEAMS_META]\n\n${text}`;
}

describe("TurnDispatcher", () => {
	let tmpDir: string;
	let registry: SessionRegistry;
	let runner: FakeRunner;
	let dispatcher: TurnDispatcher;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-"));
		registry = new SessionRegistry(path.join(tmpDir, "registry.json"));
		registry.load();
		runner = new FakeRunner();
		dispatcher = new TurnDispatcher(makeConfig(), registry, runner);
	});

	afterEach(() => {
		dispatcher.stop();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("bootstraps the first message and registers the captured session id", async () => {
		const result = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("hello"),
		);
		expect(result.ok).toBe(true);
		expect(result.queued).toBeUndefined();

		expect(runner.spawns).toHaveLength(1);
		const call = runner.spawns[0]!;
		expect(call.resumeSessionId).toBeUndefined();
		expect(call.message).toContain("📋 Reply with ONE final message.");
		expect(call.message).toContain(teamsMessage("hello"));

		call.completion.sessionId = "20260811_000000_aaa111";
		call.release();
		await new Promise((r) => setTimeout(r, 10));

		expect(registry.get("main", "conv-1")?.sessionId).toBe(
			"20260811_000000_aaa111",
		);
		expect(runner.renames).toEqual([
			{ sessionId: "20260811_000000_aaa111", title: "teams:conv-1" },
		]);
	});

	it("resumes the registered session for later messages", async () => {
		registry.set("main", "conv-1", "20260811_000000_aaa111");

		const result = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("hello again"),
		);
		expect(result.ok).toBe(true);

		expect(runner.spawns).toHaveLength(1);
		expect(runner.spawns[0]?.resumeSessionId).toBe("20260811_000000_aaa111");
		expect(runner.renames).toHaveLength(0);
	});

	it("bootstraps fresh when the registered session came from another profile", async () => {
		registry.set("main", "conv-1", "20260811_000000_old001", "chatbot");

		const result = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("hello"),
		);
		expect(result.ok).toBe(true);

		expect(runner.spawns).toHaveLength(1);
		expect(runner.spawns[0]?.resumeSessionId).toBeUndefined();

		runner.spawns[0]!.completion.sessionId = "20260811_000000_new002";
		runner.spawns[0]!.release();
		await new Promise((r) => setTimeout(r, 10));

		const entry = registry.get("main", "conv-1");
		expect(entry?.sessionId).toBe("20260811_000000_new002");
		expect(entry?.profile).toBe("default");
	});

	it("serializes rapid messages: one in-flight turn, spawns run in order", async () => {
		const first = dispatcher.dispatch("main", "conv-1", teamsMessage("first"));
		await new Promise((r) => setTimeout(r, 10));
		expect(runner.spawns).toHaveLength(1);

		const second = dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("second"),
		);
		await new Promise((r) => setTimeout(r, 10));

		// Second turn queued: no spawn until the first child exits.
		expect(runner.spawns).toHaveLength(1);

		// First turn completes with its session id → registered.
		runner.spawns[0]!.completion.sessionId = "20260811_000000_aaa111";
		runner.spawns[0]!.release();
		await new Promise((r) => setTimeout(r, 10));

		// Now the second turn spawns, resuming the registered session.
		const secondResult = await second;
		expect(secondResult.ok).toBe(true);
		expect(secondResult.queued).toBe(true);
		expect(runner.spawns).toHaveLength(2);
		expect(runner.spawns[1]?.resumeSessionId).toBe("20260811_000000_aaa111");
		expect(runner.spawns[1]?.message).toContain("second");
		await first;
	});

	it("leaves a pending marker when the session id is not captured", async () => {
		const result = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("hello"),
		);
		expect(result.ok).toBe(true);

		runner.spawns[0]!.release(); // no sessionId set
		await new Promise((r) => setTimeout(r, 10));

		expect(registry.get("main", "conv-1")).toBeUndefined();
		expect(registry.hasPendingBootstrap("main", "conv-1")).toBe(true);
		expect(runner.renames).toHaveLength(0);
	});

	it("associates a store session via the fallback when pending", async () => {
		registry.markPendingBootstrap("main", "conv-1");

		const associated = dispatcher.associateIfPending(
			"main",
			"20260811_000000_bbb222",
			"conv-1",
		);
		expect(associated).toBe(true);
		expect(registry.get("main", "conv-1")?.sessionId).toBe(
			"20260811_000000_bbb222",
		);
		expect(registry.hasPendingBootstrap("main", "conv-1")).toBe(false);
		// Fallback-registered sessions still get the teams:<conversation> rename.
		expect(runner.renames).toEqual([
			{ sessionId: "20260811_000000_bbb222", title: "teams:conv-1" },
		]);
	});

	it("rejects fallback association of a session that predates the pending bootstrap", async () => {
		registry.markPendingBootstrap("main", "conv-1");
		const pendingTs = registry.getPendingBootstrapTs("main", "conv-1")!;

		// A pre-reset session still inside the lookback window (probe scenario).
		const stale = dispatcher.associateIfPending(
			"main",
			"20260811_000000_old999",
			"conv-1",
			pendingTs - 1000,
		);
		expect(stale).toBe(false);
		expect(registry.get("main", "conv-1")).toBeUndefined();
		// Pending marker survives so the genuine bootstrap product can still associate.
		expect(registry.hasPendingBootstrap("main", "conv-1")).toBe(true);
		expect(runner.renames).toHaveLength(0);

		// The actual bootstrap session (born after the pending marker) associates.
		const fresh = dispatcher.associateIfPending(
			"main",
			"20260811_000000_bbb222",
			"conv-1",
			pendingTs + 1000,
		);
		expect(fresh).toBe(true);
		expect(registry.get("main", "conv-1")?.sessionId).toBe(
			"20260811_000000_bbb222",
		);
		expect(registry.hasPendingBootstrap("main", "conv-1")).toBe(false);
	});

	it("never registers sessions that were not bootstrap-spawned (manual pastes)", async () => {
		const associated = dispatcher.associateIfPending(
			"main",
			"20260811_000000_bbb222",
			"conv-1",
		);
		expect(associated).toBe(false);
		expect(registry.get("main", "conv-1")).toBeUndefined();
	});

	it("ignores association without a conversation id", () => {
		registry.markPendingBootstrap("main", "conv-1");
		expect(dispatcher.associateIfPending("main", "sess-x", undefined)).toBe(
			false,
		);
		expect(registry.hasPendingBootstrap("main", "conv-1")).toBe(true);
	});

	it("the mapping survives a dispatcher restart (persistent registry)", async () => {
		registry.set("main", "conv-1", "20260811_000000_aaa111");
		await registry.flushAndWait();

		const reloaded = new SessionRegistry(path.join(tmpDir, "registry.json"));
		reloaded.load();
		const freshDispatcher = new TurnDispatcher(makeConfig(), reloaded, runner);

		await freshDispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("after restart"),
		);
		expect(runner.spawns[0]?.resumeSessionId).toBe("20260811_000000_aaa111");
		freshDispatcher.stop();
	});

	it("runs different conversations in parallel", async () => {
		const a = dispatcher.dispatch(
			"main",
			"conv-a",
			teamsMessage("a", "conv-a"),
		);
		await new Promise((r) => setTimeout(r, 10));
		const b = dispatcher.dispatch(
			"main",
			"conv-b",
			teamsMessage("b", "conv-b"),
		);
		await new Promise((r) => setTimeout(r, 10));

		expect(runner.spawns).toHaveLength(2);
		expect(runner.spawns[0]?.message).toContain("conv-a");
		expect(runner.spawns[1]?.message).toContain("conv-b");
		expect((await b).queued).toBeUndefined();
		await a;
	});

	it("rejects unknown agents", async () => {
		const result = await dispatcher.dispatch(
			"nobody",
			"conv-1",
			teamsMessage("hi"),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unknown agent");
		expect(runner.spawns).toHaveLength(0);
	});

	it("rejects dispatches after stop", async () => {
		dispatcher.stop();
		const result = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("hi"),
		);
		expect(result.ok).toBe(false);
		expect(runner.spawns).toHaveLength(0);
	});
});

describe("TurnDispatcher reset command", () => {
	let tmpDir: string;
	let registry: SessionRegistry;
	let runner: FakeRunner;
	let dispatcher: TurnDispatcher;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dispatcher-"));
		registry = new SessionRegistry(path.join(tmpDir, "registry.json"));
		registry.load();
		runner = new FakeRunner();
	});

	afterEach(() => {
		dispatcher.stop();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("exactly matching /reset severs the binding and spawns nothing", async () => {
		registry.set("main", "conv-1", "20260811_000000_aaa111");
		dispatcher = new TurnDispatcher(makeConfig(), registry, runner);

		const result = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("/reset"),
		);
		expect(result.ok).toBe(true);
		expect(result.reset).toBe(true);
		expect(registry.get("main", "conv-1")).toBeUndefined();
		expect(runner.spawns).toHaveLength(0);
	});

	it("next turn after a reset bootstraps a fresh session and renames it", async () => {
		registry.set("main", "conv-1", "20260811_000000_aaa111");
		dispatcher = new TurnDispatcher(makeConfig(), registry, runner);

		await dispatcher.dispatch("main", "conv-1", teamsMessage("/reset"));
		await dispatcher.dispatch("main", "conv-1", teamsMessage("fresh start"));

		expect(runner.spawns).toHaveLength(1);
		const call = runner.spawns[0]!;
		expect(call.resumeSessionId).toBeUndefined();
		call.completion.sessionId = "20260811_000000_ccc333";
		call.release();
		await new Promise((r) => setTimeout(r, 10));

		expect(registry.get("main", "conv-1")?.sessionId).toBe(
			"20260811_000000_ccc333",
		);
		expect(runner.renames).toEqual([
			{ sessionId: "20260811_000000_ccc333", title: "teams:conv-1" },
		]);
	});

	it("detection is exact-match on the cleaned text", async () => {
		registry.set("main", "conv-1", "20260811_000000_aaa111");
		dispatcher = new TurnDispatcher(makeConfig(), registry, runner);

		// Not a reset: longer text, different command.
		const notReset = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("/reset please"),
		);
		expect(notReset.reset).toBeUndefined();
		runner.spawns[0]!.release();

		const notReset2 = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("/restart"),
		);
		expect(notReset2.reset).toBeUndefined();
		expect(runner.spawns).toHaveLength(2);
		expect(runner.spawns[0]?.resumeSessionId).toBe("20260811_000000_aaa111");
		expect(runner.spawns[1]?.resumeSessionId).toBe("20260811_000000_aaa111");
		runner.spawns[1]!.release();

		// Exact match wins even with surrounding whitespace (cleaned).
		const reset = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("  /reset  "),
		);
		expect(reset.reset).toBe(true);
		expect(registry.get("main", "conv-1")).toBeUndefined();
	});

	it("supports custom resetCommands from config", async () => {
		registry.set("main", "conv-1", "20260811_000000_aaa111");
		dispatcher = new TurnDispatcher(
			makeConfig({ resetCommands: ["/start over", "/nuke"] }),
			registry,
			runner,
		);

		expect(
			(await dispatcher.dispatch("main", "conv-1", teamsMessage("/nuke")))
				.reset,
		).toBe(true);
		expect(registry.get("main", "conv-1")).toBeUndefined();
		expect(
			(await dispatcher.dispatch("main", "conv-1", teamsMessage("/reset")))
				.reset,
		).toBeUndefined();
	});

	it("an in-flight turn at reset time still completes; a queued message then bootstraps", async () => {
		dispatcher = new TurnDispatcher(makeConfig(), registry, runner);

		// Turn 1 in flight (bootstrap, not yet released).
		const first = dispatcher.dispatch("main", "conv-1", teamsMessage("first"));
		await new Promise((r) => setTimeout(r, 10));

		// Message 2 queues behind turn 1 (no spawn yet).
		const second = dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("second"),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(runner.spawns).toHaveLength(1);

		// Reset severs the binding while turn 1 is still in flight.
		const reset = await dispatcher.dispatch(
			"main",
			"conv-1",
			teamsMessage("/reset"),
		);
		expect(reset.reset).toBe(true);
		expect(registry.get("main", "conv-1")).toBeUndefined();

		// Turn 1 completes normally and registers its session.
		runner.spawns[0]!.completion.sessionId = "20260811_000000_aaa111";
		runner.spawns[0]!.release();
		await first;

		// The queued message runs after the reset → bootstraps a fresh session.
		expect(await second).toMatchObject({ ok: true, queued: true });
		expect(runner.spawns).toHaveLength(2);
		expect(runner.spawns[1]?.resumeSessionId).toBeUndefined();
	});
});
