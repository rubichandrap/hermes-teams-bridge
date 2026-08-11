import http from "node:http";
import https from "node:https";

let cachedHttp: http.Agent | null = null;
let cachedHttps: https.Agent | null = null;

export function getHttpAgent(): http.Agent {
	if (!cachedHttp) {
		cachedHttp = new http.Agent({
			keepAlive: true,
			keepAliveMsecs: 1_000,
			maxSockets: 4,
			maxFreeSockets: 2,
		});
	}
	return cachedHttp;
}

export function getHttpsAgent(): https.Agent {
	if (!cachedHttps) {
		cachedHttps = new https.Agent({
			keepAlive: true,
			keepAliveMsecs: 1_000,
			maxSockets: 4,
			maxFreeSockets: 2,
		});
	}
	return cachedHttps;
}

export function closeHttpAgents(): Promise<void> {
	if (cachedHttp) {
		cachedHttp.destroy();
		cachedHttp = null;
	}
	if (cachedHttps) {
		cachedHttps.destroy();
		cachedHttps = null;
	}
	return Promise.resolve();
}
