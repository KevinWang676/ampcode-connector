# 2026-05-07 — `read_thread` exact local thread fix

## Context

User reported that asking any mode to summarize thread `T-019e0151-56a5-7095-949a-f57040d94049` via Amp's `read_thread` tool produced a result claiming metadata for a different/current thread id.

## Investigation

- The requested thread exists in the connector-local Neo store and its Markdown transcript is correct:
  - `~/.local/share/ampcode-connector/neo-threads/T-019e0151-56a5-7095-949a-f57040d94049.md`
- The failing conversation's local transcript showed Amp's built-in `read_thread` tool was called with the correct requested id, but the tool result described the current conversation thread instead.
- Amp's built-in `read_thread` first asks Amp CLI's own `threadService.get(threadID)`, only falling back to `GET /api/threads/<id>.md` when that local lookup misses. For connector-local Neo threads, the connector can have the correct transcript even when Amp's local thread service lookup is stale or mismatched.

## Fix

- Added connector-local handling for `read_thread` tool calls in `LocalThreadActor`.
- If the tool input contains a requested `T-...` id and that id exists in `NeoLocalPersistence`, the actor returns that exact Markdown transcript directly as the tool result.
- If the requested thread does not exist locally, the tool call is leased to Amp's executor as before.
- URL inputs such as `https://ampcode.com/threads/T-...` are normalized to the embedded thread id.

## Validation

- Added a unit test proving local `read_thread` returns the exact requested thread and not another/current thread.
- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed.
