# 2026-05-07 — Hosted Neo debug env

## Context

User wants a local-only switch for debugging Amp hosted actor protocol changes after new Amp CLI releases, without committing the hosted actor token to the public repository.

## Change

- Created `.env.local` with:
  - `AMPCODE_CONNECTOR_NEO_RUNTIME=hosted`
  - `AMPCODE_CONNECTOR_HOSTED_ACTORS_TOKEN=<local hosted actors token>`
- `.env.local` is already ignored by `.gitignore`.
- Bun auto-loads `.env.local`, so `bun run dev` in this checkout will use hosted debug mode locally.
- Public/default clone behavior remains safe because `.env.local` is not tracked. Without that file, `bun run dev` uses the local Neo runtime by default.

## Validation

- `bun -e 'console.log(process.env.AMPCODE_CONNECTOR_NEO_RUNTIME, Boolean(process.env.AMPCODE_CONNECTOR_HOSTED_ACTORS_TOKEN))'` showed `.env.local` is loaded.
- `git check-ignore -v .env.local` confirms `.env.local` is ignored.
- `git status --short .env.local` shows no tracked change.
- `git grep` found no hosted actor token in tracked files.
