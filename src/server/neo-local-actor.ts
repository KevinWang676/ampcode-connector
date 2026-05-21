import type { ProxyConfig } from "../config/config.ts";
import { logger } from "../utils/logger.ts";
import { extractLocalThreadContent, generateLocalThreadTitle, inferLocal } from "./neo-local-inference.ts";
import { type LocalActorSnapshot, NeoLocalPersistence } from "./neo-local-persistence.ts";
import {
  decodeThreadMessage,
  type JsonRecord,
  jsonRecord,
  type LocalHistoryMessage,
  type NeoThreadMessage,
  type NeoToolSpec,
  type NeoToolUseBlock,
  newMessageId,
  normalizeNeoUsage,
  normalizeToolCallId,
  nowIso,
  runToText,
  sendProtocol,
  textFromBlocks,
  toolResultMessageId,
} from "./neo-protocol.ts";
export interface SocketData {
  actorId: string;
}
interface PendingToolCall {
  id: string;
  name: string;
  input: JsonRecord;
  agentMode: string;
  reasoningEffort?: string;
}
const THREAD_ID_PATTERN = /T-[0-9A-Za-z][0-9A-Za-z-]*/;
const READ_THREAD_MAX_CHARS = 80_000;
const READ_THREAD_TOOL_RESULT_MAX_CHARS = 8_000;
const READ_THREAD_JSON_BLOCK_MAX_CHARS = 2_000;
const RUSH_REMOVED_TOOL_NAMES = new Set(["grep", "glob", "create_file"]);
interface QueuedUserMessage {
  role: "user";
  messageId: string;
  content: unknown[];
  userState?: unknown;
  meta?: JsonRecord;
  createdAt?: string;
  agentMode?: string;
  reasoningEffort?: string;
}
export interface LocalThreadActorOptions {
  config: ProxyConfig;
  actorId: string;
  threadId: string;
  input?: JsonRecord;
  snapshot?: LocalActorSnapshot;
  persist?: (snapshot: LocalActorSnapshot) => void;
}
function extractRequestedThreadId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(THREAD_ID_PATTERN)?.[0] ?? null;
}

