# Connector-local inference through provider handlers

## Purpose

This note captures the least-risk way for a connector-managed local actor/runtime to make a single model call using the connector's existing OAuth provider handlers. The goal is to avoid duplicating Anthropic, Codex/OpenAI, or Google authentication and request-normalization code while keeping hosted Amp upstream fallback out of local actor execution.

## Implementation status

Implemented in `src/server/neo-local-inference.ts` and used by `src/server/neo-local-runtime.ts`:

- Local inference calls existing `Provider.forward(...)` handlers directly after `parseBody(...)` and `routeRequest(...)`.
- `smart`, `rush`, and `large` route to Anthropic Claude models; `deep` routes to Codex/OpenAI.
- `settings["internal.model"]` can override routes for Anthropic, OpenAI/Codex, and Google.
- Provider usage payloads are normalized with `normalizeNeoUsage(...)` before emitting Neo `delta` or `message_added` frames, because raw provider token fields are not accepted by Amp's Neo WebSocket schema.
- Local execution fails closed when no connector-local provider is available; it does not fall back to Amp hosted model execution.
- Executor tool bootstrap is awaited before inference so local model calls receive the real Amp tool registry.
- Tool-call loops now round-trip through Neo `tool_lease` / `executor_tool_result` and continue inference with the same agent mode.
- Thread snapshots are persisted, exposed through local `/api/threads/find`, `/api/threads/:id.md`, and `/api/threads/:id/export` endpoints, smart-titled with a connector-local Anthropic title call without a connector-enforced word cap, and mirrored to Amp cloud through `uploadThread` for normal `ampcode.com` visibility.

## Current provider API findings

All local model providers implement `Provider` from `src/providers/base.ts`:

```ts
forward(
  path: string,
  body: ParsedBody,
  headers: Headers,
  rewrite?: (data: string) => string,
  account?: number,
): Promise<Response>;
```

Important integration points:

- `src/server/body.ts` provides `parseBody(raw, subpath)`, which extracts `model`, `stream`, model rewrites, and the lazy parsed JSON used by providers.
- `src/routing/router.ts` maps Amp provider names to handlers:
  - `anthropic` -> `src/providers/anthropic.ts`
  - `openai` -> `src/providers/codex.ts`
  - `google` -> `src/providers/google.ts`
- `src/proxy/rewriter.ts` rewrites provider model names back to the Amp/local requested model and suppresses unsupported Anthropic thinking/tool-use combinations in responses.
- `src/routing/retry.ts` can preserve prompt-cache retries and reroute across accounts, but the server's final Amp upstream fallback should not be used for connector-local actors unless explicitly desired.

Provider-specific behavior:

- Anthropic expects the Anthropic Messages API at `/v1/messages`. The handler injects Claude Code billing metadata, strips `speed`, strips top-level `thinking` when forced tool choice is incompatible, and supplies Claude OAuth/CLI headers.
- OpenAI requests are handled by the Codex provider. Both `/v1/chat/completions` and `/v1/responses` map to ChatGPT's `/codex/responses`. The handler converts Chat Completions `messages[]` to Responses `input[]`, normalizes function tools, forces upstream streaming, and converts results back to Chat Completions when the caller used `/v1/chat/completions`.
- Google expects Vertex/Gemini `generateContent` style paths such as `/v1beta/models/{model}:generateContent`; the handler wraps requests in the Cloud Code Assist envelope. This is useful later, but it is not the smallest Anthropic/OpenAI actor MVP.

## Recommended least-risk adapter

Add a small in-process local inference adapter rather than changing the `Provider` interface or exporting private provider transforms. The adapter should:

1. Accept a normalized local actor request: provider, model, messages, registered tools, max tokens, and a stable actor/session id.
2. Build a provider-compatible JSON body for Anthropic or OpenAI.
3. Serialize the body and call `parseBody(raw, subpath)`.
4. Select an account with `routeRequest(providerName, model, config, actorSessionId)`.
5. If no local handler is available, return a local error. Do not fall back to Amp upstream by default.
6. Call `handler.forward(subpath, parsedBody, syntheticHeaders, rewrite, route.account)`.
7. Optionally reuse `tryWithCachePreserve`/`tryReroute` for `429`/`403`, but still stop with an error instead of calling `fallbackUpstream`.
8. Record `recordSuccess(route.pool, route.account)` on successful local responses.
9. Parse only the response shape produced by the chosen request format.

Minimal direct-call sketch:

