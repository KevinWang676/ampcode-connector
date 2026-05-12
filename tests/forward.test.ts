import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { codexHeaderValues, codexUserAgent } from "../src/constants.ts";
import { prepareBody as prepareAnthropicBody } from "../src/providers/anthropic.ts";
import { bufferResponseJson } from "../src/providers/codex-state.ts";
import { denied, type ForwardOptions, forward } from "../src/providers/forward.ts";
import { parseBody } from "../src/server/body.ts";

/** Minimal HTTP server that simulates provider responses. */
const baseUrl = "http://mock.local";
const originalFetch = globalThis.fetch;

// Track requests for assertions
const requests: { url: string; body: string; headers: Record<string, string> }[] = [];

// Configurable response behavior
const nextResponses: Array<{ status: number; body: string; headers?: Record<string, string> } | { error: Error }> = [];

function enqueue(status: number, body: string, headers?: Record<string, string>): void {
  nextResponses.push({ status, body, headers });
}

function enqueueError(error: Error): void {
  nextResponses.push({ error });
}

beforeAll(() => {
  globalThis.fetch = (async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const body = await req.text();
    const hdrs: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      hdrs[k] = v;
    });
    requests.push({ url: req.url, body, headers: hdrs });

    const next = nextResponses.shift();
    if (!next) return new Response("no mock configured", { status: 500 });
    if ("error" in next) throw next.error;

    return new Response(next.body, {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function opts(overrides?: Partial<ForwardOptions>): ForwardOptions {
  return {
    url: `${baseUrl}/test`,
    body: '{"prompt":"hello"}',
    streaming: false,
    headers: { "Content-Type": "application/json" },
    providerName: "TestProvider",
    ...overrides,
  };
}

function clearRequests(): void {
  requests.length = 0;
  nextResponses.length = 0;
}

function responseCompletedFromSse(text: string): Record<string, unknown> {
  const line = text.split("\n").find((entry) => entry.startsWith('data: {"type":"response.completed"'));
  if (!line) throw new Error("response.completed event not found");
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

describe("forward", () => {
  test("returns successful JSON response", async () => {
    clearRequests();
    enqueue(200, '{"result":"ok"}');

    const res = await forward(opts());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "ok" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toBe('{"prompt":"hello"}');
  });

  test("retries on 500 and eventually succeeds", async () => {
    clearRequests();
    enqueue(500, "server error");
    enqueue(500, "server error");
    enqueue(200, '{"result":"recovered"}');

    const res = await forward(opts());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "recovered" });
    expect(requests).toHaveLength(3);
  });

  test("retries on fetch error and eventually succeeds", async () => {
    clearRequests();
    enqueueError(new Error("ECONNRESET"));
    enqueue(200, '{"ok":true}');

    const res = await forward(opts());
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
  });

  test("returns error response on non-retryable 4xx", async () => {
    clearRequests();
    enqueue(422, '{"error":"validation"}');

    const res = await forward(opts());
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('{"error":"validation"}');
    expect(requests).toHaveLength(1);
  });

  test("returns 429 without retry (handled at routing layer)", async () => {
    clearRequests();
    enqueue(429, '{"error":"rate limited"}');

    const res = await forward(opts());
    expect(res.status).toBe(429);
    expect(requests).toHaveLength(1);
  });

  test("applies rewrite to non-streaming response", async () => {
    clearRequests();
    enqueue(200, '{"model":"real-model"}');

    const rewrite = (data: string) => data.replace("real-model", "fake-model");
    const res = await forward(opts({ rewrite }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"model":"fake-model"}');
  });

  test("logs email context on error", async () => {
    clearRequests();
    enqueue(403, '{"error":"forbidden"}');

    const res = await forward(opts({ email: "user@test.com" }));
    expect(res.status).toBe(403);
  });

  test("exhausts retries on persistent 500", async () => {
    clearRequests();
    enqueue(500, "fail");
    enqueue(500, "fail");
    enqueue(500, "fail");
    enqueue(500, "fail"); // attempt 0,1,2,3

    const res = await forward(opts());
    // After MAX_RETRIES (3), the 4th 500 is returned as-is
    expect(res.status).toBe(500);
    expect(requests).toHaveLength(4);
  });

  test("returns actionable Anthropic transport diagnostics after fetch retries are exhausted", async () => {
    clearRequests();
    enqueueError(new Error("ECONNRESET"));
    enqueueError(new Error("ECONNRESET"));
    enqueueError(new Error("ECONNRESET"));
    enqueueError(new Error("ECONNRESET"));

    const res = await forward(
      opts({
        providerName: "Anthropic",
      }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("connection_error");
    expect(body.error.message).toContain("Anthropic connection error after retries were exhausted.");
    expect(body.error.message).toContain("MTU");
  });

  test("strips unsupported Codex request fields before forwarding", async () => {
    clearRequests();
    enqueue(200, '{"result":"ok"}');

    const res = await forward(
      opts({
        providerName: "OpenAI Codex",
        body: JSON.stringify({
          model: "gpt-5.4",
          prompt_cache_retention: "24h",
          safety_identifier: "amp-user",
          stream: true,
          stream_options: { include_obfuscation: false },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(requests[0]!.body)).toEqual({ model: "gpt-5.4", stream: true });
  });

  test("backfills empty Codex streaming completed output from output_item.done events", async () => {
    clearRequests();
    enqueue(
      200,
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
      ].join("\n"),
      { "Content-Type": "text/event-stream" },
    );

    const res = await forward(
      opts({
        providerName: "OpenAI Codex",
        streaming: true,
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"response.completed"');
    expect(text).toContain('"output":[{"type":"message","id":"msg_1"');
    expect(text).toContain('"text":"hello"');
  });

  test("backfills missing Codex message output when completed output only has reasoning", async () => {
    clearRequests();
    enqueue(
      200,
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"{\\"goal\\":\\"continue\\"}"}]}}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"reasoning","id":"rs_1","summary":[]}],"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
      ].join("\n"),
      { "Content-Type": "text/event-stream" },
    );

    const res = await forward(
      opts({
        providerName: "OpenAI Codex",
        streaming: true,
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"reasoning","id":"rs_1"');
    expect(text).toContain('"type":"message","id":"msg_1"');
    expect(text).toContain("goal");
  });

  test("synthesizes missing Codex message output from output_text events", async () => {
    clearRequests();
    enqueue(
      200,
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}',
        "",
        'data: {"type":"response.content_part.added","output_index":1,"content_index":0,"part":{"type":"output_text","text":""}}',
        "",
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"{\\"goal\\":"}',
        "",
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"\\"continue\\"}"}',
        "",
        'data: {"type":"response.output_text.done","output_index":1,"content_index":0,"text":"{\\"goal\\":\\"continue\\"}"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"reasoning","id":"rs_1","summary":[]}],"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
      ].join("\n"),
      { "Content-Type": "text/event-stream" },
    );

    const res = await forward(
      opts({
        providerName: "OpenAI Codex",
        streaming: true,
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"reasoning","id":"rs_1"');
    expect(text).toContain('"type":"message","role":"assistant"');
    expect(text).toContain("goal");
  });

  test("compacts synthesized Codex streaming message content gaps", async () => {
    clearRequests();
    enqueue(
      200,
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}',
        "",
        'data: {"type":"response.content_part.added","output_index":1,"content_index":1,"part":{"type":"output_text","text":""}}',
        "",
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":1,"delta":"hello"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
      ].join("\n"),
      { "Content-Type": "text/event-stream" },
    );

    const res = await forward(
      opts({
        providerName: "OpenAI Codex",
        streaming: true,
        body: JSON.stringify({ model: "gpt-5.4", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    const completed = responseCompletedFromSse(await res.text());
    const response = completed.response as { output: Array<{ content?: unknown[] }> };
    expect(response.output[0]!.content).toEqual([{ type: "output_text", text: "hello", annotations: [] }]);
  });
});

describe("Codex headers", () => {
  test("builds a Codex CLI user agent with the supplied version", () => {
    expect(codexUserAgent("0.125.0")).toMatch(/^codex_cli_rs\/0\.125\.0 \(.+\)$/);
  });

  test("does not send the removed legacy Version header value", () => {
    expect("VERSION" in codexHeaderValues).toBe(false);
  });
});

describe("prepareAnthropicBody", () => {
  test("removes thinking when tool_choice forces a specific tool", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "create handoff context" }],
        speed: "fast",
        thinking: { type: "enabled", budget_tokens: 1024 },
        tool_choice: { type: "tool", name: "create_handoff_context" },
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as Record<string, unknown>;
    expect(prepared.thinking).toBeUndefined();
    expect(prepared.speed).toBeUndefined();
    // tool_choice.name is rewritten to the Claude Code MCP convention so api.anthropic.com
    // bills against the Max subscription. The response rewriter strips the prefix back.
    expect(prepared.tool_choice).toEqual({ type: "tool", name: "mcp__amp__create_handoff_context" });
  });

  test("keeps thinking when tool_choice is auto", () => {
    const thinking = { type: "enabled", budget_tokens: 1024 };
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "normal request" }],
        thinking,
        tool_choice: { type: "auto" },
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as Record<string, unknown>;
    expect(prepared.thinking).toEqual(thinking);
  });

  test("injects billing header and Claude Code identity as the first two system blocks", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello world" }],
        system: [{ type: "text", text: "You are an Amp coding agent." }],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as { system: Array<{ type: string; text: string }> };
    expect(prepared.system[0]?.text).toMatch(
      /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
    expect(prepared.system[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(prepared.system[2]?.text).toBe("You are an Amp coding agent.");
  });

  test("wraps a string system prompt into [billing, identity, original] blocks", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
        system: "Original Amp system prompt.",
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as { system: Array<{ type: string; text: string }> };
    expect(prepared.system).toHaveLength(3);
    expect(prepared.system[0]?.text).toContain("x-anthropic-billing-header: cc_version=");
    expect(prepared.system[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(prepared.system[2]?.text).toBe("Original Amp system prompt.");
  });

  test("dedupes existing billing header and Claude Code identity blocks", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=stale; cc_entrypoint=cli; cch=00000;" },
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: "Real system content." },
        ],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as { system: Array<{ type: string; text: string }> };
    expect(prepared.system).toHaveLength(3);
    expect(prepared.system[0]?.text).toMatch(/^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3};/);
    expect(prepared.system[0]?.text).not.toContain("stale");
    expect(prepared.system[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(prepared.system[2]?.text).toBe("Real system content.");
  });

  test("populates metadata.user_id when supplied", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body, "abc123")) as { metadata?: { user_id?: string } };
    expect(prepared.metadata?.user_id).toBe("abc123");
  });

  test("preserves caller-provided metadata.user_id over derived one", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "amp-supplied" },
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body, "derived")) as { metadata?: { user_id?: string } };
    expect(prepared.metadata?.user_id).toBe("amp-supplied");
  });

  test("does not mutate cached body.parsed when rewriting tool names", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "oracle", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
          },
        ],
        tools: [{ name: "oracle", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "oracle" },
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      tools: Array<{ name: string }>;
      tool_choice: { name: string };
      messages: Array<{ content: Array<{ name?: string }> }>;
    };

    // Outbound body sent to Anthropic must use the MCP-prefixed names.
    expect(prepared.tools[0]?.name).toBe("mcp__amp__oracle");
    expect(prepared.tool_choice.name).toBe("mcp__amp__oracle");
    expect(prepared.messages[0]?.content[0]?.name).toBe("mcp__amp__oracle");

    // Cached body.parsed must remain pristine so reroute/retry passes operate on
    // the original Amp-shaped names, and so amp's request graph isn't observably
    // altered by the connector.
    const cached = body.parsed as {
      tools: Array<{ name: string }>;
      tool_choice: { name: string };
      messages: Array<{ content: Array<{ name?: string }> }>;
    };
    expect(cached.tools[0]?.name).toBe("oracle");
    expect(cached.tool_choice.name).toBe("oracle");
    expect(cached.messages[0]?.content[0]?.name).toBe("oracle");
  });
});

