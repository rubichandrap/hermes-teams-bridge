import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, BridgeConfig } from "../types";
import { debug, error } from "../utils/logger";

export const AGENT_SOURCE = "teams-bridge";

export interface SpawnResult {
	ok: boolean;
	error?: string;
}

/**
 * Spawn a one-shot Hermes agent turn for an inbound Teams message.
 *
 * The child runs `hermes chat -q <message> -Q --source teams-bridge`, which
 * creates a session in the Hermes session store. The bridge's store watcher
 * picks the session up there — the child's stdout is not used for the
 * response path, keeping the settle-window machinery authoritative.
 *
 * The child is detached and unref'd: it outlives the bridge, so in-flight
 * turns keep running across a bridge restart and their responses are picked
 * up by the lookback heartbeat.
 */
export function spawnAgentTurn(
	config: BridgeConfig,
	agent: AgentConfig,
	message: string,
): Promise<SpawnResult> {
	const args = [
		"chat",
		"-q",
		message,
		"-Q",
		"--source",
		AGENT_SOURCE,
		...(agent.extraArgs ?? []),
	];

	const env: NodeJS.ProcessEnv = { ...process.env };
	if (agent.profile && agent.profile !== "default") {
		const profileHome = path.join(
			os.homedir(),
			".hermes",
			"profiles",
			agent.profile,
		);
		env.HERMES_HOME = profileHome;
	}

	debug(
		`Spawning agent turn: ${config.hermesBin} ${args
			.filter((a) => a !== message)
			.join(" ")} (profile=${agent.profile ?? "default"})`,
	);

	return new Promise<SpawnResult>((resolve) => {
		const child = spawn(config.hermesBin, args, {
			env,
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			error(`Agent spawn failed: ${err.message}`);
			resolve({ ok: false, error: err.message });
		});

		child.on("spawn", () => {
			child.unref();
			resolve({ ok: true });
		});

		child.on("exit", (code) => {
			if (code !== 0 && stderr) {
				error(`Agent turn exited with code ${code}: ${stderr.slice(0, 500)}`);
			}
		});
	});
}
