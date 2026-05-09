import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudThreadFromActor } from "../src/server/neo-cloud-sync.ts";
import { LocalThreadActor, localFindThreadRun, localReadThreadRun } from "../src/server/neo-local-actor.ts";
import {
  anthropicMaxOutputTokens,
  googleMaxOutputTokens,
  parseAnthropicSse,
  parseOpenAISse,
  selectModelRoute,
} from "../src/server/neo-local-inference.ts";
import { NeoLocalPersistence, type PersistedActorState } from "../src/server/neo-local-persistence.ts";
import {
  actorRecord,
  decodeThreadMessage,
  encodeThreadMessage,
  extractThreadIdFromActorBody,
  normalizeNeoUsage,
  normalizeToolCallId,
} from "../src/server/neo-protocol.ts";

describe("Neo local protocol helpers", () => {
  test("encodes the ThreadActor protocol as JSON strings", () => {
    const encoded = encodeThreadMessage({ type: "agent_state", state: "idle" });
    expect(encoded).toBe('{"type":"agent_state","state":"idle"}');
    expect(decodeThreadMessage(encoded)).toEqual({ type: "agent_state", state: "idle" });
  });

  test("extracts thread ids from actor creation bodies", () => {
    expect(extractThreadIdFromActorBody({ input: { threadId: "T-12345678-1234-1234-1234-123456789abc" } }, null)).toBe(
      "T-12345678-1234-1234-1234-123456789abc",
    );
    expect(extractThreadIdFromActorBody({}, "neo/T-abcdef12-1234-1234-1234-abcdef123456")).toBe(
      "T-abcdef12-1234-1234-1234-abcdef123456",
    );
  });

  test("normalizes provider tool ids into Neo ids", () => {
    expect(normalizeToolCallId("TU-1234567890123456789012")).toBe("TU-1234567890123456789012");
    expect(normalizeToolCallId("toolu_abc")).toMatch(/^TU-[0-9A-Za-z]{22}$/);
  });

  test("normalizes provider usage into Neo's required token shape", () => {
    expect(
      normalizeNeoUsage({
        input_tokens: 12,
        output_tokens: 3,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 5,
      }),
    ).toMatchObject({
      maxInputTokens: 0,
      inputTokens: 12,
      outputTokens: 3,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 5,
      totalInputTokens: 21,
    });
  });
});