describe("prepareAnthropicBody — thinking block stripping (fixes Librarian 'Invalid signature in thinking block' 400)", () => {
  test("removes thinking blocks from assistant messages in history", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "user", content: "what's in /etc/hosts?" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "I should read the file first",
                signature: "EuYBCkQYAiJBfh7XQ8a4...VALID_LOOKING_SIG_FROM_PRIOR_TURN...",
              },
              { type: "text", text: "Let me read the file." },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/etc/hosts" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "127.0.0.1 localhost" }],
          },
        ],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };

    // The assistant turn must no longer contain a thinking block — its
    // signature would no longer validate against the new system prompt
    // injected by prepareBody (cch hash + Claude Code identity).
    const assistant = prepared.messages[1]!;
    expect(assistant.role).toBe("assistant");
    const types = assistant.content.map((b) => b.type);
    expect(types).not.toContain("thinking");
    // Tool_use and text are preserved exactly.
    expect(types).toContain("text");
    expect(types).toContain("tool_use");
  });

  test("removes redacted_thinking blocks (Anthropic's masked variant) from messages", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "encrypted-bytes" },
              { type: "text", text: "Doing it." },
            ],
          },
        ],
      }),
      "/v1/messages",
    );
    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    const types = prepared.messages[1]!.content.map((b) => b.type);
    expect(types).not.toContain("redacted_thinking");
    expect(types).toContain("text");
  });

  test("messages without thinking blocks pass through unchanged in shape", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      }),
      "/v1/messages",
    );
    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    expect(prepared.messages[1]!.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("empty content arrays survive (no crash, no spurious mutation)", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [] },
        ],
      }),
      "/v1/messages",
    );
    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(prepared.messages[1]!.content).toEqual([]);
  });

  test("string-content messages (no array) pass through untouched", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "answer" },
        ],
      }),
      "/v1/messages",
    );
    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(prepared.messages[1]!.content).toBe("answer");
  });

  test("multi-turn history with thinking on every assistant turn — all stripped, tool_use chain intact", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "user", content: "find foo" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "search...", signature: "sig-1" },
              { type: "tool_use", id: "tu-1", name: "Grep", input: { pattern: "foo" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-1", content: "match in a.ts" }],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "now read it", signature: "sig-2" },
              { type: "tool_use", id: "tu-2", name: "Read", input: { path: "a.ts" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-2", content: "..." }],
          },
        ],
      }),
      "/v1/messages",
    );
    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      messages: Array<{ role: string; content: Array<{ type: string; id?: string }> }>;
    };
    // Every assistant turn must have its thinking stripped.
    const assistant1 = prepared.messages[1]!;
    expect(assistant1.content.map((b) => b.type)).toEqual(["tool_use"]);
    expect(assistant1.content[0]?.id).toBe("tu-1");
    const assistant2 = prepared.messages[3]!;
    expect(assistant2.content.map((b) => b.type)).toEqual(["tool_use"]);
    expect(assistant2.content[0]?.id).toBe("tu-2");
    // Tool_result user turns are untouched.
    expect((prepared.messages[2]!.content[0] as { type: string }).type).toBe("tool_result");
    expect((prepared.messages[4]!.content[0] as { type: string }).type).toBe("tool_result");
  });
});

