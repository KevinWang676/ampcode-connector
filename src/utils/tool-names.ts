/** Bidirectional translation of Amp tool names ↔ Claude Code MCP tool names.
 *
 *  api.anthropic.com classifies OAuth Bearer requests against the Claude Code
 *  Pro/Max subscription only when the request body looks like Claude Code traffic.
 *  Custom tool names that don't follow either Anthropic's builtin tool catalogue
 *  or the `mcp__<server>__<tool>` MCP convention cause Anthropic to fall back to
 *  the third-party API-credits billing path (resulting in 400
 *  "You're out of extra usage" once those credits are exhausted).
 *
 *  This helper rewrites Amp's tool names to the MCP convention on the request
 *  side and undoes the rewrite on the response side, leaving Anthropic-native
 *  and Claude-Code-builtin tools untouched. */

const MCP_SERVER_NAME = "amp";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Tools shipped with Claude Code itself. Names are case-sensitive and must
 *  pass through unmodified so Anthropic recognises them as builtin. */
const CLAUDE_CODE_BUILTIN_TOOLS = new Set([
  "Task",
  "Bash",
  "BashOutput",
  "KillBash",
  "Glob",
  "Grep",
  "LS",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookRead",
  "NotebookEdit",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "ExitPlanMode",
]);

/** Anthropic-server-builtin tool names (typed `tools[]` entries with versioned
 *  `type` fields like `web_search_20250305`). */
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "computer",
  "str_replace_editor",
  "bash",
  "code_execution",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function shouldPrefixToolName(name: string): boolean {
  return !name.startsWith("mcp__") && !CLAUDE_CODE_BUILTIN_TOOLS.has(name) && !ANTHROPIC_BUILTIN_TOOL_NAMES.has(name);
}

function shouldPrefixToolDefinition(tool: Record<string, unknown>): boolean {
  if (typeof tool.name !== "string") return false;
  // Anthropic-native server tools carry a versioned `type` (e.g. `web_search_20250305`).
  if (typeof tool.type === "string" && tool.type !== "custom") return false;
  return shouldPrefixToolName(tool.name);
}

export function toAnthropicToolName(name: string): string {
  return shouldPrefixToolName(name) ? `${MCP_PREFIX}${name}` : name;
}

export function fromAnthropicToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Rewrite Amp tool names to the Claude Code MCP convention in-place.
 *  Touches `tools[].name`, `tool_choice.name`, and `messages[].content[].name`
 *  for tool_use blocks. Returns true if any field was modified. */
export function rewriteAnthropicRequestToolNames(body: Record<string, unknown>): boolean {
  let modified = false;

  const renamed = new Map<string, string>();
  const passthrough = new Set<string>();

  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const item of tools) {
      const tool = record(item);
      if (!tool || typeof tool.name !== "string") continue;
      const original = tool.name;
      if (shouldPrefixToolDefinition(tool)) {
        const next = toAnthropicToolName(original);
        if (next !== original) {
          tool.name = next;
          renamed.set(original, next);
          modified = true;
        } else {
          passthrough.add(original);
        }
      } else {
        passthrough.add(original);
      }
    }
  }

  const remap = (name: string): string => {
    const mapped = renamed.get(name);
    if (mapped) return mapped;
    if (passthrough.has(name)) return name;
    return toAnthropicToolName(name);
  };

  const toolChoice = record(body.tool_choice);
  if (toolChoice?.type === "tool" && typeof toolChoice.name === "string") {
    const next = remap(toolChoice.name);
    if (next !== toolChoice.name) {
      toolChoice.name = next;
      modified = true;
    }
  }

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const msg = record(message);
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const blockValue of msg.content) {
        const block = record(blockValue);
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const next = remap(block.name);
        if (next !== block.name) {
          block.name = next;
          modified = true;
        }
      }
    }
  }

  return modified;
}

/** Strip the `mcp__amp__` prefix from any tool_use blocks in an Anthropic
 *  response or SSE event so Amp's local tool registry can match by name.
 *  Returns true if any field was modified. */
export function unrewriteAnthropicResponseToolNames(body: Record<string, unknown>): boolean {
  let modified = false;

  if (rewriteToolUseContentArray(body.content)) modified = true;

  const message = record(body.message);
  if (message && rewriteToolUseContentArray(message.content)) modified = true;

  const contentBlock = record(body.content_block);
  if (contentBlock && rewriteToolUseBlock(contentBlock)) modified = true;

  // Anthropic does not currently stream tool_use names via `delta`, but cover it
  // defensively in case the wire format extends.
  const delta = record(body.delta);
  if (delta && rewriteToolUseBlock(delta)) modified = true;

  return modified;
}

function rewriteToolUseContentArray(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let modified = false;
  for (const value of content) {
    const block = record(value);
    if (block && rewriteToolUseBlock(block)) modified = true;
  }
  return modified;
}

function rewriteToolUseBlock(block: Record<string, unknown>): boolean {
  if (block.type !== "tool_use" || typeof block.name !== "string") return false;
  const next = fromAnthropicToolName(block.name);
  if (next === block.name) return false;
  block.name = next;
  return true;
}
