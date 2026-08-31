import { type TurnRunner, defaultTurnRunner } from "../agent/runner";
import {
	type SessionRegistry,
	conversationKey,
} from "../registry/session-registry";
import { parseMessage } from "../session/parser";
import type { AgentConfig, BridgeConfig } from "../types";
import { debug, error, info, warn } from "../utils/logger";

export interface DispatchResult {
	ok: boolean;
	error?: string;
	/** True when the turn was queued behind an in-flight turn for the conversation. */
	queued?: boolean;
	/** True when the message matched a reset command and severed the binding. */
	reset?: boolean;
}

/** Minimal surface the proxy (and tests) depend on. */
export interface DispatchService {
	dispatch(
		agentId: string,
		conversationId: string,
		rawMessage: string,
	): Promise<DispatchResult>;
}

export const TURN_INSTRUCTION =
	"📋 Reply with ONE final message. No narration, no planning, no NO_REPLY for questions.";

const PENDING_BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

/**
 * Routes inbound Teams messages to their conversation's Hermes session.
 *
 * The first message in a conversation bootstraps a fresh session (capturing
 * its id from the child's stderr and registering it, renamed
 * `teams:<conversation>`); later messages resume the recorded session. Only
 * one turn per conversation is in flight — concurrent messages queue and run
 * in order. Reset commands sever the binding so the next turn bootstraps.
 *
 * The dispatcher never writes to the session store: it only spawns detached
 * children and records session ids. Manually pasted messages (not spawned
 * here) are never registered; the watcher's associateIfPending() call only
 * registers sessions for bootstrap spawns whose id capture failed.
 */
export class TurnDispatcher {
	private readonly queues = new Map<string, Promise<void>>();
	private stopped = false;

	constructor(
		private readonly config: BridgeConfig,
		private readonly registry: SessionRegistry,
		private readonly runner: TurnRunner = defaultTurnRunner,
	) {}

	/**
	 * Enqueue an inbound message for the conversation. Resolves when the
	 * turn's spawn completes (or the message is a reset command). Turns are
	 * serialized per conversation: the next spawn only starts once the
	 * previous turn's child has exited, so one turn is in flight at a time.
	 */
	async dispatch(
		agentId: string,
		conversationId: string,
		rawMessage: string,
	): Promise<DispatchResult> {
		if (this.stopped) return { ok: false, error: "dispatcher stopped" };

		const agent = this.config.agents[agentId];
		if (!agent) return { ok: false, error: `Unknown agent: ${agentId}` };
		if (!conversationId) return { ok: false, error: "Missing conversationId" };

		this.registry.purgeExpiredPending(PENDING_BOOTSTRAP_TTL_MS);

		if (this.isResetCommand(rawMessage)) {
			this.registry.remove(agentId, conversationId);
			info(
				`${agentId}/${conversationId}: Reset command — session binding severed`,
			);
			return { ok: true, reset: true };
		}

		const key = conversationKey(agentId, conversationId);
		const prev = this.queues.get(key);
		const queued = prev !== undefined;
		const turn = (prev ?? Promise.resolve()).then(() =>
			this.runTurn(agentId, agent, conversationId, rawMessage),
		);
		const gate = turn.then(
			(r) => r.completion,
			() => undefined,
		);
		const chained = gate.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(key, chained);
		void chained.finally(() => {
			if (this.queues.get(key) === chained) this.queues.delete(key);
		});

		if (queued) debug(`${key}: turn queued behind in-flight turn`);

		return turn.then((r) =>
			queued ? { ...r.result, queued: true } : r.result,
		);
	}

