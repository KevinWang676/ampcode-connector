import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cloudThreadFromActor } from "../src/server/neo-cloud-sync.ts";
import { LocalThreadActor, localFindThreadRun, localReadThreadRun } from "../src/server/neo-local-actor.ts";
import { selectModelRoute } from "../src/server/neo-local-inference.ts";
import { NeoLocalPersistence, type PersistedActorState } from "../src/server/neo-local-persistence.ts";
import {
  decodeThreadMessage,
  encodeThreadMessage,
  extractThreadIdFromActorBody,
  actorRecord,
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
      store.importCloudThread({ id: targetThreadId, title: "Target", messages: [{ role: "user", content: [{ type: "text", text: "target content" }] }] });
      store.importCloudThread({ id: currentThreadId, title: "Current", messages: [{ role: "user", content: [{ type: "text", text: "current content" }] }] });

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
          { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(200_000), signature: "gAAAAAB" + "x".repeat(1_000) }] },
          { role: "user", content: [{ type: "tool_result", toolUseID: "TU-1", run: { output: `<loaded_skill name="x">${"skill".repeat(20_000)}</loaded_skill> useful result` } }] },
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
      store.importCloudThread({ id: threadId, title: "Needle Thread", messages: [{ role: "user", content: [{ type: "text", text: "unique needle phrase" }] }] });

      const run = localFindThreadRun({ query: "needle", limit: 5 }, store);
      expect(run?.result).toContain(threadId);
      expect(run?.threads).toEqual(expect.arrayContaining([expect.objectContaining({ id: threadId, title: "Needle Thread" })]));
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
          { role: "user", messageId: "M-2234567890123456789011", content: [{ type: "text", text: "download me" }], agentMode: "large" },
          { role: "assistant", messageId: "M-2234567890123456789012", content: [{ type: "text", text: "synced locally" }] },
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
      config: { hostname: "localhost", port: 8765, ampUpstreamUrl: "https://ampcode.com", logLevel: "error", providers: { anthropic: true, codex: true, google: true } },
      actorId: "actor-cancel-test",
      threadId: "T-72345678-1234-1234-1234-123456789abc",
    });
    const ws = { readyState: WebSocket.OPEN, send: (value: string) => sent.push(JSON.parse(value)) };
    actor.open(ws as never);
    sent.length = 0;

    (actor as unknown as { activeAssistantMessageId: string; cancel(): void }).activeAssistantMessageId = "M-activecancel1234567890";
    (actor as unknown as { cancel(): void }).cancel();

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message_added", message: expect.objectContaining({ messageId: "M-activecancel1234567890", state: expect.objectContaining({ type: "cancelled" }) }) }),
      expect.objectContaining({ type: "delta", messageId: "M-activecancel1234567890", state: "cancelled" }),
      expect.objectContaining({ type: "agent_state", state: "idle", messageId: "M-activecancel1234567890" }),
    ]));
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
          { threadId, role: "user", agentMode: "deep", messageId: "M-1234567890123456789011", content: [{ type: "text", text: "first deep turn" }], seq: 3 },
          { threadId, role: "assistant", messageId: "M-1234567890123456789012", content: [{ type: "text", text: "cloud sync" }], seq: 4 },
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
    expect(cloud).toMatchObject({ id: threadId, v: 5, title: "Cloud sync", agentMode: "deep", meta: { ampcodeConnectorLocalNeo: true } });
    expect(cloud.messages).toEqual(
      expect.arrayContaining([{ role: "assistant", content: [{ type: "text", text: "cloud sync" }], state: { type: "complete", stopReason: "end_turn" }, messageId: "M-1234567890123456789012", protocolMessageID: "M-1234567890123456789012" }]),
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
