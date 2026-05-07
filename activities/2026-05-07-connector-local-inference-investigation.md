# 2026-05-07 — Connector-local inference investigation

## Context

Investigated how a future connector-managed local actor/runtime can perform a single-turn model inference through the existing provider handlers without duplicating OAuth, request normalization, or streaming/rewrite logic.

## Files inspected

- `src/providers/base.ts`
- `src/providers/anthropic.ts`
- `src/providers/codex.ts`
- `src/providers/google.ts`
- `src/providers/forward.ts`
- `src/server/body.ts`
- `src/server/server.ts`
- `src/routing/router.ts`
- `src/routing/retry.ts`
- `src/proxy/rewriter.ts`
- `src/utils/code-assist.ts`
- Existing provider docs in `docs/`

## Findings

- The common provider API is `Provider.forward(path, ParsedBody, Headers, rewrite?, account?)`.
- `parseBody()` should be reused to construct `ParsedBody` so model extraction, stream detection, and model rewrites match normal proxy traffic.
- `routeRequest()` can select the local handler/account for `anthropic`, `openai`/Codex, or `google` using existing config, credentials, cooldowns, and affinity.
- A connector-local actor should not call the server's Amp upstream fallback by default; local inference should fail closed when no local OAuth provider is available.
- Anthropic is simplest when the actor builds native `/v1/messages` bodies.
- OpenAI/Codex is simplest for MVP when the actor builds `/v1/chat/completions` bodies and lets `src/providers/codex.ts` convert them to Responses API for the ChatGPT Codex backend.
- Google is already usable for callers that produce Vertex/Gemini `generateContent` bodies, but it is not required for the first Anthropic/OpenAI local actor MVP.

## Decision

Implemented the least-risk adapter and local runtime path:

1. Keep the existing `Provider` interface unchanged.
2. Build provider-native request bodies from normalized actor messages and registered tool schemas.
3. Use `parseBody`, `routeRequest`, `rewriter.rewrite`, and `handler.forward`.
4. Reuse existing connector provider auth, account selection, model rewriting, Codex conversion, Anthropic compatibility, and Google wrapping.
5. Avoid Amp upstream fallback for local actor inference.
6. Default `startRivetProxy(config)` to the local ThreadActor runtime; keep the hosted bridge behind `AMPCODE_CONNECTOR_NEO_RUNTIME=hosted` for debugging.

## Implementation notes

- Added `src/server/neo-protocol.ts` for JSON protocol helpers, id generation, thread id extraction, tool-call id normalization, and Neo usage normalization.
- Added `src/server/neo-local-inference.ts` for connector-local model routing and provider calls.
- Added `src/server/neo-local-actor.ts` for the local ThreadActor protocol loop.
- Added `src/server/neo-local-runtime.ts` for the Rivet-compatible HTTP/WebSocket runtime on `localhost:6420`.
- Added `src/server/neo-local-persistence.ts` for durable local actor snapshots and Markdown export.
- Added `src/server/neo-cloud-sync.ts` to mirror local Neo snapshots to Amp's classic `uploadThread` cloud thread API and to fetch cloud thread data for local actor recreation.
- Added `tests/neo-local-runtime.test.ts` and included it in `package.json`'s test script.
- Execute-mode initially timed out after local inference succeeded. Root causes:
  - Amp execute mode tracks the current assistant by an active `agent_state` carrying the assistant `messageId`, so the runtime now emits `agent_state: streaming` before assistant `delta`/`message_added`.
  - Raw provider `usage` payloads do not match Amp Neo's WebSocket schema. `normalizeNeoUsage(...)` now maps Anthropic/OpenAI/Google token fields into the required camelCase Neo shape before emitting frames.
