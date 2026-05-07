# AMP CLI Built-in Tool Details (Latest Binary)

- **Source binary:** `~/.amp/bin/amp`
- **Version:** `0.0.1778130306-g2889d9 (released 2026-05-07T05:06:28.128Z)`
- **Extraction date:** 2026-05-07T05:16:00+00:00
- **Method:** `amp tools list --json --mode <mode>` to find active tools, then `amp --mode <mode> tools show <tool>` for schemas.

## Tool Mode Map

| Tool | Shown With Mode | Active Modes |
|---|---|---|
| `apply_patch` | `deep` | `deep` |
| `Bash` | `smart` | `smart,rush,large` |
| `chart` | `deep` | `deep,rush` |
| `create_file` | `smart` | `smart,rush,large` |
| `edit_file` | `smart` | `smart,rush,large` |
| `find_thread` | `smart` | `smart,deep,rush,large` |
| `finder` | `smart` | `smart,deep,rush,large` |
| `glob` | `rush` | `rush` |
| `Grep` | `rush` | `rush` |
| `handoff` | `smart` | `smart,deep,rush,large` |
| `librarian` | `smart` | `smart,deep,rush,large` |
| `look_at` | `smart` | `smart,deep,rush,large` |
| `mcp__exa__crawling_exa` | `smart` | `smart,deep,rush,large` |
| `mcp__exa__get_code_context_exa` | `smart` | `smart,deep,rush,large` |
| `mcp__exa__web_search_exa` | `smart` | `smart,deep,rush,large` |
| `mcp__grep__searchGitHub` | `smart` | `smart,deep,rush,large` |
| `oracle` | `smart` | `smart,deep,rush,large` |
| `painter` | `smart` | `smart,deep,rush,large` |
| `Read` | `smart` | `smart,rush,large` |
| `read_mcp_resource` | `smart` | `smart,rush,large` |
| `read_thread` | `smart` | `smart,deep,rush,large` |
| `read_web_page` | `smart` | `smart,deep,rush,large` |
| `shell_command` | `deep` | `deep` |
| `skill` | `smart` | `smart,deep,rush,large` |
| `Task` | `smart` | `smart,rush,large` |
| `task_list` | `rush` | `rush` |
| `web_search` | `smart` | `smart,deep,rush,large` |

## Tool Definitions

===== TOOL: apply_patch (shown with --mode deep; modes: deep) =====
# apply_patch (built-in)

Apply a patch to one or more files using the Codex patch format.

You MUST read the file before applying a patch to it.

## Patch Format

The patch must be wrapped in `*** Begin Patch` and `*** End Patch` markers.

Each operation starts with one of three headers:
- `*** Add File: <path>` - create a new file. Every following line must start with `+`.
- `*** Delete File: <path>` - remove an existing file. Nothing follows.
- `*** Update File: <path>` - patch an existing file (optionally with a rename via `*** Move to:`).

### Grammar

```
Patch       := Begin { FileOp } End
Begin       := "*** Begin Patch" NEWLINE
End         := "*** End Patch" NEWLINE
FileOp      := AddFile | DeleteFile | UpdateFile
AddFile     := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile  := "*** Delete File: " path NEWLINE
UpdateFile  := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo      := "*** Move to: " newPath NEWLINE
Hunk        := "@@" [ " " header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine    := (" " | "-" | "+") text NEWLINE
```

## Context Rules
- By default, show **3 lines** of unchanged code immediately above and 3 lines immediately below each change.
- Treat 3 lines as a minimum, not a target. For large files, repeated code, or any edit that could plausibly match in multiple places, prefer **5-10 lines** of unchanged context on each side.
- If a change is within the chosen context window of a previous change, do NOT duplicate the first change's context-after lines in the second change's context-before lines.
- If 3 lines of context is insufficient to uniquely identify the location, use the `@@` operator to indicate the class or function the snippet belongs to. For example:
  `@@ class BaseClass`
  [3+ lines of pre-context]
  [changes]
  [3+ lines of post-context]
- If a code block is repeated so many times that even a single `@@` header and 3 lines of context cannot uniquely identify it, use multiple `@@` statements to narrow the location:
  `@@ class BaseClass`
  `@@ def method():`
  [3+ lines of pre-context]
  [changes]
  [3+ lines of post-context]
## Additional Rules
- **When editing conflict markers**, ensure their length matches the file's existing marker length (e.g., jj markers like `<<<<<<<`, `%%%%%%%`, or `\\\\`/longer).
- For Add File: every content line MUST start with `+` (which gets stripped)
- For Update File hunks: lines start with ` ` (context), `-` (remove), or `+` (add)
- Use `*** End of File` marker to anchor changes at end of file
- Multiple files can be patched in a single call
- File paths can be relative or absolute
- Don't use apply patch for edits that an available linter or formatter could do based on the instructions in the users AGENTS.md file.

## Reliability Tips (Hard Cases)
- Repeated blocks (CSS vars, test mocks, large "god" files): include a *unique* `@@ ...` header, and add 5-10 or more context lines until the target is unique.
- If you only read part of a file, do not guess. Read more of the file and expand the context until the hunk can match only once.
- Indentation-sensitive files (Svelte/CSS/TS): keep indentation exactly as in the file (tabs vs spaces). Do not reindent unrelated lines.
- Insert-only hunks (no `-` lines): avoid unanchored insert-only hunks; include a nearby unchanged context line (either via `@@` header or ` ` context lines) to show *where* to insert.
- Ambiguous matches are worse than verbose hunks. Prefer a longer patch over a shorter patch that could apply in multiple places.
- Whitespace drift: avoid changing internal spacing in context lines (e.g., `get: () =>` vs `get:  () =>`). Copy context lines from the file.
- CRLF files: keep line endings consistent with the file you're patching.

# Examples

Add a new file
```json
{"patchText":"*** Begin Patch\n*** Add File: path/to/new/file.ts\n+const hello = 'world'\n+export { hello }\n*** End Patch"}
```

