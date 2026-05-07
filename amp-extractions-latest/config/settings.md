# AMP CLI Settings (Latest Binary)

- **Source binary:** `~/.amp/bin/amp`
- **Version:** `0.0.1778117719-gd7c638 (released 2026-05-07T01:36:50.973Z)`
- **Extraction date:** 2026-05-07T01:44:00+00:00
- **Method:** `amp --help` settings reference, plus hidden CLI flag strings from the binary.

## Visible Settings Reference

```text
Settings reference:

amp.bitbucketToken
      Personal access token for Bitbucket Enterprise. Used with a workspace-level Bitbucket connection configured by an
      admin.
  amp.dangerouslyAllowAll
      Disable all command confirmation prompts (agent will execute all commands without asking)
  amp.defaultVisibility
      Define default thread visibility per repository origin using mappings like "github.com/org/repo": "workspace".
      Values: private, public, workspace, group.
  amp.experimental.modes
      Enable experimental agent modes by name. Available modes: deep
  amp.fuzzy.alwaysIncludePaths
      Glob patterns for paths that should always be included in fuzzy file search, even if gitignored
  amp.git.commit.ampThread.enabled
      Enable adding Amp-Thread trailer in git commits
  amp.git.commit.coauthor.enabled
      Enable adding Amp as co-author in git commits
  amp.guardedFiles.allowlist
      Array of file glob patterns that are allowed to be accessed without confirmation. Takes precedence over the
      built-in denylist.
  amp.mcpServers
      Model Context Protocol servers to connect to for additional tools
  amp.network.timeout
      How many seconds to wait for network requests to the Amp server before timing out
  amp.notifications.enabled
      Enable notification alerts when the agent completes tasks. Over SSH, this sends a terminal bell.
  amp.notifications.system.enabled
      Enable system notifications when terminal is not focused
  amp.permissions
      Permission rules for tool calls. See amp permissions --help
  amp.proxy
      Proxy URL used for both HTTP and HTTPS requests to the Amp server
  amp.showCosts
      Set to false to hide costs while working on a thread
  amp.skills.disableClaudeCodeSkills
      Disable loading skills from Claude Code directories (.claude/skills/, ~/.claude/skills/,
      ~/.claude/plugins/cache/). Amp-native skill directories are not affected.
  amp.skills.path
      Path to additional directories containing skills. Supports colon-separated paths (semicolon on Windows). Use ~ for
      home directory.
  amp.terminal.animation
      Set to false to disable terminal animations (or use the equivalent NO_ANIMATION=1 env var)
  amp.terminal.theme
      Color theme for the CLI. Built-in: terminal, dark, light, catppuccin-mocha, solarized-dark, solarized-light,
      gruvbox-dark-hard, nord. Custom themes: ~/.config/amp/themes/<name>/colors.toml
  amp.terminal.copyOnSelect
      Automatically copy selection to clipboard.
  amp.toolbox.path
      Path to the directory containing toolbox scripts. Supports colon-separated paths.
  amp.tools.disable
      Array of tool names to disable. Use 'builtin:toolname' to disable only the builtin tool with that name (allowing
      an MCP server to provide a tool by that name).
  amp.tools.enable
      Array of tool name patterns to enable. Supports glob patterns (e.g., 'mcp__metabase__*'). If not set, all tools
      are enabled. If set, only matching tools are enabled.
  amp.updates.mode
      Control update checking behavior: "warn" shows update notifications, "disabled" turns off checking, "auto"
      automatically runs update.
```

## Hidden/Neo CLI Flags Found In Binary

These are CLI flags, not necessarily persisted settings keys. They matter because they identify Neo rollout behavior and routes that may hit the connector.

| Flag | Purpose observed in binary help string |
|---|---|
| `--take-me-back` | Disable thread-actors mode and use the legacy worker runtime. |
| `--neo-orb` | Use the experimental Neo splash orb. |
| `--show-welcome` | Show the welcome experience on startup. |
| `--observe <thread>` | Open the Neo TUI as an observer of an existing thread. |
| `--headless [thread]` | Run a headless thread-actor executor; optionally connect to an existing thread. |
| `--sp <value>` | Custom system prompt text or file path. |
| `--system-prompt <value>` | Custom system prompt text. |
| `--model <value>` | Override model globally or per mode, e.g. `mode=provider:model`. |

## Example Configuration From Help

```json
{
  "amp.dangerouslyAllowAll": false,
  "amp.defaultVisibility": {
    "github.com/sourcegraph/amp": "workspace"
  },
  "amp.experimental.modes": [],
  "amp.fuzzy.alwaysIncludePaths": [],
  "amp.git.commit.ampThread.enabled": true,
  "amp.git.commit.coauthor.enabled": true,
  "amp.guardedFiles.allowlist": [],
  "amp.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-filesystem",
        "/path/to/allowed/dir"
      ]
    }
  },
  "amp.network.timeout": 30,
  "amp.notifications.enabled": true,
  "amp.notifications.system.enabled": true,
  "amp.permissions": [
    {
      "tool": "Bash",
      "action": "ask",
      "matches": {
        "cmd": [
          "git push*",
          "git commit*",
          "git branch -D*",
          "git checkout HEAD*"
        ]
      }
    }
  ],
  "amp.showCosts": true,
  "amp.skills.disableClaudeCodeSkills": false,
  "amp.terminal.animation": true,
  "amp.terminal.theme": "terminal",
  "amp.terminal.copyOnSelect": true,
  "amp.tools.disable": [
    "browser_navigate",
    "builtin:edit_file"
  ],
  "amp.updates.mode": "auto"
}
```
