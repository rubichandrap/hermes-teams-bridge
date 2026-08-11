# AGENTS.md — Hermes Teams Bridge

## Development Workflow

Every change follows three phases, in order. Don't skip steps.

### 1. Plan
- Read the affected code, related modules, and this AGENTS.md
- Search for existing patterns before introducing new ones
- Present a plan: what changes, where, why, and any tradeoffs
- Wait for explicit approval before writing code

### 2. Code
- Match the existing style: tab indent, biome, individual `export const` loggers
- Keep zero runtime dependencies (Node built-ins only, including `node:sqlite`)
- Update or add tests in the same change when behavior changes
- Don't add comments unless asked

### 3. Validate
Before considering any change done, all must pass:
- `npm run typecheck`
- `npm run lint`
- `npm run test` (write or update tests first if behavior changed)
- `npm run build` for any change to `src/`

## Build & Verify
```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit (build) + tsc -p tsconfig.test.json --noEmit (tests)
npm run lint        # biome check src/
npm run lint:fix    # biome check --write src/
npm run test        # vitest run
npm run test:watch  # vitest (watch mode)
npm run test:cov    # vitest run --coverage
```

## Architecture

```
src/index.ts                    Bootstrap
  └─ src/core/bridge.ts         Orchestrator (db watcher, heartbeat, proxy, signals)
       └─ src/core/session-lifecycle.ts   Core logic (parse, scan, forward, retry)
            ├─ src/session/parser.ts      [TEAMS_META] parsing, assistant extraction
            ├─ src/store/hermes-store.ts  Read-only node:sqlite adapter over Hermes state.db
            ├─ src/forwarder/flow2.ts     POST to Power Automate Flow 2
            ├─ src/state/manager.ts       Dedup, retry (3 max), failed tracking
            ├─ src/context/manager.ts     Per-conversation JSON context
            ├─ src/context/md-writer.ts   Conversation Markdown for AI context
            └─ src/security/index.ts      Strategy-pattern security scanner
       ├─ src/watcher/db-watcher.ts       Polls state.db for [TEAMS_META] session activity
       ├─ src/agent/runner.ts             Spawns `hermes chat -q -Q --source teams-bridge` (bootstrap/resume by session id)
       ├─ src/dispatcher/turn-dispatcher.ts  Per-conversation turn queue: bootstrap/resume, session registry, /reset
       ├─ src/registry/session-registry.ts   Persistent conversation→session mapping (registry.json)
       └─ src/proxy/server.ts            HTTP proxy (port 18790) — dispatches inbound Teams messages to the turn dispatcher
```

- **Zero runtime dependencies** — Node.js built-ins only (`fs`, `path`, `http`, `sqlite`)
- **Strict TS** — `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`
- **Formatter:** biome (tabs, 120 cols)
- **Config load order:** `programmatic defaults → config.json → .env`
- **Requires Node >= 22.13** (for `node:sqlite` with read-only connections)

## Hermes Integration Points (what changed vs the OpenClaw bridge)

| OpenClaw bridge | Hermes bridge |
|-----------------|---------------|
| `fs.watch` on `~/.openclaw/agents/<id>/sessions/*.jsonl` | Poll `~/.hermes/state.db` (SQLite, WAL) every `sessionPollMs` |
| Session files parsed as JSONL | `messages` rows mapped to the same `SessionEntry` shape |
| Tool calls = content parts `{type:"toolCall"}` | `tool_calls` column non-empty OR `finish_reason = "tool_calls"` |
| Proxy POSTs to OpenClaw webhook (port 18789) | Proxy spawns `hermes chat -q -Q --source teams-bridge` |
| Agent ID = OpenClaw agent | Agent ID = configured key; `profile` maps to a Hermes profile (`HERMES_HOME` per profile) |
| `forwardTo` / `hookToken` config | Removed (no external ingress hop) |

