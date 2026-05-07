# AMP CLI Endpoint Candidates (Latest Binary)

- **Source binary:** `~/.amp/bin/amp`
- **Version:** `0.0.1778117719-gd7c638 (released 2026-05-07T01:36:50.973Z)`
- **Extraction date:** 2026-05-07T01:44:00+00:00
- **Method:** static `strings` scan for `/api/...` paths and selected service URLs.

## API Path Candidates

```text
/api/1.0/projects/
/api/1.0/repos?
/api/attachments
/api/hello
/api/hello/:name
/api/html_rewriter.zig
/api/internal
/api/internal?
/api/internal/bitbucket-instance-url
/api/internal/github-auth-status
/api/internal/github-proxy/
/api/JSBundler.zig
/api/provider/anthropic
/api/provider/baseten/v1
/api/provider/cerebras
/api/provider/fireworks/v1
/api/provider/google
/api/provider/groq
/api/provider/kimi
/api/provider/openai/v1
/api/provider/xai/v1
/api/telemetry
/api/thread-actors
/api/thread-actors/
/api/threads/
/api/threads/find?
/api/types.ts
/api/users.ts
/api/users/:id
/api/v2/
```

## Connector-Relevant Paths

| Path/prefix | Connector behavior | Notes |
|---|---|---|
| `/api/provider/*` | Provider router | Local routing may intercept Anthropic/OpenAI/Google/Codex depending on config. |
| `/api/internal?...` | Local handler for known methods; otherwise upstream | Existing local handlers remain `extractWebPageContent` and `webSearch2`. |
| `/api/threads/*` | Upstream passthrough | Thread storage/sync. |
| `/api/thread-actors/*` | Upstream passthrough | Neo remote-control/thread actor runtime. |
| `/api/attachments*` | Upstream passthrough | Attachment/media upload/download path. |
| `/api/telemetry`, `/api/otel` | Upstream passthrough | Telemetry/OTel routes. |
| `/api/v2/*` | Upstream passthrough | Newer app/API surface; exact runtime usage should be verified with logs. |
| `/v2/*` | Browser redirect to upstream | Neo web workspace/thread URLs should preserve Amp domain/cookies. |

## Selected Service URLs

```text
http://127.0.0.1:
http://127.0.0.1:6420
http://localhost:
http://localhost:3000
http://localhost:3000/
http://localhost:4317
http://localhost:4318/
http://localhost:6420
http://localhost:8976/oauth/callback
http://localhost:9411/api/v2/spans
http://localhost:9999
http://localhost/
https://accounts.google.com
https://accounts.google.com/o/oauth2/v2/auth
https://aiplatform.googleapis.com/
https://ampcode.com
https://ampcode.com/
https://ampcode.com/chronicle
https://ampcode.com/manual
https://ampcode.com/manual/appendix
https://ampcode.com/manual/plugin-api
https://ampcode.com/models
https://ampcode.com/news/neo
https://ampcode.com/news/stick-a-fork-in-it
https://ampcode.com/settings
https://ampcode.com/threads/
https://ampcode.com/threads/T-3f1beb2b-bded-4fda-96cc-1af7192f24b6
https://ampcode.com/threads/T-5928a90d-d53b-488f-a829-4e36442142ee
https://ampcode.com/threads/T-95e73a95-f4fe-4f22-8d5c-6297467c97a5
https://ampcode.com/threads/T-f916b832-c070-4853-8ab3-5e7596953bec
https://ampcode.com/threads/T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
https://ampcode.com/v2/amp/amp/T-019d01b5-f70d-73ea-9445-f6d358f7213e
https://ampcode.com/v2/workspace/project/T-a38f981d-52da-47b1-818c-fbaa9ab56e0c
https://ampcode.com/v2/workspace/project/T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
https://api.anthropic.com
https://api.anthropic.com/
https://api.cerebras.ai
https://api.github.com
https://api.openai.com/v1
https://cloudresourcemanager.googleapis.com/v1/projects/
https://generativelanguage.googleapis.com
https://generativelanguage.googleapis.com/
https://huggingface.co/mcp
https://mcp.monday.com/sse
https://oauth2.googleapis.com/revoke
https://oauth2.googleapis.com/revoke?token=
https://oauth2.googleapis.com/token
https://oauth2.googleapis.com/tokeninfo
https://openrouter.ai/api/v1
https://sourcegraph.example.com/.api/mcp/v1
https://static.ampcode.com/cli
https://static.ampcode.com/cli/cli-version.txt
```

## Notes

- This is a static candidate list; dead strings and embedded dependency URLs may appear in raw extraction.
- Runtime verification should use connector request logs when exercising Neo `--observe`/`--headless`, attachment, and Deep Mode flows.
