# Hermes Teams Bridge

Bridges Microsoft Teams messages to a Hermes Agent and back: inbound messages are enriched with conversation context and injected into an isolated Hermes session; outbound AI responses are scanned, deduplicated, and forwarded to Teams via Power Automate.

## Language

**Session**:
One AI response cycle triggered by a Teams message; persisted as one row in the Hermes session store (`~/.hermes/state.db`).
_Avoid_: thread, exchange

**Conversation**:
The Teams chat thread, keyed by `conversationId`; spans many sessions. Harvested context is stored per conversation.
_Avoid_: chat, thread

**Settle window**:
The debounce period (`responseSettleMs`) after the assistant's first text appears, giving the AI time to finish writing before the session is finalized.
_Avoid_: debounce, grace period

**Pending session**:
A session with Teams metadata whose response has not arrived yet; tracked against the response window and removed when the response lands, the window expires, or the session is deleted.

**Timeout fallback**:
The message sent to Teams when a pending session exceeds the response window, telling the user the AI is still processing.
_Avoid_: timeout message, fallback

**NO_REPLY**:
The sentinel response the AI writes when it deliberately has nothing to say; the bridge records it as forwarded and stays silent.

**Finalize**:
Resolve a settled session: dedup check, retry handling, context harvest, security scan, and forward to Flow 2.
_Avoid_: complete, resolve

**Forward**:
Deliver the AI response to Power Automate Flow 2 for Teams delivery.
_Avoid_: send, push, deliver

**Retry**:
Resend of one exact failed message on its own backoff schedule; counted per message (`teamsMessageId`-stable), capped at 3; the failed message payload is snapshotted at failure time, never re-derived from the session store.
_Avoid_: retry loop, poll, sleep

**Forward ledger**:
The persisted record of forwarded, retried, and failed deliveries, keyed by dedup key and Teams message id.
_Avoid_: state, store

**Circuit breaker**:
Per-agent gate on Flow 2 that opens after repeated failures, halting posts during outages without consuming message retry budgets.
_Avoid_: breaker, fuse, outage gate

**Message text**:
The cleaned user message after the Teams metadata block, webhook wrapper, injected context, and HTML are stripped; what conversation history, Flow 2, and the security scan consume.
_Avoid_: cleaned message, plain text

**Injection**:
The 📜/📋 context block the proxy prepends to an inbound message to guide the agent; stripped from message text before use.
_Avoid_: enrichment block, context header

**Agent turn**:
The `hermes chat -q -Q --source teams-bridge` subprocess spawned for one inbound message; writes its session into the Hermes session store.
_Avoid_: spawn, child process

**Store**:
The read-only SQLite adapter over Hermes `state.db` (`src/store/hermes-store.ts`); the only place the database is touched.
_Avoid_: db, sqlite
