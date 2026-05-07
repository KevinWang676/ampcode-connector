# 2026-05-07 — Hosted debug flag defaults local

## Context

User wants to keep a hosted actor token in local env for future Amp CLI protocol debugging, but does not want the connector to use hosted mode by default just because the env file/token exists.

## Change

- Replaced hosted activation from `AMPCODE_CONNECTOR_NEO_RUNTIME=hosted` to explicit truthy debug flag:
  - `AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=1|true|yes|on`
- Token presence alone is inert.
- Updated local `.env.local` to:
  - `AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=false`
  - `AMPCODE_CONNECTOR_HOSTED_ACTORS_TOKEN=<local token>`
- Default behavior with `.env.local` present is now the connector-local Neo runtime.

## Usage

Default local runtime:

```sh
bun run dev
```

Hosted actor debug mode for a new Amp CLI release:

```sh
AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=1 bun run dev
```

or edit `.env.local` temporarily:

```sh
AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=true
```

## Validation

- `bunx tsc --noEmit` passed.
- Bun loads `.env.local` with `AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=false`, no old `AMPCODE_CONNECTOR_NEO_RUNTIME`, and token present.
- `.env.local` is gitignored.
- `git grep` found no hosted actor token or old hosted runtime env default in tracked files.
