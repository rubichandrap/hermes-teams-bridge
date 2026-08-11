# 01 — Turn dispatcher: bootstrap + resume + serialization

**What to build:** an inbound message resumes the conversation's session; the first message in a conversation bootstraps a fresh session, captures its id from the spawn's stdout, registers it in the session registry, and renames it `teams:<conversation>`; two rapid messages in one conversation serialize (one in-flight turn per conversation); the mapping survives bridge restarts. Includes the session registry module, the turn dispatcher, the runner rework (explicit bootstrap/resume mode, resume-by-session-id, stdout capture), the proxy hookup replacing the old context-enrichment call, and tests driven through a fake spawner and temp-file registry.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] First message in a conversation spawns a fresh turn and records the new session id in the registry (captured from spawn stdout; watcher-association fallback when capture fails)
- [x] Later messages in the same conversation spawn turns that resume the recorded session
- [x] Only one turn per conversation is in flight; concurrent messages queue and run in order
- [x] Registry persists across bridge restarts; conversations resume their sessions after a reboot
- [x] Bootstrap sessions are renamed `teams:<conversation>` (best-effort; rename failure is non-fatal)
- [x] Manually pasted messages carrying Teams metadata (not bridge-spawned) are still answered and forwarded without entering the registry
- [x] Detached/unref'd child semantics preserved: in-flight turns survive a bridge restart and the lookback heartbeat forwards late responses
- [x] Dispatcher tests green (fake spawner + temp registry); existing suites stay green