describe("Neo local persistence", () => {
  test("saves, finds, renders, and deletes local thread snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-local-test-"));
    try {
      const store = new NeoLocalPersistence(dir);
      const threadId = "T-12345678-1234-1234-1234-123456789abc";
      const record = actorRecord("actor-test", "thread-actor", "key", "2026-05-07T00:00:00.000Z");
      store.saveActor({
        version: 1,
        id: "actor-test",
        name: "thread-actor",
        key: "key",
        record,
        updatedAt: "2026-05-07T00:00:00.000Z",
        snapshot: {
          version: 1,
          actorId: "actor-test",
          threadId,
          settings: {},
          messages: [
            {
              threadId,
              role: "user",
              messageId: "M-1234567890123456789012",
              content: [{ type: "text", text: "hello persisted neo" }],
              seq: 1,
            },
          ],
          history: [{ role: "user", text: "hello persisted neo" }],
          queue: [],
          seq: 2,
          agentState: "idle",
          environment: {},
          title: null,
          updatedAt: "2026-05-07T00:00:00.000Z",
        },
      });

      expect(store.findByThreadId(threadId)?.id).toBe("actor-test");
      expect(store.findThreads("persisted", 10, 0)[0]?.id).toBe(threadId);
      expect(store.markdownForThread(threadId)).toContain("hello persisted neo");
      store.deleteActor("actor-test");
      expect(store.findByThreadId(threadId)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serves read_thread locally by exact requested thread id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-local-read-thread-test-"));
    try {
      const store = new NeoLocalPersistence(dir);
      const targetThreadId = "T-32345678-1234-1234-1234-123456789abc";
      const currentThreadId = "T-42345678-1234-1234-1234-123456789abc";
      store.importCloudThread({
        id: targetThreadId,
        title: "Target",
        messages: [{ role: "user", content: [{ type: "text", text: "target content" }] }],
      });
      store.importCloudThread({
        id: currentThreadId,
        title: "Current",
        messages: [{ role: "user", content: [{ type: "text", text: "current content" }] }],
      });

      const run = await localReadThreadRun({ threadID: `https://ampcode.com/threads/${targetThreadId}` }, store);
      expect(run?.threadID).toBe(targetThreadId);
      expect(run?.result).toContain(`Thread: ${targetThreadId}`);
      expect(run?.result).toContain("target content");
      expect(run?.result).not.toContain("current content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compacts local read_thread output to avoid context overflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-local-read-thread-compact-test-"));
    try {
      const store = new NeoLocalPersistence(dir);
      const threadId = "T-62345678-1234-1234-1234-123456789abc";
      store.importCloudThread({
        id: threadId,
        title: "Huge Thread",
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "x".repeat(200_000), signature: `gAAAAAB${"x".repeat(1_000)}` }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseID: "TU-1",
                run: { output: `<loaded_skill name="x">${"skill".repeat(20_000)}</loaded_skill> useful result` },
              },
            ],
          },
        ],
      });

      const run = await localReadThreadRun({ threadID: threadId }, store);
      expect(String(run?.result).length).toBeLessThanOrEqual(80_000);
      expect(run?.result).not.toContain("gAAAAAB");
      expect(run?.result).not.toContain("skill".repeat(100));
      expect(run?.result).toContain("useful result");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serves find_thread locally when local Neo threads match", () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-local-find-thread-test-"));
    try {
      const store = new NeoLocalPersistence(dir);
      const threadId = "T-52345678-1234-1234-1234-123456789abc";
      store.importCloudThread({
        id: threadId,
        title: "Needle Thread",
        messages: [{ role: "user", content: [{ type: "text", text: "unique needle phrase" }] }],
      });

      const run = localFindThreadRun({ query: "needle", limit: 5 }, store);
      expect(run?.result).toContain(threadId);
      expect(run?.threads).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: threadId, title: "Needle Thread" })]),
      );
      expect(localFindThreadRun({ query: "missing", limit: 5 }, store)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("imports Amp sync downloaded cloud threads into local snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-local-sync-test-"));
    try {
      const store = new NeoLocalPersistence(dir);
      const threadId = "T-22345678-1234-1234-1234-123456789abc";
      const imported = store.importCloudThread({
        id: threadId,
        v: 7,
        title: "Downloaded thread",
        agentMode: "large",
        env: { initial: { workspaceRoot: "/repo" } },
        meta: { visibility: "private" },
        messages: [
          {
            role: "user",
            messageId: "M-2234567890123456789011",
            content: [{ type: "text", text: "download me" }],
            agentMode: "large",
          },
          {
            role: "assistant",
            messageId: "M-2234567890123456789012",
            content: [{ type: "text", text: "synced locally" }],
          },
        ],
      });

      expect(imported?.snapshot.threadId).toBe(threadId);
      expect(store.findByThreadId(threadId)?.snapshot.settings.agentMode).toBe("large");
      expect(store.findThreads("synced locally", 10, 0)[0]?.title).toBe("Downloaded thread");
      expect(store.markdownForThread(threadId)).toContain("download me");
      expect(store.findByThreadId(threadId)?.snapshot.cloud?.meta).toEqual({ visibility: "private" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Neo local cancellation", () => {
  test("emits a cancelled assistant message and idle state for active inference", () => {
    const sent: unknown[] = [];
    const actor = new LocalThreadActor({
      config: {
        hostname: "localhost",
        port: 8765,
        ampUpstreamUrl: "https://ampcode.com",
        logLevel: "error",
        providers: { anthropic: true, codex: true, google: true },
      },
      actorId: "actor-cancel-test",
      threadId: "T-72345678-1234-1234-1234-123456789abc",
    });
    const ws = { readyState: WebSocket.OPEN, send: (value: string) => sent.push(JSON.parse(value)) };
    actor.open(ws as never);
    sent.length = 0;

    (actor as unknown as { activeAssistantMessageId: string; cancel(): void }).activeAssistantMessageId =
      "M-activecancel1234567890";
    (actor as unknown as { cancel(): void }).cancel();

    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message_added",
          message: expect.objectContaining({
            messageId: "M-activecancel1234567890",
            state: expect.objectContaining({ type: "cancelled" }),
          }),
        }),
        expect.objectContaining({ type: "delta", messageId: "M-activecancel1234567890", state: "cancelled" }),
        expect.objectContaining({ type: "agent_state", state: "idle", messageId: "M-activecancel1234567890" }),
      ]),
    );
  });
});

