/** Connector-local inference adapter for Neo ThreadActor execution. */

import type { ProxyConfig } from "../config/config.ts";
import * as rewriter from "../proxy/rewriter.ts";
import { recordSuccess, routeRequest } from "../routing/router.ts";
import { logger } from "../utils/logger.ts";
import * as sse from "../utils/streaming.ts";
import { parseBody } from "./body.ts";
import type { JsonRecord, LocalHistoryMessage, NeoToolSpec } from "./neo-protocol.ts";
import { jsonRecord, runToText } from "./neo-protocol.ts";

export interface LocalInferenceRequest {
  actorId: string;
  threadId: string;
  agentMode: string;
  reasoningEffort?: string;
  settings: JsonRecord;
  history: LocalHistoryMessage[];
  tools: NeoToolSpec[];
  environment?: JsonRecord;
  signal?: AbortSignal;
  onHistoryCompacted?: (history: LocalHistoryMessage[]) => void;
}

export interface LocalInferenceResult {
  model: string;
  provider: "anthropic" | "openai" | "google";
  text: string;
  toolCalls: Array<{ id: string; name: string; input: JsonRecord }>;
  usage?: JsonRecord;
}

/** Incremental events emitted by streaming inference. */
export interface InferenceStreamHandler {
  onTextDelta?(text: string): void;
  onThinkingDelta?(text: string): void;
  onToolStart?(call: { id: string; name: string }): void;
  onToolInputDelta?(id: string, partialJson: string): void;
  onUsage?(usage: JsonRecord): void;
}

interface ModelRoute {
  provider: "anthropic" | "openai" | "google";
  model: string;
}

const LOCAL_COMPACTION_RESERVE_TOKENS = 16_384;
const LOCAL_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const LOCAL_COMPACTION_SUMMARY_PREFIX = "[Compaction summary]";
const LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS = 2_000;
const LOCAL_COMPACTION_DEFAULT_MODEL = "gemini-3.1-pro-preview";

interface LocalCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

interface LocalHistoryCompactionPreparation {
  messagesToSummarize: LocalHistoryMessage[];
  turnPrefixMessages: LocalHistoryMessage[];
  isSplitTurn: boolean;
  previousSummary?: string;
  tokensBefore: number;
  firstKeptIndex: number;
}

function contextWindowTokensForRoute(route: ModelRoute): number {
  if (route.provider === "google") return 1_000_000;
  if (route.provider === "openai") return 400_000;
  return 200_000;
}

function compactionSettings(settings: JsonRecord): LocalCompactionSettings {
  const raw = jsonRecord(settings["localNeo.compaction"]);
  return {
    enabled: raw.enabled !== false,
    reserveTokens: numberSetting(raw.reserveTokens, LOCAL_COMPACTION_RESERVE_TOKENS),
    keepRecentTokens: numberSetting(raw.keepRecentTokens, LOCAL_COMPACTION_KEEP_RECENT_TOKENS),
  };
}

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function estimateHistoryTokens(message: LocalHistoryMessage): number {
  let chars = message.text?.length ?? 0;
  for (const call of message.toolCalls ?? []) chars += call.name.length + JSON.stringify(call.input).length;
  if (message.toolCallId) chars += message.toolCallId.length;
  if (message.toolName) chars += message.toolName.length;
  return Math.ceil(chars / 4);
}

function findLocalTurnStart(history: LocalHistoryMessage[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) if (history[i]?.role === "user") return i;
  return -1;
}

function findLocalHistoryCutPoint(
  history: LocalHistoryMessage[],
  startIndex: number,
  keepRecentTokens: number,
): { firstKeptIndex: number; turnStartIndex: number; isSplitTurn: boolean } {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < history.length; i++) {
    const role = history[i]?.role;
    if (role === "user" || role === "assistant") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let i = history.length - 1; i >= startIndex; i--) {
    accumulatedTokens += estimateHistoryTokens(history[i]!);
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = cutPoints.find((point) => point >= i) ?? cutIndex;
      break;
    }
  }

  const isUserMessage = history[cutIndex]?.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findLocalTurnStart(history, cutIndex, startIndex);
  return { firstKeptIndex: cutIndex, turnStartIndex, isSplitTurn: !isUserMessage && turnStartIndex !== -1 };
}

export function prepareLocalHistoryCompaction(
  history: LocalHistoryMessage[],
  contextWindowTokens: number,
  settings: LocalCompactionSettings = {
    enabled: true,
    reserveTokens: LOCAL_COMPACTION_RESERVE_TOKENS,
    keepRecentTokens: LOCAL_COMPACTION_KEEP_RECENT_TOKENS,
  },
): LocalHistoryCompactionPreparation | undefined {
  if (!settings.enabled) return undefined;
  const tokensBefore = history.reduce((sum, message) => sum + estimateHistoryTokens(message), 0);
  if (tokensBefore <= contextWindowTokens - settings.reserveTokens) return undefined;

  const first = history[0];
  const previousSummary =
    first?.role === "user" && first.text?.startsWith(LOCAL_COMPACTION_SUMMARY_PREFIX)
      ? first.text.slice(LOCAL_COMPACTION_SUMMARY_PREFIX.length).trim()
      : undefined;
  const boundaryStart = previousSummary ? 1 : 0;
  const cutPoint = findLocalHistoryCutPoint(history, boundaryStart, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;
  if (historyEnd <= boundaryStart) return undefined;

  return {
    messagesToSummarize: history.slice(boundaryStart, historyEnd),
    turnPrefixMessages: cutPoint.isSplitTurn ? history.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex) : [],
    isSplitTurn: cutPoint.isSplitTurn,
    previousSummary,
    tokensBefore,
    firstKeptIndex: cutPoint.firstKeptIndex,
  };
}

export function compactLocalHistoryForContext(
  history: LocalHistoryMessage[],
  preparation: LocalHistoryCompactionPreparation,
  summary: string,
): LocalHistoryMessage[] {
  const kept = history.slice(preparation.firstKeptIndex);
  if (kept.length === 0) return history;
  return [{ role: "user", text: `${LOCAL_COMPACTION_SUMMARY_PREFIX}\n${summary.trim()}` }, ...kept];
}

function serializeLocalHistory(messages: LocalHistoryMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") parts.push(`[User]: ${message.text ?? ""}`);
    if (message.role === "assistant") {
      if (message.text) parts.push(`[Assistant]: ${message.text}`);
      if (message.toolCalls?.length) {
        const calls = message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join("; ");
        parts.push(`[Assistant tool calls]: ${calls}`);
      }
    }
    if (message.role === "tool") {
      parts.push(`[Tool result]: ${clipToolResult(message.text ?? "")}`);
    }
  }
  return parts.join("\n\n");
}

