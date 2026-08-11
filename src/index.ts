/**
 * Hermes Teams Bridge Daemon — SOLID + TypeScript Entry Point
 * SRP: Bootstrap only
 */

import { loadConfig } from "./config/loader";
import { BridgeOrchestrator } from "./core/bridge";
import { SqliteStore } from "./store/hermes-store";

async function main(): Promise<void> {
	const config = loadConfig();
	const store = new SqliteStore(config.dbPath);
	const bridge = new BridgeOrchestrator(config, store);
	await bridge.start();
}

main().catch((err) => {
	console.error(`Fatal: ${(err as Error).message}`);
	process.exit(1);
});
