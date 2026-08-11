# Hermes Teams Bridge

Bridges Microsoft Teams messages to a **Hermes Agent** and back: inbound messages are enriched with conversation context and injected into an isolated Hermes session; outbound AI responses are scanned, deduplicated, and forwarded to Teams via Power Automate.

A port of [openclaw-teams-bridge](https://github.com/rubichandrap/openclaw-teams-bridge) — same architecture and reliability machinery (settle window, per-message retries, circuit breaker, dual-key dedup), with the agent substrate swapped from OpenClaw session files to the Hermes session store.

## Features

- **Event-driven, zero polling of the agent** — Hermes' SQLite session store is watched at a short interval; responses are finalized only after a settle window so mid-turn tool-call narration is never forwarded
- **Conversation memory** — per-conversation context JSON + Markdown history injected into every inbound message (📜 context reference + 📋 instruction block)
- **Resilient delivery** — dual-key dedup (`agentId::sessionId::entryId` and `teamsMessageId`), per-message retry scheduler (transient 3 / server-busy 2 / permanent 0) with exponential backoff + jitter, per-agent circuit breaker on Flow 2, in-flight post gate
- **Timeout fallback** — if the agent hasn't answered after `responseTimeoutSeconds`, Teams gets a "still processing" notice (the real answer still arrives when ready)
- **Security scanner** — blocks dangerous commands, file writes, and identity-file tampering from Teams chat, replying with a warning instead
- **Multi-agent** — each configured agent maps to a Hermes profile (`main`, `stevbot`, …), with per-agent signatures and Flow 2 URLs
- **Authenticated proxy** — optional bearer token on the inbound endpoint (required when tunneled publicly)
- **Zero runtime dependencies** — Node built-ins only (including `node:sqlite`)

## How It Works

```
Teams ──Power Automate──▶ Proxy (127.0.0.1:18790/teams-proxy)
                             │  enrich: 📜 conversation history + 📋 instruction
                             ▼
                     hermes chat -q <message> -Q --source teams-bridge
                             │  (detached subprocess, profile via HERMES_HOME)
                             ▼
                     Hermes session store (~/.hermes/state.db)
                             │  db-watcher polls for [TEAMS_META] activity
                             ▼
                     SessionLifecycle: settle window → security scan
                             → context harvest → dedup → forward
                             ▼
                     Power Automate Flow 2 ──▶ Teams
```

### Inbound (Teams → agent)
1. Power Automate POSTs the Teams message (with `agentId`) to the proxy.
2. The proxy extracts `[TEAMS_META]` (conversationId, teamsMessageId, sender, reply refs), loads the conversation context, and prepends a 📜/📋 injection block.
3. The runner spawns a one-shot `hermes chat -q -Q --source teams-bridge` with the enriched message as the prompt. The child is detached and unref'd — it survives a bridge restart.

### Outbound (agent → Teams)
1. The db-watcher polls `state.db` every `sessionPollMs` for sessions whose user messages carry `[TEAMS_META]`; the 15s heartbeat re-scans a `lookbackMinutes` window to catch stragglers.
2. When the assistant's final text appears (a message with `finish_reason != "tool_calls"`), the settle timer (`responseSettleMs`) waits for the turn to finish writing.
3. Finalize: dedup check → conversation context harvest → security scan → POST to Flow 2 → Teams. Failures enter the retry scheduler with a msgId-stable counter.

## Requirements

- Node.js >= 22.13 (for `node:sqlite` read-only connections)
- [Hermes Agent](https://hermes-agent.nousresearch.com/) installed and usable (`hermes chat -q "ping"` works)
- A Power Automate Flow 2 trigger URL that posts to your Teams channel
- (Optional) Hermes profiles for multi-agent setups: `hermes profile create stevbot`

## Setup

```bash
cd ~/projects/github.com/rubichandrap/hermes-teams-bridge
npm install
npm run build
cp .env.example .env
```

Fill `.env` — at minimum the per-agent Flow 2 URL:

```
TEAMS_BRIDGE_FLOW2_URL_MAIN=https://prod-xx.centralindia.logic.azure.com/workflows/.../triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=YOUR_SIG
TEAMS_BRIDGE_PROXY_MODE=true
```

Tune behavior in `config.json` (proxy port, settle window, response timeout, context mode, agents).

### Run

```bash
npm start                    # node dist/index.js
npm run dev                  # tsx watch (development)
npm run start:pm2            # pm2 start ecosystem.config.js
npm run logs                 # pm2 logs hermes-teams-bridge
```

## Power Automate Wiring

- **Flow 1 (inbound):** Teams "When a new message is added" → HTTP POST to `http://127.0.0.1:18790/teams-proxy` with JSON body:
  ```json
  {
    "agentId": "main",
    "message": "[TEAMS_META]\nconversationId: {conversationId}\nteamsMessageId: {teamsMessageId}\nsenderName: {senderName}\nsenderUserId: {senderUserId}\nreplyToId: {replyToId}\n[/TEAMS_META]\n\n{message text}"
  }
  ```
  If `TEAMS_BRIDGE_PROXY_TOKEN` is set (recommended), the HTTP action must also send header `Authorization: Bearer <token>` — the proxy answers 401 without it.
- **Flow 2 (outbound):** HTTP trigger. The bridge POSTs:
  ```json
  {
    "message": "[🤖 Rubot]\n\n<AI response>",
    "conversationId": "...",
    "teamsMessageId": "...",
    "senderName": "...",
    "senderUserId": "...",
    "originalMessage": "Re: <user message>"
  }
  ```
  The Flow posts the message back to the conversation.

> The bridge and Hermes must run on a machine reachable from Power Automate. For a home network, expose the proxy port via a tunnel (ngrok/cloudflared) and update Flow 1's URL accordingly — and put an authenticator in front of it.

## Agent Autonomy (headless tool approval)

`hermes chat -q` in a non-interactive subprocess cannot answer approval prompts. For full tool autonomy, add approval flags per agent in `config.json`:

```json
{
  "agents": {
    "main": {
      "profile": "default",
      "extraArgs": ["--yolo", "--accept-hooks"]
    }
  }
}
```

Alternatively configure the profile's approval mode in `~/.hermes/config.yaml` (see Hermes docs on approval modes). Without this, the agent answers from knowledge/tools that need no approval, and prompts that require tool approval may stall until the response timeout.

## Testing & Validation

```bash
npm run typecheck   # strict TS, build + tests
npm run lint        # biome
npm run test        # vitest — 245 tests (13 files)
npm run build
```

Tests cover the full lifecycle with a `FileBackedStore` fixture (injected via the `SessionStore` interface), the SQLite adapter against a real temp database, the runner's spawn/env/args contract, and all ported parser/forwarder/state/security suites.

## Port Notes (OpenClaw → Hermes)

| Concern | Change |
|---|---|
| Session source | `~/.openclaw/agents/*/sessions/*.jsonl` → `~/.hermes/state.db` (`messages`/`sessions` tables) |
| Watcher | `fs.watch` → SQLite polling (`node:sqlite`, read-only, WAL-safe) |
| Tool-call detection | content parts `{type:"toolCall"}` → `tool_calls` column / `finish_reason="tool_calls"` |
| Inbound injection | OpenClaw webhook (port 18789) → `hermes chat -q -Q --source teams-bridge` subprocess |
| Agent identity | OpenClaw agent dir → Hermes profile (`profile` per agent; `HERMES_HOME` env for non-default) |
| Config | `forwardTo`/`hookToken`/`minAgeSeconds`/`sessionsDir` dropped; `hermesBin`/`dbPath`/`sessionPollMs`/`profile`/`extraArgs` added |
| Engine | Node >= 22.13 (was >= 18) — required for `node:sqlite` |

Kept identical: settle window, pending-session timeout fallback, retry scheduler + backoff, circuit breaker, dual-key dedup, state/failed persistence, security rules, context/md-writer, proxy enrichment, PM2 ecosystem, strict-TS/biome conventions.

## Troubleshooting

- **"Agent main: missing flow2Url"** — set `TEAMS_BRIDGE_FLOW2_URL_MAIN` (or a top-level `flow2Url`) in `.env`; the loader exits(1) on missing config.
- **Bridge won't start: SQLite error** — confirm `dbPath` points at a real Hermes `state.db` (`hermes doctor` validates the install). The store opens read-only; if Hermes is mid-VACUUM, the 3s busy timeout handles it.
- **Responses never forwarded** — check the message carried a full `[TEAMS_META]` block (bare mentions are ignored by design), the session has an assistant message with `finish_reason != "tool_calls"`, and `state.json` isn't marking it `failed`.
- **Agent turn stalls** — headless approval (see above); watch `LOG_LEVEL=DEBUG` logs for the spawned command and `~/.hermes/logs/` for the agent side.

## License

MIT
