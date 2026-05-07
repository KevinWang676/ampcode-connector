# Amp Neo tool compatibility audit

## Purpose

Track which Amp Neo tools are sensitive to the connector-local ThreadActor runtime and what parity protections exist. The connector should not restrict Amp CLI command-panel slash commands or tool availability; it should either forward executor tools unchanged or shim only the local-runtime storage/control-plane gaps.

## Risk classes

### Connector-local thread/history tools

These tools can consult Amp CLI local thread storage before using cloud/server endpoints. Local Neo conversations are persisted by the connector, so Amp CLI's local storage can be stale or mismatched.

- `read_thread`
  - Risk found: Amp's built-in tool can return current-thread metadata instead of the requested local Neo thread because it checks `threadService.get(threadID)` before `/api/threads/<id>.md`.
  - Amp behavior from `~/.amp/package/dist/main.js`: `read_thread` renders/fetches the thread markdown, then calls a separate extraction model (`GEMINI_2_5_FLASH_LITE_PREVIEW_09_2025`) with the thread inside `<mentionedThread>` plus a goal-specific extraction prompt. The tool returns only `relevantContent`, not the full transcript.
  - Mitigation: local actor intercepts `read_thread` only when the requested `T-...` exists in `NeoLocalPersistence`, renders an exact-id compact Markdown transcript, then runs a connector-local extraction call using Amp's extraction prompt structure. The compact transcript strips huge reasoning/signature/encrypted payloads, omits loaded skill bodies, clips large tool results, and caps pre-extraction input to avoid local-provider context overflows. If extraction fails, it falls back to the compact transcript rather than the raw transcript.
  - Fallback: if not local, lease to Amp executor unchanged.
- `find_thread`
  - Risk: Amp's built-in search may miss connector-local Neo snapshots or search stale local storage.
  - Mitigation: local actor intercepts when connector-local matches exist and returns local thread IDs/titles. If no local matches, lease to Amp executor unchanged.

### Local filesystem/editor/shell tools

These tools are executed by Amp's local executor after the connector emits `tool_lease`.

- `Read`, `Bash`, `shell_command`, `create_file`, `edit_file`, `apply_patch`, `glob`, `Grep`, `finder`, `look_at`, `chart`, `painter`
- Current connector role: preserve tool definitions from executor registration, emit leases, persist results, and continue tool loops.
- Known parity protections:
  - waits for executor tool bootstrap before inference
  - forwards opaque tool names and inputs
  - acknowledges executor results
  - preserves mode/reasoning effort after tool results
  - relays filesystem read requests/results for UI-side flows

### Amp internal/network tools

These use Amp internal API or web services through Amp executor or connector internal handlers.

- `read_web_page`, `web_search`, `librarian`, `oracle`
- Current connector behavior:
  - `extractWebPageContent` and `webSearch2` have connector-local handlers when configured; otherwise upstream fallback remains.
  - Other executor tools are leased unchanged.
- No local-thread ID mismatch found except `read_thread`/`find_thread`.

### MCP tools/resources

- `mcp__server__tool` function tools are registered by Amp executor and forwarded as opaque function tools.
- `read_mcp_resource` remains an Amp executor tool in modes where Amp exposes it.
- Connector does not hard-code MCP names.

### UI/control-plane tools and events

- approvals, queued messages, artifacts, plugin messages, manual bash invocation, retry/cancel/edit/title/read-state
- Current connector support exists in `LocalThreadActor` protocol handling.
- Remote executor spawn is intentionally rejected in local runtime.

## Current known unavailable/intentional differences

- Amp hosted credit/cost display is unavailable for connector-local provider calls.
- Classic handoff relationship parity is not restored because Neo replaced handoff with compaction.
- Hosted-only actor internals may differ unless `AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=1` is used for protocol debugging.

## Smoke matrix

Recommended after Amp CLI updates:

```sh
bunx tsc --noEmit
bun run test

# tool loop
amp --dangerously-allow-all -m rush -x "Use Bash to run 'printf TOOL_LOOP_OK'. Reply with exactly the output."

# read local thread by exact id
amp -m rush -x "Use read_thread to summarize T-<known-local-thread-id>. Include the thread id you read."

# find local thread
amp -m rush -x "Use find_thread to find threads mentioning '<known-local-unique-phrase>'. Return the thread id."

# filesystem
amp -m rush -x "Use Read on an absolute path in this repo and summarize the first line."

# MCP, if configured
amp -m rush -x "Use an available MCP tool and summarize whether it worked."
```
