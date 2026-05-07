/** Connector-local inference adapter for Neo ThreadActor execution. */

import type { ProxyConfig } from "../config/config.ts";
import * as rewriter from "../proxy/rewriter.ts";
import { recordSuccess, routeRequest } from "../routing/router.ts";
import { logger } from "../utils/logger.ts";
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
}

export interface LocalInferenceResult {
  model: string;
  provider: "anthropic" | "openai" | "google";
  text: string;
  toolCalls: Array<{ id: string; name: string; input: JsonRecord }>;
  usage?: JsonRecord;
}

interface ModelRoute {
  provider: "anthropic" | "openai" | "google";
  model: string;
}

export async function generateLocalThreadTitle(config: ProxyConfig, threadId: string, messageText: string): Promise<{ title?: string; usage?: JsonRecord }> {
  if (!messageText.trim()) return {};
  const titleMessage = cleanTitleMessage(messageText);
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 60,
    temperature: 0.7,
    stream: false,
    system: 'You are an assistant that generates short, descriptive titles in sentence case based on user\'s message to an agentic coding tool. Be concise, precise, and do not guess beyond the message. Omit generic words like "question" or "request". Ignore validation markers and requested exact-output strings; title the underlying coding task. Use the set_title tool to provide your answer.',
    messages: [{ role: "user", content: `<message>${titleMessage}</message>` }],
    tools: [{ name: "set_title", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }],
    tool_choice: { type: "tool", name: "set_title", disable_parallel_tool_use: true },
  };
  const json = await callLocalProvider(config, "anthropic", "/v1/messages", body, threadId);
  const first = jsonRecord(Array.isArray(json.content) ? json.content[0] : undefined);
  const input = jsonRecord(first.input);
  return { title: typeof input.title === "string" ? sanitizeTitle(input.title) : undefined, usage: jsonRecord(json.usage) };
}

function cleanTitleMessage(message: string): string {
  return message
    .replace(/for validation marker\s+\S+[,]?\s*/gi, "")
    .replace(/reply with exactly\s+\S+\s+and nothing else\.?/gi, "")
    .replace(/\bTITLE_[A-Z0-9_]+\b/g, "")
    .replace(/\s+/g, " ")
    .trim() || message;
}

