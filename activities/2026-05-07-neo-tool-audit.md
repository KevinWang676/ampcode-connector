# 2026-05-07 — Neo tool compatibility audit

## Context

After fixing `read_thread`, user asked whether other Amp Neo tools could have similar local/cloud mismatch issues under the connector-local ThreadActor runtime.

## Findings

- Current Amp Neo tool matrix includes thread/history tools, filesystem/editor/shell tools, internal web/research tools, MCP tools, and UI/control-plane events.
- Most tools are safe because Amp executor owns execution and the connector only forwards opaque tool leases/results.
- The risky class is thread/history tools that consult Amp CLI local thread storage before cloud/server fallback.
- Confirmed `read_thread` had this issue.
- Added matching protection for `find_thread`: connector returns local Neo matches when present; otherwise Amp executor fallback is unchanged.

## Changes

- `src/server/neo-local-actor.ts`
  - Added local `find_thread` handling alongside `read_thread`.
  - Local handling is conditional: only intercept when connector-local store has an answer.
  - No local result means normal Amp executor tool lease.
- `tests/neo-local-runtime.test.ts`
  - Added regression coverage for local `find_thread` exact local match behavior.
- `docs/amp-neo-tool-compatibility-audit.md`
  - Added risk classification and smoke matrix for future Amp CLI updates.

## Validation

- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed.

## Follow-up

Run the documented smoke matrix after starting the connector manually, especially after every new Amp CLI release.
