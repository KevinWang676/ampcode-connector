# 2026-05-07 — Reasoning effort persistence fix

## Context

After fixing deep-mode persistence, checked whether the user's selected reasoning effort is also preserved across later Neo thread messages.

## Finding

Before this fix, the connector did not fully guarantee that later messages used the originally selected reasoning effort when Neo omitted `reasoningEffort` on later `client_append_user_msg` frames. The local actor passed `user.reasoningEffort` directly into inference; if later user messages omitted it, OpenAI/Codex inference fell back to the adapter default (`medium`).

Current Neo often stores the selected effort in `client_update_thread_settings` as `settings["reasoning.effort"]`, so many threads were effectively okay. But it was not robust if settings were absent and only the first user message carried the effort.

## Fix

- Added optional `reasoningEffort` to persisted `NeoThreadMessage`.
- For every user message, compute and persist an effective reasoning effort from:
  1. current user message `reasoningEffort`,
  2. `settings["reasoning.effort"]`,
  3. first persisted user message `reasoningEffort`,
  4. current actor reasoning effort.
- Inference now receives the effective value, so later turns do not silently fall back to adapter defaults when Neo omits per-message effort.
- Snapshot resume initializes `currentReasoningEffort` from the same fallback chain.

## Validation

- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed: 8 pass, 0 fail.
- `bun run test` passed: 76 pass, 0 fail.