function clipToolResult(text: string): string {
  if (text.length <= LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS) return text;
  const truncated = text.length - LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS;
  return `${text.slice(0, LOCAL_COMPACTION_TOOL_RESULT_MAX_CHARS)}\n\n[... ${truncated} more characters truncated]`;
}

export async function generateLocalThreadTitle(
  config: ProxyConfig,
  threadId: string,
  messageText: string,
): Promise<{ title?: string; usage?: JsonRecord }> {
  if (!messageText.trim()) return {};
  const titleMessage = cleanTitleMessage(messageText);
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 60,
    temperature: 0.7,
    stream: false,
    system:
      'You are an assistant that generates short, descriptive titles in sentence case based on user\'s message to an agentic coding tool. Be concise, precise, and do not guess beyond the message. Omit generic words like "question" or "request". Ignore validation markers and requested exact-output strings; title the underlying coding task. Use the set_title tool to provide your answer.',
    messages: [{ role: "user", content: `<message>${titleMessage}</message>` }],
    tools: [
      {
        name: "set_title",
        input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
    ],
    tool_choice: { type: "tool", name: "set_title", disable_parallel_tool_use: true },
  };
  const json = await callLocalProvider(config, "anthropic", "/v1/messages", body, threadId);
  const first = jsonRecord(Array.isArray(json.content) ? json.content[0] : undefined);
  const input = jsonRecord(first.input);
  return {
    title: typeof input.title === "string" ? sanitizeTitle(input.title) : undefined,
    usage: jsonRecord(json.usage),
  };
}

function cleanTitleMessage(message: string): string {
  return (
    message
      .replace(/for validation marker\s+\S+[,]?\s*/gi, "")
      .replace(/reply with exactly\s+\S+\s+and nothing else\.?/gi, "")
      .replace(/\bTITLE_[A-Z0-9_]+\b/g, "")
      .replace(/\s+/g, " ")
      .trim() || message
  );
}

