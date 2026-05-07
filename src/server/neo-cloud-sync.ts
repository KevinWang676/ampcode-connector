import { gzipSync } from "node:zlib";
import type { ProxyConfig } from "../config/config.ts";
import { logger } from "../utils/logger.ts";
import type { PersistedActorState } from "./neo-local-persistence.ts";
import { jsonRecord, textFromBlocks, type JsonRecord, type NeoThreadMessage } from "./neo-protocol.ts";

const UPLOAD_DEBOUNCE_MS = 750;
const GZIP_THRESHOLD_BYTES = 10 * 1024 * 1024;

export class NeoCloudSync {
  private timers = new Map<string, Timer>();
  private pending = new Map<string, PersistedActorState>();

  constructor(private readonly config: ProxyConfig) {}

  schedule(actor: PersistedActorState): void {
    if (!this.config.ampApiKey) return;
    this.pending.set(actor.snapshot.threadId, actor);
    const prior = this.timers.get(actor.snapshot.threadId);
    if (prior) clearTimeout(prior);
    this.timers.set(
      actor.snapshot.threadId,
      setTimeout(() => {
        this.timers.delete(actor.snapshot.threadId);
        const next = this.pending.get(actor.snapshot.threadId);
        this.pending.delete(actor.snapshot.threadId);
        if (next) void this.upload(next);
      }, UPLOAD_DEBOUNCE_MS),
    );
  }

  async fetchThread(threadId: string): Promise<JsonRecord | null> {
    if (!this.config.ampApiKey) return null;
    try {
      const response = await this.callInternal("getThread", { thread: threadId });
      const thread = jsonRecord(jsonRecord(jsonRecord(response.result).thread).data);
      if (Array.isArray(thread.messages)) return thread;
    } catch (err) {
      logger.debug("No Amp cloud thread available for local Neo import", {
        threadID: threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  async upload(actor: PersistedActorState): Promise<void> {
    if (!this.config.ampApiKey) return;
    const thread = cloudThreadFromActor(actor);
    try {
      const json = await this.callInternal("uploadThread", { thread, createdOnServer: false });
      logger.info("Synced local Neo thread to Amp cloud", { threadID: actor.snapshot.threadId, version: thread.v, ok: json.ok });
    } catch (err) {
      logger.warn("Failed to sync local Neo thread to Amp cloud", {
        threadID: actor.snapshot.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async callInternal(method: string, params: JsonRecord): Promise<JsonRecord> {
    const payload = JSON.stringify({ method, params });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.ampApiKey}`,
      "Content-Type": "application/json",
    };
    const body = payload.length > GZIP_THRESHOLD_BYTES ? gzipPayload(payload, headers) : payload;
    const response = await fetch(new URL(`/api/internal?${encodeURIComponent(method)}`, this.config.ampUpstreamUrl), {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const json = (await response.json()) as JsonRecord;
    if (json.ok === false) throw new Error(JSON.stringify(json.error ?? json));
    return json;
  }
}

export function cloudThreadFromActor(actor: PersistedActorState): JsonRecord {
  const snapshot = actor.snapshot;
  const created = Date.parse(actor.record.create_ts) || Date.now();
  const messages = [...snapshot.messages].sort((a, b) => a.seq - b.seq).map(cloudMessageFromNeo);

  return {
    id: snapshot.threadId,
    v: Math.max(snapshot.seq, ...snapshot.messages.map((message) => message.seq), 0),
    created,
    title: snapshot.title ?? titleFromMessages(snapshot.messages),
    messages,
    agentMode: cloudAgentMode(snapshot),
    env: cloudEnvironment(snapshot.environment),
    meta: { ...jsonRecord(snapshot.cloud?.meta), usesDtw: true, ampcodeConnectorLocalNeo: true },
  };
}

function cloudEnvironment(environment: JsonRecord): JsonRecord | undefined {
  const trees = Array.isArray(environment.trees) ? environment.trees.map((tree) => {
    const item = jsonRecord(tree);
    return { repository: item.repository, displayName: item.displayName, uri: item.uri };
  }) : undefined;
  const initial: JsonRecord = {
    ...(trees ? { trees } : {}),
    ...(typeof environment.platform === "string" ? { platform: environment.platform } : {}),
    ...(typeof environment.workspaceRoot === "string" ? { workspaceRoot: environment.workspaceRoot } : {}),
    ...(typeof environment.workingDirectory === "string" ? { workingDirectory: environment.workingDirectory } : {}),
  };
  return Object.keys(initial).length > 0 ? { initial } : undefined;
}

function cloudAgentMode(snapshot: PersistedActorState["snapshot"]): string | undefined {
  if (typeof snapshot.settings.agentMode === "string") return snapshot.settings.agentMode;
  return snapshot.messages.find((message) => message.role === "user" && typeof message.agentMode === "string")?.agentMode;
}

function cloudMessageFromNeo(message: NeoThreadMessage & { seq: number }): JsonRecord {
  const base: JsonRecord = {
    role: message.role,
    content: message.content,
    messageId: message.messageId,
    protocolMessageID: message.messageId,
  };
  if (message.role === "user") {
    if (message.meta) base.meta = message.meta;
    if (message.userState) base.userState = message.userState;
    if (message.agentMode) base.agentMode = message.agentMode;
  }
  if (message.role === "assistant") {
    base.state = message.state ?? { type: "complete", stopReason: message.content.some((block) => isToolUse(block)) ? "tool_use" : "end_turn" };
    if (message.usage) base.usage = message.usage;
  }
  if (message.createdAt) base.createdAt = message.createdAt;
  return base;
}

function titleFromMessages(messages: Array<NeoThreadMessage & { seq: number }>): string | null {
  const first = messages.find((message) => message.role === "user" && textFromBlocks(message.content).trim());
  if (!first) return null;
  const text = textFromBlocks(first.content).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function isToolUse(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value && (value as { type?: unknown }).type === "tool_use";
}

function gzipPayload(payload: string, headers: Record<string, string>): Uint8Array {
  headers["Content-Encoding"] = "gzip";
  return gzipSync(payload);
}