describe("Neo cloud sync shape", () => {
  test("converts persisted Neo snapshots into Amp uploadThread payloads", () => {
    const threadId = "T-12345678-1234-1234-1234-123456789abc";
    const actor: PersistedActorState = {
      version: 1,
      id: "actor-test",
      name: "thread-actor",
      key: threadId,
      record: actorRecord("actor-test", "thread-actor", threadId, "2026-05-07T00:00:00.000Z"),
      updatedAt: "2026-05-07T00:00:01.000Z",
      snapshot: {
        version: 1,
        actorId: "actor-test",
        threadId,
        settings: {},
        messages: [
          {
            threadId,
            role: "user",
            agentMode: "deep",
            messageId: "M-1234567890123456789011",
            content: [{ type: "text", text: "first deep turn" }],
            seq: 3,
          },
          {
            threadId,
            role: "assistant",
            messageId: "M-1234567890123456789012",
            content: [{ type: "text", text: "cloud sync" }],
            seq: 4,
          },
        ],
        history: [{ role: "assistant", text: "cloud sync" }],
        queue: [],
        seq: 5,
        agentState: "idle",
        environment: {},
        title: "Cloud sync",
        updatedAt: "2026-05-07T00:00:01.000Z",
      },
    };

    const cloud = cloudThreadFromActor(actor);
    expect(cloud).toMatchObject({
      id: threadId,
      v: 5,
      title: "Cloud sync",
      agentMode: "deep",
      meta: { ampcodeConnectorLocalNeo: true },
    });
    expect(cloud.messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: [{ type: "text", text: "cloud sync" }],
          state: { type: "complete", stopReason: "end_turn" },
          messageId: "M-1234567890123456789012",
          protocolMessageID: "M-1234567890123456789012",
        },
      ]),
    );
  });
});

describe("Neo local model routing", () => {
  test("matches Amp modes to connector-local providers", () => {
    expect(selectModelRoute("smart", {})).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
    expect(selectModelRoute("deep", {})).toEqual({ provider: "openai", model: "gpt-5.5" });
    expect(selectModelRoute("rush", {})).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });

  test("honors internal.model overrides", () => {
    expect(selectModelRoute("smart", { "internal.model": "google/gemini-3-pro-preview" })).toEqual({
      provider: "google",
      model: "gemini-3-pro-preview",
    });
    expect(selectModelRoute("deep", { "internal.model": { deep: "openai:gpt-5.4" } })).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });
});

describe("Neo provider max_tokens caps", () => {
  test("Anthropic uses model-specific output ceilings well above the old 8192 cap", () => {
    expect(anthropicMaxOutputTokens("claude-haiku-4-5-20251001")).toBeGreaterThanOrEqual(32000);
    expect(anthropicMaxOutputTokens("claude-opus-4-7")).toBeGreaterThanOrEqual(32000);
    expect(anthropicMaxOutputTokens("claude-opus-4-6")).toBeGreaterThanOrEqual(32000);
    expect(anthropicMaxOutputTokens("unknown-future-model")).toBeGreaterThanOrEqual(32000);
  });

  test("Google sets an explicit maxOutputTokens above the legacy 8192 default", () => {
    expect(googleMaxOutputTokens("gemini-3-pro-preview")).toBeGreaterThanOrEqual(32000);
    expect(googleMaxOutputTokens("gemini-2.5-flash")).toBeGreaterThanOrEqual(32000);
    expect(googleMaxOutputTokens("unknown-future-gemini")).toBeGreaterThanOrEqual(32000);
  });
});