	/**
	 * Register a store-discovered session for a conversation whose bootstrap
	 * spawn did not capture its session id. Never registers sessions that were
	 * not spawned by this dispatcher (manual pastes).
	 */
	associateIfPending(
		agentId: string,
		sessionId: string,
		conversationId: string | undefined,
		startedAtMs?: number,
	): boolean {
		if (!conversationId) return false;
		this.registry.purgeExpiredPending(PENDING_BOOTSTRAP_TTL_MS);
		const pendingTs = this.registry.getPendingBootstrapTs(
			agentId,
			conversationId,
		);
		if (pendingTs === undefined) return false;
		if (this.registry.wasSeveredAfter(agentId, conversationId, pendingTs)) {
			this.registry.clearPendingBootstrap(agentId, conversationId);
			debug(
				`${agentId}/${conversationId}: Pending bootstrap severed by reset, not associating`,
			);
			return false;
		}
		if (startedAtMs !== undefined && startedAtMs < pendingTs) {
			debug(
				`${agentId}/${conversationId}: Session ${sessionId} predates pending bootstrap — not associating`,
			);
			return false;
		}
		this.registry.set(
			agentId,
			conversationId,
			sessionId,
			this.config.agents[agentId]?.profile ?? "default",
		);
		this.registry.clearPendingBootstrap(agentId, conversationId);
		const agent = this.config.agents[agentId];
		if (agent) {
			this.runner.rename(
				this.config,
				agent,
				sessionId,
				`teams:${conversationId}`,
			);
		}
		info(
			`${agentId}/${conversationId}: Associated session ${sessionId} (fallback)`,
		);
		return true;
	}

	stop(): void {
		this.stopped = true;
	}

	private async runTurn(
		agentId: string,
		agent: AgentConfig,
		conversationId: string,
		rawMessage: string,
	): Promise<{ result: DispatchResult; completion: Promise<unknown> }> {
		const key = conversationKey(agentId, conversationId);
		const message = `${TURN_INSTRUCTION}\n\n${rawMessage}`;
		const agentProfile = agent.profile ?? "default";
		const entry = this.registry.get(agentId, conversationId);

		if (entry && entry.profile === agentProfile) {
			const result = await this.runner.spawn(this.config, agent, message, {
				resumeSessionId: entry.sessionId,
			});
			if (!result.ok) {
				error(
					`${agentId}/${conversationId}: Resume spawn failed: ${result.error}`,
				);
				return {
					result: { ok: false, error: result.error ?? "spawn failed" },
					completion: Promise.resolve(),
				};
			}
			debug(
				`${agentId}/${conversationId}: Resuming session ${entry.sessionId}`,
			);
			const completion = result.done.then((c) => {
				debug(`${key}: Turn finished (exit ${c.exitCode})`);
			});
			return { result: { ok: true }, completion };
		}

		this.registry.markPendingBootstrap(agentId, conversationId);
		const spawnStartedAt = Date.now();
		const result = await this.runner.spawn(this.config, agent, message);
		if (!result.ok) {
			this.registry.clearPendingBootstrap(agentId, conversationId);
			error(
				`${agentId}/${conversationId}: Bootstrap spawn failed: ${result.error}`,
			);
			return {
				result: { ok: false, error: result.error ?? "spawn failed" },
				completion: Promise.resolve(),
			};
		}

		info(
			`${agentId}/${conversationId}: Bootstrapping fresh session (${message.length} chars)`,
		);

		const completion = result.done.then((c) => {
			if (
				c.sessionId &&
				!this.registry.wasSeveredAfter(agentId, conversationId, spawnStartedAt)
			) {
				this.registry.set(agentId, conversationId, c.sessionId, agentProfile);
				this.registry.clearPendingBootstrap(agentId, conversationId);
				this.runner.rename(
					this.config,
					agent,
					c.sessionId,
					`teams:${conversationId}`,
				);
				info(`${agentId}/${conversationId}: Registered session ${c.sessionId}`);
			} else if (c.sessionId) {
				this.registry.clearPendingBootstrap(agentId, conversationId);
				warn(
					`${agentId}/${conversationId}: Bootstrap session ${c.sessionId} severed by reset — not registering`,
				);
			} else {
				warn(
					`${agentId}/${conversationId}: Session id not captured — watcher association fallback`,
				);
			}
		});
		return { result: { ok: true }, completion };
	}

	private isResetCommand(rawMessage: string): boolean {
		const cleaned = parseMessage(rawMessage).text.trim();
		return this.config.resetCommands.some((cmd) => cmd === cleaned);
	}
}
