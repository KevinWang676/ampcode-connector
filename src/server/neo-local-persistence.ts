import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActorRecord, JsonRecord, LocalHistoryMessage, NeoThreadMessage } from "./neo-protocol.ts";
import { actorRecord, isRecord, newActorId, newMessageId, runToText, textFromBlocks } from "./neo-protocol.ts";

export const LOCAL_NEO_STORE_DIR = join(homedir(), ".local", "share", "ampcode-connector", "neo-threads");

export interface LocalActorSnapshot {
  version: 1;
  actorId: string;
  threadId: string;
  settings: JsonRecord;
  messages: Array<NeoThreadMessage & { seq: number }>;
  history: LocalHistoryMessage[];
  queue: JsonRecord[];
  seq: number;
  agentState: string;
  environment: JsonRecord;
  title: string | null;
  cloud?: { meta?: JsonRecord; archived?: boolean; deleted?: boolean };
  updatedAt: string;
}

export interface PersistedActorState {
  version: 1;
  id: string;
  name: string;
  key: string | null;
  record: ActorRecord;
  snapshot: LocalActorSnapshot;
  updatedAt: string;
}

export class NeoLocalPersistence {
  constructor(private readonly root = LOCAL_NEO_STORE_DIR) {}

  loadActors(): PersistedActorState[] {
    this.ensureDir();
    return readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          const raw = JSON.parse(readFileSync(join(this.root, name), "utf8")) as unknown;
          if (isPersistedActorState(raw)) return [raw];
        } catch {}
        return [];
      });
  }

  saveActor(state: PersistedActorState): void {
    this.ensureDir();
    const updated = { ...state, updatedAt: new Date().toISOString() };
    const file = this.actorFile(state.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2));
    renameSync(tmp, file);
    writeFileSync(this.markdownFile(state.snapshot.threadId), renderThreadMarkdown(updated));
  }

  updateCloudState(threadId: string, patch: NonNullable<LocalActorSnapshot["cloud"]>): void {
    const actor = this.findByThreadId(threadId);
    if (!actor) return;
    this.saveActor({ ...actor, snapshot: { ...actor.snapshot, cloud: { ...actor.snapshot.cloud, ...patch } } });
  }

  importCloudThread(thread: JsonRecord): PersistedActorState | null {
    const threadId = typeof thread.id === "string" ? thread.id : null;
    if (!threadId) return null;
    const existing = this.findByThreadId(threadId);
    const imported = persistedActorFromCloudThread(thread, existing);
    this.saveActor(imported);
    return imported;
  }

  deleteThread(threadId: string): void {
    const actor = this.findByThreadId(threadId);
    if (actor) this.deleteActor(actor.id);
  }

  deleteActor(actorId: string): void {
    const current = this.loadActors().find((actor) => actor.id === actorId);
    rmSync(this.actorFile(actorId), { force: true });
    if (current) rmSync(this.markdownFile(current.snapshot.threadId), { force: true });
  }

  findByThreadId(threadId: string): PersistedActorState | null {
    return this.loadActors().find((actor) => actor.snapshot.threadId === threadId) ?? null;
  }

  findThreads(query = "", limit = 20, offset = 0): JsonRecord[] {
    const q = query.trim().toLowerCase();
    const rows = this.loadActors()
      .filter((actor) => !actor.snapshot.cloud?.archived && !actor.snapshot.cloud?.deleted)
      .filter((actor) => {
        if (!q) return true;
        const haystack = [actor.snapshot.threadId, actor.snapshot.title, renderThreadMarkdown(actor)].join("\n").toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return rows.slice(offset, offset + limit).map((actor) => ({
      id: actor.snapshot.threadId,
      title: actor.snapshot.title ?? localThreadTitle(actor),
      creatorUserID: "local",
      created: actor.record.create_ts,
      updatedAt: actor.updatedAt,
      messageCount: actor.snapshot.messages.length,
      local: true,
    }));
  }

  markdownForThread(threadId: string): string | null {
    const actor = this.findByThreadId(threadId);
    return actor ? renderThreadMarkdown(actor) : null;
  }

  jsonForThread(threadId: string): JsonRecord | null {
    const actor = this.findByThreadId(threadId);
    return actor ? (actor as unknown as JsonRecord) : null;
  }

  private ensureDir(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  private actorFile(actorId: string): string {
    return join(this.root, `${safeName(actorId)}.json`);
  }

  private markdownFile(threadId: string): string {
    return join(this.root, `${safeName(threadId)}.md`);
  }
}

export function renderThreadMarkdown(actor: PersistedActorState): string {
  const title = actor.snapshot.title ?? localThreadTitle(actor);
  const lines = [`# ${title}`, "", `Thread: ${actor.snapshot.threadId}`, `Actor: ${actor.id}`, `Updated: ${actor.updatedAt}`, ""];

  for (const message of actor.snapshot.messages.sort((a, b) => a.seq - b.seq)) {
    lines.push(`## ${message.role.toUpperCase()} — ${message.messageId}`, "");
    const text = renderBlocks(message.content);
    lines.push(text || "_(empty)_", "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderBlocks(blocks: unknown[]): string {
  const parts = blocks.map((block) => {
    if (!isRecord(block)) return String(block);
    if (block.type === "text") return String(block.text ?? "");
    if (block.type === "tool_use") return `Tool call: ${block.name ?? "unknown"}\n\`\`\`json\n${JSON.stringify(block.input ?? {}, null, 2)}\n\`\`\``;
    if (block.type === "tool_result") return `Tool result (${block.toolUseID ?? "unknown"}):\n\`\`\`\n${runToText(block.run)}\n\`\`\``;
    if (block.type === "manual_bash_invocation") return `Manual bash invocation:\n\`\`\`json\n${JSON.stringify(block.args ?? {}, null, 2)}\n\`\`\``;
    return `\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``;
  });
  return parts.join("\n\n").trim();
}

function persistedActorFromCloudThread(thread: JsonRecord, existing: PersistedActorState | null): PersistedActorState {
  const threadId = String(thread.id);
  const now = new Date().toISOString();
  const created = typeof thread.created === "number" ? new Date(thread.created).toISOString() : existing?.record.create_ts ?? now;
  const messages = cloudMessages(thread).map((raw, index) => cloudMessageFromRaw(raw, threadId, index));
  const snapshot: LocalActorSnapshot = {
    version: 1,
    actorId: existing?.id ?? newActorId(),
    threadId,
    settings: { ...existing?.snapshot.settings, ...(typeof thread.agentMode === "string" ? { agentMode: thread.agentMode } : {}) },
    messages,
    history: messages.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", text: textFromBlocks(message.content) })),
    queue: existing?.snapshot.queue ?? [],
    seq: Math.max(Number(thread.v) || 0, messages.length + 1, existing?.snapshot.seq ?? 0),
    agentState: "idle",
    environment: cloudEnvironment(thread, existing),
    title: typeof thread.title === "string" ? thread.title : existing?.snapshot.title ?? null,
    cloud: { ...existing?.snapshot.cloud, meta: jsonRecord(thread.meta) },
    updatedAt: now,
  };
  return {
    version: 1,
    id: existing?.id ?? snapshot.actorId,
    name: existing?.name ?? "thread-actor",
    key: existing?.key ?? threadId,
    record: existing?.record ?? actorRecord(snapshot.actorId, "thread-actor", threadId, created),
    snapshot,
    updatedAt: now,
  };
}

function cloudEnvironment(thread: JsonRecord, existing: PersistedActorState | null): JsonRecord {
  const env = jsonRecord(thread.env);
  return Object.keys(env).length > 0 ? env : existing?.snapshot.environment ?? {};
}

function cloudMessages(thread: JsonRecord): JsonRecord[] {
  const messages = thread.messages;
  return Array.isArray(messages) ? messages.map(jsonRecord) : [];
}

function cloudMessageFromRaw(msg: JsonRecord, threadId: string, index: number): NeoThreadMessage & { seq: number } {
  const role = msg.role === "assistant" || msg.role === "info" ? msg.role : "user";
  return {
    threadId,
    role,
    messageId: typeof msg.messageId === "string" ? msg.messageId : typeof msg.protocolMessageID === "string" ? msg.protocolMessageID : newMessageId(),
    content: Array.isArray(msg.content) ? msg.content : [],
    agentMode: typeof msg.agentMode === "string" ? msg.agentMode : undefined,
    reasoningEffort: typeof msg.reasoningEffort === "string" ? msg.reasoningEffort : undefined,
    createdAt: typeof msg.createdAt === "string" ? msg.createdAt : undefined,
    meta: jsonRecord(msg.meta),
    userState: msg.userState,
    state: role === "assistant" ? (jsonRecord(msg.state).type ? (jsonRecord(msg.state) as NeoThreadMessage["state"]) : { type: "complete", stopReason: "end_turn" }) : undefined,
    usage: jsonRecord(msg.usage),
    seq: index + 1,
  };
}

function localThreadTitle(actor: PersistedActorState): string {
  const firstUser = actor.snapshot.messages.find((message) => message.role === "user" && textFromBlocks(message.content).trim());
  const text = firstUser ? textFromBlocks(firstUser.content).replace(/\s+/g, " ").trim() : actor.snapshot.threadId;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function jsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function safeName(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]/g, "_");
}

function isPersistedActorState(value: unknown): value is PersistedActorState {
  if (!isRecord(value)) return false;
  const snapshot = value.snapshot;
  return value.version === 1 && typeof value.id === "string" && isRecord(snapshot) && typeof snapshot.threadId === "string";
}
