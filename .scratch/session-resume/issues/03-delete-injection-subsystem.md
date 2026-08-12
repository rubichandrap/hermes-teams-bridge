# 03 — Delete the injection subsystem

**What to build:** the entire context-injection machinery is gone and nothing references it: markdown conversation files (and the `~/.openclaw` directory they live in) are no longer created, per-conversation context JSON files and their manager are removed, injection markers/context-reference builders and the OpenClaw webhook-wrapper strip are removed from parsing, context cleanup jobs are gone, the context configuration keys are removed from the config surface and validation, and security rules no longer reference OpenClaw artifacts. The per-turn instruction line and its stripping for forwarded raw messages are retained. All validation gates stay green with the deletions.

**Blocked by:** 01 — Turn dispatcher: bootstrap + resume + serialization (the dispatcher hookup removes the enrichment call site; this ticket removes the dead modules)

**Status:** ready-for-agent

- [x] No `.openclaw` references remain in code, tests, or docs
- [x] Markdown conversation files and their directory are no longer created — the `~/.openclaw` directory is never (re)created
- [x] Per-conversation context JSON files and their manager are removed
- [x] Injection markers, context-reference builders, and the OpenClaw webhook-wrapper strip are removed from parsing
- [x] Context config keys (`contextMode`, `maxContextMessages`, `contextSummaryLength`, `contextMaxAgeDays`, `enrichResponses`) removed from the config surface and validation
- [x] Context cleanup jobs removed
- [x] Security rules no longer reference OpenClaw artifacts
- [x] The per-turn instruction line and its stripping for forwarded raw messages are retained
- [x] `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all green with the deletions
