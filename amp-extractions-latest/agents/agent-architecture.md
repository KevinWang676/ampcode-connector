# AMP CLI Agent Architecture Notes (Latest Binary)

- **Source binary:** `~/.amp/bin/amp`
- **Version:** `0.0.1778130306-g2889d9 (released 2026-05-07T05:06:28.128Z)`
- **Extraction date:** 2026-05-07T05:16:00+00:00
- **Method:** `amp tools list --json --mode <mode>` + `amp tools show` + binary strings extraction.

## Tool Availability By Mode

| Mode | Built-in Tool Count | Built-in Tools |
|---|---:|---|
| `smart` | 21 | `Bash`, `create_file`, `edit_file`, `find_thread`, `finder`, `handoff`, `librarian`, `look_at`, `mcp__exa__crawling_exa`, `mcp__exa__get_code_context_exa`, `mcp__exa__web_search_exa`, `mcp__grep__searchGitHub`, `oracle`, `painter`, `Read`, `read_mcp_resource`, `read_thread`, `read_web_page`, `skill`, `Task`, `web_search` |
| `deep` | 18 | `apply_patch`, `chart`, `find_thread`, `finder`, `handoff`, `librarian`, `look_at`, `mcp__exa__crawling_exa`, `mcp__exa__get_code_context_exa`, `mcp__exa__web_search_exa`, `mcp__grep__searchGitHub`, `oracle`, `painter`, `read_thread`, `read_web_page`, `shell_command`, `skill`, `web_search` |
| `rush` | 25 | `Bash`, `chart`, `create_file`, `edit_file`, `find_thread`, `finder`, `glob`, `Grep`, `handoff`, `librarian`, `look_at`, `mcp__exa__crawling_exa`, `mcp__exa__get_code_context_exa`, `mcp__exa__web_search_exa`, `mcp__grep__searchGitHub`, `oracle`, `painter`, `Read`, `read_mcp_resource`, `read_thread`, `read_web_page`, `skill`, `Task`, `task_list`, `web_search` |
| `large` | 21 | `Bash`, `create_file`, `edit_file`, `find_thread`, `finder`, `handoff`, `librarian`, `look_at`, `mcp__exa__crawling_exa`, `mcp__exa__get_code_context_exa`, `mcp__exa__web_search_exa`, `mcp__grep__searchGitHub`, `oracle`, `painter`, `Read`, `read_mcp_resource`, `read_thread`, `read_web_page`, `skill`, `Task`, `web_search` |

## Neo Rollout Deltas Observed

Compared with the previous local snapshot (`0.0.1773129970-gb3ab74`):

- `large` is now a first-class mode in the CLI mode list.
- `free` is no longer advertised by `amp --help`.
- `mermaid` and `undo_edit` no longer appear in any extracted built-in tool matrix.
- `chart`, `glob`, `Grep`, and `task_list` moved out of the current `smart`/`large` tool sets; `rush` keeps them, and `deep` keeps `chart`.
- `look_at` is now present in `smart`, `deep`, `rush`, and `large`; this was the only built-in tool-matrix change observed between `0.0.1778080581-g3b0b56` and `0.0.1778117719-gd7c638`.
- `0.0.1778130306-g2889d9` shows configured MCP tools directly in all modes as `mcp__server__tool` functions. In this environment: `mcp__exa__crawling_exa`, `mcp__exa__get_code_context_exa`, `mcp__exa__web_search_exa`, and `mcp__grep__searchGitHub`.
- The top-level CLI help again lists `skill add/list/remove/info` management commands.
- Deep Mode remains the only extracted mode using Codex-native `apply_patch` and `shell_command` tools.

## Provider/Connector Relevance

- Built-in Amp tools are still regular function/tool definitions from the provider perspective. The connector should not hard-code the exact tool matrix; it should forward/normalize unknown function tools.
- New Neo sync endpoints such as `/api/thread-actors` and attachment endpoints should pass through to Amp upstream instead of being interpreted as provider routes.
- Browser-facing `/v2/...` workspace/thread URLs should redirect to Amp upstream when they arrive at the connector.

## Notes

- Full assembled system prompts are not publicly retrievable in this environment.
- MCP tools in `amp tools list --json` are included in the counts above for this snapshot, but they depend on local user configuration.
