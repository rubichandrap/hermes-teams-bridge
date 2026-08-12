# Spec — Per-conversation session resume (Hermes Teams Bridge)

Status: done (issues 01–04 complete; commits 9fb80ad + 03/04 commits)

## Goal

Replace the context-injection model with per-conversation Hermes session
resume: each Teams conversation owns one resumable Hermes session; inbound
messages trigger serialized turns on that session; a `/reset` command severs
the binding. The entire context-injection subsystem (markdown conversation
files, per-conversation context JSON, injection markers, context config keys)
is deleted.

## The resume model

- First message in a conversation → dispatcher marks a pending bootstrap,
  spawns `hermes chat -q -Q --source teams-bridge` (detached + unref'd),
  captures `session_id:` from the child's stderr, registers it in
  `registry.json`, renames it `teams:<conversation>` (best-effort).
- Later messages → spawn with `-r <sessionId>` (resume-by-id).
- Watcher-association fallback: if stderr capture failed, the db-watcher /
  heartbeat associates the store-discovered session for the pending
  bootstrap — but only sessions started after the pending marker are
  accepted (a pre-reset session inside the lookback window is rejected).
- One in-flight turn per conversation; concurrent messages queue in order.
- `/reset` (exact match on cleaned message text, `resetCommands` config,
  default `["/reset"]`) severs the binding and records a `severedAt`
  tombstone so a late in-flight bootstrap cannot resurrect it.
- Registry persists across bridge restarts (write-through, atomic tmp+rename).
- Detached children survive a bridge restart; the 15s heartbeat re-scans a
  `lookbackMinutes` window and forwards responses that landed while down.
- Config surface: `resetCommands` added; `contextMode`, `maxContextMessages`,
  `contextSummaryLength`, `contextMaxAgeDays`, `enrichResponses` removed.
- Per-turn instruction line retained: `📋 Reply with ONE final message. No
  narration, no planning, no NO_REPLY for questions.` (stripped from forwarded
  raw messages).

## Ticket status

| # | Ticket | Status |
|---|--------|--------|
| 01 | Turn dispatcher: bootstrap + resume + serialization | done (commit 9fb80ad) |
| 02 | Reset command | done (commit 9fb80ad) |
| 03 | Delete the injection subsystem | done |
| 04 | Docs + live integration verification | done — probe all PASS, two defects found and fixed |

## Live probe record (ticket 04)

Rig: isolated scratch environment — real `hermes` binary v0.20.0, scratch
HERMES_HOME at `/tmp/tb-probe/hermes-home`, probe bridge from
`/tmp/tb-probe/run` (proxy port 18799), local HTTPS Flow-2 sink on 18899
(self-signed cert + NODE_EXTRA_CA_CERTS — the forwarder is https-only).
Production pm2 bridge never touched. Conversation `19:probe04:1@thread.v2`.

- Bootstrap PASS — session `20260812_084340_4c776e`, source teams-bridge,
  renamed `teams:19:probe04:1@thread.v2` (title_source=user), signed response
  forwarded with correct metadata.
- Cross-turn continuity PASS — turn 2 resumed the same session (4 messages,
  one row) and recalled "BOOTSTRAP" from turn 1.
- /reset PASS — `{"status":"reset"}`, conversations emptied, severedAt
  tombstone; next turn bootstrapped fresh session `20260812_084601_d1e379`
  and forwarded "RESETOK".
- Restart mid-turn PASS — turn 5 spawned, bridge killed 3s later; detached
  child finished and committed (finish_reason=stop) while down; restart →
  heartbeat forwarded the straggler; next turn resumed the persisted binding
  (session at 8 messages).
- Final-build sanity PASS — turn 7 resumed and forwarded "FINAL-OK".

## Defects found by the probe (both fixed)

1. **Fallback association rebinds a pre-reset session.** The 15s heartbeat's
   lookback re-scan sees the old session after a reset; `wasSeveredAfter(
   pendingTs)` cannot catch it (sever < pending marker). Fixed: reject
   sessions whose `startedAtMs` < pending bootstrap ts (`TeamSessionRef`
   gained `startedAtMs` from `s.started_at`). Dispatcher test + live
   verification.
2. **Silent rename failure on title collision.** `hermes sessions rename`
   exits 0 while printing "Error: Title ... already in use" (old session
   holds `teams:<conversation>` after a reset) → bridge never warned, every
   post-reset session kept its derived title. Fixed: `renameSession` captures
   stdout and warns on error text regardless of exit code. Test added.

Also fixed pre-existing test flakiness found by stress runs (suite was ~40%
flaky): `spawnAgentTurn` now resolves `done` on child `close` (not `exit`),
registry test teardown awaits `flushAndWait()`, `waitForFile` 3s → 10s.
Flake rate now ~2% (residual: detached-child timing under parallel load).

## Deployment note (user decision)

The machine rebooted on 2026-08-12 and pm2 has no apps — the production
bridge has been down since the reboot. `dist/` is rebuilt from this work;
`pm2 start ecosystem.config.js` deploys all fixes. The devtunnel
(`rubot-proxy`) and token in `~/teamstoken.md` are unaffected.
