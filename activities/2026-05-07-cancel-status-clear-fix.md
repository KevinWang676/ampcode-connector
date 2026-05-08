# 2026-05-07 — Cancel status clear fix

## Context

User reported that during a local Neo request, pressing Escape twice cancels the request, but Amp CLI's bottom-left status animation continues to show the previous working/streaming/tool status.

## Root cause hypothesis

The local runtime handled `client_cancel`, incremented the generation counter, and emitted `agent_state: idle`, but it used the last persisted message id. During active inference the assistant message may not be persisted yet, so the last persisted message is usually the user message. The CLI had previously seen `agent_state: working` for a generated assistant id, then received cancellation/idle events tied to the wrong id. That can leave the UI status bound to the active assistant turn uncleared.

For tool-running cancellation, the runtime also left approval queues/pending tool state without an explicit empty approval queue broadcast.

## Fix

- Track `activeAssistantMessageId` as soon as local inference starts.
- On `client_cancel`, prefer the active assistant id over the last persisted message id.
- If the active assistant message has not been persisted yet, persist and broadcast an assistant `message_added` with state `{ type: "cancelled" }`.
- Emit `delta` with `state: "cancelled"` for the active assistant id.
- Clear pending tools and approval queues, and broadcast an empty `tool_approval_queue`.
- Emit final `agent_state: idle` with the active assistant id.
- Ignore late provider errors/results from the cancelled generation.

## Validation

- Added regression test that cancel emits a cancelled assistant message, cancelled delta, and idle agent state for the active inference message id.
- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed.