function sanitizeTitle(title: string): string | undefined {
  const words = title
    .replace(/^['"`]+|['"`.!?:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return undefined;
  const compact = words.join(" ").toLowerCase();
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

export async function extractLocalThreadContent(
  config: ProxyConfig,
  currentThreadId: string,
  mentionedThreadId: string,
  threadMarkdown: string,
  goal: string,
): Promise<string> {
  const prompt = `Here is the mentioned thread content:\n\n<mentionedThread>\n${threadMarkdown}\n</mentionedThread>\n\nYou are helping me extract relevant information from the mentioned thread based on a goal.\n\n## Task\n\nI am talking to another user. They mentioned a thread (a conversation) in their last message. I turned the thread into Markdown and provided it to you, along with a goal of what I want you to extract.\n\nYour job is to:\n1. Analyze the mentioned thread's content\n2. Identify information that is relevant to the goal\n3. Extract and preserve those relevant parts with full fidelity\n4. Omit clearly irrelevant content to keep the context concise\n\n## Guidelines\n\n**Preserve Fidelity**: When content IS relevant, include it completely with all important details, code snippets, explanations, and context.\n**Be Selective**: When content is clearly NOT relevant to the user's query, omit it entirely.\n**Maintain Structure**: Keep the extracted content well-organized and coherent. If multiple parts are relevant, preserve their logical flow.\n**Technical Precision**: Preserve exact technical details like file paths, function names, error messages, and code snippets that are relevant.\n\n## Goal\n\n${goal}\n\n## Your Response\n\nReturn only the extracted relevant information as markdown text. Do not wrap it in JSON.`;

  const result = await inferLocal(config, {
    actorId: `read-thread-${mentionedThreadId}`,
    threadId: currentThreadId,
    agentMode: "rush",
    settings: { "internal.model": "openai/gpt-5.5" },
    history: [{ role: "user", text: prompt }],
    tools: [],
    environment: {},
  });
  return result.text.trim() || threadMarkdown;
}

async function compactLocalHistoryIfNeeded(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
): Promise<LocalInferenceRequest> {
  const preparation = prepareLocalHistoryCompaction(
    request.history,
    contextWindowTokensForRoute(route),
    compactionSettings(request.settings),
  );
  if (!preparation) return request;

  const summaryRoute = compactionSummaryRoute(request, route);
  const summary = await generateLocalCompactionSummary(
    config,
    request.threadId,
    preparation,
    summaryRoute,
    request.signal,
  );
  const compactedHistory = compactLocalHistoryForContext(request.history, preparation, summary);
  request.onHistoryCompacted?.(compactedHistory);
  logger.warn("Neo local history compacted before inference", {
    mode: request.agentMode,
    model: route.model,
    provider: route.provider,
    originalMessages: request.history.length,
    compactedMessages: compactedHistory.length,
    tokensBefore: preparation.tokensBefore,
    splitTurn: preparation.isSplitTurn,
    summaryProvider: summaryRoute.provider,
    summaryModel: summaryRoute.model,
  });
  return { ...request, history: compactedHistory };
}

export function compactionSummaryRoute(request: LocalInferenceRequest, inferenceRoute: ModelRoute): ModelRoute {
  if (request.agentMode === "deep") return inferenceRoute;
  return { provider: "google", model: LOCAL_COMPACTION_DEFAULT_MODEL };
}

async function generateLocalCompactionSummary(
  config: ProxyConfig,
  threadId: string,
  preparation: LocalHistoryCompactionPreparation,
  summaryRoute: ModelRoute,
  signal?: AbortSignal,
): Promise<string> {
  const historySummary = preparation.messagesToSummarize.length
    ? await generateLocalSummary(
        config,
        threadId,
        preparation.messagesToSummarize,
        preparation.previousSummary,
        SUMMARIZATION_PROMPT,
        summaryRoute,
        signal,
      )
    : (preparation.previousSummary ?? "No prior history.");

  if (!preparation.isSplitTurn || preparation.turnPrefixMessages.length === 0) return historySummary;
  const turnSummary = await generateLocalSummary(
    config,
    threadId,
    preparation.turnPrefixMessages,
    undefined,
    TURN_PREFIX_SUMMARIZATION_PROMPT,
    summaryRoute,
    signal,
  );
  return `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnSummary}`;
}

async function generateLocalSummary(
  config: ProxyConfig,
  threadId: string,
  messages: LocalHistoryMessage[],
  previousSummary: string | undefined,
  prompt: string,
  summaryRoute: ModelRoute,
  signal?: AbortSignal,
): Promise<string> {
  let promptText = `<conversation>\n${serializeLocalHistory(messages)}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : prompt;

  if (summaryRoute.provider === "google") {
    const body = {
      contents: [
        { role: "user", parts: [{ text: SUMMARIZATION_SYSTEM_PROMPT }] },
        { role: "user", parts: [{ text: promptText }] },
      ],
      generationConfig: { maxOutputTokens: 4096 },
    };
    const json = await callLocalProvider(
      config,
      "google",
      `/v1beta/models/${encodeURIComponent(summaryRoute.model)}:generateContent`,
      body,
      threadId,
      signal,
    );
    return textFromGoogleContent(json).trim();
  }

  if (summaryRoute.provider === "openai") {
    const body = {
      model: summaryRoute.model,
      stream: false,
      messages: [
        { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: "user", content: promptText },
      ],
    };
    const json = await callLocalProvider(config, "openai", "/v1/chat/completions", body, threadId, signal);
    const choice = Array.isArray(json.choices) ? jsonRecord(json.choices[0]) : {};
    const message = jsonRecord(choice.message);
    return typeof message.content === "string" ? message.content.trim() : "";
  }

  const body = {
    model: summaryRoute.model,
    max_tokens: 4096,
    stream: false,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: promptText }],
  };
  const json = await callLocalProvider(config, "anthropic", "/v1/messages", body, threadId, signal);
  return textFromAnthropicContent(json.content).trim();
}

function textFromGoogleContent(json: JsonRecord): string {
  const candidate = Array.isArray(json.candidates) ? jsonRecord(json.candidates[0]) : {};
  const content = jsonRecord(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => {
      const item = jsonRecord(part);
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function textFromAnthropicContent(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((block) => {
      const item = jsonRecord(block);
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Read a conversation between a user and an AI coding assistant, then produce only the requested structured summary. Do not continue the conversation.";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the same structured summary format.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export async function inferLocal(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  handler?: InferenceStreamHandler,
): Promise<LocalInferenceResult> {
  const modelRoute = selectModelRoute(request.agentMode, request.settings);
  const effectiveRequest = await compactLocalHistoryIfNeeded(config, request, modelRoute);

  switch (modelRoute.provider) {
    case "anthropic":
      return inferAnthropic(config, effectiveRequest, modelRoute, handler);
    case "openai":
      return inferOpenAI(config, effectiveRequest, modelRoute, handler);
    case "google":
      return inferGoogle(config, effectiveRequest, modelRoute, handler);
  }
}

export function selectModelRoute(agentMode: string, settings: JsonRecord): ModelRoute {
  const explicit = explicitModel(agentMode, settings);
  if (explicit) return explicit;

  switch (agentMode) {
    case "deep":
      return { provider: "openai", model: "gpt-5.5" };
    case "rush":
      return { provider: "openai", model: "gpt-5.5" };
    case "large":
      return { provider: "anthropic", model: "claude-opus-4-6" };
    default:
      return { provider: "anthropic", model: "claude-opus-4-7" };
  }
}

/** Output-token ceilings per Anthropic model family.
 *  Hard-coded 8192 was truncating large tool_use inputs (e.g. create_file with
 *  multi-thousand-line content) mid-stream, causing the AMP CLI to receive
 *  empty/partial JSON. Use each model's real max output to avoid that. */
export function anthropicMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("claude-haiku")) return 64000;
  if (m.includes("claude-opus")) return 32000;
  if (m.includes("claude-sonnet")) return 32000;
  return 32000;
}

/** Anthropic extended-thinking constraints.
 *
 *  Hard constraints (enforced by api.anthropic.com — violating these returns
 *  400 Bad Request, breaking the whole turn):
 *    1. budget_tokens >= 1024 (Anthropic's documented minimum)
 *    2. budget_tokens <  max_tokens (strict less-than, NOT less-or-equal)
 *
 *  Soft constraint (enforced by us so the model has room to emit a full
 *  visible response — including a large tool_use input like create_file with a
 *  multi-thousand-line content arg — even if the model fills its full thinking
 *  budget):
 *    3. budget_tokens <= max_tokens − ANTHROPIC_THINKING_RESPONSE_RESERVE
 *
 *  8192 is enough for ~800 lines of code-style content, which is the practical
 *  upper bound for a single tool call in this codebase. */
const ANTHROPIC_THINKING_MIN_BUDGET = 1024;
const ANTHROPIC_THINKING_RESPONSE_RESERVE = 8192;

/** Per-effort thinking budget targets (Anthropic-recommended ranges). The
 *  upper bound is enforced separately so these tiers stay valid across all
 *  Claude 4.x models including future variants with different max_tokens. */
const ANTHROPIC_THINKING_TIERS: Readonly<Record<string, number>> = {
  low: 2048,
  medium: 6144,
  high: 16384,
  xhigh: 24576,
  max: 24576,
};

/** Extended-thinking ("adaptive thinking") config for Anthropic.
 *
 *  Returns `{type: "enabled", budget_tokens: N}` when the model supports
 *  extended thinking AND the math works out within the constraints above;
 *  otherwise returns `undefined` so the caller omits the `thinking` field
 *  entirely (the API rejects `{type: "enabled", budget_tokens: 0}`).
 *
 *  Defaults:
 *  - claude-opus-4.x / claude-sonnet-4.x → ON (medium) when no effort is set.
 *    Opus 4.7 (smart mode) gets adaptive thinking by default.
 *  - claude-haiku-4.x → OFF unless reasoningEffort is explicitly set, since
 *    rush mode is meant for fast turnaround.
 *  - older Claude families → OFF (extended thinking unsupported). */
export function anthropicThinking(
  model: string,
  reasoningEffort: string | undefined,
  maxTokens: number,
): { type: "enabled"; budget_tokens: number } | undefined {
  const m = model.toLowerCase();
  const supportsThinking = m.includes("claude-opus-4") || m.includes("claude-sonnet-4") || m.includes("claude-haiku-4");
  if (!supportsThinking) return undefined;

  let effort = reasoningEffort?.toLowerCase();
  if (!effort) {
    // Default ON for the heavyweight families, OFF for haiku.
    if (m.includes("claude-opus-4") || m.includes("claude-sonnet-4")) effort = "medium";
    else return undefined;
  }
  if (effort === "minimal" || effort === "none") return undefined;

  // Enforce Anthropic's hard constraints AND our visible-response reserve.
  // Use the tighter of the two upper bounds.
  const upperBound = Math.min(maxTokens - ANTHROPIC_THINKING_RESPONSE_RESERVE, maxTokens - 1);
  if (upperBound < ANTHROPIC_THINKING_MIN_BUDGET) return undefined;

  const target = ANTHROPIC_THINKING_TIERS[effort] ?? ANTHROPIC_THINKING_TIERS.medium;
  if (target === undefined) return undefined;

  // Clamp into [MIN, upperBound]. Floor wins if the clamp would push below
  // Anthropic's minimum — in that case extended thinking can't be requested
  // safely, so we omit the field rather than send an invalid request.
  const budget = Math.min(target, upperBound);
  if (budget < ANTHROPIC_THINKING_MIN_BUDGET) return undefined;

  return { type: "enabled", budget_tokens: budget };
}

/** Build the JSON body for a connector-local Anthropic `/v1/messages` call.
 *
 *  Prompt caching is enabled with the Claude Code-style 3-of-4 breakpoint
 *  pattern so the running cost matches `amp --take-me-back` instead of paying
 *  full input-token price every turn:
 *
 *    1. Top-level `cache_control: { type: "ephemeral" }` → automatic caching.
 *       Anthropic places a sliding breakpoint on the last cacheable block
 *       (typically the latest `tool_result` / user message) every request,
 *       which keeps the growing message history in cache for multi-turn
 *       agentic loops (e.g. Amp's "explain the codebase" flow) without us
 *       having to walk the array each turn.
 *
 *    2. Explicit `cache_control` on the LAST tool definition. Tools rarely
 *       change inside an Amp session, so this entry survives the full
 *       conversation and the tool prefix is read from cache from turn 2 on.
 *
 *    3. Explicit `cache_control` on the LAST system block. The connector's
 *       providers/anthropic.ts::injectClaudeCodeSystem prepends a billing
 *       header (stable per conversation via `cch`) and the Claude Code
 *       identity line; after that injection the locally-built system block
 *       is the array's tail, so the cached prefix covers
 *       `[billing, identity, systemPrompt]` — all stable per conversation.
 *
 *  The fourth `cache_control` slot is intentionally left free so that a
 *  caller (or `injectClaudeCodeSystem`'s defensive marker) can add a
 *  second breakpoint without exceeding Anthropic's 4-marker hard cap.
 *
 *  Exported so tests can validate the exact body shape without spinning up
 *  the routing/forwarding stack. */
export function buildAnthropicInferenceBody(
  model: string,
  request: LocalInferenceRequest,
  streaming: boolean,
): JsonRecord {
  const maxTokens = anthropicMaxOutputTokens(model);
  const thinking = anthropicThinking(model, request.reasoningEffort, maxTokens);
  const tools = buildCachedAnthropicTools(request.tools);
  return {
    model,
    max_tokens: maxTokens,
    stream: streaming,
    cache_control: { type: "ephemeral" as const },
    ...(thinking ? { thinking } : {}),
    system: [
      {
        type: "text",
        text: systemPrompt(request),
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: anthropicMessages(request.history),
    ...(tools.length > 0 ? { tools, tool_choice: { type: "auto" as const } } : {}),
  };
}

/** Map NeoToolSpec[] to Anthropic tool definitions and stamp a single
 *  `cache_control: { type: "ephemeral" }` marker on the LAST entry so the
 *  whole tool-definition prefix is cached as one segment. Returns `[]` when
 *  the spec list is empty so callers can omit the `tools` field entirely. */
function buildCachedAnthropicTools(tools: NeoToolSpec[]): JsonRecord[] {
  if (tools.length === 0) return [];
  const list = tools.map(toAnthropicTool);
  const lastIdx = list.length - 1;
  list[lastIdx] = { ...list[lastIdx]!, cache_control: { type: "ephemeral" as const } };
  return list;
}

async function inferAnthropic(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
  handler?: InferenceStreamHandler,
): Promise<LocalInferenceResult> {
  const streaming = !!handler;
  const body = buildAnthropicInferenceBody(route.model, request, streaming);

  if (!streaming) {
    const json = await callLocalProvider(config, "anthropic", "/v1/messages", body, request.threadId, request.signal);
    return collectAnthropicJson(json, route.model);
  }

  const response = await callLocalProviderStream(
    config,
    "anthropic",
    "/v1/messages",
    body,
    request.threadId,
    request.signal,
  );
  return parseAnthropicSse(response, route.model, handler, request.signal);
}

function collectAnthropicJson(json: JsonRecord, model: string): LocalInferenceResult {
  const content = Array.isArray(json.content) ? json.content : [];
  const toolCalls: LocalInferenceResult["toolCalls"] = [];
  let text = "";

  for (const block of content) {
    const item = jsonRecord(block);
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    if (item.type === "tool_use" && typeof item.name === "string") {
      toolCalls.push({
        id: typeof item.id === "string" ? item.id : `tool-${toolCalls.length}`,
        name: item.name,
        input: jsonRecord(item.input),
      });
    }
  }

  return { provider: "anthropic", model, text, toolCalls, usage: jsonRecord(json.usage) };
}

export async function parseAnthropicSse(
  response: Response,
  model: string,
  handler: InferenceStreamHandler,
  signal?: AbortSignal,
): Promise<LocalInferenceResult> {
  let text = "";
  const toolCalls: LocalInferenceResult["toolCalls"] = [];
  const toolCallByIndex = new Map<number, LocalInferenceResult["toolCalls"][number]>();
  const partialJsonByIndex = new Map<number, string>();
  let usage: JsonRecord = {};
  let stopReason: string | undefined;

  await readSseChunks(
    response,
    (chunk) => {
      const event = parseJsonChunk(chunk.data);
      if (!event) return;
      const type = event.type;

      if (type === "message_start") {
        const message = jsonRecord(event.message);
        const u = jsonRecord(message.usage);
        if (Object.keys(u).length) usage = { ...usage, ...u };
        const msgStopReason = message.stop_reason;
        if (typeof msgStopReason === "string") stopReason = msgStopReason;
        return;
      }

      if (type === "content_block_start") {
        const index = typeof event.index === "number" ? event.index : -1;
        const block = jsonRecord(event.content_block);
        const blockType = String(block.type ?? "");
        if (blockType === "tool_use") {
          partialJsonByIndex.set(index, "");
          const id = typeof block.id === "string" ? block.id : `tool-${toolCalls.length}`;
          const name = typeof block.name === "string" ? block.name : "unknown_tool";
          const call = { id, name, input: {} as JsonRecord };
          toolCalls.push(call);
          toolCallByIndex.set(index, call);
          handler.onToolStart?.({ id, name });
        }
        return;
      }

      if (type === "content_block_delta") {
        const index = typeof event.index === "number" ? event.index : -1;
        const delta = jsonRecord(event.delta);
        const deltaType = String(delta.type ?? "");
        if (deltaType === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          handler.onTextDelta?.(delta.text);
        } else if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
          handler.onThinkingDelta?.(delta.thinking);
        } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
          partialJsonByIndex.set(index, (partialJsonByIndex.get(index) ?? "") + delta.partial_json);
          const call = toolCallByIndex.get(index);
          if (call) handler.onToolInputDelta?.(call.id, delta.partial_json);
        }
        return;
      }

      if (type === "content_block_stop") {
        const index = typeof event.index === "number" ? event.index : -1;
        const call = toolCallByIndex.get(index);
        if (call) {
          const partial = partialJsonByIndex.get(index) ?? "";
          if (partial) {
            try {
              call.input = jsonRecord(JSON.parse(partial));
              partialJsonByIndex.delete(index);
            } catch {
              // Leave the partial buffer in place; final reconciliation below
              // decides whether this is a max_tokens truncation or a true parse
              // error and surfaces the right diagnostic.
            }
          } else {
            partialJsonByIndex.delete(index);
          }
        }
        return;
      }

      if (type === "message_delta") {
        const delta = jsonRecord(event.delta);
        const deltaStopReason = delta.stop_reason;
        if (typeof deltaStopReason === "string") stopReason = deltaStopReason;
        const u = jsonRecord(event.usage);
        if (Object.keys(u).length) usage = { ...usage, ...u };
        return;
      }
    },
    signal,
  );

  // Final reconciliation: any tool_use block whose JSON could not be parsed
  // either lost its content_block_stop (mid-stream max_tokens) or contained
  // invalid JSON. Surface a structured error so the AMP CLI sees the failure
  // mode instead of an empty {} or opaque {raw: ...} input.
  for (const [index, call] of toolCallByIndex) {
    const partial = partialJsonByIndex.get(index);
    if (!partial) continue;
    try {
      call.input = jsonRecord(JSON.parse(partial));
    } catch {
      const truncated = stopReason === "max_tokens";
      logger.warn(
        truncated
          ? `Anthropic tool input truncated: tool=${call.name} id=${call.id} model=${model} stop_reason=max_tokens partialBytes=${partial.length}`
          : `Anthropic tool input invalid JSON: tool=${call.name} id=${call.id} model=${model} partialBytes=${partial.length}`,
      );
      call.input = {
        error: truncated
          ? "tool_input_truncated_max_tokens: model output hit max_tokens before tool JSON closed; raise max_tokens or shrink the request"
          : "tool_input_invalid_json: model emitted partial JSON that could not be parsed",
        partial,
      };
    }
  }

  if (stopReason === "max_tokens") {
    logger.warn(
      `Anthropic response stopped at max_tokens model=${model} — large tool inputs (e.g. file contents) may be truncated. Consider raising max_tokens or splitting the request.`,
    );
  }

  if (Object.keys(usage).length) handler.onUsage?.(usage);
  return { provider: "anthropic", model, text, toolCalls, usage };
}

async function inferOpenAI(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
  handler?: InferenceStreamHandler,
): Promise<LocalInferenceResult> {
  const streaming = !!handler;
  const body = {
    model: route.model,
    stream: streaming,
    messages: openAIMessages(request.history, systemPrompt(request)),
    reasoning_effort: openAIReasoningEffortForRequest(request.agentMode, request.reasoningEffort),
    ...(request.tools.length > 0 ? { tools: request.tools.map(toOpenAITool), tool_choice: "auto" } : {}),
  };

  if (!streaming) {
    const json = await callLocalProvider(
      config,
      "openai",
      "/v1/chat/completions",
      body,
      request.threadId,
      request.signal,
    );
    const choice = Array.isArray(json.choices) ? jsonRecord(json.choices[0]) : {};
    const message = jsonRecord(choice.message);
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((raw, index) => {
          const call = jsonRecord(raw);
          const fn = jsonRecord(call.function);
          return {
            id: typeof call.id === "string" ? call.id : `call-${index}`,
            name: typeof fn.name === "string" ? fn.name : "unknown_tool",
            input: parseToolArguments(fn.arguments),
          };
        })
      : [];
    return {
      provider: "openai",
      model: route.model,
      text: typeof message.content === "string" ? message.content : "",
      toolCalls,
      usage: jsonRecord(json.usage),
    };
  }

  const response = await callLocalProviderStream(
    config,
    "openai",
    "/v1/chat/completions",
    body,
    request.threadId,
    request.signal,
  );
  return parseOpenAISse(response, route.model, handler, request.signal);
}

export async function parseOpenAISse(
  response: Response,
  model: string,
  handler: InferenceStreamHandler,
  signal?: AbortSignal,
): Promise<LocalInferenceResult> {
  let text = "";
  const toolByIndex = new Map<number, { id: string; name: string; argsBuf: string; started: boolean }>();
  let usage: JsonRecord = {};
  let finishReason: string | undefined;

  await readSseChunks(
    response,
    (chunk) => {
      if (!chunk.data || chunk.data === "[DONE]") return;
      const event = parseJsonChunk(chunk.data);
      if (!event) return;

      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const raw of choices) {
        const choice = jsonRecord(raw);
        const delta = jsonRecord(choice.delta);
        const content = delta.content;
        if (typeof content === "string" && content.length > 0) {
          text += content;
          handler.onTextDelta?.(content);
        }
        const reasoning = delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) handler.onThinkingDelta?.(reasoning);

        const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tcRaw of toolCallDeltas) {
          const tc = jsonRecord(tcRaw);
          const index = typeof tc.index === "number" ? tc.index : 0;
          const fn = jsonRecord(tc.function);
          let entry = toolByIndex.get(index);
          if (!entry) {
            entry = {
              id: typeof tc.id === "string" ? tc.id : `call-${index}`,
              name: typeof fn.name === "string" ? fn.name : "unknown_tool",
              argsBuf: "",
              started: false,
            };
            toolByIndex.set(index, entry);
          } else {
            if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
            if (typeof fn.name === "string" && fn.name) entry.name = fn.name;
          }
          if (!entry.started && entry.name && entry.id) {
            entry.started = true;
            handler.onToolStart?.({ id: entry.id, name: entry.name });
          }
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            entry.argsBuf += fn.arguments;
            if (entry.started) handler.onToolInputDelta?.(entry.id, fn.arguments);
          }
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      const u = jsonRecord(event.usage);
      if (Object.keys(u).length) usage = { ...usage, ...u };
    },
    signal,
  );

  const toolCalls: LocalInferenceResult["toolCalls"] = [...toolByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => {
      // parseToolArguments falls back to {input: raw} on JSON.parse failure.
      // When the upstream truncated the response (finish_reason=length), surface
      // a structured error so the AMP CLI doesn't dispatch a tool call with
      // garbage arguments.
      const parsed = parseToolArguments(entry.argsBuf);
      const looksTruncated =
        finishReason === "length" &&
        entry.argsBuf.length > 0 &&
        (Object.keys(parsed).length === 0 || (Object.keys(parsed).length === 1 && typeof parsed.input === "string"));
      if (looksTruncated) {
        logger.warn(
          `OpenAI tool input truncated: tool=${entry.name} id=${entry.id} model=${model} finish_reason=length partialBytes=${entry.argsBuf.length}`,
        );
        return {
          id: entry.id,
          name: entry.name,
          input: {
            error:
              "tool_input_truncated_max_tokens: model output hit the response length cap before tool JSON closed; raise max_output_tokens or shrink the request",
            partial: entry.argsBuf,
          },
        };
      }
      return { id: entry.id, name: entry.name, input: parsed };
    });

  if (finishReason === "length") {
    logger.warn(
      `OpenAI response stopped at finish_reason=length model=${model} — large outputs (e.g. file contents) may be truncated.`,
    );
  }

  if (Object.keys(usage).length) handler.onUsage?.(usage);
  return { provider: "openai", model, text, toolCalls, usage };
}

/** Output-token ceiling for Gemini models. Older Gemini-1.5 defaulted to 8192,
 *  which would silently truncate large tool inputs (the same failure class the
 *  Anthropic 8192 cap caused). Gemini-2.5/3 models accept up to 65536 output
 *  tokens, so we explicitly request 32768 — well above any sane file-write tool
 *  invocation but within every supported model's hard ceiling. */
export function googleMaxOutputTokens(_model: string): number {
  return 32768;
}

async function inferGoogle(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
  handler?: InferenceStreamHandler,
): Promise<LocalInferenceResult> {
  const streaming = !!handler;
  const body = {
    contents: googleContents(request.history, systemPrompt(request)),
    generationConfig: { maxOutputTokens: googleMaxOutputTokens(route.model) },
    ...(request.tools.length > 0
      ? { tools: [{ functionDeclarations: request.tools.map(toGoogleFunctionDeclaration) }] }
      : {}),
  };

  if (!streaming) {
    const json = await callLocalProvider(
      config,
      "google",
      `/v1beta/models/${encodeURIComponent(route.model)}:generateContent`,
      body,
      request.threadId,
      request.signal,
    );
    return collectGoogleJson(json, route.model);
  }

  const response = await callLocalProviderStream(
    config,
    "google",
    `/v1beta/models/${encodeURIComponent(route.model)}:streamGenerateContent`,
    body,
    request.threadId,
    request.signal,
  );
  return parseGoogleSse(response, route.model, handler, request.signal);
}

function collectGoogleJson(json: JsonRecord, model: string): LocalInferenceResult {
  const candidate = Array.isArray(json.candidates) ? jsonRecord(json.candidates[0]) : {};
  const content = jsonRecord(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const toolCalls: LocalInferenceResult["toolCalls"] = [];
  let text = "";

  for (const part of parts) {
    const item = jsonRecord(part);
    if (typeof item.text === "string") text += item.text;
    const functionCall = jsonRecord(item.functionCall);
    if (typeof functionCall.name === "string") {
      toolCalls.push({
        id: `google-${toolCalls.length}`,
        name: functionCall.name,
        input: jsonRecord(functionCall.args),
      });
    }
  }
  return { provider: "google", model, text, toolCalls, usage: jsonRecord(json.usageMetadata) };
}

async function parseGoogleSse(
  response: Response,
  model: string,
  handler: InferenceStreamHandler,
  signal?: AbortSignal,
): Promise<LocalInferenceResult> {
  let text = "";
  const toolCalls: LocalInferenceResult["toolCalls"] = [];
  let usage: JsonRecord = {};

  await readSseChunks(
    response,
    (chunk) => {
      const event = parseJsonChunk(chunk.data);
      if (!event) return;

      const candidates = Array.isArray(event.candidates) ? event.candidates : [];
      for (const candRaw of candidates) {
        const candidate = jsonRecord(candRaw);
        const content = jsonRecord(candidate.content);
        const parts = Array.isArray(content.parts) ? content.parts : [];
        for (const partRaw of parts) {
          const part = jsonRecord(partRaw);
          if (typeof part.text === "string" && part.text.length > 0) {
            text += part.text;
            handler.onTextDelta?.(part.text);
          }
          const functionCall = jsonRecord(part.functionCall);
          if (typeof functionCall.name === "string") {
            const id = `google-${toolCalls.length}`;
            const name = functionCall.name;
            const input = jsonRecord(functionCall.args);
            toolCalls.push({ id, name, input });
            handler.onToolStart?.({ id, name });
            handler.onToolInputDelta?.(id, JSON.stringify(input));
          }
        }
      }

      const u = jsonRecord(event.usageMetadata);
      if (Object.keys(u).length) usage = { ...usage, ...u };
    },
    signal,
  );

  if (Object.keys(usage).length) handler.onUsage?.(usage);
  return { provider: "google", model, text, toolCalls, usage };
}

async function callLocalProvider(
  config: ProxyConfig,
  providerName: string,
  subpath: string,
  providerBody: JsonRecord,
  threadId: string,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  const response = await invokeLocalProvider(config, providerName, subpath, providerBody, threadId, false, signal);
  return (await response.json()) as JsonRecord;
}

async function callLocalProviderStream(
  config: ProxyConfig,
  providerName: string,
  subpath: string,
  providerBody: JsonRecord,
  threadId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return invokeLocalProvider(config, providerName, subpath, providerBody, threadId, true, signal);
}

async function invokeLocalProvider(
  config: ProxyConfig,
  providerName: string,
  subpath: string,
  providerBody: JsonRecord,
  threadId: string,
  streaming: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const raw = JSON.stringify(providerBody);
  const body = parseBody(raw, subpath);
  const route = routeRequest(providerName, body.ampModel, config, threadId);
  if (!route.handler)
    throw new Error(`No connector-local provider available for ${providerName}/${body.ampModel ?? "?"}`);

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: streaming ? "text/event-stream" : "application/json",
    "x-session-id": threadId,
    ...(providerName === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
  });
  const rewrite = body.ampModel ? rewriter.rewrite(body.ampModel) : undefined;
  logger.info(
    `Neo local inference ${providerName} model=${body.ampModel ?? "?"} account=${route.account} stream=${streaming}`,
  );

  const response = await route.handler.forward(subpath, body, headers, rewrite, route.account, config, signal);
  if (!response.ok) throw new Error(await providerError(response));
  if (route.pool) recordSuccess(route.pool, route.account);
  return response;
}

async function readSseChunks(
  response: Response,
  onChunk: (chunk: sse.Chunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary === -1) continue;
      const complete = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      for (const chunk of sse.parse(complete)) onChunk(chunk);
    }

    if (buffer.trim()) for (const chunk of sse.parse(buffer)) onChunk(chunk);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function parseJsonChunk(data: string): JsonRecord | null {
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function explicitModel(agentMode: string, settings: JsonRecord): ModelRoute | null {
  const raw = settings["internal.model"];
  const value = typeof raw === "string" ? raw : jsonRecord(raw)[agentMode];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  const normalized = colon >= 0 ? `${trimmed.slice(0, colon).trim()}/${trimmed.slice(colon + 1).trim()}` : trimmed;
  const slash = normalized.indexOf("/");
  if (slash === -1) return { provider: providerForModel(normalized), model: normalized };

  const provider = normalized.slice(0, slash);
  const model = normalized.slice(slash + 1);
  if (provider === "anthropic") return { provider, model };
  if (provider === "openai") return { provider, model };
  if (provider === "google" || provider === "vertexai") return { provider: "google", model };
  return { provider: providerForModel(model), model };
}

function providerForModel(model: string): ModelRoute["provider"] {
  if (model.startsWith("gpt-") || model.includes("codex")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  return "anthropic";
}

function systemPrompt(request: LocalInferenceRequest): string {
  const cwd =
    typeof request.environment?.workingDirectory === "string" ? request.environment.workingDirectory : undefined;
  return [
    "You are Amp, a powerful AI coding agent. Help the user with software engineering tasks.",
    "Use registered tools when you need to inspect or modify the workspace.",
    cwd ? `Current working directory: ${cwd}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function anthropicMessages(history: LocalHistoryMessage[]): JsonRecord[] {
  const messages: JsonRecord[] = [];
  for (const msg of history) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.toolCallId, content: msg.text ?? "" }],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const content: JsonRecord[] = [];
      if (msg.text) content.push({ type: "text", text: msg.text });
      for (const call of msg.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    messages.push({ role: "user", content: [{ type: "text", text: msg.text ?? "" }] });
  }
  return ensureAnthropicToolResults(messages);
}

/** Anthropic strictly requires that every `tool_use` block in an assistant
 *  message be answered by a `tool_result` block (with matching `tool_use_id`)
 *  in the very next message. Stale persisted threads can break this invariant
 *  whenever a turn was cancelled, the connector restarted mid-tool, or a tool
 *  truncation aborted before the CLI returned a result.
 *
 *  This pass repairs the message list in-place: for any orphan `tool_use` ids
 *  in an assistant message, synthesize a placeholder `tool_result` (with
 *  `is_error: true`) and inject it into the next user message — or insert a
 *  fresh user message immediately after if none exists. Runs in O(N). */
function ensureAnthropicToolResults(messages: JsonRecord[]): JsonRecord[] {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const expectedIds: string[] = [];
    for (const block of content) {
      const item = jsonRecord(block);
      if (item.type === "tool_use" && typeof item.id === "string") expectedIds.push(item.id);
    }
    if (expectedIds.length === 0) continue;

    // Scan ALL consecutive user messages following this assistant turn — not
    // just messages[i+1]. anthropicMessages() emits one user message per tool
    // history entry, and the Anthropic validator merges consecutive same-role
    // messages during validation. If we only inspected i+1 we would synthesize
    // a stub for an id that is actually present in i+2 / i+3 / …, producing
    // duplicate tool_result blocks and a 400 "each tool_use must have a single
    // result" error.
    let userRunEnd = i + 1;
    while (userRunEnd < messages.length && messages[userRunEnd]!.role === "user") {
      userRunEnd++;
    }

    // Walk the user run: extract tool_result blocks (deduped by tool_use_id,
    // first occurrence wins) into a single bucket; preserve any non-tool_result
    // content (text, images, etc.) in its original message ordering.
    const seenToolIds = new Set<string>();
    const dedupedToolResults: JsonRecord[] = [];
    let duplicatesRemoved = 0;
    const leftoverMessages: JsonRecord[] = [];
    for (let j = i + 1; j < userRunEnd; j++) {
      const userMsg = messages[j]!;
      const userContent = Array.isArray(userMsg.content) ? (userMsg.content as JsonRecord[]) : [];
      const leftover: JsonRecord[] = [];
      for (const block of userContent) {
        const item = jsonRecord(block);
        if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
          if (seenToolIds.has(item.tool_use_id)) {
            duplicatesRemoved++;
            continue;
          }
          seenToolIds.add(item.tool_use_id);
          dedupedToolResults.push(item);
        } else {
          leftover.push(item);
        }
      }
      if (leftover.length > 0) leftoverMessages.push({ role: "user", content: leftover });
    }

    if (duplicatesRemoved > 0) {
      logger.warn(
        `Anthropic history repair: removed ${duplicatesRemoved} duplicate tool_result block(s) for assistant turn at message index ${i}`,
      );
    }

    const missing = expectedIds.filter((id) => !seenToolIds.has(id));
    const synthesized: JsonRecord[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "Tool execution did not complete in this session (cancelled, interrupted, or truncated).",
      is_error: true,
    }));

    if (synthesized.length > 0) {
      logger.warn(
        `Anthropic history repair: synthesizing tool_result for ${synthesized.length} orphan tool_use id(s) at message index ${i} (likely from a cancelled or interrupted prior turn)`,
      );
    }

    const allToolResults = [...dedupedToolResults, ...synthesized];
    const replacement: JsonRecord[] = [];
    if (allToolResults.length > 0) {
      replacement.push({ role: "user", content: allToolResults });
    }
    replacement.push(...leftoverMessages);

    // Replace the entire user run with the canonicalized form. If the user run
    // was empty (assistant was last) and we only synthesized stubs, this still
    // inserts the stub message correctly because removedCount is 0.
    const removedCount = userRunEnd - (i + 1);
    if (removedCount === 0 && replacement.length === 0) continue;
    messages.splice(i + 1, removedCount, ...replacement);
    // Skip past the messages we just rewrote — none of them are assistant
    // messages, so the i++ from the for loop will land us correctly on the
    // next assistant (if any).
    i += replacement.length;
  }
  return messages;
}

