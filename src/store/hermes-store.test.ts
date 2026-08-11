import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./hermes-store";

describe("SqliteStore", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: DatabaseSync;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-store-"));
		dbPath = path.join(tmpDir, "state.db");
		db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				source TEXT,
				profile_name TEXT,
				last_activity_at REAL,
				started_at REAL
			);
			CREATE TABLE messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				role TEXT,
				content TEXT,
				timestamp REAL,
				tool_calls TEXT,
				finish_reason TEXT
			);
		`);
	});

	afterEach(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function seedSession(
		sessionId: string,
		profileName: string | null,
		rows: {
			role: string;
			content: string;
			toolCalls?: string | null;
			finish?: string | null;
			ts: number;
		}[],
	): void {
		db.prepare(
			"INSERT INTO sessions (id, source, profile_name, last_activity_at, started_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			sessionId,
			"teams-bridge",
			profileName,
			rows[rows.length - 1]!.ts,
			rows[0]!.ts,
		);
		const ins = db.prepare(
			"INSERT INTO messages (session_id, role, content, timestamp, tool_calls, finish_reason) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const r of rows) {
			ins.run(
				sessionId,
				r.role,
				r.content,
				r.ts,
				r.toolCalls ?? null,
				r.finish ?? null,
			);
		}
	}

	it("maps Hermes message rows to SessionEntry shape", () => {
		seedSession("s1", "default", [
			{
				role: "user",
				content: "[TEAMS_META]\nconversationId: conv-1\n[/TEAMS_META]\n\nhi",
				ts: 1_700_000_000,
			},
			{
				role: "assistant",
				content: "checking...",
				toolCalls: "[]",
				finish: "tool_calls",
				ts: 1_700_000_005,
			},
			{
				role: "assistant",
				content: "Final answer.",
				finish: "stop",
				ts: 1_700_000_010,
			},
		]);

		const store = new SqliteStore(dbPath);
		const entries = store.readSessionEntries("s1");
		expect(entries).not.toBeNull();
		expect(entries).toHaveLength(3);

		expect(entries?.[0]?.message?.role).toBe("user");
		expect(entries?.[0]?.message?.content).toContain("TEAMS_META");
		expect(entries?.[0]?.timestamp).toBe(
			new Date(1_700_000_000 * 1000).toISOString(),
		);

		expect(entries?.[1]?.message?.toolCalls).toBe("[]");
		expect(entries?.[1]?.message?.finishReason).toBe("tool_calls");
		expect(entries?.[2]?.message?.finishReason).toBe("stop");
		store.close();
	});

	it("returns null for unknown sessions", () => {
		const store = new SqliteStore(dbPath);
		expect(store.readSessionEntries("nope")).toBeNull();
		store.close();
	});

	it("lists only sessions whose user messages carry [TEAMS_META]", () => {
		seedSession("s-meta", "default", [
			{
				role: "user",
				content: "[TEAMS_META]\nconversationId: c\n[/TEAMS_META]\n\nq",
				ts: 1_700_001_000,
			},
		]);
		seedSession("s-plain", "stevbot", [
			{ role: "user", content: "plain question", ts: 1_700_002_000 },
		]);

		const store = new SqliteStore(dbPath);
		const refs = store.listSessionsWithTeamsMeta(1_600_000_000 * 1000);
		expect(refs.map((r) => r.sessionId)).toEqual(["s-meta"]);
		expect(refs[0]?.profileName).toBe("default");
		expect(refs[0]?.lastActivityAt).toBe(1_700_001_000 * 1000);
		store.close();
	});

	it("respects the since cutoff", () => {
		seedSession("s-old", "default", [
			{
				role: "user",
				content: "[TEAMS_META]\nconversationId: c\n[/TEAMS_META]\n\nq",
				ts: 1_500_000_000,
			},
		]);
		seedSession("s-new", "default", [
			{
				role: "user",
				content: "[TEAMS_META]\nconversationId: c2\n[/TEAMS_META]\n\nq",
				ts: 1_700_003_000,
			},
		]);

		const store = new SqliteStore(dbPath);
		const refs = store.listSessionsWithTeamsMeta(1_600_000_000 * 1000);
		expect(refs.map((r) => r.sessionId)).toEqual(["s-new"]);
		store.close();
	});
});
