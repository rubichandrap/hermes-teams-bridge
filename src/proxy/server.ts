import http from "node:http";
import type { DispatchService } from "../dispatcher/turn-dispatcher";
import { parseTeamsMetadataFromText } from "../session/parser";
import type { BridgeConfig } from "../types";
import { debug, error, info, warn } from "../utils/logger";

let proxyServer: http.Server | null = null;

export function startProxyServer(
	config: BridgeConfig,
	dispatcher: DispatchService,
): http.Server | null {
	if (!config.proxyMode) {
		info("Proxy mode: DISABLED (direct mode)");
		return null;
	}

	proxyServer = http.createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/teams-proxy") {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
			return;
		}

		if (config.proxyToken) {
			const authHeader = req.headers.authorization;
			const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
			if (!checkProxyAuth(auth, config.proxyToken)) {
				warn("Proxy: rejected request — missing or invalid bearer token");
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Unauthorized" }));
				return;
			}
		}

		let body = "";
		let tooLarge = false;
		const MAX_BODY = 1024 * 1024;
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_BODY) {
				tooLarge = true;
				req.destroy();
			}
		});
		req.on("end", async () => {
			if (tooLarge) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Payload too large" }));
				return;
			}
			try {
				const payload = JSON.parse(body) as Record<string, unknown>;

				debug(`Proxy: Received message for agent=${payload.agentId}`);

				const agentId = String(payload.agentId ?? "main");
				const agent = config.agents[agentId];
				if (!agent) {
					warn(
						`Proxy: rejected request — unknown agent "${agentId}" (agent=${agentId})`,
					);
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `Unknown agent: ${agentId}` }));
					return;
				}

				const message = String(payload.message ?? "");
				if (!message.trim()) {
					warn("Proxy: rejected request — empty message");
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Empty message" }));
					return;
				}

				const meta = parseTeamsMetadataFromText(message);
				if (!meta?.conversationId) {
					warn(
						"Proxy: rejected request — missing conversationId in TEAMS_META",
					);
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: "Missing conversationId in TEAMS_META",
						}),
					);
					return;
				}

				const result = await dispatcher.dispatch(
					agentId,
					meta.conversationId,
					message,
				);
				if (!result.ok) {
					res.writeHead(502, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: result.error ?? "spawn failed" }));
					return;
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						status: result.reset ? "reset" : "queued",
						agentId,
					}),
				);

				info(
					`Proxy: ${result.reset ? "Reset" : "Agent turn queued"} for ${agentId} (${meta.conversationId})`,
				);
			} catch (err) {
				error(`Proxy: Failed to process request: ${(err as Error).message}`);
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Internal server error" }));
			}
		});
	});

	proxyServer.listen(config.proxyPort, "127.0.0.1", () => {
		info(`=== Proxy server listening on port ${config.proxyPort} ===`);
	});

	proxyServer.on("error", (err) => {
		error(`Proxy server error: ${err.message}`);
	});

	return proxyServer;
}

export function stopProxyServer(): void {
	if (proxyServer) {
		proxyServer.close();
		proxyServer = null;
		info("Proxy server stopped");
	}
}

/**
 * Accepts `Authorization: Bearer <token>` or the bare token. Used to keep
 * publicly-tunneled proxy endpoints from triggering agent runs unauthenticated.
 */
export function checkProxyAuth(
	authHeader: string | undefined,
	expected: string,
): boolean {
	if (!authHeader) return false;
	const trimmed = authHeader.trim();
	const value = trimmed.startsWith("Bearer ")
		? trimmed.slice("Bearer ".length)
		: trimmed;
	return value.trim() === expected;
}
