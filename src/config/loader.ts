import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, BridgeConfig } from "../types";
import { fatal } from "../utils/logger";

const CONFIG_PATH = path.join(process.cwd(), "config.json");
const ENV_PATH = path.join(process.cwd(), ".env");

const DEFAULT_CONFIG: Partial<BridgeConfig> = {
	proxyMode: false,
	proxyPort: 18790,
	signature: "[🤖 Rubot]",
	lookbackMinutes: 10,
	maxContextMessages: 50,
	contextSummaryLength: 500,
	enrichResponses: true,
	contextMode: "reply-chain",
	contextMaxAgeDays: 30,
	responseTimeoutSeconds: 180,
	responseSettleMs: 5000,
	timeoutFallbackMessage:
		"⏱️ AI is still processing and exceeded the {seconds} second time limit. Please resend your question...",
	hermesBin: "hermes",
	dbPath: "",
	sessionPollMs: 2000,
	agents: {},
};

const ENV_KEY_MAP: Record<string, keyof BridgeConfig> = {
	TEAMS_BRIDGE_FLOW2_URL: "flow2Url",
	TEAMS_BRIDGE_PROXY_MODE: "proxyMode",
	TEAMS_BRIDGE_PROXY_PORT: "proxyPort",
	TEAMS_BRIDGE_HERMES_BIN: "hermesBin",
	TEAMS_BRIDGE_DB_PATH: "dbPath",
	TEAMS_BRIDGE_SESSION_POLL_MS: "sessionPollMs",
};

function resolveDbPath(): string {
	const hermesHome =
		process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
	return path.join(hermesHome, "state.db");
}

function loadEnvFile(): Record<string, string> {
	const vars: Record<string, string> = {};

	try {
		const raw = fs.readFileSync(ENV_PATH, "utf-8");
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIdx = trimmed.indexOf("=");
			if (eqIdx === -1) continue;

			const key = trimmed.slice(0, eqIdx).trim();
			let value = trimmed.slice(eqIdx + 1).trim();

			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			} else {
				const commentIdx = value.indexOf(" #");
				if (commentIdx >= 0) {
					value = value.slice(0, commentIdx).trim();
				}
			}

			if (key) vars[key] = value;
		}
	} catch {
		// .env file is optional
	}

	return vars;
}

function applyEnvOverrides(config: BridgeConfig): void {
	const envVars = loadEnvFile();

	for (const [envKey, configKey] of Object.entries(ENV_KEY_MAP)) {
		const raw = process.env[envKey] ?? envVars[envKey];
		if (raw === undefined || raw === "") continue;

		if (configKey === "proxyMode") {
			config.proxyMode = raw.toLowerCase() === "true";
		} else if (configKey === "proxyPort") {
			const num = Number.parseInt(raw, 10);
			if (!Number.isNaN(num)) config.proxyPort = num;
		} else if (configKey === "sessionPollMs") {
			const num = Number.parseInt(raw, 10);
			if (!Number.isNaN(num) && num > 0) config.sessionPollMs = num;
		} else {
			config[configKey] = raw as never;
		}
	}
}

export function loadConfig(): BridgeConfig {
	let fileConfig: Partial<BridgeConfig> = {};

	try {
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		fileConfig = JSON.parse(raw) as Partial<BridgeConfig>;
	} catch (err) {
		fatal(`Failed to load config.json: ${(err as Error).message}`);
		process.exit(1);
	}

	const config = { ...DEFAULT_CONFIG, ...fileConfig } as BridgeConfig;
	applyEnvOverrides(config);
	config.dbPath = config.dbPath || resolveDbPath();
	resolveAgents(config, fileConfig);
	validateConfig(config);
	return config;
}

function resolveAgents(
	config: BridgeConfig,
	fileConfig: Partial<BridgeConfig>,
): void {
	const envVars = loadEnvFile();
	const agentsFromFile = (fileConfig.agents ?? {}) as Record<
		string,
		Partial<AgentConfig>
	>;

	if (Object.keys(agentsFromFile).length === 0) {
		agentsFromFile.main = {};
	}

	const resolved: Record<string, AgentConfig> = {};

	for (const [agentId, agentConfig] of Object.entries(agentsFromFile)) {
		const envKey = `TEAMS_BRIDGE_FLOW2_URL_${agentId.toUpperCase()}`;
		const agentFlow2Url =
			agentConfig.flow2Url ??
			process.env[envKey] ??
			envVars[envKey] ??
			config.flow2Url;
		const agentSignature = agentConfig.signature ?? config.signature;

		resolved[agentId] = {
			flow2Url: agentFlow2Url,
			signature: agentSignature,
			...(agentConfig.profile !== undefined && {
				profile: agentConfig.profile,
			}),
			...(agentConfig.extraArgs !== undefined && {
				extraArgs: agentConfig.extraArgs,
			}),
		};
	}

	config.agents = resolved;
}

function validateConfig(config: BridgeConfig): void {
	for (const [agentId, agent] of Object.entries(config.agents)) {
		if (!agent.flow2Url) {
			fatal(`Agent ${agentId}: missing flow2Url`);
			process.exit(1);
		}
		if (!/^https?:\/\//i.test(agent.flow2Url)) {
			fatal(`Agent ${agentId}: invalid flow2Url: ${agent.flow2Url}`);
			process.exit(1);
		}
	}

	if (config.proxyMode && (!config.proxyPort || config.proxyPort <= 0)) {
		fatal(`Invalid proxy settings: proxyPort=${config.proxyPort}`);
		process.exit(1);
	}

	if (!["reply-chain", "conversation"].includes(config.contextMode)) {
		fatal(`Invalid contextMode: ${config.contextMode}`);
		process.exit(1);
	}

	if (!config.dbPath) {
		fatal("dbPath not set (Hermes session store)");
		process.exit(1);
	}
}
