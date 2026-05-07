# 2026-05-07 — Deep mode persistence fix

## Context

User reported that a thread started in `deep` mode switched to `smart` after later messages in the same Neo thread.

## Root cause

Amp Neo sends `agentMode` on the first user message, but later user messages in the same thread may omit it. The connector's local actor persisted the first message with `agentMode: "deep"`, but `settings` only contained values like `reasoning.effort`; it did not include `agentMode`. On subsequent messages the local actor called `agentMode()`, which defaulted to `smart` when `settings.agentMode` was absent.

This made later turns route through Anthropic smart mode instead of Codex deep mode.

## Fix

- `src/server/neo-local-actor.ts`
  - Compute an effective agent mode for every user message.
  - Persist that effective mode on the user message.
  - Resolve the thread mode from `settings.agentMode`, then the first user message's `agentMode`, then the current mode, then `smart` as a final fallback.
- `src/server/neo-cloud-sync.ts`
  - Cloud upload `agentMode` now also falls back to the first user message mode when thread settings lack `agentMode`.
- `tests/neo-local-runtime.test.ts`
  - Updated cloud-sync coverage to verify a thread with no `settings.agentMode` but first user message `agentMode: "deep"` uploads `agentMode: "deep"`.

Existing persisted deep threads are covered on next resume because their first user message already carries `agentMode: "deep"`.

## Validation

- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed: 8 pass, 0 fail.
- `bun run test` passed: 76 pass, 0 fail.
- Manual multi-turn deep smoke using `amp --mode deep --stream-json --stream-json-input -x` stored both user messages with `agentMode: "deep"` and logged Codex routing for both turns:
  - `Route decision route=LOCAL_CODEX provider=openai model=gpt-5.5`
  - persisted transcript contained `FIRST_DEEP_TURN` and `SECOND_DEEP_TURN`.
