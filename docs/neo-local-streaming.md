# Neo local inference streaming

`src/server/neo-local-inference.ts` parses upstream provider SSE incrementally
when a caller provides an `InferenceStreamHandler`. The handler is invoked for
each text/thinking/tool-input chunk so that
`src/server/neo-local-actor.ts:LocalThreadActor.runInference` can broadcast
`delta` frames in near-real time. Without a handler the existing buffered
behavior is preserved (used by helper paths like `extractLocalThreadContent`
and the title generator).

## Stream events

```ts
export interface InferenceStreamHandler {
  onTextDelta?(text: string): void;
  onThinkingDelta?(text: string): void;
  onToolStart?(call: { id: string; name: string }): void;
  onToolInputDelta?(id: string, partialJson: string): void;
  onUsage?(usage: JsonRecord): void;
}
```

| Provider                   | Endpoint                          | SSE format                                                                              |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| Anthropic                  | `POST /v1/messages`               | Anthropic SSE (`message_start`, `content_block_*`, `message_delta`).                    |
| OpenAI / Codex (deep mode) | `POST /v1/chat/completions`       | Chat Completions chunks. The Codex provider rewrites Responses API SSE into this shape. |
| Google                     | `:streamGenerateContent`          | Gemini SSE (`candidates[].content.parts[]`, `usageMetadata`).                           |

## Actor wiring

`runInference` owns an `AbortController`. The signal is passed through
`inferLocal` → provider `forward(...)` → `forward()` `fetch`. `cancel()`
calls `abort()` to terminate the upstream stream immediately. Aborted runs are
swallowed so they do not surface as `error` broadcasts.

### Delta semantics — incremental, not snapshot

Each provider text chunk is broadcast as an **incremental** delta containing
only the new bytes:

```jsonc
{
  "type": "delta",
  "messageId": "...",
  "role": "assistant",
  "blocks": [{ "type": "text", "text": "<new chunk>" }],
  "blockIndex": 0,
  "state": "generating"
}
```

The Amp CLI appends `delta.blocks[blockIndex].text` to the in-flight
assistant message at that block index (mirrors Anthropic Messages SSE's
`content_block_delta` append semantics). Sending a snapshot of the entire
accumulated text on every frame is **incorrect** here and triggers a visible
mid-stream slowdown because payload size grows O(N) and total work over the
run is O(N²).

After the upstream stream completes, `finishAssistantMessage`:

- Skips re-emitting the assembled text (the CLI already has it from the
  incremental deltas — replaying duplicates the response).
- If the model emitted tool_use calls, appends them in a single delta at
  `blockIndex = (text ? 1 : 0)` with `state: "tool_use"`.
- Sends the terminal `message_added` with the final assembled blocks and
  normalized usage.
- For zero-tool turns, also sends a final `delta` with `state: "complete"`.

## Notes

- Anthropic `thinking_delta` is forwarded only as a `streaming` state
  transition; thinking content is not stored in the message blocks.
- For Google, partial `functionCall` arguments are not streamed — Gemini
  emits the full call inside one part — so `onToolInputDelta` fires once per
  tool call with the serialized arguments.
- Tool stubs are NOT streamed via incremental deltas — partial tool_use
  with empty input would race the final complete tool_use block. They are
  attached only in the final post-stream delta inside
  `finishAssistantMessage`.