export function openAIMessages(history: LocalHistoryMessage[], system: string): JsonRecord[] {
  const messages: JsonRecord[] = [{ role: "system", content: system }];
  for (const msg of history) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      messages.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.text ?? "" });
      continue;
    }
    if (msg.role === "assistant") {
      const assistant: JsonRecord = { role: "assistant", content: msg.text || null };
      if (msg.toolCalls?.length) {
        assistant.tool_calls = msg.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      messages.push(assistant);
      continue;
    }
    messages.push({ role: "user", content: msg.text ?? "" });
  }
  return ensureOpenAIToolResponses(messages);
}

/** OpenAI Chat Completions requires a {role:"tool", tool_call_id} message for
 *  every tool_call emitted by an assistant turn. Cancellation / restart /
 *  truncation can leave orphan tool_calls. Synthesize stub responses so the
 *  Codex backend doesn't reject the request. */
function ensureOpenAIToolResponses(messages: JsonRecord[]): JsonRecord[] {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as JsonRecord[]) : [];
    if (calls.length === 0) continue;
    const expectedIds = calls.map((c) => (typeof c.id === "string" ? c.id : "")).filter(Boolean);
    if (expectedIds.length === 0) continue;

    // Scan and dedupe consecutive role:"tool" messages. If the same
    // tool_call_id appears twice (cloud-sync replay, persisted-state
    // corruption, etc.), drop the later occurrence so the Codex backend
    // does not see two responses for one tool_call.
    const seenIds = new Set<string>();
    let duplicatesRemoved = 0;
    let scan = i + 1;
    while (scan < messages.length && messages[scan]?.role === "tool") {
      const id = messages[scan]?.tool_call_id;
      if (typeof id === "string") {
        if (seenIds.has(id)) {
          messages.splice(scan, 1);
          duplicatesRemoved++;
          continue;
        }
        seenIds.add(id);
      }
      scan++;
    }
    if (duplicatesRemoved > 0) {
      logger.warn(
        `OpenAI history repair: removed ${duplicatesRemoved} duplicate tool message(s) for assistant turn at message index ${i}`,
      );
    }

    const missing = expectedIds.filter((id) => !seenIds.has(id));
    if (missing.length === 0) continue;

    logger.warn(
      `OpenAI history repair: synthesizing tool response for ${missing.length} orphan tool_call id(s) at message index ${i}`,
    );
    const synthesized: JsonRecord[] = missing.map((id) => ({
      role: "tool",
      tool_call_id: id,
      content: "Tool execution did not complete in this session (cancelled, interrupted, or truncated).",
    }));
    // Insert at the END of the existing tool sequence (scan), preserving the
    // order of any real tool responses already present.
    messages.splice(scan, 0, ...synthesized);
    i = scan + synthesized.length - 1;
  }
  return messages;
}