export async function localReadThreadRun(
  input: JsonRecord,
  store = new NeoLocalPersistence(),
  config?: ProxyConfig,
  currentThreadId = "local-read-thread",
): Promise<JsonRecord | null> {
  const requestedThreadId = extractRequestedThreadId(input.threadID);
  if (!requestedThreadId) return null;
  const actor = store.jsonForThread(requestedThreadId);
  const result = actor ? compactThreadMarkdown(actor, requestedThreadId) : store.markdownForThread(requestedThreadId);
  if (!result) return null;
  const goal = typeof input.goal === "string" ? input.goal : "Extract the relevant information from this thread.";
  const extracted = config
    ? await extractLocalThreadContent(config, currentThreadId, requestedThreadId, result, goal).catch((err) => {
        logger.warn("Local read_thread extraction failed; returning compact transcript", {
          threadID: requestedThreadId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
    : null;
  return {
    status: "done",
    result: extracted ?? result,
    threadID: requestedThreadId,
    source: extracted ? "ampcode-connector-local-neo-extraction" : "ampcode-connector-local-neo-store",
  };
}

function compactThreadMarkdown(actor: JsonRecord, threadId: string): string {
  const snapshot = jsonRecord(actor.snapshot);
  const title = typeof snapshot.title === "string" && snapshot.title.trim() ? snapshot.title : threadId;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages.map(jsonRecord) : [];
  const lines = [`# ${title}`, "", `Thread: ${threadId}`, ""];
  for (const message of messages.sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const role = typeof message.role === "string" ? message.role.toUpperCase() : "MESSAGE";
    const messageId = typeof message.messageId === "string" ? ` — ${message.messageId}` : "";
    const text = compactBlocks(message.content).trim();
    if (!text) continue;
    lines.push(`## ${role}${messageId}`, "", text, "");
  }
  return clipText(
    lines.join("\n").trim(),
    READ_THREAD_MAX_CHARS,
    "\n\n[Thread transcript compacted for context window]",
  );
}

function compactBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const rendered = blocks.map(compactBlock).filter(Boolean).join("\n\n");
  return rendered;
}

function compactBlock(block: unknown): string {
  if (!jsonRecord(block).type) return clipText(JSON.stringify(block), READ_THREAD_JSON_BLOCK_MAX_CHARS);
  const item = jsonRecord(block);
  if (item.type === "thinking") return "";
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "tool_use")
    return `Tool call: ${String(item.name ?? "unknown")}\n\`\`\`json\n${clipText(JSON.stringify(item.input ?? {}, null, 2), READ_THREAD_JSON_BLOCK_MAX_CHARS)}\n\`\`\``;
  if (item.type === "tool_result")
    return `Tool result (${String(item.toolUseID ?? "unknown")}):\n\`\`\`\n${clipText(cleanToolResultText(runToText(item.run)), READ_THREAD_TOOL_RESULT_MAX_CHARS)}\n\`\`\``;
  if (item.type === "manual_bash_invocation")
    return `Manual bash invocation: ${clipText(JSON.stringify(item.args ?? {}), READ_THREAD_JSON_BLOCK_MAX_CHARS)}`;
  return clipText(JSON.stringify(stripHugeFields(item), null, 2), READ_THREAD_JSON_BLOCK_MAX_CHARS);
}

function cleanToolResultText(text: string): string {
  return text
    .replace(/<loaded_skill[\s\S]*?<\/loaded_skill>/g, "[loaded skill content omitted]")
    .replace(/gAAAAAB[0-9A-Za-z_-]{200,}/g, "[encrypted content omitted]");
}

function stripHugeFields(value: JsonRecord): JsonRecord {
  const copy = { ...value };
  delete copy.signature;
  delete copy.openAIReasoning;
  delete copy.encryptedContent;
  delete copy.thinking;
  return copy;
}

function clipText(text: string, max: number, suffix = "\n[truncated]"): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}` : text;
}

export function toolsForAgentMode(agentMode: string, tools: NeoToolSpec[]): NeoToolSpec[] {
  return tools.filter(
    (tool) => !tool.meta?.deferred && (agentMode !== "rush" || !RUSH_REMOVED_TOOL_NAMES.has(tool.name.toLowerCase())),
  );
}

export function localFindThreadRun(input: JsonRecord, store = new NeoLocalPersistence()): JsonRecord | null {
  const query = typeof input.query === "string" ? input.query : "";
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 20;
  const threads = store.findThreads(query, limit, 0);
  if (threads.length === 0) return null;
  const lines = threads.map((thread, index) => {
    const id = String(thread.id ?? "unknown");
    const title = String(thread.title ?? id);
    const updated = typeof thread.updatedAt === "string" ? ` — updated ${thread.updatedAt}` : "";
    return `${index + 1}. ${title}\n   Thread ID: ${id}${updated}`;
  });
  return {
    status: "done",
    result: `Found ${threads.length} local connector Neo thread(s) matching ${JSON.stringify(query)}:\n\n${lines.join("\n\n")}`,
    threads,
    source: "ampcode-connector-local-neo-store",
  };
}

export class LocalThreadActor {
  private sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  private seq = 1;
  private settings: JsonRecord = {};
  private tools = new Map<string, NeoToolSpec>();
  private messages: Array<NeoThreadMessage & { seq: number }> = [];
  private history: LocalHistoryMessage[] = [];
  private queue: QueuedUserMessage[] = [];
  private pendingTools = new Map<string, PendingToolCall>();
  private approvals = new Map<string, JsonRecord>();
  private agentState = "idle";
  private executorId: string | null = null;
  private executorReady = false;
  private environment: JsonRecord = {};
  private title: string | null = null;
  private cloud: LocalActorSnapshot["cloud"];
  private generation = 0;
  private currentAgentMode = "smart";
  private currentReasoningEffort: string | undefined;
  private activeAssistantMessageId: string | undefined;
  private titleGenerationStarted = false;
  private inferenceAbort: AbortController | null = null;
  constructor(private readonly options: LocalThreadActorOptions) {
    const snapshot = options.snapshot;
    if (snapshot) {
      this.seq = snapshot.seq;
      this.settings = snapshot.settings;
      this.messages = snapshot.messages;
      this.history = snapshot.history;
      this.queue = snapshot.queue as unknown as QueuedUserMessage[];
      this.agentState = snapshot.agentState === "idle" ? "idle" : "idle";
      this.environment = snapshot.environment;
      this.title = snapshot.title;
      this.cloud = snapshot.cloud;
      this.currentAgentMode = this.agentMode();
      this.currentReasoningEffort = this.reasoningEffort();
      if (
        this.synthesizeMissingToolResults(
          "Tool execution did not complete before the connector session ended.",
          false,
        ) > 0
      )
        this.persist();
      return;
    }
    const fromInput = jsonRecord(options.input?.input);
    if (typeof fromInput.agentMode === "string") this.settings.agentMode = fromInput.agentMode;
    this.currentAgentMode = this.agentMode();
    this.persist();
  }
  importCloudThread(thread: JsonRecord): void {
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    this.settings = {
      ...this.settings,
      ...(typeof thread.agentMode === "string" ? { agentMode: thread.agentMode } : {}),
    };
    this.title = typeof thread.title === "string" ? thread.title : this.title;
    this.cloud = { ...this.cloud, meta: jsonRecord(thread.meta) };
    this.messages = messages.map((raw, index) => {
      const msg = jsonRecord(raw);
      const role = msg.role === "assistant" || msg.role === "info" ? msg.role : "user";
      return {
        threadId: this.options.threadId,
        role,
        messageId:
          typeof msg.messageId === "string"
            ? msg.messageId
            : typeof msg.protocolMessageID === "string"
              ? msg.protocolMessageID
              : newMessageId(),
        content: Array.isArray(msg.content) ? msg.content : [],
        agentMode: typeof msg.agentMode === "string" ? msg.agentMode : undefined,
        reasoningEffort: typeof msg.reasoningEffort === "string" ? msg.reasoningEffort : undefined,
        meta: jsonRecord(msg.meta),
        userState: msg.userState,
        state:
          role === "assistant"
            ? jsonRecord(msg.state).type
              ? (jsonRecord(msg.state) as NeoThreadMessage["state"])
              : { type: "complete", stopReason: "end_turn" }
            : undefined,
        usage: jsonRecord(msg.usage),
        seq: index + 1,
      };
    });
    this.seq = this.messages.length + 1;
    this.currentAgentMode = this.agentMode();
    this.rebuildHistory();
    this.persist();
  }
  snapshot(): LocalActorSnapshot {
    return {
      version: 1,
      actorId: this.options.actorId,
      threadId: this.options.threadId,
      settings: this.settings,
      messages: this.messages,
      history: this.history,
      queue: this.queue as unknown as JsonRecord[],
      seq: this.seq,
      agentState: "idle",
      environment: this.environment,
      title: this.title,
      cloud: this.cloud,
      updatedAt: nowIso(),
    };
  }
  open(ws: Bun.ServerWebSocket<SocketData>): void {
    this.sockets.add(ws);
    this.sendSnapshot(ws, 0);
    this.broadcastObservers();
  }
  close(ws: Bun.ServerWebSocket<SocketData>): void {
    this.sockets.delete(ws);
    this.broadcastObservers();
  }
  dispose(): void {
    for (const ws of this.sockets) ws.close(1000, "Actor destroyed");
    this.sockets.clear();
  }
  message(ws: Bun.ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array): void {
    const msg = decodeThreadMessage(raw);
    if (!msg?.type || typeof msg.type !== "string") {
      sendProtocol(ws, { type: "error", message: "Invalid Neo protocol message", code: "PARSE_ERROR" });
      return;
    }
    logger.info(`Neo local runtime WS recv ${msg.type}`);
    this.handle(ws, msg).catch((err) => this.fail(err));
  }
  private async handle(ws: Bun.ServerWebSocket<SocketData>, msg: JsonRecord): Promise<void> {
    switch (msg.type) {
      case "client_resume":
        return this.sendSnapshot(ws, typeof msg.version === "number" ? msg.version : 0);
      case "client_update_thread_settings":
        return this.updateSettings(jsonRecord(msg.settings));
      case "executor_connect":
        return this.executorConnect(msg);
      case "executor_environment_snapshot":
      case "executor_environment_update":
        return this.updateEnvironment(jsonRecord(msg.environment));
      case "executor_tools_register":
        return this.registerTools(msg.tools);
      case "executor_tools_unregister":
        return this.unregisterTools(msg.toolNames);
      case "executor_tools_bootstrap_complete":
        return this.completeExecutorBootstrap(msg);
      case "executor_tool_lease_ack":
        return;
      case "client_append_user_msg":
        return this.receiveUserMessage(msg);
      case "executor_tool_result":
        return this.receiveToolResult(msg);
      case "tool_progress":
        return this.broadcast(msg);
      case "executor_tool_approval_request":
        return this.receiveApprovalRequest(jsonRecord(msg.approval));
      case "client_tool_approval_response":
        return this.resolveApproval(msg);
      case "client_filesystem_read_directory":
        return this.broadcast({ type: "executor_filesystem_read_directory", requestId: msg.requestId, uri: msg.uri });
      case "client_filesystem_read_file":
        return this.broadcast({ type: "executor_filesystem_read_file", requestId: msg.requestId, uri: msg.uri });
      case "executor_filesystem_read_directory_result":
        return this.broadcast({ ...msg, type: "client_filesystem_read_directory_result" });
      case "executor_filesystem_read_file_result":
        return this.broadcast({ ...msg, type: "client_filesystem_read_file_result" });
      case "executor_plugin_message":
        return this.broadcast({ type: "plugin_message", message: msg.message });
      case "executor_artifact_upsert":
        return this.broadcast({ type: "artifact_upserted", artifact: msg.artifact });
      case "executor_artifact_delete":
        return this.broadcast({ type: "artifact_deleted", key: msg.key });
      case "client_cancel":
        return this.cancel();
      case "client_remove_queued_msg":
        return this.removeQueuedMessage(String(msg.queuedMessageId ?? ""));
      case "client_steer_queued_msg":
        return this.steerQueuedMessage(String(msg.queuedMessageId ?? ""));
      case "client_edit_message":
        return this.editMessage(msg);
      case "client_mark_message_read":
        return this.markRead(String(msg.messageId ?? ""), true);
      case "client_mark_message_unread":
        return this.markRead(String(msg.messageId ?? ""), false);
      case "client_set_thread_title":
        return this.setTitle(typeof msg.title === "string" ? msg.title : null);
      case "client_retry":
        return this.retry();
      case "client_dismiss_active_error":
        return this.broadcast({ type: "error_cleared", seq: typeof msg.seq === "number" ? msg.seq : this.nextSeq() });
      case "client_append_manual_bash_invocation":
        return this.appendManualBashInvocation(msg);
      case "client_spawn_executor":
        return this.rejectExecutorSpawn(msg);
      case "client_upsert_notification_subscription":
        return;
      default:
        logger.debug(`Neo local runtime ignored message ${msg.type}`);
    }
  }
  private updateSettings(settings: JsonRecord): void {
    const priorAgentMode = this.agentMode();
    this.settings = {
      ...settings,
      ...(typeof settings.agentMode === "string" ? {} : { agentMode: priorAgentMode }),
    };
    this.currentAgentMode = this.agentMode();
    this.broadcast({ type: "thread_settings", settings: this.settings });
    this.persist();
  }
  private executorConnect(msg: JsonRecord): void {
    this.executorId = typeof msg.clientId === "string" ? msg.clientId : this.executorId;
    this.executorReady = false;
    this.environment = { ...this.environment, ...jsonRecord(jsonRecord(msg.capabilities).environment) };
    this.sendExecutorConnected();
    this.broadcastObservers();
    this.persist();
  }
  private updateEnvironment(environment: JsonRecord): void {
    this.environment = environment;
    this.broadcast({ type: "environment_update", environment });
    this.persist();
  }
  private persistAgentMode(agentMode: string): void {
    if (this.settings.agentMode === agentMode) return;
    this.settings = { ...this.settings, agentMode };
    this.broadcast({ type: "thread_settings", settings: this.settings });
  }
  private completeExecutorBootstrap(msg: JsonRecord): void {
    if (msg.ok === false) {
      this.fail(new Error(typeof msg.error === "string" ? msg.error : "Executor bootstrap failed"));
      return;
    }
    this.executorReady = true;
    this.sendExecutorConnected();
    this.processQueue();
  }

  private receiveUserMessage(msg: JsonRecord): void {
    const user: QueuedUserMessage = {
      role: "user",
      messageId: typeof msg.messageId === "string" ? msg.messageId : newMessageId(),
      content: Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }],
      userState: msg.userState,
      meta: jsonRecord(msg.meta),
      createdAt: nowIso(),
      agentMode: typeof msg.agentMode === "string" ? msg.agentMode : undefined,
      reasoningEffort: typeof msg.reasoningEffort === "string" ? msg.reasoningEffort : undefined,
    };

    if (this.agentState !== "idle" || !this.executorReady) {
      this.queue.push(user);
      this.broadcast({
        type: "queued_message_added",
        message: { steer: Boolean(msg.steer), queuedMessage: user },
        seq: this.nextSeq(),
      });
      this.persist();
      return;
    }
    this.startUserMessage(user);
  }

  private startUserMessage(user: QueuedUserMessage): void {
    const effectiveAgentMode = user.agentMode ?? this.agentMode();
    const effectiveReasoningEffort = user.reasoningEffort ?? this.reasoningEffort();
    this.persistAgentMode(effectiveAgentMode);
    const message = this.storeMessage({
      threadId: this.options.threadId,
      role: "user",
      messageId: user.messageId,
      content: user.content as NeoThreadMessage["content"],
      agentMode: effectiveAgentMode,
      reasoningEffort: effectiveReasoningEffort,
      userState: user.userState,
      meta: user.meta,
      createdAt: user.createdAt,
    });
    this.history.push({ role: "user", text: textFromBlocks(user.content) });
    this.broadcast({ type: "message_added", message: this.protocolMessage(message), seq: message.seq });
    this.persist();
    this.maybeGenerateTitle(user.content);
    void this.runInference(effectiveAgentMode, effectiveReasoningEffort);
  }

  private maybeGenerateTitle(content: unknown[]): void {
    if (this.title || this.titleGenerationStarted || this.messages.some((message) => message.role === "user") === false)
      return;
    const text = textFromBlocks(content);
    this.titleGenerationStarted = true;
    generateLocalThreadTitle(this.options.config, this.options.threadId, text)
      .then(({ title }) => {
        if (title && !this.title) this.setTitle(title);
      })
      .catch((err) =>
        logger.warn("Neo local title generation failed", {
          threadID: this.options.threadId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  private async runInference(agentMode: string, reasoningEffort?: string): Promise<void> {
    const generation = ++this.generation;
    const assistantId = newMessageId();
    this.activeAssistantMessageId = assistantId;
    this.currentAgentMode = agentMode;
    this.currentReasoningEffort = reasoningEffort;
    this.setAgentState("working", assistantId, agentMode, reasoningEffort);
    const activeTools = toolsForAgentMode(agentMode, [...this.tools.values()]);
    this.broadcast({
      type: "inference_tools",
      messageId: assistantId,
      agentMode,
      tools: activeTools.map((tool) => tool.name),
    });

    if (this.inferenceAbort) this.inferenceAbort.abort();
    const abortController = new AbortController();
    this.inferenceAbort = abortController;

    let streamingStarted = false;
    let lastUsage: JsonRecord | undefined;

    const ensureStreamingState = (): void => {
      if (streamingStarted) return;
      streamingStarted = true;
      this.setAgentState("streaming", assistantId, agentMode, reasoningEffort);
    };

    try {
      const result = await inferLocal(
        this.options.config,
        {
          actorId: this.options.actorId,
          threadId: this.options.threadId,
          agentMode,
          reasoningEffort,
          settings: this.settings,
          history: this.history,
          tools: activeTools,
          environment: this.environment,
          signal: abortController.signal,
          onHistoryCompacted: (history) => {
            if (generation !== this.generation) return;
            this.history = history;
            this.persist();
          },
        },
        {
          // Send each text chunk as an INCREMENTAL delta. Neo `delta.blocks` is
          // append/patch by blockIndex (mirrors Anthropic Messages SSE), not a
          // snapshot — so we must emit just the new bytes, not the full
          // accumulated text. Sending snapshots was O(N²) over the run length
          // and caused the visible mid-stream slowdown.
          onTextDelta: (chunk) => {
            if (generation !== this.generation) return;
            if (!chunk) return;
            ensureStreamingState();
            this.broadcast({
              type: "delta",
              messageId: assistantId,
              role: "assistant",
              blocks: [{ type: "text", text: chunk }],
              blockIndex: 0,
              state: "generating",
            });
          },
          onThinkingDelta: () => {
            if (generation !== this.generation) return;
            ensureStreamingState();
          },
          onToolStart: (call) => {
            if (generation !== this.generation) return;
            ensureStreamingState();
            // Tool blocks land in finishAssistantMessage with their final
            // input. Streaming partial tool stubs through delta would race
            // the final complete tool_use block in the CLI's view.
            void call;
          },
          onToolInputDelta: () => {
            if (generation !== this.generation) return;
            ensureStreamingState();
          },
          onUsage: (usage) => {
            lastUsage = usage;
          },
        },
      );

      if (generation !== this.generation) return;
      if (this.inferenceAbort === abortController) this.inferenceAbort = null;
      const toolCalls = result.toolCalls.map((call) => ({ ...call, id: normalizeToolCallId(call.id) }));
      logger.info(`Neo local inference complete text=${result.text.length} toolCalls=${toolCalls.length}`);
      await this.finishAssistantMessage(
        assistantId,
        result.text,
        toolCalls,
        result.usage ?? lastUsage,
        agentMode,
        reasoningEffort,
        streamingStarted,
      );
    } catch (err) {
      if (this.inferenceAbort === abortController) this.inferenceAbort = null;
      if (generation !== this.generation) return;
      // Suppress AbortError noise when caller cancelled mid-flight
      if (abortController.signal.aborted) {
        this.activeAssistantMessageId = undefined;
        this.setAgentState("idle", assistantId, agentMode, reasoningEffort);
        this.processQueue();
        return;
      }
      this.fail(err);
      this.activeAssistantMessageId = undefined;
      this.setAgentState("idle", assistantId, agentMode, reasoningEffort);
      this.processQueue();
    }
  }

  private async finishAssistantMessage(
    messageId: string,
    text: string,
    toolCalls: Array<Omit<PendingToolCall, "agentMode">>,
    usage: JsonRecord | undefined,
    agentMode: string,
    reasoningEffort?: string,
    alreadyStreamedText = false,
  ): Promise<void> {
    const blocks: Array<NeoToolUseBlock | { type: "text"; text: string }> = [];
    if (text) blocks.push({ type: "text", text });
    for (const call of toolCalls)
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input, complete: true });

    const neoUsage = normalizeNeoUsage(usage);
    this.setAgentState("streaming", messageId, agentMode, reasoningEffort);

    // When we streamed token-level text deltas, do NOT replay the full
    // accumulated text here — the CLI has already appended each chunk via
    // delta.blocks[0].text. Replaying would duplicate the response. Only
    // append tool_use blocks (which we don't stream incrementally) and the
    // terminal usage frame.
    if (!alreadyStreamedText) {
      this.broadcast({
        type: "delta",
        messageId,
        role: "assistant",
        blocks,
        blockIndex: 0,
        state: toolCalls.length ? "tool_use" : "generating",
        usage: neoUsage,
      });
    } else if (toolCalls.length > 0) {
      // After streaming text, append the tool_use blocks at index 1+.
      const toolBlocks = blocks.filter((block) => block.type === "tool_use");
      this.broadcast({
        type: "delta",
        messageId,
        role: "assistant",
        blocks: toolBlocks,
        blockIndex: text ? 1 : 0,
        state: "tool_use",
        usage: neoUsage,
      });
    }
    if (toolCalls.length === 0)
      this.broadcast({ type: "delta", messageId, role: "assistant", blocks: [], state: "complete", usage: neoUsage });

    const stored = this.storeMessage({
      threadId: this.options.threadId,
      messageId,
      role: "assistant",
      content: blocks,
      agentMode,
      reasoningEffort,
      state: { type: "complete", stopReason: toolCalls.length ? "tool_use" : "end_turn" },
      usage: neoUsage,
      createdAt: nowIso(),
    });
    this.broadcast({ type: "message_added", message: this.protocolMessage(stored), seq: stored.seq });
    this.history.push({ role: "assistant", text, toolCalls });
    this.persist();

    if (toolCalls.length === 0) {
      this.activeAssistantMessageId = undefined;
      this.setAgentState("idle", messageId, agentMode, reasoningEffort);
      this.processQueue();
      return;
    }

    for (const call of toolCalls) this.pendingTools.set(call.id, { ...call, agentMode, reasoningEffort });
    this.setAgentState("running_tools", messageId, agentMode, reasoningEffort);
    for (const call of toolCalls) {
      const localRun = await this.localToolRun(call);
      if (localRun) {
        this.receiveToolRun(call.id, localRun, false);
      } else {
        this.broadcast({
          type: "tool_lease",
          toolCallId: call.id,
          toolName: call.name,
          args: call.input,
          messageId: stored.messageId,
        });
      }
    }
  }

  private receiveToolResult(msg: JsonRecord): void {
    this.receiveToolRun(String(msg.toolCallId ?? ""), jsonRecord(msg.run), true);
  }

  private synthesizeMissingToolResults(
    reason: string,
    shouldBroadcast: boolean,
    onlyToolCallIds?: Set<string>,
  ): number {
    const ordered = [...this.messages].sort((a, b) => a.seq - b.seq);
    let synthesizedCount = 0;
    for (let i = 0; i < ordered.length; i++) {
      const message = ordered[i]!;
      if (message.role !== "assistant") continue;
      const expectedIds = message.content
        .filter((block): block is NeoToolUseBlock => jsonRecord(block).type === "tool_use")
        .map((block) => block.id)
        .filter((id) => !onlyToolCallIds || onlyToolCallIds.has(id));
      if (expectedIds.length === 0) continue;

      const answeredIds = new Set<string>();
      let scan = i + 1;
      while (scan < ordered.length && ordered[scan]?.role === "user") {
        const content = ordered[scan]?.content ?? [];
        const hasNonToolResult = content.some((block) => jsonRecord(block).type !== "tool_result");
        if (hasNonToolResult) break;
        for (const block of content) {
          const item = jsonRecord(block);
          if (item.type === "tool_result" && typeof item.toolUseID === "string") answeredIds.add(item.toolUseID);
        }
        scan++;
      }

      const missingIds = expectedIds.filter((id) => !answeredIds.has(id));
      if (missingIds.length === 0) continue;

      const nextSeq = ordered[i + 1]?.seq;
      const seq = nextSeq === undefined ? this.nextSeq() : message.seq + (nextSeq - message.seq) / 2;
      const run = { status: "cancelled", reason };
      const synthetic = {
        threadId: this.options.threadId,
        role: "user" as const,
        messageId: missingIds.length === 1 ? toolResultMessageId(missingIds[0]!) : newMessageId(),
        content: missingIds.map((toolCallId) => ({ type: "tool_result", toolUseID: toolCallId, run })),
        createdAt: nowIso(),
        seq,
      };
      this.messages.push(synthetic);
      ordered.splice(i + 1, 0, synthetic);
      synthesizedCount += missingIds.length;
      if (shouldBroadcast)
        this.broadcast({
          type: "message_added",
          message: this.protocolMessage(synthetic),
          seq: synthetic.seq,
          parentToolUseId: missingIds.length === 1 ? missingIds[0] : undefined,
        });
    }
    if (synthesizedCount > 0) this.rebuildHistory();
    return synthesizedCount;
  }

  private receiveToolRun(toolCallId: string, run: JsonRecord, ackExecutor: boolean): void {
    const pending = this.pendingTools.get(toolCallId);
    if (!pending) {
      this.broadcast({
        type: "executor_error",
        message: `Unknown tool lease ${toolCallId}`,
        toolCallId,
        code: "LEASE_NOT_FOUND",
      });
      return;
    }

    this.pendingTools.delete(toolCallId);
    const message = this.storeMessage({
      threadId: this.options.threadId,
      role: "user",
      messageId: toolResultMessageId(toolCallId),
      content: [{ type: "tool_result", toolUseID: toolCallId, run }],
      createdAt: nowIso(),
    });
    this.history.push({ role: "tool", toolCallId, toolName: pending.name, text: runToText(run) });
    this.broadcast({
      type: "message_added",
      message: this.protocolMessage(message),
      seq: message.seq,
      parentToolUseId: toolCallId,
    });
    if (ackExecutor) this.broadcast({ type: "executor_tool_result_ack", toolCallId });
    this.persist();

    if (this.pendingTools.size === 0) {
      this.activeAssistantMessageId = undefined;
      void this.runInference(pending.agentMode, pending.reasoningEffort);
    }
  }

  private async localToolRun(call: Omit<PendingToolCall, "agentMode">): Promise<JsonRecord | null> {
    if (call.name === "read_thread")
      return localReadThreadRun(call.input, new NeoLocalPersistence(), this.options.config, this.options.threadId);
    if (call.name === "find_thread") return localFindThreadRun(call.input);
    return null;
  }

  private receiveApprovalRequest(approval: JsonRecord): void {
    const id = typeof approval.id === "string" ? approval.id : String(approval.toolCallId ?? newMessageId());
    this.approvals.set(id, { ...approval, id });
    this.broadcastApprovalQueue();
  }

  private resolveApproval(msg: JsonRecord): void {
    const toolCallId = String(msg.toolCallId ?? "");
    for (const [id, approval] of this.approvals) if (approval.toolCallId === toolCallId) this.approvals.delete(id);
    this.broadcast({
      type: "executor_tool_approval_response",
      toolCallId,
      accepted: Boolean(msg.accepted),
      input: jsonRecord(msg.input),
    });
    this.broadcastApprovalQueue();
  }

  private editMessage(msg: JsonRecord): void {
    const index = this.messages.findIndex((message) => message.messageId === msg.messageId && message.role === "user");
    if (index < 0) {
      this.broadcast({
        type: "edit_rejected",
        editId: String(msg.editId ?? "unknown"),
        message: "Message not found",
      });
      return;
    }
    const removed = this.messages[index + 1];
    this.messages[index] = {
      ...this.messages[index]!,
      content: Array.isArray(msg.content) ? msg.content : [],
      agentMode: typeof msg.agentMode === "string" ? msg.agentMode : this.messages[index]!.agentMode,
    };
    this.messages = this.messages.slice(0, index + 1);
    this.rebuildHistory();
    this.broadcast({
      type: "message_updated",
      message: this.protocolMessage(this.messages[index]!),
      seq: this.messages[index]!.seq,
    });
    if (removed)
      this.broadcast({ type: "thread_truncated", seq: this.nextSeq(), truncateFromMessage: removed.messageId });
    this.persist();
    void this.runInference(typeof msg.agentMode === "string" ? msg.agentMode : this.agentMode());
  }

  private appendManualBashInvocation(msg: JsonRecord): void {
    const message = this.storeMessage({
      threadId: this.options.threadId,
      role: "info",
      messageId: newMessageId(),
      content: [
        {
          type: "manual_bash_invocation",
          args: jsonRecord(msg.args),
          toolRun: jsonRecord(msg.run),
          hidden: Boolean(msg.hidden),
        },
      ],
      createdAt: nowIso(),
    });
    this.broadcast({ type: "message_added", message: this.protocolMessage(message), seq: message.seq });
    this.persist();
  }

  private sendSnapshot(ws: Bun.ServerWebSocket<SocketData>, sinceSeq: number): void {
    sendProtocol(ws, { type: "thread_settings", settings: this.settings });
    sendProtocol(ws, {
      type: "queued_messages",
      messages: this.queue.map((queuedMessage) => ({ steer: false, queuedMessage })),
    });
    sendProtocol(ws, {
      type: "observers",
      count: this.sockets.size,
      observers: [],
      hasExecutor: Boolean(this.executorId),
    });
    if (this.executorId) this.sendExecutorConnected(ws);
    if (this.title) sendProtocol(ws, { type: "thread_title", title: this.title });
    if (Object.keys(this.environment).length > 0)
      sendProtocol(ws, { type: "environment_update", environment: this.environment });
    for (const message of this.messages)
      if (message.seq > sinceSeq)
        sendProtocol(ws, { type: "message_added", message: this.protocolMessage(message), seq: message.seq });
    sendProtocol(ws, {
      type: "agent_state",
      state: this.agentState,
      agentMode: this.currentAgentMode,
      reasoningEffort: this.currentReasoningEffort,
    });
  }

  private sendExecutorConnected(ws?: Bun.ServerWebSocket<SocketData>): void {
    const message = {
      type: "executor_connected",
      executorId: this.executorId ?? "local-executor",
      registeredToolCount: this.tools.size,
      guidanceInventory: [],
      resumeBootstrap: false,
    };
    if (ws) sendProtocol(ws, message);
    else this.broadcast(message);
  }

  private registerTools(rawTools: unknown): void {
    for (const raw of Array.isArray(rawTools) ? rawTools : []) {
      const tool = jsonRecord(raw) as unknown as NeoToolSpec;
      if (typeof tool.name === "string")
        this.tools.set(tool.name, { ...tool, inputSchema: jsonRecord(tool.inputSchema) });
    }
  }

  private unregisterTools(rawNames: unknown): void {
    for (const name of Array.isArray(rawNames) ? rawNames : []) if (typeof name === "string") this.tools.delete(name);
  }

  private markRead(messageId: string, read: boolean): void {
    const message = this.messages.find((item) => item.messageId === messageId);
    if (!message) return;
    (message as NeoThreadMessage & { readAt?: string | null }).readAt = read ? nowIso() : null;
    this.broadcast({ type: "message_updated", message: this.protocolMessage(message), seq: message.seq });
    this.persist();
  }

  private setTitle(title: string | null): void {
    if (this.title !== title) this.nextSeq();
    this.title = title;
    this.broadcast({ type: "thread_title", title });
    this.persist();
  }

  private retry(): void {
    if (this.agentState !== "idle") return;
    void this.runInference(this.currentAgentMode, this.currentReasoningEffort);
  }

  private rejectExecutorSpawn(msg: JsonRecord): void {
    this.broadcast({
      type: "executor_status",
      spawnId: typeof msg.requestId === "string" ? msg.requestId : undefined,
      status: "failed",
      message: "Local connector runtime does not spawn remote executors",
      details: { reasonCode: "spawn_rejected" },
    });
  }

  private storeMessage(message: NeoThreadMessage): NeoThreadMessage & { seq: number } {
    const existing = this.messages.findIndex((item) => item.messageId === message.messageId);
    const withSeq = { ...message, seq: existing >= 0 ? this.messages[existing]!.seq : this.nextSeq() };
    if (existing >= 0) this.messages[existing] = withSeq;
    else this.messages.push(withSeq);
    return withSeq;
  }

  private protocolMessage(message: NeoThreadMessage & { seq: number }): NeoThreadMessage {
    const { seq: _seq, ...payload } = message;
    return payload;
  }

  private rebuildHistory(): void {
    this.history = [];
    for (const message of this.messages.sort((a, b) => a.seq - b.seq)) {
      if (message.role === "assistant")
        this.history.push({
          role: "assistant",
          text: textFromBlocks(message.content),
          toolCalls: message.content
            .filter((block): block is NeoToolUseBlock => jsonRecord(block).type === "tool_use")
            .map((block) => ({ id: block.id, name: block.name, input: block.input })),
        });
      if (message.role === "user")
        this.history.push(
          ...message.content.map((block) =>
            jsonRecord(block).type === "tool_result"
              ? {
                  role: "tool" as const,
                  toolCallId: String(jsonRecord(block).toolUseID ?? ""),
                  text: runToText(jsonRecord(block).run),
                }
              : { role: "user" as const, text: textFromBlocks([block]) },
          ),
        );
    }
  }

  private broadcast(message: unknown): void {
    for (const ws of this.sockets) sendProtocol(ws, message);
  }

  private setAgentState(
    state: string,
    messageId?: string,
    agentMode = this.agentMode(),
    reasoningEffort?: string,
  ): void {
    this.agentState = state;
    this.broadcast({ type: "agent_state", state, messageId, agentMode, reasoningEffort });
  }

  private processQueue(): void {
    if (this.agentState !== "idle") return;
    const next = this.queue.shift();
    if (!next) return;
    this.broadcast({ type: "queued_message_dequeued", queuedMessageId: next.messageId, seq: this.nextSeq() });
    this.persist();
    this.startUserMessage(next);
  }

  private removeQueuedMessage(messageId: string): void {
    this.queue = this.queue.filter((message) => message.messageId !== messageId);
    this.broadcast({ type: "queued_message_removed", queuedMessageId: messageId, seq: this.nextSeq() });
    this.persist();
  }

  private steerQueuedMessage(messageId: string): void {
    this.broadcast({
      type: "queued_messages",
      messages: this.queue.map((queuedMessage) => ({ steer: queuedMessage.messageId === messageId, queuedMessage })),
    });
  }

  private cancel(): void {
    this.generation++;
    if (this.inferenceAbort) {
      this.inferenceAbort.abort();
      this.inferenceAbort = null;
    }
    const messageId =
      this.activeAssistantMessageId ?? this.messages.findLast((message) => message.role === "assistant")?.messageId;
    const pendingToolIds = new Set(this.pendingTools.keys());
    if (pendingToolIds.size > 0)
      this.synthesizeMissingToolResults(
        "Tool execution was cancelled before a result was returned.",
        true,
        pendingToolIds,
      );
    this.pendingTools.clear();
    this.approvals.clear();
    this.broadcastApprovalQueue();
    this.broadcast({ type: "cancelled", seq: this.nextSeq(), messageId });
    if (messageId) {
      const existing = this.messages.find((message) => message.messageId === messageId);
      if (!existing) {
        const message = this.storeMessage({
          threadId: this.options.threadId,
          role: "assistant",
          messageId,
          content: [],
          state: { type: "cancelled", stopReason: "cancelled" },
          createdAt: nowIso(),
        });
        this.broadcast({ type: "message_added", message: this.protocolMessage(message), seq: message.seq });
      }
      this.broadcast({ type: "delta", messageId, role: "assistant", blocks: [], state: "cancelled" });
    }
    this.activeAssistantMessageId = undefined;
    this.setAgentState("idle", messageId);
    this.persist();
    this.processQueue();
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Neo local actor error", { error: message });
    this.broadcast({ type: "error", message, code: "INTERNAL_ERROR" });
    this.broadcast({ type: "error_set", seq: this.nextSeq(), error: { message, code: "INTERNAL_ERROR" } });
  }

  private broadcastObservers(): void {
    this.broadcast({
      type: "observers",
      count: this.sockets.size,
      observers: [],
      hasExecutor: Boolean(this.executorId),
    });
  }

  private broadcastApprovalQueue(): void {
    this.broadcast({ type: "tool_approval_queue", approvals: [...this.approvals.values()] });
  }

  private persist(): void {
    this.options.persist?.(this.snapshot());
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private agentMode(): string {
    if (typeof this.settings.agentMode === "string") return this.settings.agentMode;
    const firstMode = this.messages.find(
      (message) => message.role === "user" && typeof message.agentMode === "string",
    )?.agentMode;
    return firstMode ?? this.currentAgentMode ?? "smart";
  }

  private reasoningEffort(): string | undefined {
    if (typeof this.settings["reasoning.effort"] === "string") return this.settings["reasoning.effort"];
    const firstEffort = this.messages.find(
      (message) => message.role === "user" && typeof message.reasoningEffort === "string",
    )?.reasoningEffort;
    return firstEffort ?? this.currentReasoningEffort;
  }
}