describe("bufferResponseJson", () => {
  test("synthesizes handoff message output while buffering Codex SSE", async () => {
    const response = new Response(
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}',
        "",
        'data: {"type":"response.content_part.added","output_index":1,"content_index":0,"part":{"type":"output_text","text":""}}',
        "",
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"{\\"goal\\":"}',
        "",
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"\\"continue\\"}"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"reasoning","id":"rs_1","summary":[]}],"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
      ].join("\n"),
      { headers: { "Content-Type": "text/event-stream" } },
    );

    const fullResponse = await bufferResponseJson(response);
    expect(fullResponse?.output).toEqual([
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: '{"goal":"continue"}', annotations: [] }],
        status: "completed",
      },
    ]);
  });

  test("compacts synthesized Codex buffered message content gaps", async () => {
    const response = new Response(
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        "",
        'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}',
        "",
        'data: {"type":"response.content_part.added","output_index":1,"content_index":1,"part":{"type":"output_text","text":""}}',
        "",
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":1,"delta":"hello"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
        "",
      ].join("\n"),
      { headers: { "Content-Type": "text/event-stream" } },
    );

    const fullResponse = await bufferResponseJson(response);
    expect(fullResponse?.output).toEqual([
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
        status: "completed",
      },
    ]);
  });
});

