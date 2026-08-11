import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../types";
import { spawnAgentTurn } from "./runner";

function makeConfig(tmpDir: string, hermesBin: string): BridgeConfig {
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
		timeoutFallbackMessage: "timeout",
		hermesBin,
		dbPath: path.join(tmpDir, "state.db"),
		sessionPollMs: 2000,
		agents: {
			main: { flow2Url: "https://example.com/flow2", signature: "[SIG]" },
		},
	};
}

function waitForFile(file: string, timeoutMs = 3000): Promise<string> {
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
		const bin = fakeBin(`printf "%s\n" "$@" > "${out}"`);

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
		const bin = fakeBin(`printf "%s\n" "$@" > "${out}"`);

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

	it("reports spawn failure when the binary is missing", async () => {
		const result = await spawnAgentTurn(
			makeConfig(tmpDir, "/nonexistent/hermes-bin"),
			{ flow2Url: "https://example.com/flow2", signature: "[SIG]" },
			"hello",
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});
