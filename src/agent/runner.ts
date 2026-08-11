import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, BridgeConfig } from "../types";
import { debug, error, warn } from "../utils/logger";

export const AGENT_SOURCE = "teams-bridge";

export interface TurnCompletion {
	sessionId?: string;
	exitCode: number | null;
}

export interface SpawnResult {
	ok: boolean;
	error?: string;
	/**
	 * Resolves when the child exits (or the turn-duration cap is hit).
	 * sessionId is the session captured from the child's stderr, when any.
	 */
	done: Promise<TurnCompletion>;
}

export interface TurnRunner {
	spawn(
		config: BridgeConfig,
		agent: AgentConfig,
		message: string,
		opts?: { resumeSessionId?: string },
	): Promise<SpawnResult>;
	rename(
		config: BridgeConfig,
		agent: AgentConfig,
		sessionId: string,
		title: string,
	): void;
}

export const defaultTurnRunner: TurnRunner = {
	spawn: spawnAgentTurn,
	rename: renameSession,
};

/**
 * Spawn a Hermes agent turn for an inbound Teams message.
 *
 * Bootstrap mode (no resumeSessionId) creates a session in the Hermes session
 * store; resume mode (`-r <sessionId>`) continues the conversation's session.
 * The child prints `session_id: <id>` to stderr on exit, which is captured for
 * the session registry.
 *
 * The child is detached and unref'd: it outlives the bridge, so in-flight
 * turns keep running across a bridge restart and their responses are picked
 * up by the lookback heartbeat.
 */
export function spawnAgentTurn(
	config: BridgeConfig,
	agent: AgentConfig,
	message: string,
	opts?: { resumeSessionId?: string },
): Promise<SpawnResult> {
	const args = [
		"chat",
		"-q",
		message,
		"-Q",
		...(opts?.resumeSessionId ? ["-r", opts.resumeSessionId] : []),
		"--source",
		AGENT_SOURCE,
		...(agent.extraArgs ?? []),
	];

	const env = agentEnv(agent);

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
		let capturedSessionId: string | undefined;
		let exitCode: number | null = null;
		let finished = false;

		let resolveDone!: (completion: TurnCompletion) => void;
		const done = new Promise<TurnCompletion>((r) => {
			resolveDone = r;
		});

		const finishDone = (): void => {
			if (finished) return;
			finished = true;
			clearTimeout(capTimer);
			const completion: TurnCompletion = {
				...(capturedSessionId && { sessionId: capturedSessionId }),
				exitCode,
			};
			resolveDone(completion);
		};

		const capMs = Math.max(
			300_000,
			config.responseTimeoutSeconds * 1000 + 30_000,
		);
		const capTimer = setTimeout(() => {
			if (!finished) {
				warn(
					`Agent turn exceeded ${Math.round(capMs / 1000)}s cap, releasing queue without session id`,
				);
				finishDone();
			}
		}, capMs);

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			capturedSessionId ??= extractSessionIdFromStderr(stderr) ?? undefined;
		});

		child.stderr?.on("close", () => {
			finishDone();
		});

		child.on("error", (err) => {
			error(`Agent spawn failed: ${err.message}`);
			resolve({ ok: false, error: err.message, done });
			finishDone();
		});

		child.on("spawn", () => {
			child.unref();
			resolve({ ok: true, done });
		});

		child.on("exit", (code) => {
			exitCode = code;
			if (code !== 0 && stderr) {
				error(`Agent turn exited with code ${code}: ${stderr.slice(0, 500)}`);
			}
			finishDone();
		});
	});
}

/**
 * Rename a Hermes session to `teams:<conversation>` (best-effort).
 *
 * Fire-and-forget: detached, unref'd, and never throws. A failed rename only
 * logs — resume-by-session-id does not depend on titles.
 */
export function renameSession(
	config: BridgeConfig,
	agent: AgentConfig,
	sessionId: string,
	title: string,
): void {
	const args = ["sessions", "rename", sessionId, title];

	debug(
		`Renaming session ${sessionId} to "${title}" (profile=${agent.profile ?? "default"})`,
	);

	let stderr = "";
	const child = spawn(config.hermesBin, args, {
		env: agentEnv(agent),
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	child.on("error", (err) => {
		error(`Session rename spawn failed: ${err.message}`);
	});

	child.on("exit", (code) => {
		if (code !== 0) {
			warn(
				`Session rename failed (exit ${code}): ${stderr.slice(0, 300) || "no output"}`,
			);
		}
	});

	child.on("spawn", () => {
		child.unref();
	});
}

/** Pull the `session_id: <id>` line Hermes prints to stderr on exit. */
export function extractSessionIdFromStderr(stderr: string): string | null {
	const match = stderr.match(/session_id:\s*([^\s]+)/);
	return match?.[1] ?? null;
}

function agentEnv(agent: AgentConfig): NodeJS.ProcessEnv {
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
	return env;
}
