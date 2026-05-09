/** Shared helpers for the local Amp Neo ThreadActor protocol. */

import { randomBytes, randomUUID } from "node:crypto";

export type JsonRecord = Record<string, unknown>;
export type AgentMode = "smart" | "rush" | "large" | "deep" | string;

export interface NeoTextBlock {
  type: "text";
  text: string;
  hidden?: boolean;
}

export interface NeoToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  complete: true;
  input: JsonRecord;
  normalizedInput?: JsonRecord;
}

export interface NeoToolResultBlock {
  type: "tool_result";
  toolUseID: string;
  run: JsonRecord;
  userInput?: unknown;
}

export type NeoUserBlock = NeoTextBlock | NeoToolResultBlock | JsonRecord;
export type NeoAssistantBlock = NeoTextBlock | NeoToolUseBlock | JsonRecord;

export interface NeoToolSpec {
  name: string;
  description?: string;
  inputSchema?: JsonRecord;
  source?: unknown;
  meta?: { deferred?: boolean; serial?: boolean; skillNames?: string[] };
}

export interface NeoThreadMessage {
  threadId: string;
  messageId: string;
  role: "user" | "assistant" | "info";
  content: Array<NeoUserBlock | NeoAssistantBlock | JsonRecord>;
  agentMode?: AgentMode;
  reasoningEffort?: string;
  createdAt?: string;
  meta?: JsonRecord;
  userState?: unknown;
  state?: { type: "complete" | "cancelled" | "streaming"; stopReason?: string | null };
  usage?: JsonRecord;
}

export interface LocalHistoryMessage {
  role: "system" | "user" | "assistant" | "tool";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ id: string; name: string; input: JsonRecord }>;
}

export interface ActorRecord {
  actor_id: string;
  name: string;
  key: string | null;
  create_ts: string;
  start_ts: string;
  connectable_ts: string;
  sleep_ts?: string | null;
  destroy_ts?: string | null;
  error?: unknown;
}

export function encodeThreadMessage(message: unknown): string {
  return JSON.stringify(message);
}

export function decodeThreadMessage(message: string | ArrayBuffer | Uint8Array): JsonRecord | null {
  try {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function sendProtocol(ws: Bun.ServerWebSocket<unknown>, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeThreadMessage(message));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newThreadId(): string {
  return `T-${randomUUID()}`;
}

export function newMessageId(): string {
  return `M-${randomBase62(22)}`;
}

export function newToolCallId(): string {
  return `TU-${randomBase62(22)}`;
}

export function toolResultMessageId(toolCallId: string): string {
  const suffix = toolCallId.startsWith("TU-") ? toolCallId.slice(3) : randomBase62(22);
  return `M-${suffix}`;
}

export function newActorId(): string {
  return `actor-${randomBase62(22)}`;
}

export function actorRecord(actorId: string, name: string, key: string | null, createdAt = nowIso()): ActorRecord {
  return {
    actor_id: actorId,
    name,
    key,
    create_ts: createdAt,
    start_ts: createdAt,
    connectable_ts: createdAt,
    sleep_ts: null,
    destroy_ts: null,
  };
}

export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return typeof blocks === "string" ? blocks : "";
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") return runToText(block.run);
      return "";
    })
    .join("");
}

export function runToText(run: unknown): string {
  if (!isRecord(run)) return stringify(run);
  for (const key of ["output", "displayMessage", "message", "reason", "text"]) {
    const value = run[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const result = run.result;
  if (result !== undefined) return stringify(result);
  return stringify(run);
}

export function jsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function normalizeNeoUsage(usage: JsonRecord | undefined): JsonRecord | undefined {
  if (!usage || Object.keys(usage).length === 0) return undefined;

  const inputTokens = numberFrom(usage.inputTokens, usage.input_tokens, usage.prompt_tokens, usage.promptTokenCount);
  const outputTokens = numberFrom(
    usage.outputTokens,
    usage.output_tokens,
    usage.completion_tokens,
    usage.candidatesTokenCount,
  );
  const cacheCreationInputTokens = nullableNumberFrom(
    usage.cacheCreationInputTokens,
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = nullableNumberFrom(
    usage.cacheReadInputTokens,
    usage.cache_read_input_tokens,
    usage.cachedContentTokenCount,
  );
  const totalInputTokens = numberFrom(
    usage.totalInputTokens,
    usage.total_input_tokens,
    usage.prompt_tokens,
    usage.promptTokenCount,
    inputTokens + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0),
  );

  return {
    model: typeof usage.model === "string" ? usage.model : undefined,
    maxInputTokens: numberFrom(usage.maxInputTokens, usage.max_input_tokens, 0),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalInputTokens,
    timestamp: typeof usage.timestamp === "string" ? usage.timestamp : nowIso(),
  };
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractActorIdFromProtocols(protocols: string[]): string | null {
  for (const protocol of protocols) {
    if (protocol.startsWith("rivet_actor.")) return protocol.slice("rivet_actor.".length);
  }
  return null;
}

export function parseProtocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

export function contentTypeJson(): Headers {
  return new Headers({ "Content-Type": "application/json" });
}

export async function readJsonRecord(req: Request): Promise<JsonRecord> {
  try {
    return jsonRecord(await req.json());
  } catch {
    return {};
  }
}

export function extractThreadIdFromActorBody(body: JsonRecord, key: string | null): string {
  const candidates = [body, jsonRecord(body.input), parseJsonString(body.input), parseJsonString(key)];
  for (const candidate of candidates) {
    const threadId = findThreadId(candidate);
    if (threadId) return threadId;
  }
  const match = key?.match(/T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] ?? newThreadId();
}

export function normalizeToolCallId(id: string): string {
  return /^TU-[0-9A-Za-z]{22}$/.test(id) ? id : newToolCallId();
}

function numberFrom(...values: unknown[]): number {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function nullableNumberFrom(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function findThreadId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.startsWith("T-")) return value;
  if (Array.isArray(value)) return value.map(findThreadId).find(Boolean) ?? null;
  const record = jsonRecord(value);
  for (const key of ["threadId", "threadID", "thread_id"]) {
    const found = record[key];
    if (typeof found === "string" && found.startsWith("T-")) return found;
  }
  return null;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function randomBase62(length: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
