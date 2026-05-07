# Amp Neo CLI compatibility

## Purpose

Track connector support for Amp CLI/Neo (`~/.amp/bin/amp` versions `0.0.1778080581-g3b0b56`, `0.0.1778117719-gd7c638`, and `0.0.1778130306-g2889d9`). The connector must let users keep launching with plain `amp` while model execution uses connector-local Claude/Codex/Google provider accounts instead of Amp hosted credits.

## Neo thread-actor endpoint when using a local `amp.url`

Neo derives its Rivet/thread-actor endpoint from the configured Amp URL. With the stock hosted Amp URL, it uses:

```text
https://actors.ampcode.com
```

When `amp.url` points at the local connector (`http://localhost:8765`), Neo assumes a local RivetKit-compatible engine is available at:

```text
http://localhost:6420
```

The connector now starts a companion local Neo runtime on that port from `startRivetProxy(config)`. Users can keep launching Amp normally:

```sh
amp
```

No `RIVET_PUBLIC_ENDPOINT`, alias, or `--take-me-back` is required.

## Local ThreadActor/runtime

The default Neo runtime path is local, not hosted. `src/server/neo-local-runtime.ts` implements the current Rivet-compatible control plane:

- `/metadata`
- `/actors` GET/PUT/POST/DELETE
- WebSocket protocol using `rivet_encoding.json` and `rivet_actor.<actorId>` subprotocols
- `client_resume`, `client_update_thread_settings`, `client_append_user_msg`, `executor_connect`, executor bootstrap, tool registration, tool result, cancellation, and queue events
- Server events including `thread_settings`, `queued_messages`, `observers`, `executor_connected`, `message_added`, `agent_state`, `delta`, `tool_lease`, and `executor_tool_result_ack`

`src/server/neo-local-inference.ts` routes model calls through the existing connector providers:

- `smart` → Anthropic / `claude-opus-4-7`
- `rush` → Anthropic / `claude-haiku-4-5-20251001`
- `large` → Anthropic / `claude-opus-4-6`
- `deep` → OpenAI/Codex / `gpt-5.5`
- `settings["internal.model"]` can override the route, including `anthropic/...`, `openai/...`, and `google/...`

The inference adapter calls `routeRequest(...)` and `Provider.forward(...)` directly, so OAuth, account selection, model rewriting, Anthropic compatibility fixes, Codex conversion, and Google Cloud Code Assist wrapping stay centralized in the existing provider layer. It fails locally if no matching connector provider exists rather than falling back to Amp hosted inference.

Neo may send `agentMode` only on the first user message in a thread. The local actor therefore persists the effective mode on each user message and resolves the thread mode from `settings.agentMode`, then the first user message's `agentMode`, then the current mode. This keeps later turns in a deep-mode thread routed to Codex even when subsequent `client_append_user_msg` payloads omit `agentMode`.

The same persistence rule applies to reasoning effort. The actor resolves effective effort from the current message, `settings["reasoning.effort"]`, the first persisted user message, then the current actor state. That prevents later turns from silently falling back to the adapter default when Neo omits per-message `reasoningEffort`.

The runtime now waits for executor tool bootstrap before starting inference. This preserves Neo's tool behavior when `client_append_user_msg` arrives before `executor_tools_register`, which is common in execute mode.

## Tool, filesystem, and control-plane parity

The local runtime supports the core bidirectional executor loop:

- Model tool calls become Neo `tool_lease` events.
- `executor_tool_result` messages are persisted as user `tool_result` messages and acknowledged with `executor_tool_result_ack`.
- Tool loops continue with the same agent mode/reasoning effort after all pending tool results arrive.
- `executor_tool_approval_request` is converted into `tool_approval_queue`, and `client_tool_approval_response` is converted back into `executor_tool_approval_response`.
- `client_filesystem_read_directory` / `client_filesystem_read_file` relay to executor filesystem requests, and executor results are converted back into client result events.
- Executor plugin and artifact events are converted into server-side `plugin_message`, `artifact_upserted`, and `artifact_deleted` events.
- Basic UI controls are handled locally: queued-message removal/steering, message edit/truncate, read/unread, thread title, retry, cancellation, manual bash invocation, active-error dismissal, and remote executor spawn rejection.

