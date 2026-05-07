# 2026-05-06 — Amp Neo extraction and connector refresh

## Context

The local Amp CLI moved to the Neo rollout:

- Binary: `~/.amp/bin/amp`
- Version: `0.0.1778080581-g3b0b56`

Goal: refresh `amp-extractions-latest`, inspect config/settings/endpoints/tool changes, and update connector source capabilities without editing Amp CLI.

## Work performed

- Created feature branch `feat/amp-neo-capabilities` from `fix/codex-handoff-buffer-output`.
- Refreshed extraction docs in `amp-extractions-latest/` from the local Amp binary.
- Captured current tool matrices for `smart`, `deep`, `rush`, and `large` modes.
- Captured visible settings from `amp --help` and noted hidden Neo CLI flags from binary strings.
- Captured endpoint candidates and identified Neo-relevant upstream passthrough routes.
- Updated connector path classification for:
  - `/api/thread-actors`
  - `/api/attachments`
  - `/api/v2`
  - browser `/v2/...` redirects
- Added `src/server/rivet-proxy.ts`, initially as a local `localhost:6420` Neo actor proxy to hosted Amp actors; follow-up work switched the default to a connector-managed local ThreadActor runtime while retaining hosted mode behind `AMPCODE_CONNECTOR_NEO_RUNTIME=hosted`.
- Added middleware/path tests for the new route classifications.
- Documented Neo compatibility notes in `docs/amp-neo-compatibility.md`.
- Ran a hosted-Neo hybrid experiment to test whether hosted actor model calls could be redirected back to connector providers without replacing the hosted actor runtime.

## Findings

- With `amp.url` set to the local connector (`http://localhost:8765`), Neo derives the default Rivet/thread-actor endpoint as `http://localhost:6420` and stalls if no local RivetKit engine is running.
- Added connector-managed Neo support on `http://localhost:6420` so users can keep launching Amp by typing only `amp`; the default is now a local ThreadActor/runtime that routes model calls through connector-local providers.
- Follow-up fix: forwarded Rivet WebSocket subprotocol negotiation to hosted actors after Amp showed `Mismatch client protocol` reconnect loops.
- Follow-up fix: mirrored Rivet protocol metadata into `x-rivet-*` headers and explicitly preserved the full `Sec-WebSocket-Protocol` header for hosted actor WebSockets after Amp showed `guard.missing_header` reconnect loops.
- `large` is now listed as an Amp mode; previous `free` mode is not advertised by `amp --help`.
- `mermaid` and `undo_edit` no longer appear in extracted built-in tool matrices.
- Initial `0.0.1778080581-g3b0b56` extraction listed `look_at` in `smart`, `rush`, and `large`, but not `deep`.
- Follow-up `0.0.1778117719-gd7c638` extraction lists `look_at` in `smart`, `deep`, `rush`, and `large`.
- Connector code does not need to hard-code `look_at`: Codex tool normalization preserves arbitrary function tool names.
- Neo introduces/uses control-plane endpoints such as `/api/thread-actors`; these should remain upstream-only.
- Follow-up local runtime work added durable local thread snapshots and local `/api/threads/find` / `/api/threads/:id.md` read/export endpoints for finished Neo conversations.
- Hosted Neo model execution does not currently transit the connector as provider HTTP traffic. Execute-mode smoke prompts produced only `/api/thread-actors` and Rivet actor traffic in connector logs, with no `/api/provider/*`, `/v1/messages`, `/responses`, `LOCAL_CLAUDE`, or `LOCAL_CODEX` route decisions.
- Public-URL hybrid attempt: exposing the connector via Cloudflare Tunnel and setting `amp.url` to that URL still did not produce provider-route hits.
- Actor-input hybrid attempt: injecting the public connector URL into the hosted actor creation CBOR payload (`ampUrl`, `ampURL`, `providerBaseUrl`, `settings.url`) did not produce provider-route hits; the actor appeared to accept or ignore those extra input fields.
- Thread-settings hybrid attempt: injecting URL fields into `client_update_thread_settings` failed validation with `INVALID_MESSAGE` because the actor protocol rejects unrecognized settings keys.
- Conclusion: preserving all hosted Neo cloud benefits while replacing only hosted model billing is not achievable through the currently observed connector-side surfaces. Avoiding Amp credits for Neo requires either an Amp-supported hosted BYO provider setting or a connector-managed local thread-actor/runtime.

## Validation

- `bun test tests/middleware.test.ts tests/forward.test.ts tests/router.test.ts tests/rewriter.test.ts` passed: 68 pass, 0 fail.
- Initial plain `bun test` hit the default 5s timeout in the live external Google provider non-streaming test after a 404/fallback path.
- `bun test --timeout 20000` passed: 71 pass, 0 fail.
- Runtime smoke test: starting `bun run src/index.ts` exposes both `http://localhost:8765/status` and `http://localhost:6420/metadata`; hosted fallback metadata is available with `AMPCODE_CONNECTOR_NEO_RUNTIME=hosted`, while the default local runtime returns connector-local metadata.
- Hybrid validation used several execute-mode prompts (`HYBRID_PONG`, `LOCAL_PROXY_PONG`, `INJECTED_PROVIDER_URL_PONG`, `FRAME_LOG_PONG`, `SETTINGS_INJECT_PONG`) while watching connector and Amp logs. The only provider-url injection that produced an explicit failure was the thread-settings injection, which Amp rejected as unrecognized settings keys.
- After experiments, restored `~/.config/amp/settings.json` to `"amp.url": "http://localhost:8765"`, stopped the temporary Cloudflare tunnel, restarted the connector without experimental environment variables, and ran `bunx tsc --noEmit` successfully.
