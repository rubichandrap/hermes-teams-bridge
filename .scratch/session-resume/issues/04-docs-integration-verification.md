# 04 — Docs + live integration verification

**What to build:** the project documentation describes the resume model instead of the injection model, the example config matches the new config surface, and a live end-to-end probe against the real Hermes binary is performed with results recorded in the ticket (bootstrap, cross-turn continuity, `/reset`, bridge restart mid-turn).

**Blocked by:** 01 — Turn dispatcher: bootstrap + resume + serialization; 02 — Reset command; 03 — Delete the injection subsystem

**Status:** ready-for-agent

- [ ] AGENTS.md architecture, key-files, and config sections describe the resume model
- [ ] README updated — no `.openclaw`, no injection description
- [ ] Example config carries `resetCommands` and no context keys
- [ ] Live probe performed against the real Hermes binary: bootstrap, cross-turn continuity, `/reset`, bridge restart mid-turn — results recorded in the ticket
- [ ] CONTEXT.md glossary and ADR-0001 remain consistent with the implemented behavior
