import fs from "node:fs";
import path from "node:path";
import type { ErrorCategory } from "../types";
import { debug, error, warn } from "../utils/logger";
import { flushFailedLog, loadFailedLog } from "./failed-log";

interface ForwardState {
	ts: number;
	sessionId: string;
	entryId: string;
	textPreview: string;
}

interface RetryState {
	ts: number;
	count: number;
	lastError: string;
	category: ErrorCategory;
}

interface BridgeState {
	forwarded: Record<string, ForwardState>;
	forwardedByMessageId: Record<string, ForwardState>;
	retries: Record<string, RetryState>;
	failed: Record<string, ForwardState>;
}

const STATE_FILE = path.join(process.cwd(), "state.json");
const PURGE_AFTER_DAYS = 30;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let state: BridgeState = {
	forwarded: {},
	forwardedByMessageId: {},
	retries: {},
	failed: {},
};
let lastPurgeAt = 0;

let writeInFlight: Promise<void> | null = null;
let writeQueued = false;

function purgeExpired(force = false): void {
	const now = Date.now();
	if (!force && now - lastPurgeAt < PURGE_INTERVAL_MS) return;
	lastPurgeAt = now;

	const cutoff = now - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;

	for (const map of [
		state.forwarded,
		state.forwardedByMessageId,
		state.retries,
		state.failed,
	] as Record<string, { ts: number }>[]) {
		for (const [k, v] of Object.entries(map)) {
			if (v.ts <= cutoff) delete map[k];
		}
	}
}

export function loadState(): void {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(STATE_FILE, "utf-8"),
		) as BridgeState;
		state = {
			forwarded: parsed.forwarded ?? {},
			forwardedByMessageId: parsed.forwardedByMessageId ?? {},
			retries: parsed.retries ?? {},
			failed: loadFailedLog(),
		};
		purgeExpired(true);
	} catch {
		state = {
			forwarded: {},
			forwardedByMessageId: {},
			retries: {},
			failed: loadFailedLog(),
		};
		purgeExpired(true);
	}
}

function doFlushState(): Promise<void> {
	const snapshot = JSON.stringify(
		{
			forwarded: state.forwarded,
			forwardedByMessageId: state.forwardedByMessageId,
			retries: state.retries,
		},
		null,
		2,
	);
	const tmp = `${STATE_FILE}.tmp`;
	return fs.promises
		.writeFile(tmp, snapshot)
		.then(() => fs.promises.rename(tmp, STATE_FILE))
		.then(() => {
			debug("State flushed to disk");
		})
		.catch((err: Error) => {
			error(`Failed to flush state: ${err.message}`);
		});
}

export function flushState(): void {
	if (writeInFlight) {
		writeQueued = true;
		return;
	}
	writeInFlight = doFlushState().finally(() => {
		writeInFlight = null;
		if (writeQueued) {
			writeQueued = false;
			flushState();
		}
	});
}

export async function flushStateAndWait(): Promise<void> {
	flushState();
	if (writeInFlight) {
		await writeInFlight.catch(() => undefined);
	}
	if (writeQueued) {
		await new Promise<void>((resolve) => {
			const tick = (): void => {
				if (!writeQueued && !writeInFlight) resolve();
				else setTimeout(tick, 10);
			};
			tick();
		});
	}
}

export function markForwarded(
	dedupKey: string,
	msgId: string,
	meta: { sessionId: string; entryId: string; textPreview: string },
): void {
	const now = Date.now();

	state.forwarded[dedupKey] = {
		ts: now,
		sessionId: meta.sessionId,
		entryId: meta.entryId,
		textPreview: meta.textPreview,
	};

	state.forwardedByMessageId[msgId] = {
		ts: now,
		sessionId: meta.sessionId,
		entryId: meta.entryId,
		textPreview: meta.textPreview,
	};

	delete state.retries[dedupKey];
	delete state.retries[msgId];
	delete state.failed[dedupKey];
	delete state.failed[msgId];

	flushState();
}

export function isAlreadyForwarded(dedupKey: string, msgId: string): boolean {
	if (state.failed[dedupKey] || state.failed[msgId]) {
		return true;
	}
	return !!state.forwarded[dedupKey] || !!state.forwardedByMessageId[msgId];
}

export function getRetryCount(dedupKey: string, msgId: string): number {
	const a = state.retries[dedupKey]?.count ?? 0;
	const b = state.retries[msgId]?.count ?? 0;
	return Math.max(a, b);
}

export function getRetryCategory(
	dedupKey: string,
	msgId: string,
): ErrorCategory | undefined {
	const a = state.retries[dedupKey]?.category;
	const b = state.retries[msgId]?.category;
	return a ?? b;
}

export function incrementRetry(
	dedupKey: string,
	msgId: string,
	errMsg: string,
	category: ErrorCategory,
): number {
	const now = Date.now();

	const count =
		Math.max(
			state.retries[dedupKey]?.count ?? 0,
			state.retries[msgId]?.count ?? 0,
		) + 1;

	const retryState: RetryState = {
		ts: now,
		count,
		lastError: errMsg,
		category,
	};

	state.retries[dedupKey] = retryState;
	state.retries[msgId] = { ...retryState };

	flushState();
	purgeExpired();

	return count;
}

export function markFailed(
	dedupKey: string,
	msgId: string,
	meta: { sessionId: string; entryId: string; textPreview: string },
): void {
	const now = Date.now();

	const failedState: ForwardState = {
		ts: now,
		sessionId: meta.sessionId,
		entryId: meta.entryId,
		textPreview: meta.textPreview,
	};

	state.failed[dedupKey] = failedState;
	state.failed[msgId] = { ...failedState };

	flushState();
	flushFailedLog(state.failed);
}

export function clearFailed(): number {
	const uniqueSessions = new Set<string>();
	for (const v of Object.values(state.failed)) {
		uniqueSessions.add(`${v.sessionId}::${v.entryId}`);
	}
	const count = uniqueSessions.size;
	state.failed = {};
	state.retries = {};
	flushState();
	flushFailedLog(state.failed);
	warn(`Cleared ${count} failed entries — they will be retried on next scan`);
	return count;
}
