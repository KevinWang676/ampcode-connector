import { describe, expect, test } from "bun:test";
import { buildGeminiApiKeyUrl, provider as googleProvider, prepareGeminiApiKeyBody } from "../src/providers/google.ts";
import { parseBody } from "../src/server/body.ts";
import { maybeWrap, stripGoogleThoughtSignatures } from "../src/utils/code-assist.ts";
import { resolveModel, rewriteBodyModel } from "../src/utils/models.ts";
import * as path from "../src/utils/path.ts";

describe("path.modelFromUrl", () => {
  test("extracts model from Gemini-style path", () => {
    expect(path.modelFromUrl("/v1beta/models/gemini-pro:generateContent")).toBe("gemini-pro");
  });

  test("extracts model from streaming path", () => {
    expect(path.modelFromUrl("/v1beta/models/gemini-3-flash-preview:streamGenerateContent")).toBe(
      "gemini-3-flash-preview",
    );
  });

  test("returns null for non-matching path", () => {
    expect(path.modelFromUrl("/v1/messages")).toBeNull();
  });

  test("returns null for empty path", () => {
    expect(path.modelFromUrl("")).toBeNull();
  });

  test("extracts from nested model path", () => {
    expect(path.modelFromUrl("/api/v1beta/models/gemini-pro:generateContent")).toBe("gemini-pro");
  });
});

describe("google Gemini API key support", () => {
  test("makes Google provider available without OAuth when an API key is configured", () => {
    const config = {
      hostname: "localhost",
      port: 8765,
      ampUpstreamUrl: "https://ampcode.com",
      geminiApiKey: "test-key",
      logLevel: "error" as const,
      providers: { anthropic: true, codex: true, google: true },
    };

    expect(googleProvider.isAvailable(0, config)).toBe(true);
    expect(googleProvider.accountCount(config)).toBeGreaterThanOrEqual(1);
  });

  test("builds direct Gemini API key URLs with SSE when streaming", () => {
    expect(
      buildGeminiApiKeyUrl(
        "https://generativelanguage.googleapis.com",
        "gemini-3-flash-preview",
        "streamGenerateContent",
        true,
        "test-key",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?key=test-key&alt=sse",
    );
  });
});

describe("google thought signatures", () => {
  test("strips Gemini thought signatures before cross-strategy forwarding", () => {
    const body = {
      contents: [
        {
          role: "model",
          parts: [
            { text: "reasoning summary", thoughtSignature: "gemini-bound-signature", thought: true },
            { thought_signature: "legacy-signature" },
            { text: "visible answer" },
          ],
        },
      ],
    };

    const stripped = stripGoogleThoughtSignatures(body);

    expect(stripped).toEqual({
      contents: [
        {
          role: "model",
          parts: [{ text: "reasoning summary", thought: true }, { text: "visible answer" }],
        },
      ],
    });
    expect(body.contents[0]!.parts[0]!.thoughtSignature).toBe("gemini-bound-signature");
  });

  test("wraps Antigravity requests without provider-bound thought signatures", () => {
    const wrapped = maybeWrap(
      {
        contents: [{ role: "model", parts: [{ text: "x", thoughtSignature: "gemini-bound-signature" }] }],
      },
      "{}",
      "project",
      "gemini-3-flash",
      {
        userAgent: "antigravity",
        requestIdPrefix: "agent",
        requestType: "agent",
        stripThoughtSignatures: true,
      },
    );

    const envelope = JSON.parse(wrapped) as { request: { contents: Array<{ parts: Array<Record<string, unknown>> }> } };
    expect(envelope.request.contents[0]!.parts[0]).toEqual({ text: "x" });
  });

  test("strips thought signatures before Gemini API key fallback", () => {
    const body = JSON.stringify({
      contents: [
        {
          role: "model",
          parts: [
            { text: "reasoning summary", thoughtSignature: "oauth-bound-signature", thought: true },
            { thought_signature: "legacy-signature" },
            { text: "visible answer" },
          ],
        },
      ],
    });

    expect(JSON.parse(prepareGeminiApiKeyBody(body, null))).toEqual({
      contents: [
        {
          role: "model",
          parts: [{ text: "reasoning summary", thought: true }, { text: "visible answer" }],
        },
      ],
    });
  });
});

describe("resolveModel", () => {
  test("strips -api-preview suffix", () => {
    expect(resolveModel("gpt-5.3-codex-api-preview")).toBe("gpt-5.3-codex");
  });

  test("leaves normal models unchanged", () => {
    expect(resolveModel("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(resolveModel("gemini-3-pro-preview")).toBe("gemini-3-pro-preview");
  });
});

describe("rewriteBodyModel", () => {
  test("replaces model in body string", () => {
    const parsed = { model: "gpt-5.3-codex-api-preview", stream: true };
    const result = rewriteBodyModel(parsed, "gpt-5.3-codex");
    expect(JSON.parse(result).model).toBe("gpt-5.3-codex");
  });

  test("preserves other fields", () => {
    const parsed = { model: "gpt-5.3-codex-api-preview", messages: [{ role: "user" }], stream: true };
    const result = rewriteBodyModel(parsed, "gpt-5.3-codex");
    const out = JSON.parse(result);
    expect(out.model).toBe("gpt-5.3-codex");
    expect(out.messages).toEqual([{ role: "user" }]);
    expect(out.stream).toBe(true);
  });

  test("does not mutate original parsed object", () => {
    const parsed = { model: "gpt-5.3-codex-api-preview", stream: true };
    rewriteBodyModel(parsed, "gpt-5.3-codex");
    expect(parsed.model).toBe("gpt-5.3-codex-api-preview");
  });
});

describe("parseBody", () => {
  test("extracts model from JSON body", () => {
    const body = parseBody(JSON.stringify({ model: "claude-opus-4-6", stream: true }), "/v1/messages");
    expect(body.ampModel).toBe("claude-opus-4-6");
    expect(body.stream).toBe(true);
    expect(body.forwardBody).toBe(body.raw);
  });

  test("falls back to URL model when body has no model field", () => {
    const body = parseBody(JSON.stringify({ stream: true }), "/v1beta/models/gemini-pro:generateContent");
    expect(body.ampModel).toBe("gemini-pro");
  });

  test("returns null model for empty body", () => {
    const body = parseBody("", "/v1/messages");
    expect(body.ampModel).toBeNull();
    expect(body.stream).toBe(false);
  });

  test("rewrites -api-preview model in forwardBody", () => {
    const raw = JSON.stringify({ model: "gpt-5.3-codex-api-preview", stream: true });
    const body = parseBody(raw, "/v1/chat/completions");
    expect(body.ampModel).toBe("gpt-5.3-codex-api-preview");
    expect(JSON.parse(body.forwardBody).model).toBe("gpt-5.3-codex");
    expect(body.raw).toBe(raw);
  });

  test("handles invalid JSON gracefully", () => {
    const body = parseBody("not json", "/v1/messages");
    expect(body.parsed).toBeNull();
    expect(body.forwardBody).toBe("not json");
  });
});