## Persistence, cloud sync, and thread visibility

Local Neo thread state is persisted under:

```text
~/.local/share/ampcode-connector/neo-threads/
```

Each actor snapshot is saved as JSON and rendered as a Markdown transcript. The runtime reloads saved actors on restart, so reconnect/resume can reuse the prior actor id/name/key mapping.

The connector also serves local thread lookup/read endpoints before falling back to Amp upstream:

```text
GET /api/threads/find?q=<query>&local=1
GET /api/threads/<threadId>.md
GET /api/threads/<threadId>/export
```

This gives `read_thread`/`find_thread`-style surfaces and direct Markdown export for local Neo conversations.

The connector now also mirrors local Neo snapshots to Amp cloud using Amp's existing internal `uploadThread` API (`POST /api/internal?uploadThread`). The uploaded payload uses the classic thread data shape, including the local Neo messages, smart-generated title, sanitized environment metadata, version, and connector-local metadata. This restores the pre-Neo behavior where finished execute/interactive threads are visible through `ampcode.com` and through upstream `/api/threads/<threadId>`/`getThread` reads. If a local actor is recreated for an existing cloud thread and no local snapshot is present, the runtime attempts a `getThread` import before the WebSocket connects.

The connector also observes Amp's normal `POST /api/threads/sync` response. Download actions are imported into the local Neo store, and metadata actions update local cloud metadata. This restores periodic/on-demand cloud discovery for threads that Amp discovers through its upstream sync service, without changing the response returned to Amp CLI.

Neo `read_thread` calls are handled locally when the requested thread exists in the connector's Neo store. The local actor extracts the requested `T-...` id from the tool input, returns the exact matching Markdown transcript, and bypasses Amp CLI's local thread-service lookup. This prevents a current-thread/local-cache mismatch where Amp's built-in tool can report metadata for a different thread id even though the connector has the requested Neo transcript on disk. If the requested thread is not in the connector store, the tool call is still leased to Amp's executor normally.

Smart title generation mirrors Amp's classic ThreadWorker behavior: after the first user message, the runtime makes a connector-local Anthropic call with a forced `set_title` tool, emits a Neo `thread_title` event, persists the title, and re-syncs the cloud thread. Validation/exact-output boilerplate is stripped before title generation, but the connector does not enforce a word-count cap.

`GET /api/threads/<threadId>` without a local suffix is deliberately left to Amp upstream so Amp's normal thread-view/fork paths receive the cloud thread object rather than the connector's local export wrapper.

## Execute-mode completion details

Amp execute mode depends on a protocol-valid assistant `message_added` for the current active `agent_state` message id. The local runtime must therefore:

1. Emit an active `agent_state` (`streaming`) with the assistant `messageId` before the assistant message is added.
2. Normalize provider usage into Neo's required shape (`maxInputTokens`, `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `totalInputTokens`, `timestamp`). Raw Anthropic/OpenAI/Google usage fields can make Amp reject `delta`/`message_added` frames before execute mode sees them.
3. Emit the final assistant `message_added` with text content and complete state, then return `agent_state: idle`.

Validated smoke:

```sh
amp -m rush -x "Reply with exactly AMP_LOCAL_NEO_OK and nothing else."
# => AMP_LOCAL_NEO_OK

amp --stream-json -m rush -x "Reply with exactly AMP_LOCAL_NEO_JSON_OK and nothing else."
# emits assistant stop_reason=end_turn and result=AMP_LOCAL_NEO_JSON_OK

amp --dangerously-allow-all -m rush -x "Use the Bash tool to run 'printf TOOL_LOOP_OK'. Then reply with exactly the command output and nothing else."
# => TOOL_LOOP_OK

amp --stream-json --dangerously-allow-all -m rush -x "Use the Bash tool to run 'printf STREAM_TOOL_OK'. Then reply with exactly the command output and nothing else."
# emits a tool_use turn followed by result=STREAM_TOOL_OK
```

## Hosted fallback and limitation

