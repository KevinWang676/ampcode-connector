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

  async forward(sub, body, originalHeaders, rewrite, account = 0, _proxyConfig, signal) {
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
      signal,
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
 *  Re-parses from body.forwardBody to get a fresh deep copy so the in-place tool
 *  name rewrite never leaks back into the cached ParsedBody.parsed across retries. */
export function prepareBody(body: ParsedBody, userId?: string): string {
  const raw = body.forwardBody;

  try {
    const original = JSON.parse(raw) as Record<string, unknown> | null;
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
    stripThinkingBlocksFromMessages(prepared);
    stripThinkingIfToolChoiceForced(prepared);

    return JSON.stringify(prepared);
  } catch {
    return raw;
  }
}

/** Remove `thinking` and `redacted_thinking` content blocks from every
 *  message in the request history before forwarding to Anthropic.
 *
 *  Why: Anthropic's extended-thinking signature is bound to the conversation
 *  context that produced it (model, system prompt, prior content). The
 *  connector's prepareBody re-injects the Claude Code identity AND the
 *  per-request `cch=<hash(latest_user_message)>` billing line into the
 *  `system` field, which means the effective system prompt changes between
 *  turns. As soon as the request arrives at Anthropic with a thinking block
 *  whose signature was issued under a different system context, the API
 *  rejects with:
 *
 *    messages.N.content.M: Invalid `signature` in `thinking` block
 *
 *  This is the failure mode the Librarian subagent and any other
 *  multi-turn extended-thinking flow hits when routed through the
 *  connector. Single-turn flows (e.g. Oracle in its common usage)
 *  do not exercise the validation path because they never echo a
 *  prior thinking block back.
 *
 *  The local Neo inference path (anthropicMessages in
 *  src/server/neo-local-inference.ts) already strips thinking blocks
 *  from `LocalHistoryMessage[]` for the same reason — only `text` and
 *  `tool_use` blocks are emitted into the assistant turn. This helper
 *  brings the proxy/forward path to the same level of safety, so both
 *  routes have identical, deterministic message-shape semantics.
 *
 *  Functional impact: the model loses access to its prior chain-of-thought
 *  text on subsequent turns. This is the same trade-off the local Neo
 *  path has been making since extended-thinking support was added; the
 *  model still reasons fresh on each turn (visible via the
 *  `thinking` REQUEST config, when present), so output quality is
 *  unaffected. Cross-platform pure-logic transform — no env coupling. */
function stripThinkingBlocksFromMessages(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const msg = message as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const filtered = content.filter((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return true;
      const t = (block as Record<string, unknown>).type;
      return t !== "thinking" && t !== "redacted_thinking";
    });
    if (filtered.length !== content.length) msg.content = filtered;
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
 *  Max subscription instead of API credits.
 *
 *  After prepending, this function also guarantees the resulting system array
 *  has at least one `cache_control` marker — see `ensureSystemCacheBreakpoint`
 *  below for the full rationale and safety constraints. */
function injectClaudeCodeSystem(system: unknown, billingLine: string): unknown {
  const prefix = [
    { type: "text", text: billingLine },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];

  let combined: Array<Record<string, unknown>>;
  if (Array.isArray(system)) {
    const filtered = system.filter((s) => !isClaudeCodeAttributionBlock(s));
    combined = [...prefix, ...(filtered as Array<Record<string, unknown>>)];
  } else if (typeof system === "string") {
    const cleaned = stripClaudeCodeAttribution(system);
    combined = cleaned ? [...prefix, { type: "text", text: cleaned }] : [...prefix];
  } else {
    combined = [...prefix];
  }

  ensureSystemCacheBreakpoint(combined);
  return combined;
}

/** Guarantee at least one `cache_control` marker exists in the prepared system
 *  array so the system prefix participates in Anthropic's prompt cache. Without
 *  this, every request paid full input-token price for the system block — the
 *  root cause of the neo-fix branch consuming a Max-5x subscription ~10x faster
 *  than `amp --take-me-back` for the same agentic loop.
 *
 *  Constraints we honour:
 *
 *   • The billing header (first block) MUST stay un-marked. The api.anthropic.com
 *     billing classifier inspects it verbatim to bill against the Max
 *     subscription, and the existing convention here is "billing header first,
 *     no cache_control". We therefore attach the marker to the LAST block,
 *     which is either the connector's `CLAUDE_CODE_IDENTITY` line (when
 *     upstream sent no system content) or the final upstream system block.
 *     Both stay identical within a conversation, so the prefix hash is stable.
 *
 *   • If any block already carries `cache_control` (e.g. `amp --take-me-back`
 *     or a future Amp build sends its own breakpoints), we leave the array
 *     untouched. This preserves the caller's intent and keeps us under the
 *     4-marker hard cap Anthropic enforces.
 *
 *   • We never invent a marker on an empty system array — there's nothing to
 *     cache, and Anthropic's automatic-caching feature handles message-only
 *     requests via the top-level `cache_control` field already on the body. */
function ensureSystemCacheBreakpoint(system: Array<Record<string, unknown>>): void {
  if (system.length === 0) return;
  for (const block of system) {
    if (block && typeof block === "object" && "cache_control" in block) return;
  }
  const lastIdx = system.length - 1;
  const last = system[lastIdx]!;
  const lastText = typeof last.text === "string" ? last.text : "";
  if (lastText.startsWith("x-anthropic-billing-header:")) return;
  system[lastIdx] = { ...last, cache_control: { type: "ephemeral" } };
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
