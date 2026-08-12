# ADR-0001: Per-conversation Hermes session resume replaces context injection

Status: accepted

The bridge used to spawn a fresh, context-less `hermes chat -q` per inbound message and re-inject conversation history by writing markdown files (in a leftover OpenClaw workspace directory) and prepending a path reference plus topics to each message — a lossy, model-compliance-dependent hack. We decided each Teams conversation owns one Hermes session, resumed by ID (`hermes chat -q -Q -r <sessionId>`): history lives natively in the session, Hermes handles compression, and the injection subsystem is deleted.

## Considered Options

- **Context injection, fixed**: keep the design, move the files into a Hermes-owned directory, inject content instead of a path. Rejected — still lossy, still depends on the model choosing to read what we hand it.
- **Hermes webhook routes**: gateway-owned sessions. Rejected after source inspection — webhook runs are per-delivery (`webhook:{route}:{delivery_id}`), each session explicitly closed after one run; no continuity exists, plus a gateway daemon dependency.
- **Native Teams gateway adapter**: real per-conversation sessions and delivery. Rejected — requires an Azure AD bot registration at tenant-admin level, which is unavailable in this environment; Power Automate is the only Teams path, which is why the bridge exists.

## Consequences

- One session per conversation means cross-topic bleed in busy channels is now the model's judgment call, not suppressed by the bridge (previously `reply-chain` context clearing).
- Concurrent messages in one conversation would interleave turns in the same session, so the bridge serializes turns per conversation (in-memory queue); in-flight turns still survive bridge restarts via detached children.
- The bridge no longer manages context lifetimes; Hermes tooling (`hermes sessions rename/prune`) owns session hygiene.
- Sessions carry the per-turn instruction line to keep the single-final-message contract that the settle machinery depends on.
- A `/reset` command severs the conversation's session binding for a fresh start.
