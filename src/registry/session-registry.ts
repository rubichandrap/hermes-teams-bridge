import fs from "node:fs";
import { debug, error } from "../utils/logger";

export interface RegistryEntry {
	sessionId: string;
	createdAt: number;
	lastUsedAt: number;
}

interface RegistryData {
	conversations: Record<string, RegistryEntry>;
	/** agentId::conversationId -> timestamp of an unresolved bootstrap spawn. */
	pendingBootstraps: Record<string, number>;
	/** agentId::conversationId -> timestamp of the last reset (sever). */
	severedAt: Record<string, number>;
}

/** How long a sever tombstone is kept; far beyond any in-flight turn window. */
const SEVERED_TTL_MS = 24 * 60 * 60 * 1000;

/** Composite key shared by the registry and the dispatcher's queue. */
export function conversationKey(agentId: string, conversationId: string): string {
	return `${agentId}::${conversationId}`;
}

/**
 * Persistent mapping of Teams conversations to their Hermes session.
 *
 * Survives bridge restarts: written through to a JSON file on every mutation
 * (atomic tmp+rename, serialized writes). Pending-bootstrap markers record
 * spawns whose session id was not captured from the child's stderr; the
 * watcher associates the session when it appears in the store.
 */
export class SessionRegistry {
	private data: RegistryData = {
		conversations: {},
		pendingBootstraps: {},
		severedAt: {},
	};
	private writeInFlight: Promise<void> | null = null;
	private writeQueued = false;

	constructor(private readonly filePath: string) {}

	load(): void {
		try {
			const parsed = JSON.parse(
				fs.readFileSync(this.filePath, "utf-8"),
			) as RegistryData;
			this.data = {
				conversations: parsed.conversations ?? {},
				pendingBootstraps: parsed.pendingBootstraps ?? {},
				severedAt: parsed.severedAt ?? {},
			};
			debug(`Session registry loaded: ${this.filePath}`);
		} catch {
			this.data = { conversations: {}, pendingBootstraps: {}, severedAt: {} };
			debug(`No session registry at ${this.filePath}, starting empty`);
		}
	}

	get(agentId: string, conversationId: string): RegistryEntry | undefined {
		return this.data.conversations[this.key(agentId, conversationId)];
	}

	set(agentId: string, conversationId: string, sessionId: string): void {
		const key = this.key(agentId, conversationId);
		const now = Date.now();
		const existing = this.data.conversations[key];
		this.data.conversations[key] = {
			sessionId,
			createdAt: existing?.createdAt ?? now,
			lastUsedAt: now,
		};
		delete this.data.severedAt[key];
		this.flush();
	}

	/**
	 * Sever the conversation's session binding. Always records the sever
	 * timestamp, even when no entry existed, so an in-flight bootstrap that
	 * finishes later cannot resurrect the binding.
	 */
	remove(agentId: string, conversationId: string): boolean {
		const key = this.key(agentId, conversationId);
		const existed = !!this.data.conversations[key];
		delete this.data.conversations[key];
		this.data.severedAt[key] = Date.now();
		this.flush();
		return existed;
	}

	/** True when a reset happened after `ts` and no registration superseded it. */
	wasSeveredAfter(
		agentId: string,
		conversationId: string,
		ts: number,
	): boolean {
		const severed = this.data.severedAt[this.key(agentId, conversationId)];
		return severed !== undefined && severed > ts;
	}

	markPendingBootstrap(agentId: string, conversationId: string): void {
		this.data.pendingBootstraps[this.key(agentId, conversationId)] = Date.now();
		this.flush();
	}

	clearPendingBootstrap(agentId: string, conversationId: string): void {
		const key = this.key(agentId, conversationId);
		if (!this.data.pendingBootstraps[key]) return;
		delete this.data.pendingBootstraps[key];
		this.flush();
	}

	hasPendingBootstrap(agentId: string, conversationId: string): boolean {
		return (
			this.data.pendingBootstraps[this.key(agentId, conversationId)] !==
			undefined
		);
	}

	getPendingBootstrapTs(
		agentId: string,
		conversationId: string,
	): number | undefined {
		return this.data.pendingBootstraps[this.key(agentId, conversationId)];
	}

	/** Drop pending markers older than maxAgeMs and severs older than a day. */
	purgeExpiredPending(maxAgeMs: number): void {
		const now = Date.now();
		let changed = false;
		for (const [key, ts] of Object.entries(this.data.pendingBootstraps)) {
			if (ts <= now - maxAgeMs) {
				delete this.data.pendingBootstraps[key];
				changed = true;
			}
		}
		for (const [key, ts] of Object.entries(this.data.severedAt)) {
			if (ts <= now - SEVERED_TTL_MS) {
				delete this.data.severedAt[key];
				changed = true;
			}
		}
		if (changed) this.flush();
	}

	flush(): void {
		if (this.writeInFlight) {
			this.writeQueued = true;
			return;
		}
		this.writeInFlight = this.doFlush().finally(() => {
			this.writeInFlight = null;
			if (this.writeQueued) {
				this.writeQueued = false;
				this.flush();
			}
		});
	}

	async flushAndWait(): Promise<void> {
		this.flush();
		while (this.writeInFlight || this.writeQueued) {
			await this.writeInFlight?.catch(() => undefined);
		}
	}

	private key(agentId: string, conversationId: string): string {
		return conversationKey(agentId, conversationId);
	}

	private doFlush(): Promise<void> {
		const snapshot = JSON.stringify(this.data, null, 2);
		const tmp = `${this.filePath}.tmp`;
		return fs.promises
			.writeFile(tmp, snapshot)
			.then(() => fs.promises.rename(tmp, this.filePath))
			.catch((err: Error) => {
				error(`Failed to flush session registry: ${err.message}`);
			});
	}
}