function googleContents(history: LocalHistoryMessage[], system: string): JsonRecord[] {
  const contents: JsonRecord[] = [{ role: "user", parts: [{ text: system }] }];
  for (const msg of history) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: msg.toolName ?? msg.toolCallId, response: { content: msg.text ?? "" } } }],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: JsonRecord[] = [];
      if (msg.text) parts.push({ text: msg.text });
      for (const call of msg.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.input } });
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: msg.text ?? "" }] });
  }
  return contents;
}

/** Normalize a tool's JSON-Schema-shaped `inputSchema` into a form every
 *  upstream provider accepts.
 *
 *  - Anthropic's Messages API rejects `tools[].input_schema` whose `type` is
 *    not exactly `"object"` ("input_schema.type: Field required" / "Input
 *    should be 'object'").
 *  - OpenAI's Chat Completions and Codex Responses APIs validate the
 *    `function.parameters` JSON Schema and refuse anything that is not a
 *    well-formed object schema.
 *  - Google's Gemini `functionDeclarations[].parameters` similarly requires
 *    `{ type: "OBJECT", properties: {...} }` shape.
 *
 *  Amp's local NeoLocalActor.registerTools coerces every incoming `inputSchema`
 *  to a JsonRecord (defaulting to `{}` when the executor sends nothing), so by
 *  the time we get here the value is never null/undefined — but it can still
 *  be a typeless empty object `{}` or an object that defines `properties`
 *  without declaring `"type": "object"`. The previous `?? { type: "object" }`
 *  guard only triggered on null/undefined, leaving these typeless schemas to
 *  reach Anthropic verbatim and 400 the request.
 *
 *  This normalizer:
 *  - Forces `type: "object"` whenever it is missing (the only top-level
 *    schema type any of the three providers accepts for a tool).
 *  - Ensures `properties` is at least `{}` so the schema is structurally
 *    valid and Gemini's strict shape check passes.
 *  - Leaves user-supplied fields (`required`, `additionalProperties`,
 *    `description`, `$defs`, etc.) intact so well-typed schemas pass through
 *    unchanged.
 *
 *  Cross-platform: pure-logic transform with no environment dependencies. */
