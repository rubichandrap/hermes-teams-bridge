import { DatabaseSync } from "node:sqlite";
import type { SessionEntry } from "../types";
import { debug, error } from "../utils/logger";

/**
 * A session discovered in the Hermes session store that carries Teams metadata.
 */
export interface TeamSessionRef {
	sessionId: string;
	lastActivityAt: number;
	/** Session start (epoch ms); the fallback uses it to reject pre-bootstrap sessions. */
	startedAtMs?: number;
	/** Hermes profile the session ran under (NULL for the default profile). */
	profileName: string;
}

export interface SessionStore {
	readSessionEntries(sessionId: string): SessionEntry[] | null;
	listSessionsWithTeamsMeta(sinceMs: number): TeamSessionRef[];
	close(): void;
}

/**
 * Read-only adapter over Hermes' canonical session store (~/.hermes/state.db).
 *
 * The bridge only ever reads: Hermes writes. WAL mode lets a read-only
 * connection see committed data concurrently, so no write access is needed.
 */
export class SqliteStore implements SessionStore {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath, { readOnly: true });
		this.db.exec("PRAGMA busy_timeout = 3000;");
		debug(`Hermes session store opened: ${dbPath}`);
	}

	readSessionEntries(sessionId: string): SessionEntry[] | null {
		try {
			const rows = this.db
				.prepare(
					`SELECT id, role, content, timestamp, tool_calls, finish_reason
					 FROM messages
					 WHERE session_id = ?
					 ORDER BY id`,
				)
				.all(sessionId) as {
				id: number;
				role: string;
				content: string | null;
				timestamp: number | null;
				tool_calls: string | null;
				finish_reason: string | null;
			}[];

			if (rows.length === 0) return null;

			return rows.map((row) => ({
				type: "message",
				id: String(row.id),
				timestamp: toIso(row.timestamp),
				message: {
					role: row.role,
					content: row.content ?? "",
					timestamp: toIso(row.timestamp),
					toolCalls: row.tool_calls,
					finishReason: row.finish_reason,
				},
			}));
		} catch (err) {
			error(
				`Failed to read session ${sessionId} from store: ${(err as Error).message}`,
			);
			return null;
		}
	}

	listSessionsWithTeamsMeta(sinceMs: number): TeamSessionRef[] {
		try {
			const rows = this.db
				.prepare(
					`SELECT DISTINCT s.id AS session_id, s.last_activity_at, s.started_at, s.profile_name
					 FROM sessions s
					 JOIN messages m ON m.session_id = s.id
					 WHERE s.last_activity_at > ?
					   AND m.role = 'user'
					   AND m.content LIKE '%[TEAMS_META]%'`,
				)
				.all(sinceMs / 1000) as {
				session_id: string;
				last_activity_at: number | null;
				started_at: number | null;
				profile_name: string | null;
			}[];

			return rows.map((row) => ({
				sessionId: row.session_id,
				lastActivityAt: row.last_activity_at
					? row.last_activity_at * 1000
					: Date.now(),
				...(row.started_at && { startedAtMs: row.started_at * 1000 }),
				profileName: row.profile_name ?? "default",
			}));
		} catch (err) {
			error(
				`Failed to list sessions with Teams metadata: ${(err as Error).message}`,
			);
			return [];
		}
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// already closed
		}
	}
}

function toIso(unixSeconds: number | null): string | null {
	if (unixSeconds === null || unixSeconds === undefined) return null;
	const ms = Number.isFinite(unixSeconds) ? unixSeconds * 1000 : 0;
	return new Date(ms).toISOString();
}
