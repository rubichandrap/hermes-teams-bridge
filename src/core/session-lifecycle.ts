import { clearContext, loadContext, updateContext } from "../context/manager";
import { saveConversationMd } from "../context/md-writer";
import {
	BREAKER_COOLDOWN_MS,
	extractOriginalUserMessage,
	postToFlow2,
} from "../forwarder/flow2";
import { SecurityScanner } from "../security";
import {
	extractConversationHistory,
	extractLatestAssistantText,
	extractTeamsMetadata,
	getLatestAssistantActivity,
	hasNoReply,
	hasTeamsMetadata,
	isReplyMessage,
} from "../session/parser";
import {
	getRetryCategory,
	getRetryCount,
	incrementRetry,
	isAlreadyForwarded,
	markFailed,
	markForwarded,
} from "../state/manager";
import type { SessionStore } from "../store/hermes-store";
import type {
	BridgeConfig,
	ErrorCategory,
	ForwardResult,
	TeamsMetadata,
} from "../types";
import { debug, error, info, warn } from "../utils/logger";

interface TaggedSession {
	agentId: string;
	sessionId: string;
}

interface PendingSession {
	agentId: string;
	sessionId: string;
	firstSeen: number;
	metadata: TeamsMetadata;
	rawMessage: string;
}

interface ForwardMeta {
	sessionId: string;
	entryId: string;
	textPreview: string;
}

interface RetryPayload {
	agentId: string;
	sessionId: string;
	msgId: string;
	text: string;
	metadata: TeamsMetadata;
	rawMessage: string;
	meta: ForwardMeta;
}

interface SettleSlot {
	timer: NodeJS.Timeout;
	resolve: () => void;
	promise: Promise<void>;
}

const MAX_RETRIES: Record<ErrorCategory, number> = {
	transient: 3,
	"server-busy": 2,
	permanent: 0,
};

const BREAKER_REARM_MS = BREAKER_COOLDOWN_MS / 2;

export class SessionLifecycle {
	private readonly config: BridgeConfig;
	private readonly store: SessionStore;
	private readonly scanner: SecurityScanner;
	private scanning = false;
	private stopped = false;
	private readonly pendingSessions = new Map<string, PendingSession>();
	private readonly settlingSessions = new Map<string, SettleSlot>();
	private readonly inFlight = new Set<Promise<void>>();
	private readonly inFlightPosts = new Map<string, Promise<ForwardResult>>();
	private readonly retryTimers = new Map<string, NodeJS.Timeout>();

	constructor(config: BridgeConfig, store: SessionStore) {
		this.config = config;
		this.store = store;
		this.scanner = new SecurityScanner();
	}

	scanSessions(sessions: TaggedSession[]): void {
		if (this.scanning || this.stopped) return;
		this.scanning = true;

		try {
			for (const session of sessions) {
				this.processSingleSession(session);
			}
		} finally {
			this.scanning = false;
		}

		const work = this.checkPendingTimeouts().catch((err) => {
			error(`checkPendingTimeouts: ${(err as Error).message}`);
		});
		this.trackInFlight(work);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;

		for (const [, slot] of this.settlingSessions) {
			clearTimeout(slot.timer);
			slot.resolve();
		}
		this.settlingSessions.clear();
		for (const [, timer] of this.retryTimers) {
			clearTimeout(timer);
		}
		this.retryTimers.clear();
		this.pendingSessions.clear();

		while (this.inFlight.size > 0 || this.inFlightPosts.size > 0) {
			await Promise.allSettled([
				...this.inFlight,
				...Array.from(this.inFlightPosts.values()),
			]);
		}
	}

	private trackInFlight(work: Promise<void>): void {
		this.inFlight.add(work);
		void work.finally(() => {
			this.inFlight.delete(work);
		});
	}