describe("Neo Anthropic SSE parser", () => {
  function buildSse(events: Array<Record<string, unknown>>): string {
    return `${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
  }

  function sseResponse(body: string): Response {
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }

  test("reassembles tool_use input across many input_json_delta chunks (>8192 chars)", async () => {
    // Simulate a create_file invocation whose `content` field is ~12 KB —
    // larger than the historical 8192-token cap and large enough to be split
    // across many input_json_delta events. Asserts the parser stitches them
    // back into valid JSON.
    const bigContent = "print('hello world')\n".repeat(600);
    const fullInput = JSON.stringify({ path: "/tmp/big.py", content: bigContent });
    expect(fullInput.length).toBeGreaterThan(8192);

    const events: Array<Record<string, unknown>> = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_test_1", name: "create_file", input: {} },
      },
    ];

    const chunkSize = 512;
    for (let i = 0; i < fullInput.length; i += chunkSize) {
      events.push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: fullInput.slice(i, i + chunkSize) },
      });
    }

    events.push({ type: "content_block_stop", index: 0 });
    events.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5000 },
    });
    events.push({ type: "message_stop" });

    const result = await parseAnthropicSse(sseResponse(buildSse(events)), "claude-opus-4-7", {});
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("create_file");
    expect(result.toolCalls[0]?.input).toEqual({ path: "/tmp/big.py", content: bigContent });
    expect(result.toolCalls[0]?.input.error).toBeUndefined();
    expect(result.toolCalls[0]?.input.partial).toBeUndefined();
  });

  test("surfaces a structured error when stop_reason=max_tokens truncates the tool input", async () => {
    // Simulate the original failure mode: the model emits a partial JSON for
    // create_file but the response is cut off by max_tokens before the closing
    // braces and content_block_stop arrive.
    const truncated = '{"path":"/tmp/big.py","content":"def f0():\\n    print(0)\\n';
    const events: Array<Record<string, unknown>> = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_trunc_1", name: "create_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: truncated },
      },
      // No content_block_stop — stream cut off.
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 8192 },
      },
      { type: "message_stop" },
    ];

    const result = await parseAnthropicSse(sseResponse(buildSse(events)), "claude-opus-4-7", {});
    expect(result.toolCalls).toHaveLength(1);
    const input = result.toolCalls[0]?.input as Record<string, unknown>;
    expect(typeof input.error).toBe("string");
    expect(String(input.error)).toContain("max_tokens");
    expect(input.partial).toBe(truncated);
  });
});

describe("Neo OpenAI SSE parser", () => {
  function sseResponse(events: Array<Record<string, unknown>>): Response {
    const body = `${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }

  test("reassembles tool_calls.function.arguments across many deltas (>8192 chars)", async () => {
    const bigContent = "print('hello world')\n".repeat(600);
    const fullArgs = JSON.stringify({ path: "/tmp/big.py", content: bigContent });
    expect(fullArgs.length).toBeGreaterThan(8192);

    const events: Array<Record<string, unknown>> = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call_test_1", type: "function", function: { name: "create_file", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
    ];

    const chunkSize = 512;
    for (let i = 0; i < fullArgs.length; i += chunkSize) {
      events.push({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: fullArgs.slice(i, i + chunkSize) } }] },
            finish_reason: null,
          },
        ],
      });
    }
    events.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });

    const result = await parseOpenAISse(sseResponse(events), "gpt-5.5", {});
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("create_file");
    expect(result.toolCalls[0]?.input).toEqual({ path: "/tmp/big.py", content: bigContent });
    expect(result.toolCalls[0]?.input.error).toBeUndefined();
  });

  test("surfaces a structured error when finish_reason=length truncates the tool input", async () => {
    const partial = '{"path":"/tmp/big.py","content":"def f0():\\n    print(0)\\n';
    const events: Array<Record<string, unknown>> = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call_trunc_1", type: "function", function: { name: "create_file", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: partial } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ];

    const result = await parseOpenAISse(sseResponse(events), "gpt-5.5", {});
    expect(result.toolCalls).toHaveLength(1);
    const input = result.toolCalls[0]?.input as Record<string, unknown>;
    expect(typeof input.error).toBe("string");
    expect(String(input.error)).toContain("truncated");
    expect(input.partial).toBe(partial);
  });
});
