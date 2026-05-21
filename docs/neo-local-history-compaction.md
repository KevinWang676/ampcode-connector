# Neo Local History Compaction

## Purpose

The connector-local Neo runtime compacts oversized thread history using the same shape as pi CLI: keep a recent suffix verbatim and replace older context with an LLM-generated structured checkpoint summary.

This avoids long-running local Neo sessions failing with provider `context_length_exceeded` errors while preserving enough context for the next model call.

## Behavior

`src/server/neo-local-inference.ts` applies compaction in `inferLocal`, before provider-specific request formatting:

1. Estimate context tokens with the same chars/4 heuristic pi uses.
2. Trigger when estimated tokens exceed `contextWindow - reserveTokens`.
3. Walk backward and keep roughly `keepRecentTokens` of recent messages.
4. Cut only at `user` or `assistant` messages; never start the kept suffix with an orphan tool result.
5. Ask a summarizer model to produce pi-style structured summary sections.
6. Send `[Compaction summary] + recent messages` to the selected provider.
7. Persist the compacted local history snapshot while leaving full visible thread messages intact.

Repeated compactions update the prior summary instead of stacking synthetic snippet summaries.

## Summarizer model

- In `deep` mode, compaction summaries use the same selected route as the inference call (`deep` currently maps to `openai/gpt-5.5`).
- In all other modes, compaction summaries use `google/gemini-3.1-pro-preview`.

## Defaults

- `reserveTokens`: `16384`
- `keepRecentTokens`: `20000`
- Context window estimates:
  - Anthropic local modes: `200000`
  - OpenAI/Codex local modes: `400000`
  - Google local overrides: `1000000`

The local runtime also accepts `settings["localNeo.compaction"]` with `enabled`, `reserveTokens`, and `keepRecentTokens` overrides.

## Tests

`tests/neo-local-runtime.test.ts` covers:

- small histories do not compact;
- oversized histories become `[Compaction summary] + recent suffix` before Anthropic/OpenAI/Google formatting;
- summary model selection uses deep route for `deep` and Gemini Pro otherwise;
- recent assistant tool calls remain adjacent to their tool responses after compaction.