describe("end-to-end cache_control survival: buildAnthropicInferenceBody → prepareAnthropicBody (the exact flow `inferAnthropic` follows)", () => {
  test("a body produced by the neo-local inference builder reaches the wire with all 3 cache breakpoints intact", async () => {
    // Lazy import to avoid forcing neo-local-runtime test deps into this file.
    const { buildAnthropicInferenceBody } = await import("../src/server/neo-local-inference.ts");

    const inferenceBody = buildAnthropicInferenceBody(
      "claude-opus-4-7",
      {
        actorId: "actor-1",
        threadId: "T-cache-1",
        agentMode: "smart",
        settings: {},
        history: [{ role: "user", text: "explain the codebase" }],
        tools: [
          { name: "Read", description: "read a file", inputSchema: { type: "object", properties: {} } },
          { name: "Bash", description: "run a shell command", inputSchema: { type: "object", properties: {} } },
        ],
        environment: { workingDirectory: "/home/u/proj" },
      },
      true,
    );

    // Serialize through parseBody (the boundary inferAnthropic uses) and run
    // the same prepareAnthropicBody that the live forward path runs.
    const body = parseBody(JSON.stringify(inferenceBody), "/v1/messages");
    const onWire = JSON.parse(prepareAnthropicBody(body)) as {
      cache_control?: { type: string };
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      tools: Array<{ name: string; cache_control?: { type: string } }>;
      messages: unknown[];
    };

    // 1. Top-level cache_control survives → Anthropic's automatic caching is
    //    enabled (sliding breakpoint on the latest user/tool_result block).
    expect(onWire.cache_control).toEqual({ type: "ephemeral" });

    // 2. injectClaudeCodeSystem prepended [billing, identity] BEFORE the
    //    locally-built system block. The cache_control marker we set in
    //    buildAnthropicInferenceBody MUST still be on the array tail so the
    //    cached prefix covers [billing, identity, systemPrompt].
    expect(onWire.system).toHaveLength(3);
    expect(onWire.system[0]?.text).toMatch(/^x-anthropic-billing-header:/);
    expect(onWire.system[0]?.cache_control).toBeUndefined();
    expect(onWire.system[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(onWire.system[1]?.cache_control).toBeUndefined();
    expect(onWire.system[2]?.text).toContain("You are Amp");
    expect(onWire.system[2]?.cache_control).toEqual({ type: "ephemeral" });

    // 3. The last tool definition's cache_control survives tool-name rewriting
    //    (Read and Bash are Claude Code builtins → no prefix → unchanged
    //    names, but the marker is still there).
    expect(onWire.tools).toHaveLength(2);
    expect(onWire.tools[0]?.name).toBe("Read");
    expect(onWire.tools[0]?.cache_control).toBeUndefined();
    expect(onWire.tools[1]?.name).toBe("Bash");
    expect(onWire.tools[1]?.cache_control).toEqual({ type: "ephemeral" });

    // 4. Total cache_control slots used = 3 (top-level + system + last tool),
    //    well under Anthropic's 4-marker hard cap.
    const markerCount =
      (onWire.cache_control ? 1 : 0) +
      onWire.system.filter((s) => s.cache_control).length +
      onWire.tools.filter((t) => t.cache_control).length;
    expect(markerCount).toBe(3);
    expect(markerCount).toBeLessThanOrEqual(4);
  });

  test("Amp-custom tool names (oracle, create_handoff_context) get the mcp__amp__ prefix BUT keep their cache_control marker", async () => {
    const { buildAnthropicInferenceBody } = await import("../src/server/neo-local-inference.ts");
    const inferenceBody = buildAnthropicInferenceBody(
      "claude-opus-4-7",
      {
        actorId: "actor-1",
        threadId: "T-cache-2",
        agentMode: "smart",
        settings: {},
        history: [{ role: "user", text: "audit the codebase" }],
        tools: [
          { name: "Read", description: "", inputSchema: { type: "object", properties: {} } },
          { name: "oracle", description: "", inputSchema: { type: "object", properties: {} } },
        ],
      },
      true,
    );
    const body = parseBody(JSON.stringify(inferenceBody), "/v1/messages");
    const onWire = JSON.parse(prepareAnthropicBody(body)) as {
      tools: Array<{ name: string; cache_control?: { type: string } }>;
    };

    // Read is a Claude Code builtin and passes through; oracle is Amp-custom
    // and gets the mcp__amp__ prefix. The cache marker on the last entry
    // (oracle) must survive the rename.
    expect(onWire.tools[0]?.name).toBe("Read");
    expect(onWire.tools[1]?.name).toBe("mcp__amp__oracle");
    expect(onWire.tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("the wire body is byte-stable across two identical agent turns (cache prefix-hash will match)", async () => {
    // Anthropic caches by exact prefix hash. If anything in the wire body
    // varies between two identical inputs (timestamps, random ids, key
    // ordering, etc.) we never get a cache hit. This test asserts the full
    // pipeline (buildAnthropicInferenceBody → parseBody → prepareAnthropicBody)
    // produces the same bytes for the same inputs.
    const { buildAnthropicInferenceBody } = await import("../src/server/neo-local-inference.ts");
    const buildOnce = (): string => {
      const inferenceBody = buildAnthropicInferenceBody(
        "claude-opus-4-7",
        {
          actorId: "actor-1",
          threadId: "T-cache-3",
          agentMode: "smart",
          settings: {},
          history: [{ role: "user", text: "explain the codebase" }],
          tools: [{ name: "Read", description: "", inputSchema: { type: "object", properties: {} } }],
          environment: { workingDirectory: "/home/u/proj" },
        },
        true,
      );
      const body = parseBody(JSON.stringify(inferenceBody), "/v1/messages");
      return prepareAnthropicBody(body);
    };
    expect(buildOnce()).toBe(buildOnce());
  });
});

describe("prepareAnthropicBody — prompt cache_control wiring (fixes 10× Max-subscription burn vs `amp --take-me-back`)", () => {
  test("attaches cache_control to the LAST system block when upstream sent none", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "explain the codebase" }],
        system: [{ type: "text", text: "You are an Amp coding agent." }],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };

    // Defensive marker MUST land on the final system block (the original
    // upstream content), NOT on the billing header — the billing classifier
    // rejects requests that put cache_control on the first block.
    expect(prepared.system).toHaveLength(3);
    expect(prepared.system[0]?.text).toMatch(/^x-anthropic-billing-header:/);
    expect(prepared.system[0]?.cache_control).toBeUndefined();
    expect(prepared.system[1]?.cache_control).toBeUndefined();
    expect(prepared.system[2]?.text).toBe("You are an Amp coding agent.");
    expect(prepared.system[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("attaches cache_control to the identity block when upstream system is empty", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hello" }],
        // No `system` field at all.
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };

    expect(prepared.system).toHaveLength(2);
    expect(prepared.system[0]?.text).toMatch(/^x-anthropic-billing-header:/);
    expect(prepared.system[0]?.cache_control).toBeUndefined();
    // Identity block is the array tail → it gets the marker.
    expect(prepared.system[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(prepared.system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves upstream cache_control markers untouched (no double-marking)", () => {
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        system: [
          { type: "text", text: "Stable preamble." },
          {
            type: "text",
            text: "Upstream-marked content.",
            cache_control: { type: "ephemeral" },
          },
        ],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };

    // Upstream already supplied a marker → defensive logic is a no-op.
    expect(prepared.system).toHaveLength(4);
    expect(prepared.system[0]?.cache_control).toBeUndefined();
    expect(prepared.system[1]?.cache_control).toBeUndefined();
    expect(prepared.system[2]?.cache_control).toBeUndefined();
    expect(prepared.system[3]?.text).toBe("Upstream-marked content.");
    expect(prepared.system[3]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("never attaches cache_control to the billing header itself", () => {
    // Pathological case: upstream sent ONLY blocks that get filtered out
    // (legacy claude-code identity), so after the prepend+filter the array
    // would be just `[billing, identity]`. The marker MUST land on identity.
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=stale; cc_entrypoint=cli; cch=00000;" },
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };

    expect(prepared.system).toHaveLength(2);
    expect(prepared.system[0]?.text).toMatch(/^x-anthropic-billing-header:/);
    expect(prepared.system[0]?.cache_control).toBeUndefined();
    expect(prepared.system[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(prepared.system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves a top-level cache_control field through prepareBody", () => {
    // The neo-local inference path sets `cache_control: { type: "ephemeral" }`
    // at the top level (Anthropic's automatic-caching feature). Verify it
    // round-trips through prepareBody so the message-level cache breakpoint
    // actually reaches api.anthropic.com.
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        cache_control: { type: "ephemeral" },
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text", text: "Amp system." }],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      cache_control?: { type: string };
      system: Array<{ cache_control?: { type: string } }>;
    };

    expect(prepared.cache_control).toEqual({ type: "ephemeral" });
    // System still gets its defensive marker — both breakpoints coexist.
    expect(prepared.system[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves cache_control on tool definitions (last tool keeps its marker)", () => {
    // Mirrors the body shape `buildAnthropicInferenceBody` produces in the neo
    // path. prepareAnthropicBody must not strip or reshape the tools array in
    // a way that drops the cache marker.
    const body = parseBody(
      JSON.stringify({
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "Read", description: "", input_schema: { type: "object" } },
          {
            name: "Bash",
            description: "",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral" },
          },
        ],
      }),
      "/v1/messages",
    );

    const prepared = JSON.parse(prepareAnthropicBody(body)) as {
      tools: Array<{ name: string; cache_control?: { type: string } }>;
    };

    expect(prepared.tools).toHaveLength(2);
    expect(prepared.tools[0]?.cache_control).toBeUndefined();
    expect(prepared.tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("denied", () => {
  test("returns 401 with provider name", async () => {
    const res = denied("Anthropic");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Anthropic");
    expect(body.error.message).toContain("login");
  });
});
