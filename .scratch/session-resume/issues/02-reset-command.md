# 02 — Reset command

**What to build:** a message exactly matching a configured reset command (default `/reset`) severs the conversation's registry entry; the next turn bootstraps a fresh session; the old session remains in the store as history; an in-flight turn at reset time completes and its response is forwarded normally.

**Blocked by:** 01 — Turn dispatcher: bootstrap + resume + serialization

**Status:** ready-for-agent

- [x] A message exactly matching a configured reset command severs the conversation's registry entry
- [x] The next turn after a reset bootstraps a fresh session (and renames it `teams:<conversation>`)
- [x] An in-flight turn at reset time completes and its response is forwarded normally
- [x] `resetCommands` is configurable and non-sensitive, defaulting to `["/reset"]`
- [x] Reset detection is exact-match on the cleaned message text — no fuzzy matching
- [x] Tests green for detection and the reset lifecycle (dispatcher-level, fake spawner)
