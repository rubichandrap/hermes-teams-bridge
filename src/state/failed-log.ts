import fs from "node:fs";
import path from "node:path";

const FAILED_FILE = path.join(process.cwd(), "failed.json");
const STATE_FILE = path.join(process.cwd(), "state.json");
const PURGE_AFTER_DAYS = 30;

interface FailedEntry {
	ts: number;
	sessionId: string;
	entryId: string;
	textPreview: string;
}

let failedCache: Record<string, FailedEntry> | null = null;
let writeInFlight: Promise<void> | null = null;
let writeQueued = false;

function purgeExpiredInPlace(map: Record<string, FailedEntry>): void {
	const cutoff = Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
	for (const [k, v] of Object.entries(map)) {
		if (v.ts <= cutoff) delete map[k];
	}
}

function migrateFromStateJson(): Record<string, FailedEntry> {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
			failed?: Record<string, FailedEntry>;
		};
		if (parsed.failed && Object.keys(parsed.failed).length > 0) {
			purgeExpiredInPlace(parsed.failed);
			return parsed.failed;
		}
	} catch {
		// state.json missing or unreadable, nothing to migrate
	}
	return {};
}

export function loadFailedLog(): Record<string, FailedEntry> {
	if (failedCache) return failedCache;

	try {
		const parsed = JSON.parse(fs.readFileSync(FAILED_FILE, "utf-8")) as Record<
			string,
			FailedEntry
		>;
		purgeExpiredInPlace(parsed);
		failedCache = parsed;
		return failedCache;
	} catch {
		failedCache = migrateFromStateJson();
		if (Object.keys(failedCache).length > 0) {
			flushFailedLog(failedCache);
		}
		return failedCache;
	}
}

function doWrite(map: Record<string, FailedEntry>): Promise<void> {
	const tmp = `${FAILED_FILE}.tmp`;
	return fs.promises
		.writeFile(tmp, JSON.stringify(map, null, 2))
		.then(() => fs.promises.rename(tmp, FAILED_FILE))
		.catch(() => undefined);
}

export function flushFailedLog(map: Record<string, FailedEntry>): void {
	failedCache = map;
	if (writeInFlight) {
		writeQueued = true;
		return;
	}
	writeInFlight = doWrite(map).finally(() => {
		writeInFlight = null;
		if (writeQueued) {
			writeQueued = false;
			flushFailedLog(map);
		}
	});
}
