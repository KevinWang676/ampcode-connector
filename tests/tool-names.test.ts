import { describe, expect, test } from "bun:test";
import {
  fromAnthropicToolName,
  rewriteAnthropicRequestToolNames,
  toAnthropicToolName,
  unrewriteAnthropicResponseToolNames,
} from "../src/utils/tool-names.ts";

describe("toAnthropicToolName", () => {
  test("prefixes Amp-only tool names with mcp__amp__", () => {
    expect(toAnthropicToolName("oracle")).toBe("mcp__amp__oracle");
    expect(toAnthropicToolName("librarian")).toBe("mcp__amp__librarian");
    expect(toAnthropicToolName("painter")).toBe("mcp__amp__painter");
    expect(toAnthropicToolName("code_review")).toBe("mcp__amp__code_review");
  });

  test("leaves Claude Code builtin tool names untouched", () => {
    for (const name of ["Read", "Bash", "Grep", "Glob", "Task", "Edit", "Write", "WebSearch"]) {
      expect(toAnthropicToolName(name)).toBe(name);
    }
  });

  test("leaves names that are already MCP-prefixed untouched", () => {
    expect(toAnthropicToolName("mcp__github__list_issues")).toBe("mcp__github__list_issues");
    expect(toAnthropicToolName("mcp__amp__oracle")).toBe("mcp__amp__oracle");
  });
});

describe("fromAnthropicToolName", () => {
  test("strips the mcp__amp__ prefix", () => {
    expect(fromAnthropicToolName("mcp__amp__oracle")).toBe("oracle");
    expect(fromAnthropicToolName("mcp__amp__code_review")).toBe("code_review");
  });

  test("does not strip prefixes from other MCP servers", () => {
    expect(fromAnthropicToolName("mcp__github__list_issues")).toBe("mcp__github__list_issues");
  });

  test("leaves unprefixed names untouched", () => {
    expect(fromAnthropicToolName("Read")).toBe("Read");
    expect(fromAnthropicToolName("oracle")).toBe("oracle");
  });
});

describe("rewriteAnthropicRequestToolNames", () => {
  test("rewrites tools[].name and tool_choice.name in lockstep", () => {
    const body: Record<string, unknown> = {
      tools: [
        { name: "oracle", input_schema: { type: "object" } },
        { name: "Read", input_schema: { type: "object" } },
      ],
      tool_choice: { type: "tool", name: "oracle" },
    };

    const modified = rewriteAnthropicRequestToolNames(body);
    expect(modified).toBe(true);
    expect((body.tools as Array<{ name: string }>)[0]?.name).toBe("mcp__amp__oracle");
    expect((body.tools as Array<{ name: string }>)[1]?.name).toBe("Read");
    expect((body.tool_choice as { name: string }).name).toBe("mcp__amp__oracle");
  });

  test("rewrites tool_use names in conversation history", () => {
    const body: Record<string, unknown> = {
      tools: [{ name: "oracle", input_schema: { type: "object" } }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "oracle", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
    };

    rewriteAnthropicRequestToolNames(body);
    const assistantContent = (body.messages as Array<{ content: Array<{ name?: string }> }>)[0]?.content;
    expect(assistantContent?.[0]?.name).toBe("mcp__amp__oracle");
    // tool_result blocks have tool_use_id, not name; must not be touched
    const userContent = (body.messages as Array<{ content: Array<{ tool_use_id?: string; name?: string }> }>)[1]
      ?.content;
    expect(userContent?.[0]?.tool_use_id).toBe("toolu_1");
    expect(userContent?.[0]?.name).toBeUndefined();
  });

  test("does not prefix Anthropic-server-builtin tools (typed entries like web_search_20250305)", () => {
    const body: Record<string, unknown> = {
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    rewriteAnthropicRequestToolNames(body);
    expect((body.tools as Array<{ name: string }>)[0]?.name).toBe("web_search");
  });

  test("returns false when nothing needed rewriting", () => {
    const body: Record<string, unknown> = {
      tools: [
        { name: "Read", input_schema: { type: "object" } },
        { name: "Bash", input_schema: { type: "object" } },
      ],
    };
    expect(rewriteAnthropicRequestToolNames(body)).toBe(false);
  });
});

describe("unrewriteAnthropicResponseToolNames", () => {
  test("strips mcp__amp__ from tool_use blocks in non-streaming responses", () => {
    const body: Record<string, unknown> = {
      type: "message",
      content: [{ type: "tool_use", id: "toolu_1", name: "mcp__amp__oracle", input: {} }],
    };
    expect(unrewriteAnthropicResponseToolNames(body)).toBe(true);
    expect((body.content as Array<{ name: string }>)[0]?.name).toBe("oracle");
  });

  test("strips mcp__amp__ from streaming content_block_start events", () => {
    const body: Record<string, unknown> = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "mcp__amp__code_review", input: {} },
    };
    expect(unrewriteAnthropicResponseToolNames(body)).toBe(true);
    expect((body.content_block as { name: string }).name).toBe("code_review");
  });

  test("leaves tool_use names from other MCP servers untouched", () => {
    const body: Record<string, unknown> = {
      content: [{ type: "tool_use", id: "toolu_1", name: "mcp__github__list_issues", input: {} }],
    };
    expect(unrewriteAnthropicResponseToolNames(body)).toBe(false);
    expect((body.content as Array<{ name: string }>)[0]?.name).toBe("mcp__github__list_issues");
  });

  test("does not touch text content blocks or unrelated fields", () => {
    const body: Record<string, unknown> = {
      content: [
        { type: "text", text: "mcp__amp__should_not_change_text" },
        { type: "tool_use", id: "toolu_1", name: "mcp__amp__oracle", input: { name: "ignore_me" } },
      ],
    };
    unrewriteAnthropicResponseToolNames(body);
    const blocks = body.content as Array<{ type: string; text?: string; name?: string; input?: { name?: string } }>;
    expect(blocks[0]?.text).toBe("mcp__amp__should_not_change_text");
    expect(blocks[1]?.name).toBe("oracle");
    expect(blocks[1]?.input?.name).toBe("ignore_me");
  });
});
