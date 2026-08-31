import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./loader";

describe("loadConfig", () => {
	const origEnv = process.env;
	const origHome = process.env.HOME;
	const origCwd = process.cwd();

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...origEnv };
		// Hermetic against whatever is in the repo's .env: agent-specific
		// overrides always win over the general key.
		process.env.TEAMS_BRIDGE_FLOW2_URL_MAIN = "https://example.com/flow2-main";
	});

	afterEach(() => {
		process.env = origEnv;
		process.env.HOME = origHome;
		process.chdir(origCwd);
	});

	it("loads config successfully when env vars or config.json provides required fields", () => {
		process.env.TEAMS_BRIDGE_FLOW2_URL = "https://example.com/flow2";
		process.env.TEAMS_BRIDGE_PROXY_MODE = "true";

		const config = loadConfig();
		expect(config.flow2Url).toBe("https://example.com/flow2");
		expect(config.proxyMode).toBe(true);
		expect(config.hermesBin).toBe("hermes");
		expect(config.sessionPollMs).toBeGreaterThan(0);
		expect(config.dbPath).toContain("state.db");
		expect(config.agents.main?.flow2Url).toBe("https://example.com/flow2-main");
	});

	it("uses agent specific env var over general flow2Url", () => {
		process.env.TEAMS_BRIDGE_FLOW2_URL = "https://example.com/default";
		process.env.TEAMS_BRIDGE_FLOW2_URL_MAIN = "https://example.com/main";

		const config = loadConfig();
		expect(config.agents.main?.flow2Url).toBe("https://example.com/main");
	});

	it("resolves per-agent profiles from config.json", () => {
		process.env.TEAMS_BRIDGE_FLOW2_URL = "https://example.com/flow2";

		const config = loadConfig();
		expect(typeof config.agents.main?.profile).toBe("string");
		expect(config.agents.main?.signature).toBe("[🤖 Marbot]");
	});
});