- Tool-use prompts initially failed because inference could start before `executor_tools_register`. The actor now queues user messages until `executor_tools_bootstrap_complete`, then starts inference with the full local tool registry.
- Added protocol conversions for approval queues, filesystem request/result relays, plugin/artifact events, read/edit/title/retry controls, and local executor spawn rejection.
- Added local `/api/threads/find`, `/api/threads/:id.md`, and `/api/threads/:id/export` handling so finished local Neo threads can be found/read/exported through the connector.
- Restored ampcode.com thread visibility by posting classic thread-shaped payloads to `/api/internal?uploadThread` after local Neo snapshot saves. Plain `GET /api/threads/:id` now falls through to Amp upstream so CLI/browser thread views receive the cloud thread object instead of the connector export wrapper.
- Restored smart thread naming by comparing Amp's classic ThreadWorker path: it calls `generateThreadTitle` on the first user message and applies a `title` update. The local actor now makes a connector-local Anthropic forced-tool title call, emits `thread_title`, persists the title, and re-uploads the cloud thread. The connector does not enforce a title word-count cap.
- Added sanitized environment metadata (`env.initial`) to cloud uploads.
- Added local parity for applicable classic sync mutations: `deleteThread` / `DELETE /api/threads/:id` remove local persisted snapshots, `archiveThread` hides local snapshots from local search, and `setThreadMeta` / cloud import preserves visibility metadata for future uploads. Handoff relationship parity is intentionally skipped because Amp's Neo announcement says Handoff is gone and compaction replaces it.

## Testing

- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed: 8 pass, 0 fail.
- `bun run test` passed: 76 pass, 0 fail, including targeted Neo local runtime/persistence/cloud-sync cases.
- Manual smoke passed:

```sh
amp -m rush -x "Reply with exactly AMP_LOCAL_NEO_OK and nothing else."
# AMP_LOCAL_NEO_OK

amp --stream-json -m rush -x "Reply with exactly AMP_LOCAL_NEO_JSON_OK and nothing else."
# assistant stop_reason=end_turn; result=AMP_LOCAL_NEO_JSON_OK

amp --dangerously-allow-all -m rush -x "Use the Bash tool to run 'printf TOOL_LOOP_OK'. Then reply with exactly the command output and nothing else."
# TOOL_LOOP_OK

amp --stream-json --dangerously-allow-all -m rush -x "Use the Bash tool to run 'printf STREAM_TOOL_OK'. Then reply with exactly the command output and nothing else."
# tool_use turn followed by result=STREAM_TOOL_OK

curl 'http://localhost:8765/api/threads/find?q=TOOL_LOOP_OK&local=1'
curl 'http://localhost:8765/api/threads/<threadId>.md'
# returned persisted local thread transcript with user, tool_use, tool_result, and final assistant messages

# After restarting bun run dev, the same local thread remained discoverable via /api/threads/find.

amp -m rush -x "Reply with exactly AMP_CLOUD_SYNC_V2_1778128222 and nothing else."
# AMP_CLOUD_SYNC_V2_1778128222

curl -X POST 'http://localhost:8765/api/internal?getThread' \
  -H 'content-type: application/json' \
  --data-binary '{"method":"getThread","params":{"thread":"T-019e00b3-84e2-74da-9e3d-ab4473367dd3"}}'
# returned ok=true with the uploaded cloud thread and both local Neo messages.

amp -m rush -x "For validation marker TITLE_NOCAP_..., reply with exactly TITLE_NOCAP_OK and nothing else. The task context is investigating connector-side Neo cloud synchronization for smart generated thread titles visibility metadata archive propagation deletion propagation and download discovery parity."
# TITLE_NOCAP_OK
# cloud getThread title: "Connector-side neo cloud synchronization for smart generated thread titles visibility metadata archive propagation deletion propagation and download discovery parity" (19 words; no connector cap)
# cloud getThread includes env.initial with workspaceRoot/workingDirectory/trees.

curl -X POST 'http://localhost:8765/api/internal?deleteThread' \
  -H 'content-type: application/json' \
  --data-binary '{"method":"deleteThread","params":{"thread":"<threadId>"}}'
# returned ok=true upstream and local /api/threads/find?q=<marker>&local=1 returned no local rows.
```

The temporary smoke-test `bun run dev` process was stopped afterward; ports `8765` and `6420` were confirmed not listening.