- The store is **read-only** — the bridge never writes to Hermes' DB.
- Sessions spawned by the bridge carry `source = "teams-bridge"` (see `AGENT_SOURCE` in `src/agent/runner.ts`), but discovery is by `[TEAMS_META]` presence, not source — a manually pasted Teams message is also picked up, matching the old bridge's behavior.
- The child `hermes chat` process is detached + unref'd: it survives a bridge restart, and the lookback heartbeat forwards responses that landed while the bridge was down.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Entry point — bootstrap only |
| `src/core/bridge.ts` | Orchestrator: db watcher, heartbeat, proxy, signal handlers |
| `src/core/session-lifecycle.ts` | Core logic: parse sessions, run security, forward responses, retry |
| `src/store/hermes-store.ts` | Read-only SQLite adapter: row → `SessionEntry` mapping, `[TEAMS_META]` discovery |
| `src/agent/runner.ts` | Spawns `hermes chat -q -Q --source teams-bridge` per inbound message (bootstrap, or `-r <sessionId>` resume); captures `session_id` from stderr; best-effort `hermes sessions rename` to `teams:<conversation>` |
| `src/dispatcher/turn-dispatcher.ts` | Per-conversation turn queue (one in-flight turn per conversation); bootstraps/resumes registry sessions; /reset severs the binding; watcher-association fallback for failed id capture |
| `src/registry/session-registry.ts` | Persistent conversation→session mapping in `registry.json` (write-through, atomic); pending-bootstrap markers + severed tombstones |
| `src/proxy/server.ts` | HTTP proxy (port 18790) — dispatches inbound Teams messages to the turn dispatcher; optional bearer-token auth (`TEAMS_BRIDGE_PROXY_TOKEN`) |
| `src/forwarder/flow2.ts` | POSTs AI responses to Power Automate Flow 2 (100s timeout) |
| `src/session/parser.ts` | Parses `[TEAMS_META]` blocks (full `[...]...[/...]` match only — bare mentions ignored), extracts assistant text, strips HTML |
| `src/watcher/db-watcher.ts` | Polls the session store (default 2000ms) for changed sessions carrying Teams metadata |
| `src/state/manager.ts` | Dedup (`forwarded`/`forwardedByMessageId`), retry (3 max, `msgId`-stable counting), failed audit |
| `src/context/manager.ts` | Per-conversation JSON context CRUD in `contexts/` dir |
| `src/context/md-writer.ts` | Writes conversation history as Markdown; skips context injection when all topics are empty |
| `src/security/index.ts` | Security scanner — strategy pattern with pluggable rules |
| `src/config/loader.ts` | Config loading: defaults → config.json → .env (TEAMS_BRIDGE_* prefix) |
| `src/types/index.ts` | All domain types (BridgeConfig, TeamsMetadata, SessionEntry, etc.) |
| `src/utils/logger.ts` | Structured logging: `debug`, `info`, `warn`, `error`, `fatal` |

## Config

- `config.json` — behavioral tuning (non-sensitive): `proxyMode`, `proxyPort`, `responseTimeoutSeconds`, `responseSettleMs`, `sessionPollMs`, `hermesBin`, `resetCommands` (default `["/reset"]`), per-agent `signature`/`profile`/`extraArgs`
- `.env` — secrets + deployment (`TEAMS_BRIDGE_*` prefix, e.g. `TEAMS_BRIDGE_FLOW2_URL_MAIN`), copy from `.env.example`
- `state.json` — runtime state: `forwarded`, `retries` (max 3), `failed` (audit log, mirrored in `failed.json`)
- `dbPath` resolves to `$HERMES_HOME/state.db` (default `~/.hermes/state.db`); override with `TEAMS_BRIDGE_DB_PATH`
- Per-agent `profile` selects the Hermes profile: the runner sets `HERMES_HOME=~/.hermes/profiles/<profile>` for non-`default` profiles; sessions without a profile name map to the agent whose `profile` is `default`

## Conventions

- Tab indentation (biome)
- No comments unless explicitly asked
- Individual `export const` loggers: `debug()`, `info()`, `warn()`, `error()`, `fatal()`
- State manager writes through immediately on every mutation (`stateDirty = true; flushState()`)
- `LogLevel` is numeric (0-4) for filtering; ERROR/FATAL go to stderr
- Session store access goes through the `SessionStore` interface (`src/store/hermes-store.ts`) — never open `state.db` directly from other modules; tests inject `FileBackedStore`

## Error Handling Patterns

- `ForwardResult.forwarded: boolean` — check this, not exceptions
- `postToFlow2()` never throws — errors captured as `{ forwarded: false, error: "..." }`
- Proxy uses `http.request()` with promise wrapper (not `fetch`)
- `store.readSessionEntries()` returns `null` on failure — caller checks
- `spawnAgentTurn()` resolves `{ ok, error }` — the proxy responds 502 when spawn fails
- Config validation calls `process.exit(1)` on fatal errors

## Retry & Failed State

1. First attempt: `postToFlow2()` fails → `incrementRetry()` (count = 1)
2. Subsequent scans: `getRetryCount()` > 0 → 1s delay before retry
3. Third failure: `incrementRetry()` → count = 3 → move to `failed`
4. In `failed`: `isAlreadyForwarded()` returns `true` → permanently skipped
5. `failed` block is never auto-cleared — acts as audit log
6. To manually reset: clear `failed` and `retries` from `state.json`
7. Retry count is `msgId`-stable: AI writing multiple messages (thinking blocks) won't reset the counter because it's keyed on `teamsMessageId`, not `entryId`
