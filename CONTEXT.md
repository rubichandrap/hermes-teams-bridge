# Hermes Teams Bridge

Bridges Microsoft Teams messages to a Hermes Agent and back: each conversation owns one resumable Hermes session; inbound messages trigger serialized turns on that session; outbound AI responses are scanned, deduplicated, and forwarded to Teams via Power Automate.

## Language

**Conversation**:
A Teams chat, keyed by `conversationId`; the unit of session ownership. One conversation owns exactly one session at a time.
_Avoid_: chat, thread, group

**Thread**:
A topic branch inside a conversation (reply-to ancestry). Deliberately not a unit of memory: history spans threads, and the model decides what is relevant.
_Avoid_: topic, conversation

**Session**:
A Hermes agent session (one row in `state.db`), resumable by ID; the conversation's memory. Created on a conversation's first turn, resumed on every later turn.
_Avoid_: chat, transcript, history

**Turn**:
One inbound message → one agent run, serialized per conversation: a conversation never has two turns in flight.
_Avoid_: exchange, cycle

**Inbound message**:
A Teams message delivered via Power Automate carrying a `[TEAMS_META]` block; the trigger of a turn.
_Avoid_: webhook payload, request

**Response**:
The agent's final assistant message for a turn, forwarded to Flow 2 after settling.
_Avoid_: answer, reply

**Settle window**:
The debounce period (`responseSettleMs`) after the assistant's first text appears, giving the AI time to finish writing before the turn is finalized.
_Avoid_: debounce, grace period

**Pending turn**:
A turn whose response has not arrived yet; tracked against the response window and removed when the response lands, the window expires, or the session is deleted.
_Avoid_: pending session, pending response

**Timeout fallback**:
The message sent to Teams when a pending turn exceeds the response window, telling the user the AI is still processing.
_Avoid_: timeout message, fallback

**NO_REPLY**:
The sentinel response the AI writes when it deliberately has nothing to say; the bridge records it as forwarded and stays silent.

**Finalize**:
Resolve a settled turn: dedup check, retry handling, security scan, and forward to Flow 2.
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

**Session registry**:
The bridge's persisted mapping of agent + conversation → session id; consulted on every turn to decide bootstrap vs resume.
_Avoid_: session map, index

**Reset command**:
A message (`/reset`) that severs the conversation's session binding; the next turn starts a fresh session.
_Avoid_: clear, new-session command

**Agent**:
A configured identity (Hermes profile, signature, Flow 2 URL) that conversations route to.
_Avoid_: bot, persona

**Agent turn**:
The `hermes chat -q -Q --source tool` subprocess that runs one turn — bootstrapping a fresh session on first contact or resuming the conversation's session on later ones.
_Avoid_: spawn, child process

**Message text**:
The cleaned user message after the Teams metadata block, the per-turn instruction block, and HTML are stripped; what Flow 2 and the security scan consume.
_Avoid_: cleaned message, plain text

**Store**:
The read-only SQLite adapter over Hermes `state.db` (`src/store/hermes-store.ts`); the only place the database is touched.
_Avoid_: db, sqlite