function sanitizeTitle(title: string): string | undefined {
  const words = title.replace(/^['"`]+|['"`.!?:;]+$/g, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return undefined;
  const compact = words.join(" ").toLowerCase();
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

export async function extractLocalThreadContent(config: ProxyConfig, currentThreadId: string, mentionedThreadId: string, threadMarkdown: string, goal: string): Promise<string> {
  const prompt = `Here is the mentioned thread content:\n\n<mentionedThread>\n${threadMarkdown}\n</mentionedThread>\n\nYou are helping me extract relevant information from the mentioned thread based on a goal.\n\n## Task\n\nI am talking to another user. They mentioned a thread (a conversation) in their last message. I turned the thread into Markdown and provided it to you, along with a goal of what I want you to extract.\n\nYour job is to:\n1. Analyze the mentioned thread's content\n2. Identify information that is relevant to the goal\n3. Extract and preserve those relevant parts with full fidelity\n4. Omit clearly irrelevant content to keep the context concise\n\n## Guidelines\n\n**Preserve Fidelity**: When content IS relevant, include it completely with all important details, code snippets, explanations, and context.\n**Be Selective**: When content is clearly NOT relevant to the user's query, omit it entirely.\n**Maintain Structure**: Keep the extracted content well-organized and coherent. If multiple parts are relevant, preserve their logical flow.\n**Technical Precision**: Preserve exact technical details like file paths, function names, error messages, and code snippets that are relevant.\n\n## Goal\n\n${goal}\n\n## Your Response\n\nReturn only the extracted relevant information as markdown text. Do not wrap it in JSON.`;

  const result = await inferLocal(config, {
    actorId: `read-thread-${mentionedThreadId}`,
    threadId: currentThreadId,
    agentMode: "rush",
    settings: { "internal.model": "anthropic/claude-haiku-4-5-20251001" },
    history: [{ role: "user", text: prompt }],
    tools: [],
    environment: {},
  });
  return result.text.trim() || threadMarkdown;
}

export async function inferLocal(config: ProxyConfig, request: LocalInferenceRequest): Promise<LocalInferenceResult> {
  const modelRoute = selectModelRoute(request.agentMode, request.settings);

  switch (modelRoute.provider) {
    case "anthropic":
      return inferAnthropic(config, request, modelRoute);
    case "openai":
      return inferOpenAI(config, request, modelRoute);
    case "google":
      return inferGoogle(config, request, modelRoute);
  }
}

export function selectModelRoute(agentMode: string, settings: JsonRecord): ModelRoute {
  const explicit = explicitModel(agentMode, settings);
  if (explicit) return explicit;

  switch (agentMode) {
    case "deep":
      return { provider: "openai", model: "gpt-5.5" };
    case "rush":
      return { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
    case "large":
      return { provider: "anthropic", model: "claude-opus-4-6" };
    case "smart":
    default:
      return { provider: "anthropic", model: "claude-opus-4-7" };
  }
}

async function inferAnthropic(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
): Promise<LocalInferenceResult> {
  const body = {
    model: route.model,
    max_tokens: 8192,
    stream: false,
    system: [{ type: "text", text: systemPrompt(request) }],
    messages: anthropicMessages(request.history),
    ...(request.tools.length > 0
      ? { tools: request.tools.map(toAnthropicTool), tool_choice: { type: "auto" as const } }
      : {}),
  };

  const json = await callLocalProvider(config, "anthropic", "/v1/messages", body, request.threadId);
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

  return { provider: "anthropic", model: route.model, text, toolCalls, usage: jsonRecord(json.usage) };
}

async function inferOpenAI(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
): Promise<LocalInferenceResult> {
  const body = {
    model: route.model,
    stream: false,
    messages: openAIMessages(request.history, systemPrompt(request)),
    reasoning_effort: openAIReasoningEffort(request.reasoningEffort),
    ...(request.tools.length > 0 ? { tools: request.tools.map(toOpenAITool), tool_choice: "auto" } : {}),
  };

  const json = await callLocalProvider(config, "openai", "/v1/chat/completions", body, request.threadId);
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

async function inferGoogle(
  config: ProxyConfig,
  request: LocalInferenceRequest,
  route: ModelRoute,
): Promise<LocalInferenceResult> {
  const body = {
    contents: googleContents(request.history, systemPrompt(request)),
    ...(request.tools.length > 0
      ? { tools: [{ functionDeclarations: request.tools.map(toGoogleFunctionDeclaration) }] }
      : {}),
  };

  const json = await callLocalProvider(
    config,
    "google",
    `/v1beta/models/${encodeURIComponent(route.model)}:generateContent`,
    body,
    request.threadId,
  );
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

  return { provider: "google", model: route.model, text, toolCalls, usage: jsonRecord(json.usageMetadata) };
}

async function callLocalProvider(
  config: ProxyConfig,
  providerName: string,
  subpath: string,
  providerBody: JsonRecord,
  threadId: string,
): Promise<JsonRecord> {
  const raw = JSON.stringify(providerBody);
  const body = parseBody(raw, subpath);
  const route = routeRequest(providerName, body.ampModel, config, threadId);
  if (!route.handler) throw new Error(`No connector-local provider available for ${providerName}/${body.ampModel ?? "?"}`);

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-session-id": threadId,
    ...(providerName === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
  });
  const rewrite = body.ampModel ? rewriter.rewrite(body.ampModel) : undefined;
  logger.info(`Neo local inference ${providerName} model=${body.ampModel ?? "?"} account=${route.account}`);

  const response = await route.handler.forward(subpath, body, headers, rewrite, route.account);
  if (!response.ok) throw new Error(await providerError(response));
  if (route.pool) recordSuccess(route.pool, route.account);
  return (await response.json()) as JsonRecord;
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
  const cwd = typeof request.environment?.workingDirectory === "string" ? request.environment.workingDirectory : undefined;
  return [
    "You are Amp, a powerful AI coding agent. Help the user with software engineering tasks.",
    "Use registered tools when you need to inspect or modify the workspace.",
    cwd ? `Current working directory: ${cwd}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function anthropicMessages(history: LocalHistoryMessage[]): JsonRecord[] {
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
  return messages;
}

function openAIMessages(history: LocalHistoryMessage[], system: string): JsonRecord[] {
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

function toAnthropicTool(tool: NeoToolSpec): JsonRecord {
  return { name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema ?? { type: "object" } };
}

function toOpenAITool(tool: NeoToolSpec): JsonRecord {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object" } },
  };
}

function toGoogleFunctionDeclaration(tool: NeoToolSpec): JsonRecord {
  return { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object" } };
}

function openAIReasoningEffort(effort?: string): string {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  if (effort === "minimal" || effort === "none") return "low";
  return "medium";
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
