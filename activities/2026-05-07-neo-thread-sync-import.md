# 2026-05-07 — Neo `/api/threads/sync` import

## Context

Local Neo runtime already persisted local snapshots, uploaded them to Amp cloud, imported cloud data when recreating a known actor, and let plain `GET /api/threads/:id` fall through upstream. Remaining parity gap: Amp's periodic/on-demand `/api/threads/sync` discovery/download flow was forwarded upstream but downloaded threads were not mirrored into the connector-local Neo store.

## Change

- Added `POST /api/threads/sync` response observation in `src/server/server.ts`.
- The connector still forwards the request to Amp upstream and returns the upstream response unchanged.
- Successful sync responses are cloned and inspected asynchronously.
- `threadActions` with `action: "download"` are imported into `NeoLocalPersistence`.
- `threadActions` with `action: "meta"` update local cloud metadata.
- Added `NeoLocalPersistence.importCloudThread(...)` to create or update local snapshots from classic Amp cloud thread objects.

## Behavior

This preserves Amp CLI's normal sync protocol while giving connector-local surfaces (`find?local=1`, `.md`, `/export`, actor reload) visibility into cloud-discovered threads.

## Validation

- `bunx tsc --noEmit` passed.
- `bun test tests/neo-local-runtime.test.ts` passed with coverage for imported sync downloads.
