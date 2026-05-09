# 2026-05-09 — Neo local streaming + cancel propagation

## Problem
1. Connector-local Neo runtime (`src/server/neo-local-actor.ts`) only emitted a
   single `delta` frame after the upstream provider response had fully completed.
   The Amp CLI showed status `working` for the entire duration with no token
   counts; assistant text appeared in one chunk at the end.
2. `client_cancel` flipped the actor's `generation` so subsequent broadcasts
   were silenced, but it did not abort the in-flight upstream `fetch`. The CLI
   appeared idle while a wasted request kept running until the model finished.

## Changes
- `src/server/neo-local-inference.ts`
  - Added `InferenceStreamHandler` interface (text/thinking/tool-start/
    tool-input/usage callbacks).
  - `inferLocal` now accepts an optional handler. When passed, sets
    `stream: true` and routes through provider-specific SSE parsers.
  - `parseAnthropicSse` — handles `message_start`, `content_block_start`,
    `content_block_delta` (text/thinking/input_json), `content_block_stop`,
    `message_delta`.
  - `parseOpenAISse` — Chat Completions chunk deltas with index-keyed tool_call
    aggregation. Codex deep-mode runs through this path because
    `transformCodexResponse` converts the upstream Responses-API SSE back to
    Chat-Completions chunks.
  - `parseGoogleSse` — `streamGenerateContent` candidate parts plus
    `functionCall` and `usageMetadata`.
  - Shared helpers: `callLocalProviderStream`, `invokeLocalProvider`,
    `readSseChunks`, `parseJsonChunk`. `readSseChunks` honors an
    `AbortSignal` and cancels the underlying reader on abort.
  - `LocalInferenceRequest.signal?: AbortSignal` is plumbed through every
    provider call.
- `src/server/neo-local-actor.ts`
  - `runInference` now accumulates text + tool-stub blocks from streaming
    callbacks and emits incremental Neo `delta` frames (~50 ms throttle),
    transitioning `agent_state` to `streaming` on the first chunk.
  - Owns an `AbortController` per inference run; `cancel()` aborts it so the
    upstream fetch terminates immediately. Aborted runs no longer surface as
    error broadcasts.
- `src/providers/base.ts`, `src/providers/anthropic.ts`,
  `src/providers/codex.ts`, `src/providers/google.ts`,
  `src/providers/forward.ts` — added optional `AbortSignal` parameter on
  `Provider.forward` and `forward()` `fetch`.

## Verification
- `bun run format` (1 file fixed).
- `bun run check` — 83/83 tests pass; tsc strict + Biome clean.

## Follow-up: incremental delta fix

After initial streaming work the CLI showed an unnatural curve: fast for the
first few hundred tokens, slowing as the response grew, then stuttering and
dumping the tail.

Root cause: `runInference` was emitting each `delta` with a **snapshot** of
the full accumulated text (`buildBlocks()` rebuilt all text into a single
block every chunk). That made delta payload size O(N) and websocket
serialization total work O(N²) over the run. It also forced the CLI to
re-render the entire message on every frame.

Fix: emit incremental deltas. `onTextDelta` now broadcasts only the new
chunk in `delta.blocks[0].text`, mirroring Anthropic Messages SSE's
append-by-blockIndex semantics. The 50 ms throttle and snapshot rebuild are
gone. After the upstream stream finishes, `finishAssistantMessage` skips the
text-replay delta when text was streamed (an `alreadyStreamedText` flag) and
only appends the final tool_use blocks (if any) plus the terminal
`message_added`/`agent_state: idle`. This matches what hosted Neo emits.

## Outstanding
- `apply_patch` failures reported by user remain uninvestigated. The connector
  forwards `apply_patch` (Codex deep-mode built-in) to the executor unchanged
  via `tool_lease`; failures most likely originate from the executor's patch
  validator, not the connector. Will require runtime logs or a reproduction to
  pinpoint.
