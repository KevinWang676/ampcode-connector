# 2026-05-07 — Public secret safety review

## Context

Before publishing the branch to a public repository, reviewed whether connector changes introduced hard-coded access tokens or user credentials.

## Findings

- `src/server/rivet-proxy.ts` contained a hard-coded hosted `actors.ampcode.com` bearer/Rivet token used only by the debug hosted actor bridge (`AMPCODE_CONNECTOR_NEO_RUNTIME=hosted`).
- The token did not look like a personal Amp user token (`sgamp_...`) and was separate from the connector's local Amp API key loading, but it is still an access token for a hosted service path and should not be committed to a public repository.
- Normal user Amp tokens are loaded at runtime from `AMP_API_KEY`, config, or `~/.local/share/amp/secrets.json`; they are not hard-coded.
- OAuth app client IDs/secrets in `src/auth/configs.ts` are provider app credentials, not user refresh/access tokens. They should still be reviewed before public release because scanners may flag secret-looking OAuth client secrets.

## Fix

- Removed the hosted actor token from `src/server/rivet-proxy.ts`.
- Hosted actor debug mode now requires `AMPCODE_CONNECTOR_HOSTED_ACTORS_TOKEN` at runtime.
- Default local Neo runtime remains unaffected and does not need the hosted token.

## Validation

- `bunx tsc --noEmit` passed.
- Secret grep over tracked/untracked non-ignored files found no `sgamp_...`, the removed hosted actor token, or literal long `Bearer ...` tokens.

## Public release guidance

Do not commit:

- `~/.local/share/amp/secrets.json`
- `~/.config/ampcode-connector/config.yaml` if it contains real `ampApiKey`, `exaApiKey`, or provider secrets
- provider OAuth token stores under local data directories
- logs that include request/response headers or token-bearing URLs
- local Neo thread snapshots if they contain private conversations or repo/customer data

Keep examples as placeholders (`config.example.yaml`) and prefer runtime environment variables for debug-only service tokens.
