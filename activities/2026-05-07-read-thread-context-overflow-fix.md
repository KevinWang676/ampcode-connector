# 2026-05-07 — `read_thread` context overflow fix

## Context

After local `read_thread` interception was added to avoid wrong-thread results, asking smart/deep to summarize `T-019e0151-56a5-7095-949a-f57040d94049` failed with `context_length_exceeded`. The same request worked when pointing Amp back at hosted Amp URLs.

## Root cause

This was connector-caused. The local shim returned the full connector Markdown transcript as the tool result. That transcript was ~2.5 MB and contained large reasoning/signature/encrypted payloads plus loaded skill/tool-result bodies. Amp's hosted/built-in `read_thread` path performs extraction before returning content to the main model, so it did not feed the full transcript back into the next turn.

## Fix

- Local `read_thread` now returns a compact transcript instead of raw full Markdown.
- It removes hidden/large reasoning blocks, signatures, and encrypted reasoning payloads.
- It replaces loaded skill bodies with `[loaded skill content omitted]`.
- It clips large tool results and JSON blocks.
- It caps the final local read-thread result to 80k characters.
- If the requested thread is not in local Neo storage, the tool still falls back to Amp executor normally.

## Validation

- Added regression test for context compaction.
- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed.
- Manual local run for `T-019e0151-56a5-7095-949a-f57040d94049` now returns exactly 80,000 chars and does not include `encryptedContent` or `gAAAAAB` payloads.
