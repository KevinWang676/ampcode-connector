import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampReasoningEffort } from "../src/providers/codex.ts";
import { cloudThreadFromActor } from "../src/server/neo-cloud-sync.ts";
import { LocalThreadActor, localFindThreadRun, localReadThreadRun } from "../src/server/neo-local-actor.ts";
import {
  anthropicMaxOutputTokens,
  anthropicMessages,
  anthropicThinking,
  buildAnthropicInferenceBody,
  googleMaxOutputTokens,
  normalizeToolSchema,
  openAIMessages,
  openAIReasoningEffort,
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

describe("LocalThreadActor importCloudThread (used by stale-snapshot refresh on resume)", () => {
  test("replaces local messages with cloud messages and resets seq counter", () => {
    const actor = new LocalThreadActor({
      config: {
        hostname: "localhost",
        port: 8765,
        ampUpstreamUrl: "https://ampcode.com",
        logLevel: "error",
        providers: { anthropic: true, codex: true, google: true },
      },
      actorId: "actor-import-test-1",
      threadId: "T-import01-1234-1234-1234-123456789abc",
    });

    // Pre-seed actor state by calling open() so handlers initialize, then
    // populate a couple of in-memory messages directly (mimicking a stale
    // local snapshot from a prior connector session).
    const sent: unknown[] = [];
    const ws = { readyState: WebSocket.OPEN, send: (v: string) => sent.push(JSON.parse(v)) };
    actor.open(ws as never);
    const internal = actor as unknown as {
      messages: Array<{ seq: number; role: string }>;
      seq: number;
      history: Array<{ role: string }>;
    };
    internal.messages = [{ seq: 1, role: "user" } as never, { seq: 2, role: "assistant" } as never];
    internal.seq = 3;

    // Cloud has 5 messages — strictly newer than local's 2.
    actor.importCloudThread({
      id: "T-import01-1234-1234-1234-123456789abc",
      title: "Refreshed",
      messages: [
        { role: "user", messageId: "M-cloud1", content: [{ type: "text", text: "u1" }] },
        { role: "assistant", messageId: "M-cloud2", content: [{ type: "text", text: "a1" }] },
        { role: "user", messageId: "M-cloud3", content: [{ type: "text", text: "u2" }] },
        { role: "assistant", messageId: "M-cloud4", content: [{ type: "text", text: "a2" }] },
        { role: "user", messageId: "M-cloud5", content: [{ type: "text", text: "u3" }] },
      ],
    });

    const snap = actor.snapshot();
    expect(snap.messages.length).toBe(5);
    expect(snap.messages[0]?.messageId).toBe("M-cloud1");
    expect(snap.messages[4]?.messageId).toBe("M-cloud5");
    // Seq counter should be at least one past the imported message count so
    // the next message issued by the actor lands ahead of everything cloud
    // already has — preventing the "broadcast seq is older than CLI cache"
    // bug that made fresh prompts disappear in the CLI when switching from
    // official Neo back to the connector.
    expect(snap.seq).toBeGreaterThan(5);
    expect(snap.title).toBe("Refreshed");
  });

  test("import preserves message order and assigns monotonically increasing seq", () => {
    const actor = new LocalThreadActor({
      config: {
        hostname: "localhost",
        port: 8765,
        ampUpstreamUrl: "https://ampcode.com",
        logLevel: "error",
        providers: { anthropic: true, codex: true, google: true },
      },
      actorId: "actor-import-test-2",
      threadId: "T-import02-1234-1234-1234-123456789abc",
    });
    actor.importCloudThread({
      id: "T-import02-1234-1234-1234-123456789abc",
      title: "Ordered",
      messages: [
        { role: "user", messageId: "M-a", content: [{ type: "text", text: "a" }] },
        { role: "user", messageId: "M-b", content: [{ type: "text", text: "b" }] },
        { role: "user", messageId: "M-c", content: [{ type: "text", text: "c" }] },
      ],
    });
    const snap = actor.snapshot();
    expect(snap.messages.map((m) => m.messageId)).toEqual(["M-a", "M-b", "M-c"]);
    const seqs = snap.messages.map((m) => m.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
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

  test("renaming a thread advances the cloud upload version", () => {
    const threadId = "T-82345678-1234-1234-1234-123456789abc";
    const actor = new LocalThreadActor({
      config: {
        hostname: "localhost",
        port: 8765,
        ampUpstreamUrl: "https://ampcode.com",
        logLevel: "error",
        providers: { anthropic: true, codex: true, google: true },
      },
      actorId: "actor-title-test",
      threadId,
      snapshot: {
        version: 1,
        actorId: "actor-title-test",
        threadId,
        settings: {},
        messages: [
          {
            threadId,
            role: "user",
            messageId: "M-8234567890123456789011",
            content: [{ type: "text", text: "old title source" }],
            seq: 1,
          },
        ],
        history: [{ role: "user", text: "old title source" }],
        queue: [],
        seq: 2,
        agentState: "idle",
        environment: {},
        title: "Old title",
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
    });
    const before = cloudThreadFromActor({
      version: 1,
      id: "actor-title-test",
      name: "thread-actor",
      key: threadId,
      record: actorRecord("actor-title-test", "thread-actor", threadId, "2026-05-07T00:00:00.000Z"),
      snapshot: actor.snapshot(),
      updatedAt: "2026-05-07T00:00:00.000Z",
    });
    const sent: unknown[] = [];
    const ws = { readyState: WebSocket.OPEN, send: (v: string) => sent.push(JSON.parse(v)) };

    actor.message(ws as never, JSON.stringify({ type: "client_set_thread_title", title: "New title" }));

    const after = cloudThreadFromActor({
      version: 1,
      id: "actor-title-test",
      name: "thread-actor",
      key: threadId,
      record: actorRecord("actor-title-test", "thread-actor", threadId, "2026-05-07T00:00:00.000Z"),
      snapshot: actor.snapshot(),
      updatedAt: "2026-05-07T00:00:00.000Z",
    });
    expect(after.title).toBe("New title");
    expect(Number(after.v)).toBeGreaterThan(Number(before.v));
  });
});

describe("Neo local model routing", () => {
  test("matches Amp modes to connector-local providers", () => {
    expect(selectModelRoute("smart", {})).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
    expect(selectModelRoute("deep", {})).toEqual({ provider: "openai", model: "gpt-5.5" });
    expect(selectModelRoute("rush", {})).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });

  test("preserves deep mode in thread settings for inherited subagent model selection", () => {
    const actor = new LocalThreadActor({
      config: {
        hostname: "localhost",
        port: 8765,
        ampUpstreamUrl: "https://ampcode.com",
        logLevel: "error",
        providers: { anthropic: true, codex: true, google: true },
      },
      actorId: "actor-deep-settings",
      threadId: "T-92345678-1234-1234-1234-123456789abc",
      input: { input: { agentMode: "deep" } },
    });
    const sent: unknown[] = [];
    const ws = { readyState: WebSocket.OPEN, send: (v: string) => sent.push(JSON.parse(v)), close: () => {} };

    actor.open(ws as never);
    actor.message(ws as never, JSON.stringify({ type: "client_update_thread_settings", settings: {} }));

    expect(actor.snapshot().settings.agentMode).toBe("deep");
    expect(sent).toContainEqual({ type: "thread_settings", settings: { agentMode: "deep" } });
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

describe("buildAnthropicInferenceBody — prompt cache_control wiring", () => {
  const baseRequest = {
    actorId: "actor-1",
    threadId: "T-1234",
    agentMode: "smart",
    settings: {},
    history: [{ role: "user" as const, text: "explain the codebase" }],
    tools: [
      { name: "Read", description: "read a file", inputSchema: { type: "object", properties: {} } },
      { name: "Bash", description: "run a shell command", inputSchema: { type: "object", properties: {} } },
    ],
    environment: { workingDirectory: "/home/u/proj" },
  };

  test("places top-level cache_control for automatic message caching", () => {
    const body = buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  test("places cache_control on the LAST system block (and only that block)", () => {
    const body = buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true);
    const system = body.system as Array<{ text: string; cache_control?: { type: string } }>;
    expect(system).toHaveLength(1);
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]?.text).toContain("You are Amp");
  });

  test("places cache_control on the LAST tool definition only (tools prefix cached as one segment)", () => {
    const body = buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true);
    const tools = body.tools as Array<{ name: string; cache_control?: { type: string } }>;
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("Read");
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.name).toBe("Bash");
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("uses 3 of 4 cache_control slots (top-level + last system + last tool)", () => {
    const body = buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true);
    const markers: string[] = [];
    if (body.cache_control) markers.push("top-level");
    for (const s of body.system as Array<{ cache_control?: unknown }>) {
      if (s.cache_control) markers.push("system");
    }
    for (const t of (body.tools ?? []) as Array<{ cache_control?: unknown }>) {
      if (t.cache_control) markers.push("tool");
    }
    expect(markers).toEqual(["top-level", "system", "tool"]);
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  test("omits tools field entirely (and thus the tool breakpoint) when request.tools is empty", () => {
    const body = buildAnthropicInferenceBody("claude-haiku-4-5-20251001", { ...baseRequest, tools: [] }, false);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    // Top-level + system breakpoints remain.
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    const system = body.system as Array<{ cache_control?: { type: string } }>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("body structure mirrors what api.anthropic.com expects (model, max_tokens, stream, messages all populated)", () => {
    const body = buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true);
    expect(body.model).toBe("claude-opus-4-7");
    expect(typeof body.max_tokens).toBe("number");
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as unknown[]).length).toBeGreaterThan(0);
  });

  test("non-streaming requests still carry all three cache breakpoints", () => {
    const body = buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, false);
    expect(body.stream).toBe(false);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    const system = body.system as Array<{ cache_control?: { type: string } }>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    const tools = body.tools as Array<{ cache_control?: { type: string } }>;
    expect(tools[tools.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("cache_control content is byte-identical across calls with identical input (cache hash stability)", () => {
    // Anthropic caches by an exact prefix hash. If buildAnthropicInferenceBody
    // produced non-deterministic content (timestamps, random ids, etc.) for
    // identical inputs, every turn would write a new entry and never read —
    // exactly the regression we are fixing. Compare two builds for byte parity.
    const first = JSON.stringify(buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true));
    const second = JSON.stringify(buildAnthropicInferenceBody("claude-opus-4-7", baseRequest, true));
    expect(first).toBe(second);
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

describe("Neo Anthropic adaptive thinking", () => {
  /** Anthropic's hard constraints. Any returned config must satisfy both. */
  function expectValidBudget(
    cfg: { type: "enabled"; budget_tokens: number } | undefined,
    maxTokens: number,
  ): asserts cfg is { type: "enabled"; budget_tokens: number } {
    expect(cfg).toBeDefined();
    expect(cfg?.type).toBe("enabled");
    expect(cfg?.budget_tokens).toBeGreaterThanOrEqual(1024);
    // Strict less-than: api.anthropic.com rejects budget_tokens === max_tokens.
    expect(cfg?.budget_tokens).toBeLessThan(maxTokens);
  }

  test("turns thinking ON by default for Claude Opus 4.x and Sonnet 4.x", () => {
    const opus = anthropicThinking("claude-opus-4-7", undefined, 32000);
    expectValidBudget(opus, 32000);

    const sonnet = anthropicThinking("claude-sonnet-4-5", undefined, 32000);
    expectValidBudget(sonnet, 32000);
  });

  test("leaves thinking OFF by default for Claude Haiku 4.x (rush mode)", () => {
    expect(anthropicThinking("claude-haiku-4-5-20251001", undefined, 64000)).toBeUndefined();
  });

  test("budget_tokens is strictly monotonic in effort for Opus 4.7", () => {
    const low = anthropicThinking("claude-opus-4-7", "low", 32000);
    const med = anthropicThinking("claude-opus-4-7", "medium", 32000);
    const high = anthropicThinking("claude-opus-4-7", "high", 32000);
    const xhigh = anthropicThinking("claude-opus-4-7", "xhigh", 32000);
    expectValidBudget(low, 32000);
    expectValidBudget(med, 32000);
    expectValidBudget(high, 32000);
    expectValidBudget(xhigh, 32000);
    expect(low.budget_tokens).toBeLessThan(med.budget_tokens);
    expect(med.budget_tokens).toBeLessThan(high.budget_tokens);
    expect(high.budget_tokens).toBeLessThanOrEqual(xhigh.budget_tokens);
  });

  test("Opus 4.7 + xhigh gives the model close to the 24576 target without violating constraints", () => {
    const xhigh = anthropicThinking("claude-opus-4-7", "xhigh", 32000);
    expectValidBudget(xhigh, 32000);
    // Must be at least 16384 — substantially more than the previous 15616 cap
    // when the response reserve was 16384.
    expect(xhigh.budget_tokens).toBeGreaterThanOrEqual(16384);
    // Must leave at least 8192 tokens (one response reserve) free for the
    // visible response.
    expect(xhigh.budget_tokens).toBeLessThanOrEqual(32000 - 8192);
  });

  test("Haiku 4.5 + xhigh respects the strict-less-than constraint at maxTokens=64000", () => {
    const xhigh = anthropicThinking("claude-haiku-4-5-20251001", "xhigh", 64000);
    expectValidBudget(xhigh, 64000);
    expect(xhigh.budget_tokens).toBeLessThanOrEqual(64000 - 8192);
  });

  test("returns undefined when effort is minimal/none", () => {
    expect(anthropicThinking("claude-opus-4-7", "minimal", 32000)).toBeUndefined();
    expect(anthropicThinking("claude-opus-4-7", "none", 32000)).toBeUndefined();
  });

  test("returns undefined for degenerate maxTokens that cannot fit MIN budget + reserve", () => {
    // 8192 (reserve) + 1024 (min) = 9216. Anything below that must opt out.
    expect(anthropicThinking("claude-opus-4-7", "high", 9215)).toBeUndefined();
    expect(anthropicThinking("claude-opus-4-7", "high", 8192)).toBeUndefined();
    expect(anthropicThinking("claude-opus-4-7", "high", 1024)).toBeUndefined();
  });

  test("returns undefined for older Claude families that lack extended thinking", () => {
    expect(anthropicThinking("claude-3-5-sonnet-20241022", "high", 32000)).toBeUndefined();
    expect(anthropicThinking("claude-3-haiku-20240307", undefined, 32000)).toBeUndefined();
  });

  test("explicit medium and unset effort produce the same result for Opus 4.7", () => {
    const explicit = anthropicThinking("claude-opus-4-7", "medium", 32000);
    const implicit = anthropicThinking("claude-opus-4-7", undefined, 32000);
    expect(explicit).toEqual(implicit);
  });

  test("unknown effort labels fall back to the medium tier (no API-rejecting output)", () => {
    const unknown = anthropicThinking("claude-opus-4-7", "garbage-effort", 32000);
    const medium = anthropicThinking("claude-opus-4-7", "medium", 32000);
    expect(unknown).toEqual(medium);
  });
});

describe("Neo OpenAI reasoning effort", () => {
  test("preserves minimal/low/medium/high/xhigh as the Responses API expects", () => {
    expect(openAIReasoningEffort("minimal")).toBe("minimal");
    expect(openAIReasoningEffort("none")).toBe("minimal");
    expect(openAIReasoningEffort("low")).toBe("low");
    expect(openAIReasoningEffort("medium")).toBe("medium");
    expect(openAIReasoningEffort("high")).toBe("high");
    expect(openAIReasoningEffort("xhigh")).toBe("xhigh");
    expect(openAIReasoningEffort("max")).toBe("xhigh");
    expect(openAIReasoningEffort(undefined)).toBe("medium");
    expect(openAIReasoningEffort("garbage-input")).toBe("medium");
  });

  test("clampReasoningEffort honors gpt-5.5 minimal/low/medium/high", () => {
    expect(clampReasoningEffort("gpt-5.5", "minimal")).toBe("minimal");
    expect(clampReasoningEffort("gpt-5.5", "low")).toBe("low");
    expect(clampReasoningEffort("gpt-5.5", "medium")).toBe("medium");
    expect(clampReasoningEffort("gpt-5.5", "high")).toBe("high");
    // gpt-5.5 doesn't accept xhigh — clamp to high.
    expect(clampReasoningEffort("gpt-5.5", "xhigh")).toBe("high");
  });

  test("clampReasoningEffort retains legacy gpt-5.1 / 5.2 / 5.3 quirks", () => {
    expect(clampReasoningEffort("gpt-5.1", "xhigh")).toBe("high");
    expect(clampReasoningEffort("gpt-5.2", "minimal")).toBe("low");
    expect(clampReasoningEffort("gpt-5.3", "minimal")).toBe("low");
    expect(clampReasoningEffort("gpt-5.1-codex-mini", "low")).toBe("medium");
    expect(clampReasoningEffort("gpt-5.1-codex-mini", "high")).toBe("high");
  });
});

describe("Neo history repair (orphan tool_use)", () => {
  test("synthesizes tool_result when assistant tool_use is followed by a plain user text turn", () => {
    const messages = anthropicMessages([
      { role: "user", text: "first user msg" },
      {
        role: "assistant",
        text: "ok let me search",
        toolCalls: [{ id: "TU-orphan-1", name: "Grep", input: { pattern: "x" } }],
      },
      // Note: NO {role: "tool", toolCallId: "TU-orphan-1"} here — corrupted history.
      { role: "user", text: "second user msg after orphan" },
    ]);

    // Expected: assistant turn (idx 1) followed by injected synthetic user turn
    // with tool_result, THEN the original user text.
    expect(messages[1]?.role).toBe("assistant");
    const synth = messages[2] as Record<string, unknown>;
    expect(synth?.role).toBe("user");
    const synthContent = synth?.content as Array<Record<string, unknown>>;
    expect(synthContent?.[0]?.type).toBe("tool_result");
    expect(synthContent?.[0]?.tool_use_id).toBe("TU-orphan-1");
    expect(synthContent?.[0]?.is_error).toBe(true);
    // Original user text should still be present afterward.
    expect(messages[3]?.role).toBe("user");
    expect((messages[3]?.content as Array<Record<string, unknown>>)?.[0]?.type).toBe("text");
  });

  test("synthesizes tool_result when assistant tool_use is the final message in history", () => {
    const messages = anthropicMessages([
      { role: "user", text: "hi" },
      { role: "assistant", text: "running", toolCalls: [{ id: "TU-orphan-tail", name: "Bash", input: {} }] },
      // No follow-up at all.
    ]);
    expect(messages.length).toBe(3);
    const synth = messages[2] as Record<string, unknown>;
    expect(synth?.role).toBe("user");
    const synthContent = synth?.content as Array<Record<string, unknown>>;
    expect(synthContent?.[0]?.type).toBe("tool_result");
    expect(synthContent?.[0]?.tool_use_id).toBe("TU-orphan-tail");
  });

  test("leaves well-paired tool_use/tool_result history untouched", () => {
    const messages = anthropicMessages([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "TU-good-1", name: "Read", input: { path: "/a" } }] },
      { role: "tool", toolCallId: "TU-good-1", text: "file contents" },
      { role: "assistant", text: "done" },
    ]);
    expect(messages.length).toBe(4);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("user");
    const okContent = messages[2]?.content as Array<Record<string, unknown>>;
    expect(okContent?.[0]?.type).toBe("tool_result");
    expect(okContent?.[0]?.tool_use_id).toBe("TU-good-1");
    // No is_error on the legitimate tool_result.
    expect(okContent?.[0]?.is_error).toBeUndefined();
  });

  test("OpenAI message builder synthesizes a tool stub for orphan tool_calls", () => {
    const messages = openAIMessages(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [{ id: "call-orphan", name: "Read", input: {} }] },
        { role: "user", text: "follow-up" },
      ],
      "system",
    );
    // [system, user, assistant, synth-tool, user]
    expect(messages.length).toBe(5);
    expect(messages[3]?.role).toBe("tool");
    expect((messages[3] as Record<string, unknown>)?.tool_call_id).toBe("call-orphan");
  });

  test("Anthropic: multi-tool_use assistant with results split across consecutive user messages is coalesced into one user message with no duplicates", () => {
    const messages = anthropicMessages([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "running two tools",
        toolCalls: [
          { id: "TU-multi-A", name: "Bash", input: { cmd: "a" } },
          { id: "TU-multi-B", name: "Bash", input: { cmd: "b" } },
        ],
      },
      { role: "tool", toolCallId: "TU-multi-A", text: "result A" },
      { role: "tool", toolCallId: "TU-multi-B", text: "result B" },
    ]);
    // Expected after repair:
    //   [0] user(text "hi")
    //   [1] assistant(tool_use TU-multi-A, TU-multi-B)
    //   [2] user(tool_result TU-multi-A, tool_result TU-multi-B)  <-- coalesced
    expect(messages.length).toBe(3);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.role).toBe("user");
    const merged = messages[2]?.content as Array<Record<string, unknown>>;
    expect(merged?.length).toBe(2);
    expect(merged?.[0]?.type).toBe("tool_result");
    expect(merged?.[0]?.tool_use_id).toBe("TU-multi-A");
    expect(merged?.[0]?.is_error).toBeUndefined();
    expect(merged?.[1]?.type).toBe("tool_result");
    expect(merged?.[1]?.tool_use_id).toBe("TU-multi-B");
    expect(merged?.[1]?.is_error).toBeUndefined();
  });

  test("Anthropic: only some tool_results present across split user messages — synthesizes ONE stub for the missing id and does not duplicate the present one", () => {
    // This is the exact failure mode from the user-reported 400:
    //   "messages.N.content.M: each tool_use must have a single result.
    //    Found multiple `tool_result` blocks with id: TU-..."
    // Pre-fix: the repair only inspected messages[i+1] and synthesized a stub
    // for TU-A even though TU-A was present in messages[i+2].
    const messages = anthropicMessages([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "two tools",
        toolCalls: [
          { id: "TU-present", name: "Bash", input: {} },
          { id: "TU-missing", name: "Grep", input: {} },
        ],
      },
      // Real tool_result for TU-present sits in the SECOND user message of the
      // run, after a different one. (Order from history matters here.)
      { role: "tool", toolCallId: "TU-present", text: "ok" },
      // Note: NO tool_result for TU-missing — represents a cancelled tool.
    ]);
    // Expected: one coalesced user message holding the real tool_result for
    // TU-present plus a synthesized is_error stub for TU-missing. No duplicates.
    expect(messages.length).toBe(3);
    const merged = messages[2]?.content as Array<Record<string, unknown>>;
    expect(merged?.length).toBe(2);
    const idsSeen = merged.map((b) => b.tool_use_id);
    expect(idsSeen).toContain("TU-present");
    expect(idsSeen).toContain("TU-missing");
    // No duplicate ids.
    expect(new Set(idsSeen).size).toBe(idsSeen.length);
    const present = merged.find((b) => b.tool_use_id === "TU-present");
    expect(present?.is_error).toBeUndefined();
    const missing = merged.find((b) => b.tool_use_id === "TU-missing");
    expect(missing?.is_error).toBe(true);
  });

  test("Anthropic: pre-existing duplicate tool_result blocks (same id) are deduped (first wins)", () => {
    // Simulate a corrupted history where the actor appended TU-dup twice.
    const messages = anthropicMessages([
      { role: "user", text: "hi" },
      { role: "assistant", text: "one tool", toolCalls: [{ id: "TU-dup", name: "Bash", input: {} }] },
      { role: "tool", toolCallId: "TU-dup", text: "first result" },
      { role: "tool", toolCallId: "TU-dup", text: "second (duplicate) result" },
    ]);
    expect(messages.length).toBe(3);
    const merged = messages[2]?.content as Array<Record<string, unknown>>;
    expect(merged?.length).toBe(1);
    expect(merged?.[0]?.tool_use_id).toBe("TU-dup");
    // First-occurrence-wins.
    expect(merged?.[0]?.content).toBe("first result");
  });

  test("Anthropic: tool_result run followed by trailing user text — text user message is preserved separately", () => {
    const messages = anthropicMessages([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "TU-mix", name: "Bash", input: {} }] },
      { role: "tool", toolCallId: "TU-mix", text: "tool out" },
      { role: "user", text: "next prompt" },
    ]);
    // Expected:
    //   [0] user(text "hi")
    //   [1] assistant(tool_use)
    //   [2] user(tool_result TU-mix)
    //   [3] user(text "next prompt")
    expect(messages.length).toBe(4);
    expect(messages[2]?.role).toBe("user");
    const tr = messages[2]?.content as Array<Record<string, unknown>>;
    expect(tr?.[0]?.type).toBe("tool_result");
    expect(tr?.[0]?.tool_use_id).toBe("TU-mix");
    expect(messages[3]?.role).toBe("user");
    const txt = messages[3]?.content as Array<Record<string, unknown>>;
    expect(txt?.[0]?.type).toBe("text");
    expect(txt?.[0]?.text).toBe("next prompt");
  });

  test("OpenAI: pre-existing duplicate tool messages (same tool_call_id) are deduped", () => {
    // Build a history that produces a duplicate tool message in the wire format.
    // openAIMessages emits one role:"tool" message per history entry of role "tool".
    const messages = openAIMessages(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "", toolCalls: [{ id: "call-dup", name: "Bash", input: {} }] },
        { role: "tool", toolCallId: "call-dup", text: "first result" },
        { role: "tool", toolCallId: "call-dup", text: "duplicate result" },
      ],
      "system",
    );
    // [system, user, assistant, tool] — duplicate dropped.
    expect(messages.length).toBe(4);
    expect(messages[3]?.role).toBe("tool");
    expect((messages[3] as Record<string, unknown>)?.tool_call_id).toBe("call-dup");
    expect((messages[3] as Record<string, unknown>)?.content).toBe("first result");
  });
});

describe("normalizeToolSchema (tools[].input_schema / parameters validity for all providers)", () => {
  test('undefined inputSchema → { type: "object", properties: {} }', () => {
    const out = normalizeToolSchema(undefined);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  test('null inputSchema → { type: "object", properties: {} }', () => {
    const out = normalizeToolSchema(null);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  test('typeless empty {} → { type: "object", properties: {} } (the production failure case)', () => {
    const out = normalizeToolSchema({});
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  test('schema with properties but no type → adds type:"object" and preserves properties', () => {
    const out = normalizeToolSchema({ properties: { foo: { type: "string" } }, required: ["foo"] });
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ foo: { type: "string" } });
    expect(out.required).toEqual(["foo"]);
  });

  test("well-typed object schema passes through unchanged (preserves $defs, additionalProperties, etc.)", () => {
    const original = {
      type: "object",
      properties: { path: { type: "string", description: "absolute path" } },
      required: ["path"],
      additionalProperties: false,
      $defs: { Foo: { type: "string" } },
    };
    const out = normalizeToolSchema(original);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual(original.properties);
    expect(out.required).toEqual(["path"]);
    expect(out.additionalProperties).toBe(false);
    expect(out.$defs).toEqual({ Foo: { type: "string" } });
  });

  test('non-object inputs (string, number, array) → safe default { type: "object", properties: {} }', () => {
    expect(normalizeToolSchema("not a schema")).toEqual({ type: "object", properties: {} });
    expect(normalizeToolSchema(42)).toEqual({ type: "object", properties: {} });
    expect(normalizeToolSchema([1, 2, 3])).toEqual({ type: "object", properties: {} });
  });

  test('schema with non-object type is preserved (e.g. type:"string" — schema-author intent kept)', () => {
    // We do NOT silently force "object" over an explicit type; if the
    // executor really sent type:"string" we let upstream's strict validator
    // surface the error rather than masking it with a coercion.
    const out = normalizeToolSchema({ type: "string" });
    expect(out.type).toBe("string");
    // No properties added because type is not "object".
    expect(out.properties).toBeUndefined();
  });

  test('schema with type:"object" but properties:[] (array, invalid) → properties replaced with {}', () => {
    const out = normalizeToolSchema({ type: "object", properties: [] });
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
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
              tool_calls: [
                { index: 0, id: "call_test_1", type: "function", function: { name: "create_file", arguments: "" } },
              ],
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
              tool_calls: [
                { index: 0, id: "call_trunc_1", type: "function", function: { name: "create_file", arguments: "" } },
              ],
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