	private processSingleSession(session: TaggedSession): void {
		if (this.stopped) return;

		const { agentId, sessionId } = session;
		const agent = this.config.agents[agentId];
		if (!agent) {
			warn(`${agentId}/${sessionId}: Unknown agent`);
			return;
		}

		const entries = this.store.readSessionEntries(sessionId);
		if (!entries || !hasTeamsMetadata(entries)) {
			this.clearPendingSession(agentId, sessionId);
			return;
		}

		const metadata = extractTeamsMetadata(entries);
		if (!metadata.conversationId || !metadata.teamsMessageId) {
			warn(`${agentId}/${sessionId}: Missing metadata`);
			this.clearPendingSession(agentId, sessionId);
			return;
		}

		const msg = extractLatestAssistantText(entries);
		if (!msg) {
			if (hasNoReply(entries)) {
				const noReplyKey = `${agentId}::${sessionId}::no_reply`;
				if (!isAlreadyForwarded(noReplyKey, metadata.teamsMessageId ?? "")) {
					markForwarded(noReplyKey, metadata.teamsMessageId ?? "", {
						sessionId,
						entryId: "no_reply",
						textPreview: "NO_REPLY",
					});
				}
				info(
					`${agentId}/${sessionId}: AI responded NO_REPLY — skipping silently`,
				);
				this.clearPendingSession(agentId, sessionId);
				return;
			}
			const rawMessage = extractOriginalUserMessage(entries);
			const latestActivity = getLatestAssistantActivity(entries);
			this.trackPendingSession(
				agentId,
				sessionId,
				metadata,
				rawMessage,
				latestActivity,
			);
			return;
		}

		this.clearPendingSession(agentId, sessionId);

		const settleKey = `${agentId}::${sessionId}`;
		const existing = this.settlingSessions.get(settleKey);
		if (existing) {
			clearTimeout(existing.timer);
			existing.resolve();
			debug(`${agentId}/${sessionId}: Reset settle timer`);
		}

		let settleDone!: () => void;
		const settlePromise = new Promise<void>((resolve) => {
			settleDone = resolve;
		});
		const timer = setTimeout(() => {
			this.settlingSessions.delete(settleKey);
			void this.finalizeSession(agentId, sessionId)
				.catch((err) => {
					error(
						`${agentId}/${sessionId}: finalizeSession error: ${err.message}`,
					);
				})
				.finally(() => settleDone());
		}, this.config.responseSettleMs);
		this.settlingSessions.set(settleKey, {
			timer,
			resolve: settleDone,
			promise: settlePromise,
		});
		this.trackInFlight(settlePromise);
	}

	private trackPendingSession(
		agentId: string,
		sessionId: string,
		metadata: TeamsMetadata,
		rawMessage: string,
		latestActivityTs: string | null,
	): void {
		const key = `${agentId}::${sessionId}`;
		const dedupKey = `${agentId}::${sessionId}::timeout`;
		if (isAlreadyForwarded(dedupKey, metadata.teamsMessageId ?? "")) {
			this.clearPendingSession(agentId, sessionId);
			return;
		}

		const parsed = latestActivityTs ? Date.parse(latestActivityTs) : Number.NaN;
		const activityMs = Number.isFinite(parsed) ? parsed : 0;

		const existing = this.pendingSessions.get(key);
		if (!existing) {
			this.pendingSessions.set(key, {
				agentId,
				sessionId,
				firstSeen: Math.max(Date.now(), activityMs),
				metadata,
				rawMessage,
			});
			debug(`${agentId}/${sessionId}: Pending response tracked`);
			return;
		}

		existing.rawMessage = rawMessage;
		if (activityMs > existing.firstSeen) {
			existing.firstSeen = activityMs;
			debug(
				`${agentId}/${sessionId}: Pending window reset by assistant activity`,
			);
		}
	}

	private clearPendingSession(agentId: string, sessionId: string): void {
		const key = `${agentId}::${sessionId}`;
		this.pendingSessions.delete(key);
	}

	private async checkPendingTimeouts(): Promise<void> {
		if (this.config.responseTimeoutSeconds <= 0) return;

		const now = Date.now();
		for (const [key, pending] of Array.from(this.pendingSessions)) {
			const age = now - pending.firstSeen;
			if (age >= this.config.responseTimeoutSeconds * 1000) {
				this.pendingSessions.delete(key);
				await this.emitTimeout(pending);
			}
		}
	}

	private async emitTimeout(pending: PendingSession): Promise<void> {
		const { agentId, sessionId, metadata, rawMessage } = pending;
		const agent = this.config.agents[agentId];
		if (!agent) return;

		const msgId = metadata.teamsMessageId ?? "";
		const dedupKey = `${agentId}::${sessionId}::timeout`;
		if (isAlreadyForwarded(dedupKey, msgId)) {
			debug(`${agentId}/${sessionId}: Timeout already forwarded or failed`);
			return;
		}
		if (this.retryTimers.has(dedupKey)) {
			debug(`${agentId}/${sessionId}: Timeout retry pending, skipping emit`);
			return;
		}
		if (
			this.enforceRetryCap(dedupKey, msgId, {
				sessionId,
				entryId: "timeout",
				textPreview: "TIMEOUT_FALLBACK",
			})
		) {
			return;
		}
		const timeoutText = this.config.timeoutFallbackMessage.replaceAll(
			"{seconds}",
			String(this.config.responseTimeoutSeconds),
		);
		const payload: RetryPayload = {
			agentId,
			sessionId,
			msgId,
			text: timeoutText,
			metadata,
			rawMessage,
			meta: {
				sessionId,
				entryId: "timeout",
				textPreview: "TIMEOUT_FALLBACK",
			},
		};

		await this.postAndHandle(agentId, sessionId, dedupKey, payload);
	}

