import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../types";
import {
	extractSessionIdFromStderr,
	renameSession,
	spawnAgentTurn,
} from "./runner";

function makeConfig(tmpDir: string, hermesBin: string): BridgeConfig {
	return {
		flow2Url: "https://example.com/flow2",
		proxyMode: false,
		proxyPort: 18790,
		signature: "[SIG]",
		lookbackMinutes: 10,
		responseTimeoutSeconds: 1,
		responseSettleMs: 1,
		timeoutFallbackMessage: "timeout",
		hermesBin,
		dbPath: path.join(tmpDir, "state.db"),
		sessionPollMs: 2000,
		resetCommands: ["/reset"],
		agents: {
			main: { flow2Url: "https://example.com/flow2", signature: "[SIG]" },
		},
	};
}

function waitForFile(file: string, timeoutMs = 10_000): Promise<string> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = (): void => {
			if (fs.existsSync(file)) {
				resolve(fs.readFileSync(file, "utf-8"));
				return;
			}
			if (Date.now() - start > timeoutMs) {
				reject(new Error(`timed out waiting for ${file}`));
				return;
			}
			setTimeout(tick, 20);
		};
		tick();
	});
}

describe("spawnAgentTurn", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-runner-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function fakeBin(scriptBody: string): string {
		const bin = path.join(tmpDir, "fake-hermes.sh");
		fs.writeFileSync(bin, `#!/bin/sh\n${scriptBody}\n`);
		fs.chmodSync(bin, 0o755);
		return bin;
	}

	it("spawns hermes chat with the message and teams-bridge source", async () => {
		const out = path.join(tmpDir, "out.txt");
		const bin = fakeBin(`printf "%s\\n" "$@" > "${out}"`);

		const result = await spawnAgentTurn(
			makeConfig(tmpDir, bin),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"hello from teams",
		);
		expect(result.ok).toBe(true);

		const args = (await waitForFile(out)).split("\n");
		expect(args[0]).toBe("chat");
		expect(args[1]).toBe("-q");
		expect(args[2]).toBe("hello from teams");
		expect(args).toContain("-Q");
		expect(args).toContain("--source");
		expect(args).toContain("teams-bridge");
		expect(args).not.toContain("-r");
	});

	it("adds -r <sessionId> when resuming", async () => {
		const out = path.join(tmpDir, "out.txt");
		const bin = fakeBin(`printf "%s\\n" "$@" > "${out}"`);

		const result = await spawnAgentTurn(
			makeConfig(tmpDir, bin),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"hello again",
			{ resumeSessionId: "20260811_000000_abc123" },
		);
		expect(result.ok).toBe(true);

		const args = (await waitForFile(out)).split("\n");
		const rIdx = args.indexOf("-r");
		expect(rIdx).toBeGreaterThan(-1);
		expect(args[rIdx + 1]).toBe("20260811_000000_abc123");
	});

	it("sets HERMES_HOME for non-default profiles", async () => {
		const out = path.join(tmpDir, "env.txt");
		const bin = fakeBin(`printf '%s' "$HERMES_HOME" > "${out}"`);

		const result = await spawnAgentTurn(
			makeConfig(tmpDir, bin),
			{
				flow2Url: "https://example.com/flow2",
				signature: "[SIG]",
				profile: "stevbot",
			},
			"hello",
		);
		expect(result.ok).toBe(true);

		const home = await waitForFile(out);
		expect(home).toBe(
			path.join(os.homedir(), ".hermes", "profiles", "stevbot"),
		);
	});

	it("appends extraArgs after the default flags", async () => {
		const out = path.join(tmpDir, "args.txt");
		const bin = fakeBin(`printf "%s\\n" "$@" > "${out}"`);

		await spawnAgentTurn(
			makeConfig(tmpDir, bin),
			{
				flow2Url: "https://example.com/flow2",
				signature: "[SIG]",
				extraArgs: ["--yolo", "--accept-hooks"],
			},
			"hello",
		);

		const args = (await waitForFile(out)).split("\n");
		expect(args).toContain("--yolo");
		expect(args).toContain("--accept-hooks");
	});

	it("captures the session id from stderr after the child exits", async () => {
		const bin = fakeBin(`echo "session_id: 20260811_000000_abc123" >&2`);

		const result = await spawnAgentTurn(
			makeConfig(tmpDir, bin),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"hello",
		);
		expect(result.ok).toBe(true);

		const completion = await result.done;
		expect(completion.sessionId).toBe("20260811_000000_abc123");
		expect(completion.exitCode).toBe(0);
	});

	it("resolves done with no session id when the child prints none", async () => {
		const bin = fakeBin("exit 3");

		const result = await spawnAgentTurn(
			makeConfig(tmpDir, bin),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"hello",
		);
		expect(result.ok).toBe(true);

		const completion = await result.done;
		expect(completion.sessionId).toBeUndefined();
		expect(completion.exitCode).toBe(3);
	});

	it("reports spawn failure and resolves done when the binary is missing", async () => {
		const result = await spawnAgentTurn(
			makeConfig(tmpDir, "/nonexistent/hermes-bin"),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"hello",
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();

		const completion = await result.done;
		expect(completion.sessionId).toBeUndefined();
	});
});

describe("renameSession", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-rename-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("spawns `sessions rename <id> <title>`", async () => {
		const out = path.join(tmpDir, "out.txt");
		const bin = path.join(tmpDir, "fake-hermes.sh");
		fs.writeFileSync(bin, `#!/bin/sh\nprintf "%s\\n" "$@" > "${out}"\n`);
		fs.chmodSync(bin, 0o755);

		renameSession(
			makeConfig(tmpDir, bin),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"20260811_000000_abc123",
			"teams:19:conv@thread.v2",
		);

		const args = (await waitForFile(out)).split("\n");
		expect(args[0]).toBe("sessions");
		expect(args[1]).toBe("rename");
		expect(args[2]).toBe("20260811_000000_abc123");
		expect(args[3]).toBe("teams:19:conv@thread.v2");
	});

	it("does not throw when the binary is missing", () => {
		expect(() =>
			renameSession(
				makeConfig(tmpDir, "/nonexistent/hermes-bin"),
				{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
				"20260811_000000_abc123",
				"teams:conv",
			),
		).not.toThrow();
	});

	it("warns when the rename exits 0 but prints an error (title collision)", async () => {
		const bin = path.join(tmpDir, "fake-hermes-collide.sh");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho "Error: Title 'teams:conv' is already in use by session old-session"\nexit 0\n`,
		);
		fs.chmodSync(bin, 0o755);

		const logSpy = vi.spyOn(console, "log");
		renameSession(
			makeConfig(tmpDir, bin),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"20260811_000000_abc123",
			"teams:conv",
		);

		await vi.waitFor(
			() => {
				expect(
					logSpy.mock.calls.some((call) =>
						String(call[0]).includes("already in use"),
					),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		logSpy.mockRestore();
	});
});

describe("extractSessionIdFromStderr", () => {
	it("parses the session_id line", () => {
		expect(
			extractSessionIdFromStderr(
				"\n↻ Resumed session 20260811_000000_abc123 (1 user message)\n\nsession_id: 20260811_000000_abc123",
			),
		).toBe("20260811_000000_abc123");
	});

	it("returns null when absent", () => {
		expect(extractSessionIdFromStderr("some other output")).toBeNull();
		expect(extractSessionIdFromStderr("")).toBeNull();
	});
});