```ts
const raw = JSON.stringify(providerBody);
const body = parseBody(raw, subpath);
const route = routeRequest(ampProviderName, body.ampModel, config, actorSessionId);
if (!route.handler) throw new Error(`No local ${ampProviderName} provider available`);

const headers = new Headers({
  "content-type": "application/json",
  "x-session-id": actorSessionId,
  ...(ampProviderName === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
});
const rewrite = body.ampModel ? rewriter.rewrite(body.ampModel) : undefined;
const response = await route.handler.forward(subpath, body, headers, rewrite, route.account);
```

This keeps authentication, model-name mapping, Codex body normalization, Anthropic billing injection, SSE handling, and response rewriting in the existing provider layer.

A loopback HTTP call to `/api/provider/{provider}/...` would reuse even more server code, but it also reuses server fallback behavior and costs an extra network hop inside the same process. If used, the actor path must explicitly prevent Amp upstream fallback for local-only inference.

## Building request bodies from registered tools and messages

Assume the actor has normalized inputs like:

```ts
interface ActorTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ActorMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
}
```

### Anthropic Messages body

Use `/v1/messages` and build the native Anthropic Messages shape:

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 2048,
  "stream": false,
  "system": [{ "type": "text", "text": "system/developer instructions" }],
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "Do the task" }] }
  ],
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web",
      "input_schema": {
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"]
      }
    }
  ],
  "tool_choice": { "type": "auto" }
}
```

Mapping rules:

- Combine `system` and `developer` actor messages into top-level `system` text blocks. Do not put system messages inside Anthropic `messages[]`.
- `user` text becomes `{ role: "user", content: [{ type: "text", text }] }`.
- `assistant` text becomes `{ role: "assistant", content: [{ type: "text", text }] }`.
- Assistant tool calls become Anthropic `tool_use` content blocks: `{ type: "tool_use", id, name, input }`.
- Tool results become user messages with `tool_result` blocks: `{ type: "tool_result", tool_use_id, content }`.
- Registered tools become `{ name, description, input_schema }`.
- MVP should use `tool_choice: { type: "auto" }`; forced `{ type: "tool", name }` can wait unless the actor needs it.

### OpenAI/Codex Chat Completions body

For MVP, prefer `/v1/chat/completions`. It is easiest to build from actor messages, and `src/providers/codex.ts` already converts it to the Responses API required by ChatGPT Codex:

```json
{
  "model": "gpt-5.2",
  "stream": false,
  "messages": [
    { "role": "system", "content": "system/developer instructions" },
    { "role": "user", "content": "Do the task" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web",
        "parameters": {
          "type": "object",
          "properties": { "query": { "type": "string" } },
          "required": ["query"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

Mapping rules:

- `system` and `developer` messages can be emitted as Chat Completions `system`/`developer` messages. The Codex handler turns the first one into Responses `instructions`.
- `user` text becomes `{ role: "user", content }`.
- `assistant` text becomes `{ role: "assistant", content }`.
- Assistant tool calls become `tool_calls` entries with JSON-stringified `function.arguments`.
- Tool results become `{ role: "tool", tool_call_id, content }`.
- Registered tools become Chat Completions function tools: `{ type: "function", function: { name, description, parameters } }`.
- Use `tool_choice: "auto"` for MVP. Function-forced choices can be mapped later with `{ type: "function", function: { name } }`.

Native `/v1/responses` bodies are also supported by the Codex provider and avoid the Chat Completions response transform, but they require the actor to build `instructions`, `input[]`, top-level function tools, and function-call outputs itself. Use them later if the actor needs Responses-specific fields such as `previous_response_id`.

## Implemented scope

The current local runtime supports:

- Anthropic `/v1/messages`, OpenAI/Codex `/v1/chat/completions`, and Google/Gemini `generateContent` bodies.
- Non-streaming provider calls (`stream: false`) with Neo-compatible `delta` and `message_added` output.
- Text user/assistant/system messages.
- JSON-schema function tool registration from Amp's executor bootstrap.
- Multi-turn tool execution loops via Amp's local executor.
- Local-only routing: fail closed when no OAuth provider/account is available instead of falling back to Amp upstream.
- Persistent actor conversation state, Markdown/JSON export, smart title generation, sanitized environment metadata, cloud mirroring through Amp's classic thread upload API, local delete/archive handling, and visibility metadata preservation.

## Later work

- Token-level streaming from providers into Neo deltas.
- Native OpenAI Responses request/response support.
- Multimodal/image/file content mapping.
- Forced tool choices, parallel tool-call scheduling refinements, strict schemas, and JSON-schema response formats.
- Local inference stats/telemetry separate from Amp proxy stats.
- Richer hosted Neo transcript sync/import if Amp exposes a first-class thread-actor API beyond classic thread upload.