Simple update with context
```json
{"patchText":"*** Begin Patch\n*** Update File: src/utils/helpers.ts\n@@\n export function processData(input: string) {\n   const normalized = input.trim()\n   if (!normalized) {\n     return 'default'\n   }\n-  return normalized\n+  return normalized.toLowerCase()\n }\n\n export function formatLabel(label: string) {\n   return label.toUpperCase()\n }\n*** End Patch"}
```

Update a nested structure (include extra context lines to disambiguate the edit)
```json
{"patchText":"*** Begin Patch\n*** Update File: src/services/user-service.ts\n@@ class UserService\n   constructor(\n     private readonly repo: UserRepo,\n     private readonly logger: Logger,\n   ) {}\n\n   async updateUser(id: string, data: UserData) {\n     const user = await this.findById(id)\n-    user.name = data.name\n+    user.name = data.name?.trim() || user.name\n+    user.updatedAt = new Date()\n     await this.save(user)\n     return user\n   }\n }\n*** End Patch"}
```

Large or repetitive files: prefer 5+ context lines so the hunk matches only once
```json
{"patchText":"*** Begin Patch\n*** Update File: src/theme/button-tokens.ts\n@@ export const buttonTokens = {\n   primary: {\n     background: colors.blue[500],\n     foreground: colors.white,\n     border: colors.blue[600],\n     hoverBackground: colors.blue[600],\n     activeBackground: colors.blue[700],\n-    focusRing: colors.blue[300],\n+    focusRing: colors.cyan[300],\n     disabledBackground: colors.gray[300],\n     disabledForeground: colors.gray[500],\n   },\n   secondary: {\n*** End Patch"}
```

Use multiple @@ blocks to skip intervening code
```json
{"patchText":"*** Begin Patch\n*** Update File: src/config/settings.ts\n@@\n const defaultConfig = {\n   name: 'myapp',\n   version: '1.0.0',\n   featureFlags: {\n     metrics: true,\n     tracing: false,\n   },\n@@\n   logging: {\n     destination: 'stdout',\n-    level: 'info',\n+    level: 'debug',\n     format: 'json',\n     redact: ['token'],\n   },\n   retries: 3,\n*** End Patch"}
```

Editing content within jj conflict markers
```json
{"patchText":"*** Begin Patch\n*** Update File: src/config.ts\n@@\n <<<<<<< Conflict 1 of 1\n %%%%%%% Changes from base to side #1\n \\\\\\       (rebase destination)\n- const API_URL = 'http://localhost:3000'\n+ const API_URL = 'https://api.example.com'\n +++++++ Contents of side #2\n const API_URL = 'http://staging.example.com'\n >>>>>>> Conflict 1 of 1 ends\n*** End Patch"}
```

Deleting a file
```json
{"patchText":"*** Begin Patch\n*** Delete File: path/to/delete.ts\n*** End Patch"}
```

Moving/renaming a file with changes
```json
{"patchText":"*** Begin Patch\n*** Update File: src/old-name.ts\n*** Move to: src/new-name.ts\n@@\n-export function oldName() {\n+export function newName() {\n   return 'hello'\n }\n*** End Patch"}
```


# Schema

- patchText (string): The full patch text that describes all changes to be made

===== TOOL: Bash (shown with --mode smart; modes: smart,rush,large) =====
# Bash (built-in)

Executes the given shell command using bash (or sh on systems without bash).

- Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead
- Do NOT use interactive commands (REPLs, editors, password prompts)
- Output is truncated to the last 50000 characters
- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead
- Commands run in the workspace root by default; only use `cwd` when you need a different directory (never use `cd dir && cmd`)
- Only the last 50000 characters of the output will be returned to you along with how many lines got truncated, if any; rerun with a grep or head/tail filter if needed
- On Windows, use PowerShell commands and `\` path separators
- ALWAYS quote file paths: `cat "path with spaces/file.txt"`
- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)
- Do NOT run `find` (or any recursive search) from `/`, `~`, or another large unrelated root; scope it to the workspace or a specific directory you have reason to search, otherwise it will be extremely slow and waste tokens
- When using `find` or `grep -r`, exclude heavy directories like `node_modules`, `.git`, `dist`, `build`, and `target` (`rg` already skips these via gitignore)
- Do NOT pipe `cat file | grep/awk/sed/...`; pass the file directly to the command (e.g. `grep pattern file`)
- When using `grep`, pass `-E` (or use `egrep`) to enable extended regular expressions; `rg` uses extended regex by default.
- Only run `git commit` and `git push` if explicitly instructed by the user.


# Schema

- cmd (string): The shell command to execute
- cwd (string): Absolute path to a directory where the command will be executed (must be absolute, not relative)

===== TOOL: chart (shown with --mode deep; modes: deep,rush) =====
# chart (built-in)

Render a chart visualization by running a command that produces JSON data. The chart is displayed inline to the user.

Use this tool to visualize data as bar charts, line charts, or area charts. You provide a shell command that outputs JSON, and specify which columns map to the X and Y axes, the chart type, and display options.

# Parameters

- **cmd**: A shell command to execute that must produce JSON output (a JSON array of objects). The command is run via the Bash tool internally. Pipe through `jq -c .` if needed to produce compact JSON.
- **chartType**: "bar", "line", or "area"
- **xColumn**: The column name to use for the X axis (labels)
- **yColumns**: Array of column names for the Y axis. Multiple columns create multiple series (e.g., overlay revenue and expenses on the same chart).
- **title**: Chart title displayed above the chart
- **stacked**: When true with multiple yColumns, stack the series instead of overlaying them. Works with bar and area charts.
- **horizontal**: When true with bar chartType, renders horizontal bars (good for categorical data with long labels).
- **hoverColumns**: Extra column names to show in the hover tooltip but not plotted on the Y axis.
- **groupColumn**: A column whose unique values become separate series. Use with a single yColumn to pivot unpivoted data — e.g., rows with a "type" column become one series per type. Commonly used with stacked charts.

# When to use this tool

- When the user explicitly asks to "chart", "graph", "plot", or "visualize" data
- When the user explicitly requests a visual representation of data
- Do NOT use this tool proactively for tabular data unless the user asks for a visualization

# Examples

Bar chart from a BigQuery query:
{"cmd":"bq query --format=json --nouse_legacy_sql 'SELECT name, score FROM dataset.table LIMIT 10'","chartType":"bar","xColumn":"name","yColumns":["score"],"title":"Test Scores"}

Multi-series comparison:
{"cmd":"cat data.json","chartType":"bar","xColumn":"month","yColumns":["revenue","expenses"],"title":"Revenue vs Expenses"}

Horizontal bar chart:
{"cmd":"echo '[{\"tool\":\"Bash\",\"count\":42},{\"tool\":\"Read\",\"count\":31}]'","chartType":"bar","xColumn":"tool","yColumns":["count"],"title":"Tool Usage","horizontal":true}

Stacked area chart:
{"cmd":"cat commits.json","chartType":"area","xColumn":"date","yColumns":["frontend","backend"],"title":"Commits by Team","stacked":true}

Stacked area chart with groupColumn (auto-pivots rows by credit_type):
{"cmd":"bq query --format=json --nouse_legacy_sql 'SELECT hour, credits, credit_type FROM dataset.usage'","chartType":"area","xColumn":"hour","yColumns":["credits"],"groupColumn":"credit_type","title":"Credits by Type","stacked":true}

# Best practices

- Pipe through `jq -c .` if the command might produce non-JSON text (headers, warnings) or pretty-printed output that could break parsing.
- The chart renders at most 100 points per series (extra rows are silently dropped). Use aggregation (GROUP BY) or LIMIT so the JSON output stays under this threshold.
- Use `groupColumn` to pivot flat rows into multiple series instead of running separate queries or reshaping data manually.
- ISO-date xColumn values (YYYY-MM-DD…) are automatically sorted ascending; categorical labels preserve source order.
- Include a `link` key in JSON rows to make tooltip values clickable hyperlinks.
- Use `hoverColumns` to surface extra context (IDs, descriptions) in tooltips without adding chart clutter.
- Choose `horizontal: true` for bar charts when labels are long (e.g. file paths, URLs).

# Schema

- cmd (string): A shell command to execute that produces JSON output (a JSON array of objects).
- chartType (string): The type of chart to render.
- xColumn (string): Column name to use for the X axis (labels).
- yColumns (array of string): Column name(s) for the Y axis. Multiple columns create multiple series.
- title (string): Chart title.
- subtitle (string): Optional subtitle shown below the title.
- xAxisLabel (string): Label for the X axis. Defaults to the xColumn name.
- yAxisLabel (string): Label for the Y axis. Defaults to the first yColumn name.
- stacked (boolean): Stack multiple series instead of overlaying. Works with bar and area charts.
- horizontal (boolean): Render bars horizontally. Only applies to bar chartType.
- hoverColumns (array of string): Extra columns to display in hover tooltips but not plotted on the Y axis.
- groupColumn (string): Column whose unique values become separate series. Pivots unpivoted data — e.g., a "type" column creates one series per type. Use with a single yColumn.

===== TOOL: create_file (shown with --mode smart; modes: smart,rush,large) =====
# create_file (built-in)

Create or overwrite a file in the workspace.

Use this tool to create a **new file** that does not yet exist.

For **existing files**, prefer `edit_file` instead—even for extensive changes. Only use `create_file` to overwrite an existing file when you are replacing nearly all of its content AND the file is small (under ~250 lines).


# Schema

- path (string): The absolute path of the file to be created (must be absolute, not relative). If the file exists, it will be overwritten. ALWAYS generate this argument first.
- content (string): The content for the file.

===== TOOL: edit_file (shown with --mode smart; modes: smart,rush,large) =====
# edit_file (built-in)

Make edits to a text file.

Replaces `old_str` with `new_str` in the given file.

Returns a git-style diff showing the changes made as formatted markdown, along with the line range ([startLine, endLine]) of the changed content. The diff is also shown to the user.

The file specified by `path` MUST exist, and it MUST be an absolute path. If you need to create a new file, use `create_file` instead.

`old_str` MUST exist in the file. Use tools like `Read` to understand the files you are editing before changing them.

`old_str` and `new_str` MUST be different from each other.

Set `replace_all` to true to replace all occurrences of `old_str` in the file. Else, `old_str` MUST be unique within the file or the edit will fail. Additional lines of context can be added to make the string more unique.

If you need to replace the entire contents of a file, use `create_file` instead, since it requires less tokens for the same action (since you won't have to repeat the contents before replacing)


# Schema

- path (string): The absolute path to the file (MUST be absolute, not relative). File must exist. ALWAYS generate this argument first.
- old_str (string): Text to search for. Must match exactly.
- new_str (string): Text to replace old_str with.
- replace_all (boolean): Set to true to replace all matches of old_str. Else, old_str must be an unique match.

===== TOOL: find_thread (shown with --mode smart; modes: smart,deep,rush,large) =====
# find_thread (built-in)

Find Amp threads (conversation threads with the agent) using a query DSL.

## What this tool finds

This tool searches **Amp threads** (conversations with the agent), NOT git commits. Use this when the user asks about threads, conversations, or Amp history.

## Query syntax

- **Keywords**: Bare words or quoted phrases for text search: `auth` or `"race condition"`
- **File filter**: `file:path` to find threads that touched a file: `file:src/auth/login.ts`
- **Repo filter**: `repo:url` to scope to a repository: `repo:github.com/owner/repo` or `repo:owner/repo`
- **Ref filter**: `ref:name` to scope to a git ref: `ref:main`
- **Author filter**: `author:name` to find threads by a user: `author:alice` or `author:me` for your own threads
- **Date filters**: `after:date` and `before:date` to filter by date: `after:2024-01-15`, `after:7d`, `before:2w`
- **Task filter**: `task:id` to find threads that worked on a task: `task:142`. Use `task:142+` to include threads that worked on the task's dependencies, `task:142^` to include dependents (tasks that depend on this task), or `task:142+^` for both.
- **Combine filters**: Use implicit AND: `auth file:src/foo.ts repo:amp ref:main after:7d`

All matching is case-insensitive. File paths use partial matching. Date formats: ISO dates (`2024-01-15`), relative days (`7d`), or weeks (`2w`).

## When to use this tool

- "which thread touched this file" / "which thread modified this file"
- "what thread last changed X" / "find the thread that edited X"
- "find threads about X" / "search threads mentioning Y"
- Any question about Amp thread history or previous Amp conversations
- When the user says "thread" and is referring to Amp work, not git commits

## When NOT to use this tool

- If the user asks about git commits, git history, or git blame → use git commands instead
- If the user wants to know WHO (a person) made changes → use git log

# Examples

User asks: "Find threads where we discussed the monorepo migration"
```json
{"query":"monorepo migration","limit":10}
```

User asks: "Show me threads that modified src/server/index.ts"
```json
{"query":"file:src/server/index.ts","limit":5}
```

User asks: "What threads have touched this file?" (for current file in github.com/sourcegraph/amp)
```json
{"query":"file:core/src/tools/tool-service.ts repo:sourcegraph/amp"}
```

User asks: "Find auth-related threads in the amp repo"
```json
{"query":"auth repo:sourcegraph/amp"}
```

User asks: "Show me my recent threads"
```json
{"query":"author:me","limit":10}
```

User asks: "Find threads from the last week about authentication"
```json
{"query":"auth after:7d","limit":10}
```

User asks: "Which threads worked on task 142 and its dependencies?"
```json
{"query":"task:142+"}
```

User asks: "Show me all threads related to task 50 and tasks that depend on it"
```json
{"query":"task:50^"}
```


# Schema

- query (string): Search query using DSL syntax. Supports keywords, file:path, repo:url, author:name, after:date, before:date, and task:id filters.
- limit (number): Maximum number of threads to return. Defaults to 20.

===== TOOL: finder (shown with --mode smart; modes: smart,deep,rush,large) =====
# finder (built-in)

Intelligently search your codebase: Use it for complex, multi-step search tasks where you need to find code based on functionality or concepts rather than exact matches. Anytime you want to chain multiple grep calls you should use this tool.

WHEN TO USE THIS TOOL:
- You must locate code by behavior or concept
- You need to run multiple greps in sequence
- You must correlate or look for connection between several areas of the codebase.
- You must filter broad terms ("config", "logger", "cache") by context.
- You need answers to questions such as "Where do we validate JWT authentication headers?" or "Which module handles file-watcher retry logic"

WHEN NOT TO USE THIS TOOL:
- When you know the exact file path - use Read directly
- When looking for specific symbols or exact strings - use glob or Grep
- When you need to create, modify files, or run terminal commands

USAGE GUIDELINES:
1. Always spawn multiple search agents in parallel to maximise speed.
2. Formulate your query as a precise engineering request.
   ✓ "Find every place we build an HTTP error response."
   ✗ "error handling search"
3. Name concrete artifacts, patterns, or APIs to narrow scope (e.g., "Express middleware", "fs.watch debounce").
4. State explicit success criteria so the agent knows when to stop (e.g., "Return file paths and line numbers for all JWT verification calls").
5. Never issue vague or exploratory commands - be definitive and goal-oriented.
6. Avoid broad root-level filename globs when you can scope to a directory.
   ✓ "Find watchdog-related files under core and server/src."
   ✗ "Find files named watchdog anywhere."
7. Prefer scoped Grep searches before falling back to repo-wide filename scans.


# Schema

- query (string): The search query describing to the agent what it should. Be specific and include technical terms, file types, or expected code patterns to help the agent find relevant code. Formulate the query in a way that makes it clear to the agent when it has found the right thing.

===== TOOL: glob (shown with --mode rush; modes: rush) =====
# glob (built-in)

Fast file pattern matching tool that works with any codebase size

Use this tool to find files by name patterns across your codebase. Results are returned in ripgrep's traversal order, not by modification time.

## File pattern syntax

- `**/*.js` - All JavaScript files in any directory
- `src/**/*.ts` - All TypeScript files under the src directory (searches only in src)
- `*.json` - All JSON files in the current directory
- `**/*test*` - All files with "test" in their name
- `server/src/**/*` - All files under the server/src directory
- `**/*.{js,ts}` - All JavaScript and TypeScript files (alternative patterns)
- `src/[a-z]*/*.ts` - TypeScript files in src subdirectories that start with lowercase letters

# Examples

Find all typescript files in the codebase
```json
{"filePattern":"**/*.ts"}
```

Find all test files under a specific directory
```json
{"filePattern":"src/**/*test*.ts"}
```

Search for Svelte component files in the server/src directory
```json
{"filePattern":"server/src/**/*.svelte"}
```

Find up to 10 JSON files
```json
{"filePattern":"**/*.json","limit":10}
```


# Schema

- filePattern (string): Glob pattern like "**/*.js" or "src/**/*.ts" to match files
- limit (number): Maximum number of results to return (default: 200, max: 1000)
- offset (number): Number of results to skip (for pagination)

===== TOOL: Grep (shown with --mode rush; modes: rush) =====
# Grep (built-in)

Search for exact text patterns in files using ripgrep, a fast keyword search tool.

# When to use this tool
- Finding exact text matches (variable names, function calls, specific strings)
- Use finder for semantic/conceptual searches

# How to use it well
# Efficient usage
- Scope with `path` first; add `glob` when file type matters
- Prefer several focused searches over one repo-wide scan
- Use `literal: true` for exact text; keep regex for patterns

# Constraints
- Results are limited to 100 matches (up to 10 per file)
- Lines are truncated at 200 characters

# Examples

Find a specific function name across the codebase
```json
{"pattern":"registerTool","path":"core/src"}
```

Search for interface definitions in a specific directory
```json
{"pattern":"interface ToolDefinition","path":"core/src/tools"}
```

Use a case-sensitive search to find the exact string `ERROR:`
```json
{"pattern":"ERROR:","caseSensitive":true}
```

Find TODO comments in frontend code
```json
{"pattern":"TODO:","path":"server/src"}
```

Find a specific function name in test files
```json
{"pattern":"restoreThreads","glob":"**/*.test.ts"}
```

Find all REST API endpoint definitions
```json
{"pattern":"app\\.(get|post|put|delete)\\([\"']","path":"server"}
```

Locate route helper usage in Svelte routes
```json
{"pattern":"route\\(","path":"server/src/routes"}
```

# Complementary to finder
- Use finder first to locate relevant code concepts
- Then use Grep to find specific implementations or all occurrences
- For complex tasks, iterate between both tools to refine your understanding


# Schema

- pattern (string): The pattern to search for (regex)
- path (string): The file or directory path to search in. Use this first to avoid repo-wide scans. Cannot be used with glob.
- glob (string): A glob filter like "**/*.ts". Use this when file type matters. Cannot be used with path.
- caseSensitive (boolean): Whether to search case-sensitively
- literal (boolean): Whether to treat the pattern as exact text instead of a regex. Prefer this for identifiers and copied strings.

===== TOOL: handoff (shown with --mode smart; modes: smart,deep,rush,large) =====
# handoff (built-in)

Hand off work to a new thread that runs in the background. Use this tool when you need to continue work in a fresh context because:
- The current thread is getting too long and context is degrading
- You want to start a new focused task while preserving context from the current thread
- The current thread's context window is near capacity

When you call this tool:
1. A new thread will be created with relevant context from this thread
2. The new thread will start running in the background
3. The current thread continues to run - you can finish up any remaining work

When the user message tells you to continue the work or to handoff to only one new thread, you should follow to the new thread by setting follow to true.

The goal parameter should describe what work should continue in the new thread. Keep it short—a single sentence or at most one paragraph. Focus on what needs to be done next, not what was already completed.

Use the mode parameter when the user explicitly requests a different agent mode (e.g., "deep", "smart", "rush") for the new thread.

# Schema

- goal (string): A short description of the next task to accomplish in the new thread. Should be a single sentence or at most one paragraph. Focus on what needs to be done next, not what was already completed.
- follow (boolean): If true, navigate to the new thread after creation. Use this when the current thread is stopping and work should continue in the new thread.
- mode (string): The agent mode for the new thread. Defaults to the current thread's agent mode if not specified.

===== TOOL: librarian (shown with --mode smart; modes: smart,deep,rush,large) =====
# librarian (built-in)

The Librarian is a codebase-understanding subagent for
repositories outside the local workspace.

It can read public GitHub repositories, connected private GitHub repositories, and connected
Bitbucket Enterprise repositories.

Use this when you need deep understanding of existing code across one or more repositories:
- explaining architecture, flows, or subsystem design
- finding where a feature is implemented in an external codebase
- comparing patterns across repositories
- understanding how code evolved through commit history
- reading or diffing files in a remote repository

Do not use this for:
- local workspace reads or searches
- code modifications or implementations
- simple local lookups when a direct local tool is enough
- questions unrelated to understanding existing repositories

Guidance:
- name the repository or project when you know it
- ask a specific question or describe the feature or codepath you want understood
- include context about what you are trying to achieve
- expect a thorough answer suitable for sharing
- return the answer in full rather than summarizing it

Examples:
- "How does authentication work in the Kubernetes codebase?"
- "Explain the architecture of the React rendering system"
- "Compare how different web frameworks handle routing"
- "What changed in commit abc123 in my private repository?"
- "Read the README from the main API repo on our Bitbucket Enterprise instance"


# Schema

- query (string): Your question about the codebase. Be specific about what you want to understand or explore.
- context (string): Optional context about what you're trying to achieve or background information.

===== TOOL: look_at (shown with --mode smart; modes: smart,rush,large) =====
# look_at (built-in)

Extract specific information from a local file (including PDFs, images, and other media).

Use this tool when you need to extract or summarize information from a file without getting the literal contents. Always provide a clear objective describing what you want to learn or extract.

Pass reference files when you need to compare two or more things.

## When to use this tool

- Analyzing PDFs, images, or media files that the Read tool cannot interpret
- Extracting specific information or summaries from documents
- Describing visual content in images or diagrams
- When you only need analyzed/extracted data, not raw file contents

## When NOT to use this tool

- For source code or plain text files where you need exact contents—use Read instead
- When you need to edit the file afterward (you need the literal content from Read)
- For simple file reading where no interpretation is needed

# Examples

Summarize a local PDF document with a specific goal
```json
{"path":"docs/specs/system-design.pdf","objective":"Summarize main architectural decisions.","context":"We are evaluating this system design for a new project we are building."}
```

Describe what is shown in an image file
```json
{"path":"assets/mockups/homepage.png","objective":"Describe the layout and main UI elements.","context":"We are creating a UI component library and need to understand the visual structure."}
```

Compare two screenshots to identify visual differences
```json
{"path":"screenshots/before.png","objective":"Identify all visual differences between the two screenshots.","context":"We are reviewing UI changes for a feature update and need to document all differences.","referenceFiles":["screenshots/after.png"]}
```


# Schema

- path (string): Absolute path to the file to analyze.
- objective (string): Natural-language description of the analysis goal (e.g., summarize, extract data, describe image).
- context (string): The broader goal and context for the analysis. Include relevant background information about what you are trying to achieve and why this analysis is needed.
- referenceFiles (array of string): Optional list of absolute paths to reference files for comparison (e.g., to compare two screenshots or documents).

===== TOOL: oracle (shown with --mode smart; modes: smart,deep,rush,large) =====
# oracle (built-in)

Consult the oracle - an AI advisor powered by OpenAI's GPT-5.4 reasoning model that can plan, review, and provide expert guidance.

The oracle has access to the following tools:
- Read
- Grep
- glob
- web_search
- read_web_page
- read_thread
- find_thread.

You should consult the oracle for:
- Code reviews and architecture feedback
- Finding difficult bugs in codepaths that flow across many files
- Planning complex implementations or refactors
- Answering complex technical questions that require deep technical reasoning
- Providing an alternative point of view when you are struggling to solve a problem

You should NOT consult the oracle for:
- File reads or simple keyword searches (use Read or Grep directly)
- Codebase searches (use finder)
- Web browsing and searching (use read_web_page or web_search)
- Basic code modifications and when you need to execute code changes (do it yourself or use Task)

Usage guidelines:
- Be specific about what you want the oracle to review, plan, or debug
- Provide relevant context about what you're trying to achieve. If you know that 3 files are involved, list them and they will be attached.

# Examples

Review the authentication system architecture and suggest improvements
```json
{"task":"Review the authentication architecture and suggest improvements","files":["src/auth/index.ts","src/auth/jwt.ts"]}
```

Plan the implementation of real-time collaboration features
```json
{"task":"Plan the implementation of real-time collaboration feature"}
```

Analyze the performance bottlenecks in the data processing pipeline
```json
{"task":"Analyze performance bottlenecks","context":"Users report slow response times when processing large datasets"}
```

Review this API design and suggest better patterns
```json
{"task":"Review API design","context":"This is a REST API for user management","files":["src/api/users.ts"]}
```

Debug failing tests after refactor
```json
{"task":"Help debug why tests are failing","context":"Tests fail with \"undefined is not a function\" after refactoring the auth module","files":["src/auth/auth.test.ts"]}
```


# Schema

- task (string): The task or question you want the oracle to help with. Be specific about what kind of guidance, review, or planning you need.
- context (string): Optional context about the current situation, what you've tried, or background information that would help the oracle provide better guidance.
- files (array of string): Optional list of specific file paths (text files, images) that the oracle should examine as part of its analysis. These files will be attached to the oracle input.

===== TOOL: painter (shown with --mode smart; modes: smart,deep,rush,large) =====
# painter (built-in)

Generate an image using an AI model.

IMPORTANT: Only invoke this tool when the user explicitly asks to use the "painter" tool. Do not use this tool automatically or proactively.

- When using this tool, request a single image at a time. Multiple input reference images are OK.
- Use savePath to specify the output file path only if the user explicitly asks for it.

## When to use this tool

- When the user explicitly asks to use the "painter" tool
- When the user explicitly requests image generation using this tool

## When NOT to use this tool

- Do NOT use automatically for UI mockups, diagrams, or icons—only unless explicitly requested by user
- For diagrams—write a plain-text box-drawing `diagram` code block with rounded-corner boxes where possible; there is no Mermaid tool or renderer, so do not write Mermaid syntax or `mermaid` code fences
- For analyzing existing images—use the "look_at" tool instead

## Example Scenarios

- **Generate a image from user description**: Provide only a prompt with detailed visual instructions. No inputImagePaths needed.
- **Create with reference**: Provide one or more reference images provided by the user for style/content inspiration. The model will use these as guidance to create a new image matching your prompt. Your prompt should describe how to use each reference (e.g., "match the color palette from the first image", "use the icon style from the second").
- **Edit/composite images**: Provide the image to edit and optionally another image with elements to incorporate. The prompt should describe what to change or how to combine them.

# Examples

Generate an app icon for a CLI tool
```json
{"prompt":"1024x1024 app icon. Dark background #1a1a2e. Glowing terminal cursor symbol in cyan #00d9ff. Minimal, modern style for macOS dock."}
```

Generate a hero image using existing brand assets as reference
```json
{"prompt":"Hero image for documentation landing page. Match the color palette from the first image and icon style from the second. Abstract flowing code symbols. 1920x600 dimensions.","inputImagePaths":["/Users/alice/project/docs/assets/brand-colors.png","/Users/alice/project/docs/assets/icon-style.png"]}
```

Redact sensitive data from a terminal screenshot
```json
{"prompt":"Blur or redact any visible API keys, tokens, passwords, or email addresses in this terminal screenshot. Keep command output readable. Preserve dimensions.","inputImagePaths":["/Users/alice/project/docs/screenshots/terminal-output.png"]}
```

Generate an image and save to the Documents folder (Windows)
```json
{"prompt":"A modern company logo with blue and white colors. Clean, minimalist design.","savePath":"C:\\Users\\alice\\Documents\\logo.png"}
```


# Schema

- prompt (string): Detailed instructions for image generation based on user requirements. Include specifics about design, layout, style, colors, composition, and any other visual details the user mentioned.
- inputImagePaths (array of string): Optional image paths provided by the user for editing or style guidance. Maximum 3 images allowed. Each image path should be same as the `sourcePath` provided by the user.
- savePath (string): Optional absolute path to save the generated image (e.g., C:/Users/name/Documents/image.png on Windows, /home/user/Documents/image.png on Linux/Mac). Only valid when a single image is generated.

===== TOOL: Read (shown with --mode smart; modes: smart,rush,large) =====
# Read (built-in)

Read a file or list a directory from the file system. If the path is a directory, it returns a line-numbered list of entries. If the file or directory doesn't exist, an error is returned.

- The path parameter MUST be an absolute path.
- By default, this tool returns the first 500 lines. To read more, call it multiple times with different read_ranges.
- Use the Grep tool to find specific content in large files or files with long lines.
- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.
- The contents are returned with each line prefixed by its line number. For example, if a file has contents "abc\
", you will receive "1: abc\
". For directories, entries are returned one per line (without line numbers) with a trailing "/" for subdirectories.
- This tool can read images (such as PNG, JPEG, and GIF files) and present them to the model visually.
- When possible, call this tool in parallel for all files you will want to read.
      - Avoid tiny repeated slices (e.g., 50\u2011line chunks). If you need more context from the same file, read a larger range or the full default window instead.

# Schema

- path (string): The absolute path to the file or directory (MUST be absolute, not relative).
- read_range (array of number): An array of two integers specifying the start and end line numbers to view. Line numbers are 1-indexed. If not provided, defaults to [1, 1000]. Examples: [500, 700], [700, 1400]

===== TOOL: read_mcp_resource (shown with --mode smart; modes: smart,rush,large) =====
# read_mcp_resource (built-in)

Read a resource from an MCP (Model Context Protocol) server.

Use when the user references an MCP resource, e.g. "read @filesystem-server:file:///path/to/document.txt"

# Examples

Read a file from an MCP file server
```json
{"server":"filesystem-server","uri":"file:///path/to/document.txt"}
```

Read a database record from an MCP database server
```json
{"server":"database-server","uri":"db://users/123"}
```


# Schema

- server (string): The name or identifier of the MCP server to read from
- uri (string): The URI of the resource to read

===== TOOL: read_thread (shown with --mode smart; modes: smart,deep,rush,large) =====
# read_thread (built-in)

Read and extract relevant content from another Amp thread by its ID or ampcode.com URL.

This tool fetches a thread (locally or from the server if synced), renders it as markdown, and uses AI to extract only the information relevant to your specific goal. This keeps context concise while preserving important details.

## When to use this tool

- When the user pastes or references an Amp thread URL on ampcode.com whose last path segment is a thread ID (for example https://ampcode.com/threads/T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx or https://ampcode.com/v2/workspace/project/T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) in their message
- When the user references a thread ID (format: T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx or @T-abc123)
- When the user asks to "apply the same approach from [thread URL]"
- When the user says "do what we did in [thread URL]"
- When the user says "implement the plan we devised in [thread URL]"
- When you need to extract specific information from a referenced thread

## When NOT to use this tool

- When no thread ID is mentioned
- When working within the current thread (context is already available)

## Parameters

- **threadID**: The thread identifier in format T-{uuid}, or an ampcode.com URL whose last path segment is T-{uuid} (e.g., "T-a38f981d-52da-47b1-818c-fbaa9ab56e0c" or "https://ampcode.com/v2/workspace/project/T-a38f981d-52da-47b1-818c-fbaa9ab56e0c")
- **goal**: A clear description of what information you're looking for in that thread. Be specific about what you need to extract.

# Examples

User asks "Implement the plan we devised in https://ampcode.com/threads/T-3f1beb2b-bded-4fda-96cc-1af7192f24b6"
```json
{"threadID":"T-3f1beb2b-bded-4fda-96cc-1af7192f24b6","goal":"Extract the implementation plan, design decisions, architecture approach, and any code patterns or examples discussed"}
```

User asks: "Do what we did in https://ampcode.com/threads/T-f916b832-c070-4853-8ab3-5e7596953bec, but for the Oracle tool"
```json
{"threadID":"T-f916b832-c070-4853-8ab3-5e7596953bec","goal":"Extract the implementation approach, code patterns, techniques used, and any relevant code examples that can be adapted for the Oracle tool"}
```

User asks: "Take the SQL queries from https://ampcode.com/threads/T-95e73a95-f4fe-4f22-8d5c-6297467c97a5 and turn it into a reusable script"
```json
{"threadID":"T-95e73a95-f4fe-4f22-8d5c-6297467c97a5","goal":"Extract all SQL queries, their purpose, parameters, and any context needed to understand how to make them reusable"}
```

User asks: "Apply the same fix from https://ampcode.com/v2/amp/amp/T-019d01b5-f70d-73ea-9445-f6d358f7213e to this issue"
```json
{"threadID":"https://ampcode.com/v2/amp/amp/T-019d01b5-f70d-73ea-9445-f6d358f7213e","goal":"Extract the bug description, root cause, the fix or solution, and relevant code changes"}
```

User asks: "Apply the same fix from @T-95e73a95-f4fe-4f22-8d5c-6297467c97a5 to this issue"
```json
{"threadID":"T-95e73a95-f4fe-4f22-8d5c-6297467c97a5","goal":"Extract the bug description, root cause, the fix/solution, and relevant code changes"}
```


# Schema

- threadID (string): The thread ID in format T-{uuid}, or an ampcode.com URL whose last path segment is T-{uuid} (e.g., "T-a38f981d-52da-47b1-818c-fbaa9ab56e0c" or "https://ampcode.com/v2/workspace/project/T-a38f981d-52da-47b1-818c-fbaa9ab56e0c")
- goal (string): A clear description of what information you need from the thread. Be specific about what to extract.

===== TOOL: read_web_page (shown with --mode smart; modes: smart,deep,rush,large) =====
# read_web_page (built-in)

Read the contents of a web page at a given URL.

When only the url parameter is set, it returns the contents of the webpage converted to Markdown.

When an objective is provided, it returns excerpts relevant to that objective.

If the user asks for the latest or recent contents, pass `forceRefetch: true` to ensure the latest content is fetched.

Do NOT use for access to localhost or any other local or non-Internet-accessible URLs; use `curl` via the Bash instead.

# Examples

Summarize recent changes for a library. Force refresh because freshness is important.
```json
{"url":"https://example.com/changelog","objective":"Summarize the API changes in this software library.","forceRefetch":true}
```

Extract all text content from a web page
```json
{"url":"https://example.com/docs/getting-started"}
```


# Schema

- url (string): The URL of the web page to read
- objective (string): A natural-language description of the research goal. If set, only relevant excerpts will be returned. If not set, the full content of the web page will be returned. 
- forceRefetch (boolean): Force a live fetch of the URL (default: use a cached version that may be a few days old)

===== TOOL: shell_command (shown with --mode deep; modes: deep) =====
# shell_command (built-in)

Runs a shell command and returns its output.
- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary. For doing file changes, use the apply_patch
- Avoid end-buffering pipes like `| tail -20` for long-running commands; they can hide progress and trigger inactivity timeouts
- Use `timeout_ms` to increase the inactivity timeout for commands that may stay quiet for long stretches

# Schema

- command (string): Shell command to execute.
- workdir (string): Optional working directory to run the command in; defaults to the turn cwd.
- timeout_ms (number): The timeout for the command in milliseconds

===== TOOL: skill (shown with --mode smart; modes: smart,deep,rush,large) =====
# skill (built-in)

Load a specialized skill when the task matches one of the skills listed in the system prompt.

Use this tool to inject that skill's instructions and bundled resources into the current conversation. A loaded skill may provide:
- task-specific workflow guidance
- references to scripts, templates, or files in the skill directory
- additional builtin or MCP tools that become available after loading

Use this tool when:
- the user explicitly asks for a skill by name
- the task clearly matches a skill description from the system prompt

You usually only need to load a skill once per context window. After it is loaded, continue following its instructions instead of reloading it.

Parameters:
- name: The name of the skill to load (must match one of the skills listed below)

Example: To use the web-browser skill for interacting with web pages, call this tool with name: "web-browser"

# Schema

- name (string): The name of the skill to load
- arguments (string): Optional arguments to pass to the skill

===== TOOL: Task (shown with --mode smart; modes: smart,rush,large) =====
# Task (built-in)

Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to the following tools: Read, Bash, edit_file, create_file, read_web_page, web_search, finder, skill, task_list, look_at.


When to use the Task tool:
- When you need to perform complex multi-step tasks
- When you need to run an operation that will produce a lot of output (tokens) that is not needed after the sub-agent's task completes
- When you are making changes across many layers of an application (frontend, backend, API layer, etc.), after you have first planned and spec'd out the changes so they can be implemented independently by multiple sub-agents
- When the user asks you to launch an "agent" or "subagent", because the user assumes that the agent will do a good job

When NOT to use the Task tool:
- When you are performing a single logical task, such as adding a new feature to a single part of an application.
- When you're reading a single file (use Read), performing a text search (use Grep), editing a single file (use edit_file)
- When you're not sure what changes you want to make. Use all tools available to you to determine the changes to make.

How to use the Task tool:
- Run multiple sub-agents concurrently if the tasks may be performed independently (e.g., if they do not involve editing the same parts of the same file), by including multiple tool uses in a single assistant message.
- You will not see the individual steps of the sub-agent's execution, and you can't communicate with it until it finishes, at which point you will receive a summary of its work.
- Include all necessary context from the user's message and prior assistant steps, as well as a detailed plan for the task, in the task description. Be specific about what the sub-agent should return when finished to summarize its work.
- Tell the sub-agent how to verify its work if possible (e.g., by mentioning the relevant test commands to run).
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.


# Schema

- prompt (string): The task for the agent to perform. Be specific about what needs to be done and include any relevant context.
- description (string): A very short description of the task that can be displayed to the user.

===== TOOL: task_list (shown with --mode rush; modes: rush) =====
# task_list (built-in)

Plan and track tasks. Use this tool for ALL task planning - breaking down work into steps, tracking progress, and managing what needs to be done.

Actions:
- create: Create a new task with title (required), description, repoURL, status, dependsOn, parentID
- list: List tasks with optional filters (repoURL, status, limit, ready). Completed tasks are excluded by default; use status filter to include them.
- get: Get a single task by taskID
- update: Update a task by taskID with new values
- delete: Soft delete a task by taskID

Use dependsOn to specify task dependencies - an array of task IDs that block this task. If B dependsOn A, then A blocks B (A must complete before B can start). Use `ready: true` with the list action to find tasks where all blockers are completed. Use parentID to establish parent-child relationships between tasks (for hierarchical task breakdown). Tasks persist across sessions and the creating thread ID is automatically recorded.

Write task descriptions with enough context that a future thread can pick up the work without needing the original conversation. Include relevant file paths, function names, error messages, or acceptance criteria.

# Examples

Run the build and fix any type errors:
```
create "Run the build" → gets id "build"
create "Fix type errors", dependsOn: ["build"]
[run build, find 3 errors]
create task for each error, each dependsOn: ["build"]
update "build" → completed
[fix first error]
update that task → completed
[continue...]
```

Build a new API feature (mixed sequential and parallel):
```
create "Design API schema" → gets id "design"
create "Set up database tables", dependsOn: ["design"] → gets id "db"
create "Implement API endpoints", dependsOn: ["design"] → gets id "api"
create "Write backend tests", dependsOn: ["api"] → gets id "backend-tests"
create "Build frontend components", dependsOn: ["api"] → gets id "frontend"
create "Integration tests", dependsOn: ["backend-tests", "frontend"] → gets id "integration"
create "Deploy to staging", dependsOn: ["integration"]
```
- db and api are parallel (both blocked by design)
- backend-tests chains after api
- frontend chains after api
- integration waits for BOTH backend-tests and frontend
- deploy is the final step

# Schema

- action (string): The action to perform
- taskID (string): Task ID (required for get, update, delete)
- title (string): Task title (required for create, optional for update)
- description (string): Task description
- repoURL (string): Repository URL to associate with the task
- status (string): Task status
- dependsOn (array of string): Array of task IDs this task depends on - should be done after these tasks
- parentID (string): Parent task ID for hierarchical task breakdown
- limit (number): Maximum number of tasks to return (for list action)
- ready (boolean): Filter to only return tasks that are ready to work on (all dependencies completed)

===== TOOL: web_search (shown with --mode smart; modes: smart,deep,rush,large) =====
# web_search (built-in)

Search the web for information relevant to a research objective.

Use when you need up-to-date or precise documentation. Use `read_web_page` to fetch full content from a specific URL.

# Examples

Get API documentation for a specific provider
```json
{"objective":"I want to know the request fields for the Stripe billing create customer API. Prefer Stripe's docs site."}
```

See usage documentation for newly released library features
```json
{"objective":"I want to know how to use SvelteKit remote functions, which is a new feature shipped in the last month.","search_queries":["sveltekit","remote function"]}
```


# Schema

- objective (string): A natural-language description of the broader task or research goal, including any source or freshness guidance
- search_queries (array of string): Optional keyword queries to ensure matches for specific terms are prioritized (recommended for best results)
- max_results (number): The maximum number of results to return (default: 5)