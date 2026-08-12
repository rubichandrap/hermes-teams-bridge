# 04 — Docs + live integration verification

**What to build:** the project documentation describes the resume model instead of the injection model, the example config matches the new config surface, and a live end-to-end probe against the real Hermes binary is performed with results recorded in the ticket (bootstrap, cross-turn continuity, `/reset`, bridge restart mid-turn).

**Blocked by:** 01 — Turn dispatcher: bootstrap + resume + serialization; 02 — Reset command; 03 — Delete the injection subsystem

**Status:** done

- [x] AGENTS.md architecture, key-files, and config sections describe the resume model
- [x] README updated — no `.openclaw`, no injection description
- [x] Example config carries `resetCommands` and no context keys
- [x] Live probe performed against the real Hermes binary: bootstrap, cross-turn continuity, `/reset`, bridge restart mid-turn — results recorded in the ticket
- [x] CONTEXT.md glossary and ADR-0001 remain consistent with the implemented behavior

## Docs work

- AGENTS.md / CONTEXT.md / ADR-0001 were already consistent (updated in 01–03); verified no injection or `.openclaw` references remain.
- README: dropped the stale `stevbot` references (features + requirements), fixed the broken `Authorization: Bearer ***` redaction artifacts, added `/reset` to the feature bullet and the config tuning note, added `resetCommands` to the port-notes config row, updated the test count (270 tests / 14 files).
- `.env.example`: dropped `STEVBOT` from the agent-key comment, "enrich inbound" → "dispatch inbound", fixed the `Bearer ***` artifact.
- `config.json` (the example config): carries `resetCommands`, no context keys.

## Live probe (2026-08-12, real Hermes v0.20.0 binary)

Isolated rig: scratch `HERMES_HOME` at `/tmp/tb-probe/hermes-home` (config.yaml symlinked, auth/.env/skills copied), probe bridge run dir `/tmp/tb-probe/run` (proxy port 18799, sink URL via .env), local HTTPS Flow-2 sink (self-signed cert + `NODE_EXTRA_CA_CERTS` — the forwarder is https-only). Production pm2 bridge untouched. Conversation id `19:probe04:1@thread.v2`.

| Check | Result |
|-------|--------|
| Bootstrap | PASS — fresh session `20260812_084340_4c776e`, source `teams-bridge`, renamed `teams:19:probe04:1@thread.v2` (title_source=user); signed response forwarded to sink with correct conversationId/teamsMessageId/originalMessage |
| Cross-turn continuity | PASS — turn 2 resumed the same session id (4 messages in one session row) and answered "BOOTSTRAP" to "what word did I ask you to reply with in my first message?" |
| `/reset` | PASS — proxy answered `{"status":"reset"}`, registry conversations emptied, `severedAt` tombstone written, no child spawned |
| Post-reset bootstrap | PASS — fresh session `20260812_084601_d1e379`; response "RESETOK" forwarded |
| Bridge restart mid-turn | PASS — turn 5 spawned, bridge killed 3s later (graceful, like pm2 restart); the detached child finished and committed its response (finish_reason=stop) while the bridge was down; restart → 15s heartbeat lookback re-scan forwarded the straggler to the sink; a following turn resumed the persisted registry binding (session at 8 messages) |
| Final-build sanity | PASS — turn 7 on the final build resumed the session and forwarded "FINAL-OK" |

## Defects found and fixed

1. **Fallback association rebinds a pre-reset session (real bug).** After `/reset`, the 15s heartbeat's 60-min lookback re-scan sees the OLD session (still inside the window) and `associateIfPending` rebound it: the `wasSeveredAfter(pendingTs)` tombstone check can't catch it because the sever predates the pending bootstrap marker. Self-healed when the child exited and registered the real new session, but transiently wrong and contradicted the tombstone contract.
   Fix: `associateIfPending` now takes the session's `startedAtMs` (added to `TeamSessionRef` via `s.started_at` in the store query) and rejects sessions that started before the pending bootstrap — only the genuine bootstrap product can be associated. Test added; verified live (post-reset fallback associated the NEW session, not the old).
2. **Silent rename failure on title collision.** `hermes sessions rename` prints "Error: Title ... is already in use by session <old>" and **exits 0**, so the bridge's rename warning (non-zero exit only) never fired. Every post-reset session kept its auto-derived title while the old session held `teams:<conversation>`. Cosmetic (resume is by id) but invisible.
   Fix: `renameSession` now captures stdout too and warns when the output contains an error regardless of exit code. Test added.

## Test-suite flakiness fixed along the way (pre-existing, found by stress runs)

- `spawnAgentTurn` resolved `done` on child `exit`, which can fire before stderr drains → session-id capture sometimes empty; now resolves on child `close` (after `exit` + drained stdio).
- Session-registry test teardown raced the async atomic flush (`rmSync` → ENOTEMPTY); `afterEach` now awaits `flushAndWait()`.
- `waitForFile` timeout raised 3s → 10s (slow scheduling under parallel load).
- Result: full-suite flake rate dropped from ~40% (4/10 runs on the pristine tree) to ~2% (1/40+).

## Remaining (deployment, user decision)

- The machine rebooted on 2026-08-12 and pm2 has no apps — the production bridge has been down since; the new `dist/` (built from this work) is ready. `pm2 start ecosystem.config.js` brings it back with all fixes.