	private async finalizeSession(
		agentId: string,
		sessionId: string,
	): Promise<void> {
		const settleKey = `${agentId}::${sessionId}`;
		this.settlingSessions.delete(settleKey);

		const agent = this.config.agents[agentId];
		if (!agent) return;

		const entries = this.store.readSessionEntries(sessionId);
		if (!entries) return;

		const msg = extractLatestAssistantText(entries);
		if (!msg) return;

		const metadata = extractTeamsMetadata(entries);
		if (!metadata.conversationId || !metadata.teamsMessageId) {
			warn(`${agentId}/${sessionId}: Missing metadata`);
			return;
		}

		const dedupKey = `${agentId}::${sessionId}::${msg.entryId}`;
		const msgId = metadata.teamsMessageId;

		if (isAlreadyForwarded(dedupKey, msgId)) {
			debug(`${agentId}/${sessionId}: Already forwarded or failed`);
			return;
		}

		if (this.retryTimers.has(dedupKey)) {
			debug(`${agentId}/${sessionId}: Retry timer pending, settle path skips`);
			return;
		}

		const meta: ForwardMeta = {
			sessionId,
			entryId: msg.entryId,
			textPreview: msg.text.substring(0, 100),
		};
		if (this.enforceRetryCap(dedupKey, msgId, meta)) {
			return;
		}

		const conversationHistory = extractConversationHistory(entries);
		const isReply = isReplyMessage(metadata);
		if (this.config.contextMode === "reply-chain" && !isReply) {
			clearContext(metadata.conversationId);
		}
		updateContext(
			metadata.conversationId,
			conversationHistory,
			this.config.maxContextMessages,
		);

		const rawMessage = extractOriginalUserMessage(entries);
		const securityResult = this.scanner.scan(rawMessage);

		if (securityResult.blocked) {
			info(
				`${agentId}/${sessionId}: Security blocked (${securityResult.reason})`,
			);
			const warningText = securityResult.warning ?? "";
			const payload: RetryPayload = {
				agentId,
				sessionId,
				msgId,
				text: warningText,
				metadata,
				rawMessage: "",
				meta: {
					sessionId,
					entryId: msg.entryId,
					textPreview: `${(securityResult.reason ?? "UNKNOWN").toUpperCase()}_BLOCKED`,
				},
			};

			await this.postAndHandle(agentId, sessionId, dedupKey, payload);
			return;
		}

		const responseText = msg.text;
		const contextData = loadContext(metadata.conversationId);
		if (contextData?.messages?.length) {
			saveConversationMd(metadata.conversationId, contextData.messages);
		}

		info(
			`${agentId}/${sessionId}: Forwarding preview: "${responseText.substring(0, 80)}..."`,
		);

		const payload: RetryPayload = {
			agentId,
			sessionId,
			msgId,
			text: responseText,
			metadata,
			rawMessage,
			meta: {
				sessionId,
				entryId: msg.entryId,
				textPreview: responseText.substring(0, 100),
			},
		};

		await this.postAndHandle(agentId, sessionId, dedupKey, payload);
	}

	private async postAndHandle(
		agentId: string,
		sessionId: string,
		dedupKey: string,
		payload: RetryPayload,
	): Promise<void> {
		const result = await this.guardedPost(
			agentId,
			sessionId,
			dedupKey,
			payload.text,
			payload.metadata,
			payload.rawMessage,
		);
		if (!result) return;

		this.handleForwardResult(dedupKey, result, payload);
		this.rescanSession(agentId, sessionId);
	}

	private async guardedPost(
		agentId: string,
		sessionId: string,
		dedupKey: string,
		text: string,
		metadata: TeamsMetadata,
		rawMessage: string,
	): Promise<ForwardResult | null> {
		if (this.inFlightPosts.has(dedupKey)) {
			debug(`${agentId}/${sessionId}: Post already in flight for ${dedupKey}`);
			return null;
		}
		if (this.stopped) {
			debug(`${agentId}/${sessionId}: Stopped, refusing post for ${dedupKey}`);
			return null;
		}

		const agent = this.config.agents[agentId];
		if (!agent) return null;

		const promise = postToFlow2(
			text,
			metadata,
			rawMessage,
			agent.flow2Url,
			agent.signature,
		);
		this.inFlightPosts.set(dedupKey, promise);
		void promise.finally(() => {
			this.inFlightPosts.delete(dedupKey);
		});
		return promise;
	}

