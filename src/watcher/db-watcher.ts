import type { SessionStore, TeamSessionRef } from "../store/hermes-store";
import { debug } from "../utils/logger";

export interface Watcher {
	start: () => void;
	stop: () => void;
}

/**
 * Polls the Hermes session store for sessions whose Teams-metadata activity
 * changed. fs.watch cannot be used: Hermes writes state.db through SQLite WAL,
 * so change detection is a short-interval poll.
 */
export function createDbWatcher(
	store: SessionStore,
	pollMs: number,
	onChange: (refs: TeamSessionRef[]) => void,
): Watcher {
	let timer: NodeJS.Timeout | null = null;
	let stopped = false;
	let pollInFlight = false;

	/** sessionId -> last activity watermark; only changed sessions are emitted. */
	const seen = new Map<string, number>();

	function poll(): void {
		if (stopped || pollInFlight) return;
		pollInFlight = true;

		try {
			// Sliding window covers ticks that were missed while busy.
			const since = Date.now() - pollMs * 3;
			const refs = store.listSessionsWithTeamsMeta(since);

			const changed: TeamSessionRef[] = [];
			for (const ref of refs) {
				const last = seen.get(ref.sessionId) ?? -1;
				if (ref.lastActivityAt > last) {
					seen.set(ref.sessionId, ref.lastActivityAt);
					changed.push(ref);
				}
			}

			if (changed.length > 0) {
				debug(`DB watcher: ${changed.length} session(s) changed`);
				onChange(changed);
			}
		} finally {
			pollInFlight = false;
		}
	}

	return {
		start(): void {
			poll();
			timer = setInterval(poll, pollMs);
		},

		stop(): void {
			stopped = true;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
