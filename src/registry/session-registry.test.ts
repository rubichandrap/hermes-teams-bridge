import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "./session-registry";

describe("SessionRegistry", () => {
	let tmpDir: string;
	let filePath: string;
	let lastRegistry: SessionRegistry | null = null;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-registry-"));
		filePath = path.join(tmpDir, "registry.json");
	});

	afterEach(async () => {
		// Let any in-flight atomic flush finish before removing the directory.
		await lastRegistry?.flushAndWait();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeRegistry(): SessionRegistry {
		const registry = new SessionRegistry(filePath);
		registry.load();
		lastRegistry = registry;
		return registry;
	}

	it("starts empty when no file exists", () => {
		const registry = makeRegistry();
		expect(registry.get("main", "conv-1")).toBeUndefined();
		expect(registry.hasPendingBootstrap("main", "conv-1")).toBe(false);
	});

	it("round-trips entries and survives a reload", async () => {
		const registry = makeRegistry();
		registry.set("main", "conv-1", "20260811_000000_aaa111");
		registry.set("main", "conv-2", "20260811_000000_bbb222");
		await registry.flushAndWait();

		const reloaded = new SessionRegistry(filePath);
		reloaded.load();
		expect(reloaded.get("main", "conv-1")?.sessionId).toBe(
			"20260811_000000_aaa111",
		);
		expect(reloaded.get("main", "conv-2")?.sessionId).toBe(
			"20260811_000000_bbb222",
		);
	});

	it("persists the owning profile on entries", async () => {
		const registry = makeRegistry();
		registry.set("main", "conv-1", "session-a", "chatbot");
		await registry.flushAndWait();

		const reloaded = new SessionRegistry(filePath);
		reloaded.load();
		expect(reloaded.get("main", "conv-1")?.profile).toBe("chatbot");
	});

	it("keys entries per agent", async () => {
		const registry = makeRegistry();
		registry.set("main", "conv-1", "session-a");
		registry.set("steve", "conv-1", "session-b");
		await registry.flushAndWait();

		expect(registry.get("main", "conv-1")?.sessionId).toBe("session-a");
		expect(registry.get("steve", "conv-1")?.sessionId).toBe("session-b");
	});

	it("keeps createdAt stable and refreshes lastUsedAt on re-set", async () => {
		const registry = makeRegistry();
		registry.set("main", "conv-1", "session-a");
		const first = registry.get("main", "conv-1");
		await new Promise((r) => setTimeout(r, 5));
		registry.set("main", "conv-1", "session-b", "chatbot");
		const second = registry.get("main", "conv-1");
		expect(second?.createdAt).toBe(first?.createdAt);
		expect(second?.lastUsedAt).toBeGreaterThanOrEqual(first?.lastUsedAt ?? 0);
		expect(second?.sessionId).toBe("session-b");
		expect(second?.profile).toBe("chatbot");
	});

	it("remove severs the entry and reports whether it existed", async () => {
		const registry = makeRegistry();
		registry.set("main", "conv-1", "session-a");
		expect(registry.remove("main", "conv-1")).toBe(true);
		expect(registry.get("main", "conv-1")).toBeUndefined();
		expect(registry.remove("main", "conv-1")).toBe(false);
	});

	it("records the sever timestamp so late registration is blocked", async () => {
		const registry = makeRegistry();
		const before = Date.now() - 1000;
		registry.remove("main", "conv-1");
		expect(registry.wasSeveredAfter("main", "conv-1", before)).toBe(true);
		expect(registry.wasSeveredAfter("main", "conv-1", Date.now() + 1000)).toBe(
			false,
		);

		// A fresh registration supersedes the sever.
		registry.set("main", "conv-1", "session-b");
		expect(registry.wasSeveredAfter("main", "conv-1", before)).toBe(false);
	});

	it("persists pending bootstrap markers across reloads", async () => {
		const registry = makeRegistry();
		registry.markPendingBootstrap("main", "conv-1");
		await registry.flushAndWait();

		const reloaded = new SessionRegistry(filePath);
		reloaded.load();
		expect(reloaded.hasPendingBootstrap("main", "conv-1")).toBe(true);

		reloaded.clearPendingBootstrap("main", "conv-1");
		await reloaded.flushAndWait();
		const third = new SessionRegistry(filePath);
		third.load();
		expect(third.hasPendingBootstrap("main", "conv-1")).toBe(false);
	});

	it("purges expired pending markers only", async () => {
		const registry = makeRegistry();
		registry.markPendingBootstrap("main", "old");
		registry.markPendingBootstrap("main", "fresh");
		await registry.flushAndWait();

		// Age the "old" marker artificially via a rewrite of the file.
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		data.pendingBootstraps["main::old"] = Date.now() - 11 * 60 * 1000;
		fs.writeFileSync(filePath, JSON.stringify(data));

		const reloaded = new SessionRegistry(filePath);
		reloaded.load();
		reloaded.purgeExpiredPending(10 * 60 * 1000);

		expect(reloaded.hasPendingBootstrap("main", "old")).toBe(false);
		expect(reloaded.hasPendingBootstrap("main", "fresh")).toBe(true);
	});

	it("purges sever tombstones older than a day but keeps fresh ones", async () => {
		const registry = makeRegistry();
		registry.remove("main", "old-sever");
		registry.remove("main", "fresh-sever");
		await registry.flushAndWait();

		// Age the "old-sever" tombstone artificially via a rewrite of the file.
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		data.severedAt["main::old-sever"] = Date.now() - 25 * 60 * 60 * 1000;
		fs.writeFileSync(filePath, JSON.stringify(data));

		const reloaded = new SessionRegistry(filePath);
		reloaded.load();
		reloaded.purgeExpiredPending(10 * 60 * 1000);

		expect(
			reloaded.wasSeveredAfter(
				"main",
				"old-sever",
				Date.now() - 26 * 60 * 60 * 1000,
			),
		).toBe(false);
		expect(
			reloaded.wasSeveredAfter("main", "fresh-sever", Date.now() - 1000),
		).toBe(true);
	});

	it("normalizes legacy entries without a profile to default", async () => {
		const registry = makeRegistry();
		registry.set("main", "conv-1", "session-a", "chatbot");
		await registry.flushAndWait();

		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		data.conversations["main::conv-1"].profile = undefined;
		fs.writeFileSync(filePath, JSON.stringify(data));

		const reloaded = new SessionRegistry(filePath);
		reloaded.load();
		expect(reloaded.get("main", "conv-1")?.profile).toBe("default");
	});

	it("tolerates a corrupt registry file", () => {
		fs.writeFileSync(filePath, "{not json");
		const registry = makeRegistry();
		expect(registry.get("main", "conv-1")).toBeUndefined();
		registry.set("main", "conv-1", "session-a");
		expect(registry.get("main", "conv-1")?.sessionId).toBe("session-a");
	});
});
