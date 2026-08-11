import { cleanupOldContexts, ensureDirectory } from "../context/manager";
import { startProxyServer, stopProxyServer } from "../proxy/server";
import { flushState, loadState } from "../state/manager";
import type { SessionStore } from "../store/hermes-store";
import type { BridgeConfig } from "../types";
import { info, warn } from "../utils/logger";
import { createDbWatcher } from "../watcher/db-watcher";
import { SessionLifecycle } from "./session-lifecycle";

const HEARTBEAT_MS = 15000;
const FLUSH_MS = 60000;

export class BridgeOrchestrator {
	private readonly config: BridgeConfig;
	private readonly store: SessionStore;
	private readonly sessionLifecycle: SessionLifecycle;
	private shutdown = false;
	private timers: NodeJS.Timeout[] = [];
	private watchers: ReturnType<typeof createDbWatcher>[] = [];

	constructor(config: BridgeConfig, store: SessionStore) {
		this.config = config;
		this.store = store;
		this.sessionLifecycle = new SessionLifecycle(config, store);
	}

	async start(): Promise<void> {
		ensureDirectory();
		loadState();
		cleanupOldContexts(this.config.contextMaxAgeDays);

		info(
			"=== Hermes Teams Bridge Daemon v1.0 (Hermes Agent + TypeScript) started ===",
		);

		if (this.config.proxyMode) {
			startProxyServer(this.config);
		}

		this.startWatchers();
		this.startHeartbeat();
		this.startStateFlush();
		this.setupSignalHandlers();
	}

	private startWatchers(): void {
		const watcher = createDbWatcher(
			this.store,
			this.config.sessionPollMs,
			(refs) => {
				const tagged = refs
					.map((ref) => {
						const agentId = this.agentIdForProfile(ref.profileName);
						if (!agentId) {
							warn(
								`Session ${ref.sessionId}: no agent configured for profile "${ref.profileName}"`,
							);
							return null;
						}
						return { agentId, sessionId: ref.sessionId };
					})
					.filter(
						(t): t is { agentId: string; sessionId: string } => t !== null,
					);
				if (tagged.length > 0) {
					this.sessionLifecycle.scanSessions(tagged);
				}
			},
		);
		watcher.start();
		this.watchers.push(watcher);
	}

	private startHeartbeat(): void {
		const timer = setInterval(() => {
			if (this.shutdown) return;
			const tagged: { agentId: string; sessionId: string }[] = [];
			const refs = this.store.listSessionsWithTeamsMeta(
				this.config.lookbackMinutes * 60 * 1000,
			);
			for (const ref of refs) {
				const agentId = this.agentIdForProfile(ref.profileName);
				if (!agentId) continue;
				tagged.push({ agentId, sessionId: ref.sessionId });
			}
			if (tagged.length > 0) {
				this.sessionLifecycle.scanSessions(tagged);
			}
		}, HEARTBEAT_MS);
		this.timers.push(timer);
	}

	private startStateFlush(): void {
		const timer = setInterval(() => {
			flushState();
		}, FLUSH_MS);
		this.timers.push(timer);
	}

	/** Map a Hermes profile name back to a configured agent key. */
	private agentIdForProfile(profileName: string): string | undefined {
		for (const [agentId, agent] of Object.entries(this.config.agents)) {
			if ((agent.profile ?? "default") === profileName) return agentId;
		}
		return undefined;
	}

	private setupSignalHandlers(): void {
		const gracefulShutdown = () => {
			if (this.shutdown) return;
			info("Shutting down...");
			this.shutdown = true;

			for (const watcher of this.watchers) watcher.stop();
			for (const timer of this.timers) clearInterval(timer);

			stopProxyServer();
			void this.sessionLifecycle.stop().then(() => {
				this.store.close();
				flushState();
				info("Shutdown complete");
				process.exit(0);
			});
		};

		process.on("SIGTERM", gracefulShutdown);
		process.on("SIGINT", gracefulShutdown);
	}
}
