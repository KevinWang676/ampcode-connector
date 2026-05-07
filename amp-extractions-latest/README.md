# Amp CLI Extractions (Latest Local Binary)

This directory is a refreshed extraction snapshot built from the latest local Amp CLI binary.

## Source

- **Binary:** `~/.amp/bin/amp`
- **Version detected:** `0.0.1778130306-g2889d9 (released 2026-05-07T05:06:28.128Z)`
- **Generated:** 2026-05-07T05:16:00+00:00

## Files

- `config/settings.md` — visible settings reference from `amp --help`, plus hidden CLI flags found in the Neo binary.
- `config/endpoints.md` — endpoint and service URL candidates from binary strings scan.
- `agents/agent-tools.md` — full built-in tool descriptions and schemas from `amp tools show`, invoked with a mode where the tool is active.
- `agents/agent-architecture.md` — mode tool matrix and Neo rollout notes.

## Notes

- This folder is separate from `references/` to avoid modifying read-only reference content.
- Endpoint extraction is static/best-effort; verify runtime traffic if you need exact invocation behavior.
- The local Neo CLI advertises `smart`, `deep`, `rush`, and `large` modes. The previous `free` mode is no longer listed by `amp --help`.
- This snapshot includes user-configured MCP tools in `amp tools list --json`; MCP availability is configuration-dependent.
