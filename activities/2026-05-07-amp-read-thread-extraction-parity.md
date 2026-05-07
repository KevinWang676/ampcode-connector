# 2026-05-07 — Amp `read_thread` extraction parity

## Context

User challenged the earlier heuristic 80k local `read_thread` cap and asked to inspect Amp's binary for the actual behavior, including what happened before Neo.

## Amp binary findings

Current Amp binary (`~/.amp/package/dist/main.js`, version `0.0.1778130306-g2889d9`) implements `read_thread` as:

1. Validate `threadID`.
2. Try `threadService.get(threadID)`.
3. If found, render local thread to Markdown via `OT(thread)`.
4. If missing, fetch `GET /api/threads/<threadID>.md`.
5. Run `kt0(markdown, goal, threadID, currentThread, config, configService, signal)`.
6. `kt0` sends the whole mentioned thread markdown in `<mentionedThread>...</mentionedThread>` plus a goal-specific extraction prompt to a separate extraction model.
7. The extraction model is `Gl0`, which resolves to `GEMINI_2_5_FLASH_LITE_PREVIEW_09_2025`.
8. It requests JSON output matching `{ relevantContent: string }` and returns only `relevantContent` to the main model.

Important: Amp's tool does **not** return the full transcript to the main agent. It returns extracted relevant content.

## Connector adjustment

- Kept exact-id local `read_thread` lookup to avoid Amp's stale local `threadService.get` wrong-thread result.
- Changed local `read_thread` from returning only compact transcript to running a connector-local extraction pass based on Amp's prompt structure.
- The local extraction uses connector-local inference in `rush` mode with an Anthropic Haiku route by default.
- Because connector-local providers may not have the same large context as Amp's Gemini extraction model, the connector still pre-compacts local Neo transcripts by removing reasoning/signature/encrypted payloads and loaded skill bodies before extraction.
- If extraction fails, the connector falls back to the compact transcript, not the raw 2.5 MB transcript.

## Validation

- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed.
