/** Forwards requests to api.anthropic.com with Claude Code stealth headers. */

import { createHash } from "node:crypto";
import { anthropic as config } from "../auth/configs.ts";
import * as oauth from "../auth/oauth.ts";
import * as store from "../auth/store.ts";
import { ANTHROPIC_API_URL, CLAUDE_CODE_VERSION, claudeCodeBetas, filteredBetaFeatures } from "../constants.ts";
import type { ParsedBody } from "../server/body.ts";
import { rewriteAnthropicRequestToolNames } from "../utils/tool-names.ts";
import type { Provider } from "./base.ts";
import { denied, forward } from "./forward.ts";

/** Headers to drop from client request (replaced by connector or irrelevant). */
const DROP_HEADERS = new Set(["host", "content-length", "connection", "x-api-key", "authorization", "anthropic-beta"]);

/** Extract X-Stainless-* and other passthrough headers from the client request. */
function passthroughHeaders(originalHeaders: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of originalHeaders.entries()) {
    if (DROP_HEADERS.has(k)) continue;
    // Drop amp-specific headers
    if (k.startsWith("x-amp-")) continue;
    out[k] = v;
  }
  return out;
}

export const provider: Provider = {
  name: "Anthropic",
  routeDecision: "LOCAL_CLAUDE",

  isAvailable: (account?: number) =>
    account !== undefined ? !!store.get("anthropic", account)?.refreshToken : oauth.ready(config),

  accountCount: () => oauth.accountCount(config),

  async forward(sub, body, originalHeaders, rewrite, account = 0) {
    const accessToken = await oauth.token(config, account);
    if (!accessToken) return denied("Anthropic");

    const credentials = store.get("anthropic", account);
    const fwdBody = prepareBody(body, claudeCodeUserId(credentials));
    const betaHdr = betaHeader(originalHeaders.get("anthropic-beta"));
    const clientHeaders = passthroughHeaders(originalHeaders);

    return forward({
      url: `${ANTHROPIC_API_URL}${sub}`,
      body: fwdBody,
      streaming: body.stream,
      providerName: "Anthropic",
      rewrite,
      email: credentials?.email,
      headers: {
        // Client headers first (stainless, accept, content-type, anthropic-version, etc.)
        ...clientHeaders,
        // Override auth + identity
        "Anthropic-Dangerous-Direct-Browser-Access": "true",
        "Anthropic-Beta": betaHdr,
        "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
        "X-App": "cli",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  },
};

const BILLING_SALT = "59cf53e54c78";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Compute the 3-char version integrity hash from sampled user-message chars + version. */
function computeVersionHash(firstUserText: string, version: string): string {
  const chars = [4, 7, 20].map((i) => firstUserText[i] || "0").join("");
  return createHash("sha256").update(`${BILLING_SALT}${chars}${version}`).digest("hex").slice(0, 3);
}

/** Compute the cch — first 5 hex chars of SHA-256(first user message text). */
function computeCch(firstUserText: string): string {
  return createHash("sha256").update(firstUserText).digest("hex").slice(0, 5);
}

/** Stable Claude Code-style metadata.user_id derived from the OAuth account identity. */
function claudeCodeUserId(credentials?: store.Credentials): string | undefined {
  const stable = credentials?.accountId ?? credentials?.email;
  if (!stable) return undefined;
  return createHash("sha256").update(`anthropic:${stable}`).digest("hex");
}

/** Extract text from the first user message in the body. */
function firstUserText(parsed: Record<string, unknown>): string {
  const messages = parsed.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (!Array.isArray(messages)) return "";
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  if (typeof userMsg.content === "string") return userMsg.content;
  if (Array.isArray(userMsg.content)) {
    const textBlock = userMsg.content.find((b: { type?: string }) => b.type === "text") as
      | { text?: string }
      | undefined;
    return textBlock?.text ?? "";
  }
  return "";
}

/** Prepare body for Anthropic Max-subscription billing.
 *  Always re-injects the billing header (cch depends on per-request user message)
 *  and prepends the Claude Code identity so api.anthropic.com classifies the
 *  request as Claude Code traffic instead of falling back to API-credit billing.
 *  Shallow-copies parsed to avoid mutating the shared ParsedBody.parsed reference. */
export function prepareBody(body: ParsedBody, userId?: string): string {
  const raw = body.forwardBody;

  try {
    const original = body.parsed;
    if (!original) return raw;

    const text = firstUserText(original);
    const versionHash = computeVersionHash(text, CLAUDE_CODE_VERSION);
    const cch = computeCch(text);
    const billingLine = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${versionHash}; cc_entrypoint=cli; cch=${cch};`;

    const { speed: _, system: existingSystem, metadata: existingMetadata, ...rest } = original;
    const metadata = withClaudeCodeMetadata(existingMetadata, userId);
    const prepared = {
      ...rest,
      ...(metadata ? { metadata } : {}),
      system: injectClaudeCodeSystem(existingSystem, billingLine),
    };

    rewriteAnthropicRequestToolNames(prepared);
    stripThinkingIfToolChoiceForced(prepared);

    return JSON.stringify(prepared);
  } catch {
    return raw;
  }
}

function stripThinkingIfToolChoiceForced(body: Record<string, unknown>): void {
  const toolChoice = body.tool_choice as Record<string, unknown> | undefined;
  const type = toolChoice?.type;
  if (type === "any" || type === "tool") {
    delete body.thinking;
  }
}

function withClaudeCodeMetadata(metadata: unknown, userId?: string): Record<string, unknown> | undefined {
  const existing =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (!existing.user_id && userId) existing.user_id = userId;
  return Object.keys(existing).length ? existing : undefined;
}

function isClaudeCodeAttributionBlock(block: unknown): boolean {
  const text = (block as { text?: unknown })?.text;
  return (
    typeof text === "string" && (text.includes("x-anthropic-billing-header") || text.includes(CLAUDE_CODE_IDENTITY))
  );
}

function stripClaudeCodeAttribution(text: string): string {
  return text
    .replace(/x-anthropic-billing-header:[^\n]*\n?/g, "")
    .replaceAll(CLAUDE_CODE_IDENTITY, "")
    .trim();
}

/** Prepend `[billing header, Claude Code identity]` to the system blocks.
 *  The billing header MUST be the first system entry (no cache_control) and the
 *  identity MUST follow immediately for api.anthropic.com to bill against the
 *  Max subscription instead of API credits. */
function injectClaudeCodeSystem(system: unknown, billingLine: string): unknown {
  const prefix = [
    { type: "text", text: billingLine },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];

  if (Array.isArray(system)) {
    const filtered = system.filter((s) => !isClaudeCodeAttributionBlock(s));
    return [...prefix, ...filtered];
  }
  if (typeof system === "string") {
    const cleaned = stripClaudeCodeAttribution(system);
    return cleaned ? [...prefix, { type: "text", text: cleaned }] : prefix;
  }
  return prefix;
}

function betaHeader(original: string | null): string {
  const features = new Set<string>(claudeCodeBetas);

  if (original) {
    for (const raw of original.split(",")) {
      const feature = raw.trim();
      if (feature && !filteredBetaFeatures.includes(feature as (typeof filteredBetaFeatures)[number])) {
        features.add(feature);
      }
    }
  }

  return Array.from(features).join(",");
}
