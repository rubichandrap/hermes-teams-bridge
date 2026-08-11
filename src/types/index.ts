/**
 * Core domain types for Hermes Teams Bridge
 */

export interface TeamsMetadata {
	conversationId?: string;
	teamsMessageId?: string;
	senderName?: string;
	senderUserId?: string;
	replyToId?: string;
	hasAttachments?: string | number;
	hasMessageReference?: string;
	replyToMessageId?: string;
	[key: string]: string | number | undefined;
}

export interface AgentConfig {
	flow2Url: string;
	signature: string;
	/** Hermes profile the agent runs under; "default" when omitted. */
	profile?: string;
	/** Extra CLI args appended to `hermes chat` (e.g. --yolo, --accept-hooks). */
	extraArgs?: string[];
}

export interface BridgeConfig {
	flow2Url: string;
	proxyMode: boolean;
	proxyPort: number;
	signature: string;
	lookbackMinutes: number;
	maxContextMessages: number;
	contextSummaryLength: number;
	enrichResponses: boolean;
	contextMode: "reply-chain" | "conversation";
	contextMaxAgeDays: number;
	responseTimeoutSeconds: number;
	responseSettleMs: number;
	timeoutFallbackMessage: string;
	/** Hermes CLI binary used to spawn agent turns. */
	hermesBin: string;
	/** Path to the Hermes session store (state.db). Defaults to $HERMES_HOME/state.db. */
	dbPath: string;
	/** Session store polling interval in ms. */
	sessionPollMs: number;
	/**
	 * Optional bearer token for the /teams-proxy endpoint. When set, inbound
	 * requests must carry `Authorization: Bearer <token>` (or the bare token).
	 * Strongly recommended when the proxy is exposed via a public tunnel.
	 */
	proxyToken?: string;
	/**
	 * Messages that exactly match one of these (after cleaning) sever the
	 * conversation's session binding; the next turn bootstraps a fresh session.
	 */
	resetCommands: string[];
	agents: Record<string, AgentConfig>;
}

export interface ConversationMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: string | null;
	entryId: string;
	metadata?: TeamsMetadata;
}

export interface ContextData {
	conversationId: string;
	firstSeen: string;
	lastUpdated: string;
	messages: ConversationMessage[];
	summary: string;
}

/**
 * A Hermes store message mapped to the shape the parser consumes.
 * Mirrors an OpenClaw session-file entry so extraction logic stays portable.
 */
export interface SessionEntry {
	type: string;
	id?: string;
	timestamp?: string | null;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: string | null;
		/** Hermes `tool_calls` column — non-empty marks a mid-turn assistant message. */
		toolCalls?: string | null;
		/** Hermes `finish_reason` column: "tool_calls" | "stop" | null. */
		finishReason?: string | null;
	};
}

export interface SecurityResult {
	blocked: boolean;
	reason?: string;
	warning?: string;
}

export type ErrorCategory = "transient" | "server-busy" | "permanent";

export interface ForwardResult {
	forwarded: boolean;
	reason?: string;
	httpCode?: number;
	error?: string;
	category?: ErrorCategory;
	breakerOpen?: boolean;
}

export interface Flow2Payload {
	message: string;
	conversationId: string;
	teamsMessageId: string;
	senderName: string;
	senderUserId: string;
	originalMessage: string;
}
