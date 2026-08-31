/**
 * Hermes Teams Bridge Daemon — SOLID + TypeScript Entry Point
 * SRP: Bootstrap only
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "./config/loader";
import { BridgeOrchestrator } from "./core/bridge";
import { MultiProfileStore, profileDbPath } from "./store/hermes-store";

async function main(): Promise<void> {
	const config = loadConfig();
	const hermesHome =
		process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
	const defaultDbPath = config.dbPath || path.join(hermesHome, "state.db");
	if (!fs.existsSync(defaultDbPath)) {
		throw new Error(`Hermes session store not found: ${defaultDbPath}`);
	}
	const specs = new Map<string, string>([["default", defaultDbPath]]);
	for (const agent of Object.values(config.agents)) {
		const profile = agent.profile ?? "default";
		if (profile !== "default" && !specs.has(profile)) {
			specs.set(profile, profileDbPath(hermesHome, profile));
		}
	}
	const store = new MultiProfileStore(
		[...specs].map(([profile, dbPath]) => ({ profile, dbPath })),
	);
	const bridge = new BridgeOrchestrator(config, store);
	await bridge.start();
}

main().catch((err) => {
	console.error(`Fatal: ${(err as Error).message}`);
	process.exit(1);
});