	private rescanSession(agentId: string, sessionId: string): void {
		this.scanSessions([{ agentId, sessionId }]);
	}

	private scheduleRetry(
		dedupKey: string,
		payload: RetryPayload,
		delayMs: number,
	): void {
		if (this.stopped) return;
		if (this.retryTimers.has(dedupKey)) {
			debug(
				`${payload.agentId}/${payload.sessionId}: Retry timer already pending for ${dedupKey}`,
			);
			return;
		}
		const timer = setTimeout(() => {
			this.retryTimers.delete(dedupKey);
			void this.fireRetry(dedupKey, payload).catch((err) => {
				error(`Retry resend for ${dedupKey}: ${(err as Error).message}`);
			});
		}, delayMs);
		this.retryTimers.set(dedupKey, timer);
		debug(
			`${payload.agentId}/${payload.sessionId}: Scheduled retry for ${dedupKey} in ${Math.round(delayMs)}ms`,
		);
	}

	private async fireRetry(
		dedupKey: string,
		payload: RetryPayload,
	): Promise<void> {
		const { agentId, sessionId, msgId, meta } = payload;
		if (isAlreadyForwarded(dedupKey, msgId)) return;
		if (this.enforceRetryCap(dedupKey, msgId, meta)) return;

		await this.postAndHandle(agentId, sessionId, dedupKey, payload);
	}

	private enforceRetryCap(
		dedupKey: string,
		msgId: string,
		meta: ForwardMeta,
	): boolean {
		const retryCount = getRetryCount(dedupKey, msgId);
		if (retryCount <= 0) return false;

		const category = getRetryCategory(dedupKey, msgId) ?? "transient";
		const maxRetries = MAX_RETRIES[category];
		if (retryCount < maxRetries) return false;

		this.markMessageFailed(
			dedupKey,
			msgId,
			meta,
			`Retry cap reached (${retryCount}/${maxRetries}) for [${category}], marked as failed`,
		);
		return true;
	}

	private markMessageFailed(
		dedupKey: string,
		msgId: string,
		meta: ForwardMeta,
		message: string,
	): void {
		markFailed(dedupKey, msgId, meta);
		error(`Session ${meta.sessionId}: ${message}`);
	}

	private handleForwardResult(
		dedupKey: string,
		result: ForwardResult,
		payload: RetryPayload,
	): void {
		const { agentId, sessionId, msgId, meta } = payload;
		if (result.forwarded) {
			markForwarded(dedupKey, msgId, meta);
			info(`${agentId}/${sessionId}: Forwarded HTTP ${result.httpCode}`);
			return;
		}

		const category: ErrorCategory = result.category ?? "transient";
		const errorMsg = result.error ?? String(result.httpCode);

		if (result.breakerOpen) {
			this.scheduleRetry(dedupKey, payload, BREAKER_REARM_MS);
			warn(
				`${agentId}/${sessionId}: Breaker open, retry re-armed in ${BREAKER_REARM_MS / 1000}s without consuming budget`,
			);
			return;
		}

		if (category === "permanent" || MAX_RETRIES[category] === 0) {
			markFailed(dedupKey, msgId, meta);
			error(`${agentId}/${sessionId}: Forward failed (permanent): ${errorMsg}`);
			return;
		}

		const maxRetries = MAX_RETRIES[category];
		const previousCount = getRetryCount(dedupKey, msgId);
		const newCount = incrementRetry(dedupKey, msgId, errorMsg, category);

		if (newCount >= maxRetries) {
			this.markMessageFailed(
				dedupKey,
				msgId,
				meta,
				`Max retries exceeded (${maxRetries}) for [${category}], marked as failed`,
			);
		} else {
			this.scheduleRetry(dedupKey, payload, computeBackoff(category, newCount));
			debug(
				`${agentId}/${sessionId}: ${category} retry ${newCount}/${maxRetries} scheduled`,
			);
		}

		error(
			`${agentId}/${sessionId}: Forward failed [${category}]: ${errorMsg} — retry ${newCount}/${maxRetries} (prev=${previousCount})`,
		);
	}
}

export function computeBackoff(
	category: ErrorCategory,
	retryCount: number,
): number {
	if (category === "server-busy") {
		const base = 30_000 * 2 ** retryCount;
		const jitter = Math.random() * 5_000;
		return Math.min(base + jitter, 120_000);
	}
	const base = Math.min(1_000 * 2 ** retryCount, 8_000);
	const jitter = Math.random() * 1_000 - 500;
	return Math.max(500, base + jitter);
}
