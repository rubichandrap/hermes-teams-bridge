import http from "node:http";
import { spawnAgentTurn } from "../agent/runner";
import { loadContext } from "../context/manager";
import { buildContextReference } from "../context/md-writer";
import {
	INJECTION_MARKER_INSTRUCTION,
	buildInjectedContext,
	parseTeamsMetadataFromText,
} from "../session/parser";
import type { BridgeConfig } from "../types";
import { debug, error, info } from "../utils/logger";

let proxyServer: http.Server | null = null;

export function startProxyServer(config: BridgeConfig): void {
	if (!config.proxyMode) {
		info("Proxy mode: DISABLED (direct mode)");
		return;
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
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `Unknown agent: ${agentId}` }));
					return;
				}

				const enrichedPayload = enrichTeamsMessage(payload, config);

				if (enrichedPayload.message !== payload.message) {
					const meta = parseTeamsMetadataFromText(
						String(payload.message ?? ""),
					);
					info(
						`Proxy: Injected history for ${meta?.conversationId ?? "unknown"}`,
					);
				}

				const spawn = await spawnAgentTurn(
					config,
					agent,
					String(enrichedPayload.message ?? ""),
				);
				if (!spawn.ok) {
					res.writeHead(502, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: spawn.error ?? "spawn failed" }));
					return;
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "queued", agentId }));

				info(`Proxy: Agent turn queued for ${agentId}`);
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
	token: string,
): boolean {
	if (!authHeader) return false;
	const value = authHeader.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length)
		: authHeader;
	return value.trim() === token;
}

function enrichTeamsMessage(
	body: Record<string, unknown>,
	_config: BridgeConfig,
): Record<string, unknown> {
	const message = String(body.message ?? "");
	const meta = parseTeamsMetadataFromText(message);

	if (!meta?.conversationId) {
		return body;
	}

	const contextData = loadContext(meta.conversationId);
	const contextRef = buildContextReference(
		meta.conversationId,
		contextData?.messages ?? [],
	);
	if (!contextRef) {
		return body;
	}

	const instruction = `${INJECTION_MARKER_INSTRUCTION} Reply with ONE final message. No narration, no planning, no NO_REPLY for questions.`;

	const enrichedMessage =
		buildInjectedContext(contextRef, instruction) + "\n\n" + message;

	return { ...body, message: enrichedMessage };
}