export function normalizeToolSchema(schema: unknown): JsonRecord {
  const base = schema && typeof schema === "object" && !Array.isArray(schema) ? { ...(schema as JsonRecord) } : {};
  if (typeof base.type !== "string") base.type = "object";
  if (base.type === "object") {
    if (!base.properties || typeof base.properties !== "object" || Array.isArray(base.properties)) {
      base.properties = {};
    }
  }
  return base;
}

function toAnthropicTool(tool: NeoToolSpec): JsonRecord {
  return { name: tool.name, description: tool.description ?? "", input_schema: normalizeToolSchema(tool.inputSchema) };
}

function toOpenAITool(tool: NeoToolSpec): JsonRecord {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: normalizeToolSchema(tool.inputSchema),
    },
  };
}

function toGoogleFunctionDeclaration(tool: NeoToolSpec): JsonRecord {
  return { name: tool.name, description: tool.description ?? "", parameters: normalizeToolSchema(tool.inputSchema) };
}

/** Normalize an Amp reasoning effort label to the OpenAI Responses-API value.
 *
 *  Modern OpenAI/Codex reasoning models (gpt-5, gpt-5.x including gpt-5.5)
 *  accept "minimal" | "low" | "medium" | "high". The Codex CLI also uses
 *  "xhigh" as an extension for some models; downstream `clampReasoningEffort`
 *  in providers/codex.ts is responsible for downgrading "xhigh" or "minimal"
 *  for any model that does not support them. */
export function openAIReasoningEffort(effort?: string): string {
  switch (effort) {
    case "minimal":
    case "none":
      return "minimal";
    case "low":
      return "low";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
    case "medium":
      return "medium";
    default:
      return "medium";
  }
}

export function openAIReasoningEffortForRequest(agentMode: string, effort?: string): string {
  return openAIReasoningEffort(effort ?? (agentMode === "rush" ? "minimal" : undefined));
}

function parseToolArguments(value: unknown): JsonRecord {
  if (typeof value !== "string") return jsonRecord(value);
  try {
    return jsonRecord(JSON.parse(value));
  } catch {
    return { input: value };
  }
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `Local provider returned ${response.status}${text ? `: ${text.slice(0, 1000)}` : ""}`;
}

export function historyTextFromRun(run: unknown): string {
  return runToText(run);
}
