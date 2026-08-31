import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MultiProfileStore, profileDbPath } from "./hermes-store";

function makeStore(dir: string): { db: DatabaseSync; dbPath: string } {
	const dbPath = path.join(dir, "state.db");
	const db = new DatabaseSync(dbPath);
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
	return { db, dbPath };
}

function seedMetaSession(
	db: DatabaseSync,
	sessionId: string,
	convId: string,
	ts = 1_700_000_000,
): void {
	db.prepare(
		"INSERT INTO sessions (id, source, profile_name, last_activity_at, started_at) VALUES (?, ?, ?, ?, ?)",
	).run(sessionId, "teams-bridge", null, ts, ts);
	db.prepare(
		"INSERT INTO messages (session_id, role, content, timestamp, tool_calls, finish_reason) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		sessionId,
		"user",
		`[TEAMS_META]\nconversationId: ${convId}\nteamsMessageId: msg-${sessionId}\nsenderName: T\nsenderUserId: u\n[/TEAMS_META]\n\nq`,
		ts,
		null,
		null,
	);
	db.prepare(
		"INSERT INTO messages (session_id, role, content, timestamp, tool_calls, finish_reason) VALUES (?, ?, ?, ?, ?, ?)",
	).run(sessionId, "assistant", `reply-${sessionId}`, ts + 1, null, "stop");
}

describe("profileDbPath", () => {
	it("joins the Hermes profiles layout", () => {
		expect(profileDbPath("/home/u/.hermes", "coder")).toBe(
			"/home/u/.hermes/profiles/coder/state.db",
		);
	});
});

describe("MultiProfileStore", () => {
	let tmpDir: string;
	let defaultDb: DatabaseSync;
	let coderDb: DatabaseSync;
	let store: MultiProfileStore | null = null;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-multi-"));
		const home = path.join(tmpDir, "hermes-home");
		fs.mkdirSync(path.join(home, "profiles", "coder"), { recursive: true });
		const dflt = makeStore(home);
		const coder = makeStore(path.join(home, "profiles", "coder"));
		defaultDb = dflt.db;
		coderDb = coder.db;
		store = new MultiProfileStore([
			{ profile: "default", dbPath: dflt.dbPath },
			{ profile: "coder", dbPath: coder.dbPath },
		]);
	});

	afterEach(() => {
		store?.close();
		defaultDb.close();
		coderDb.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("merges TEAMS_META sessions across profile DBs with profile tags", () => {
		seedMetaSession(defaultDb, "s-default", "conv-1");
		seedMetaSession(coderDb, "s-coder", "conv-2");

		const refs = store!.listSessionsWithTeamsMeta(0);
		const byId = new Map(refs.map((r) => [r.sessionId, r]));
		expect(byId.get("s-default")?.profileName).toBe("default");
		expect(byId.get("s-coder")?.profileName).toBe("coder");
	});

	it("reads a session from whichever DB holds it", () => {
		seedMetaSession(defaultDb, "s-default", "conv-1");
		seedMetaSession(coderDb, "s-coder", "conv-2");

		expect(
			store!.readSessionEntries("s-default")?.map((e) => e.message?.role),
		).toEqual(["user", "assistant"]);
		expect(store!.readSessionEntries("s-coder")?.[1]?.message?.content).toBe(
			"reply-s-coder",
		);
	});

	it("lazily opens DBs created after startup", () => {
		const late = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-late-"));
		const home = path.join(late, "hermes-home");
		fs.mkdirSync(path.join(home, "profiles", "late"), { recursive: true });
		const s = new MultiProfileStore([
			{ profile: "default", dbPath: path.join(home, "state.db") },
			{ profile: "late", dbPath: profileDbPath(home, "late") },
		]);
		try {
			const { db, dbPath } = makeStore(path.join(home, "profiles", "late"));
			seedMetaSession(db, "s-late", "conv-late");
			db.close();

			const refs = s.listSessionsWithTeamsMeta(0);
			expect(refs.map((r) => r.sessionId)).toEqual(["s-late"]);
			expect(refs[0]?.profileName).toBe("late");
			expect(fs.existsSync(dbPath)).toBe(true);
		} finally {
			s.close();
			fs.rmSync(late, { recursive: true, force: true });
		}
	});

	it("returns null / empty when no DB has the session", () => {
		expect(store!.readSessionEntries("ghost")).toBeNull();
		expect(store!.listSessionsWithTeamsMeta(0)).toEqual([]);
	});

	it("close() closes every opened DB once", () => {
		seedMetaSession(defaultDb, "s-default", "conv-1");
		store!.listSessionsWithTeamsMeta(0);
		store!.readSessionEntries("s-default");
		const c = store as unknown as { dbs: Map<string, unknown> };
		expect(c.dbs.size).toBe(2);
		expect(() => store!.close()).not.toThrow();
		expect(() => store!.close()).not.toThrow();
	});
});