The previous hosted actor bridge remains available for debugging only:

```sh
AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=1 bun run dev
```

Hosted Neo model execution currently happens inside Amp's hosted actor runtime. In that flow, the local connector sees Neo control-plane traffic but not provider HTTP calls such as `/api/provider/anthropic`, `/api/provider/openai/v1`, `/v1/messages`, or `/responses`.

Hybrid attempts failed to redirect hosted model calls back to the connector:

1. Public connector URL via Cloudflare Tunnel.
2. Extra actor creation fields (`ampUrl`, `ampURL`, `providerBaseUrl`, `settings.url`).
3. Extra `client_update_thread_settings` fields.

Unknown thread settings are schema-rejected with `INVALID_MESSAGE`, and actor creation extras are ignored. Avoiding Amp credits therefore requires the local runtime path unless Amp exposes a supported hosted BYO-provider endpoint.

## Neo-relevant endpoint handling

The connector treats these prefixes as Amp upstream/control-plane traffic rather than provider routes:

- `/api/thread-actors`
- `/api/attachments`
- `/api/v2`

Browser-facing `/v2/...` URLs redirect to the configured Amp upstream host so Amp cookies and auth remain scoped to the real Amp domain.

## Tool matrix changes

The refreshed local binary advertises `smart`, `deep`, `rush`, and `large`; `free` is no longer listed.

Important deltas:

- `large` is first-class.
- `mermaid` and `undo_edit` are absent from extracted built-in tool lists.
- `chart`, `glob`, `Grep`, and `task_list` are no longer in current `smart`/`large` tool sets; `rush` keeps them, and `deep` keeps `chart`.
- In `0.0.1778117719-gd7c638`, `look_at` is present in all four modes.
- In `0.0.1778130306-g2889d9`, configured MCP server tools appear directly in all mode tool lists as `mcp__server__tool` function tools. The generic `read_mcp_resource` built-in is still not listed for deep mode, but per-server MCP tools are.
- The top-level CLI help lists `skill add/list/remove/info` management commands again.

No connector hard-code is required for `look_at` or MCP tool names; Codex/Anthropic tool normalization preserves arbitrary function tools registered by Amp's executor.

## Validation

Run:

```sh
bunx tsc --noEmit
bun run test
amp -m rush -x "Reply with exactly AMP_LOCAL_NEO_OK and nothing else."
amp --stream-json -m rush -x "Reply with exactly AMP_LOCAL_NEO_JSON_OK and nothing else."
amp --dangerously-allow-all -m rush -x "Use the Bash tool to run 'printf TOOL_LOOP_OK'. Then reply with exactly the command output and nothing else."
amp --stream-json --dangerously-allow-all -m rush -x "Use the Bash tool to run 'printf STREAM_TOOL_OK'. Then reply with exactly the command output and nothing else."
curl 'http://localhost:8765/api/threads/find?q=TOOL_LOOP_OK&local=1'
curl 'http://localhost:8765/api/threads/<threadId>.md'
curl -X POST 'http://localhost:8765/api/internal?getThread' \
  -H 'content-type: application/json' \
  --data-binary '{"method":"getThread","params":{"thread":"<threadId>"}}'
```

Relevant coverage:

- `tests/middleware.test.ts` verifies Neo passthrough and `/v2` browser redirect classification.
- `tests/neo-local-runtime.test.ts` verifies protocol helpers, model routing, tool id normalization, Neo usage normalization, local thread persistence/export, and cloud upload payload conversion.

Classic handoff relationship parity is intentionally not restored for Neo: Amp's Neo announcement says handoff is gone and compaction replaces it. The connector does preserve applicable cloud parity around the primary Neo transcript path: messages, assistant usage, generated title, environment metadata, local export, cloud upload/read/import, `/api/threads/sync` download/import, local deletion when `deleteThread` or `DELETE /api/threads/:id` is used, local archive hiding on `archiveThread`, and local visibility metadata preservation on `setThreadMeta`/cloud import/sync metadata actions.
- Existing Codex/Anthropic tests verify provider normalization and handoff compatibility remain intact.
