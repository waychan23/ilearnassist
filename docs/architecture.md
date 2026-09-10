# Architecture

## Overview

```text
┌─────────────────┐        HTTP / SSE         ┌──────────────────────────────┐
│  Vue 3 (Vite)   │  ───────────────────────► │  Fastify 5 server (Node/TS)  │
│  apps/web       │  /api/*  (JSON + SSE)    │  apps/server                 │
└─────────────────┘                           │                              │
                                              │  ┌─ routes.ts (REST + chat)  │
                                              │  ├─ agent/loop.ts (ReAct)    │
                                              │  │    └─ agent/model.ts      │
                                              │  │        (ChatOpenAI)       │
                                              │  ├─ tools/ (files + search)  │
                                              │  ├─ workspace.ts (sandbox)   │
                                              │  └─ db.ts (SQLite)           │
                                              └──────────────┬───────────────┘
                                                             │
                                          ┌──────────────────┴───────────────┐
                                          │  filesystem:  workspaces/<slug>/  │
                                          │  data/:        app.sqlite (WAL)   │
                                          └──────────────────────────────────┘
```

The frontend is a thin client: all state lives in a single Pinia store
(`apps/web/src/stores/app.ts`). It talks to the backend over JSON for CRUD and
over **Server-Sent Events** for chat streaming.

## Components

### Config (`config.ts`)

`loadConfig()` reads `config/config.yaml`, overlays `config/config.local.yaml`
(git-ignored), then resolves every `${ENV_VAR}` reference against `.env` +
real environment variables (real env wins). Missing env vars resolve to `""`.
The result is a typed `AppConfig` with providers, models, tool settings and the
workspaces root. A separate `publicConfig()` strips `apiKey` before sending it
to the client.

### Database (`db.ts`)

`better-sqlite3` with `journal_mode=WAL` and `foreign_keys=ON`. Four tables in
snake_case, mapped to camelCase objects in code:

- `workspaces` — id, name, slug, dir_path, created_at
- `copilots` — id, name, description, system_prompt, model, tools (JSON), timestamps
- `sessions` — id, workspace_id, copilot_id, title, timestamps
- `messages` — id, session_id, role, content, tool_calls (JSON), created_at

### Workspace sandboxing (`workspace.ts`)

The global workspaces root (default `./workspaces`) holds one sub-directory per
workspace. `resolveInWorkspace(dir, userPath)` resolves a tool-supplied path
against the workspace and **rejects any result outside the workspace** via a
`path.relative` check — this is the security boundary that prevents a model from
reading `/etc/passwd` or escaping with `../..`. Deletes are additionally guarded
to only remove direct children of the root.

### Tools (`tools/`)

| Tool            | Purpose                                   | Sandboxed |
| --------------- | ----------------------------------------- | --------- |
| `list_files`    | list `dist`-style entries under a path    | ✓         |
| `read_file`     | read file text (capped at 40k chars)      | ✓         |
| `write_file`    | write/overwrite a file                    | ✓         |
| `create_directory` | mkdir -p                              | ✓         |
| `delete_file`   | delete a file/dir inside the workspace    | ✓         |
| `web_search`    | search the web (bing/duckduckgo/tavily/searxng) | —   |

`buildTools({ workspaceDir, webSearch, fileToolsEnabled, allowedNames })` returns
the active set for a run, honoring config switches and the Copilot's tool
allow-list.

### Agent loop (`agent/loop.ts`)

A hand-written ReAct loop (not LangGraph's prebuilt agent), chosen for full
control over the streaming shape:

1. Compose messages: `SystemMessage` (Copilot system prompt + a note that file
   tools are scoped to the workspace) → prior history → current `HumanMessage`.
2. `chatModel.bindTools(tools)`.
3. Loop up to **15 steps**. Each step:
   - `modelWithTools.stream(messages)` and emit `text` deltas as they arrive,
     accumulating `AIMessageChunk`s.
   - Reduce chunks into a full `AIMessage`; read its `tool_calls`.
   - For each tool call: emit `tool_start`, `await tool.invoke(args)` with a
     JSON-safe result, emit `tool_end`, and append a `ToolMessage`.
4. Return `{ content, toolCalls }` for persistence.

The model is built by `model.ts` as a `ChatOpenAI` with
`{ model, apiKey, configuration: { baseURL } }`, which is what makes it
OpenAI-compatible with DeepSeek, OpenAI, Ollama, etc. Streaming is always on.

### Routes (`routes.ts`)

REST endpoints for config/health, workspaces, copilots, sessions and messages.
The chat endpoint (`POST /api/sessions/:id/chat`) is the interesting one:

1. Resolve effective copilot → model/provider (per-turn overrides win).
2. Build the sandboxed tool set.
3. Persist the user message, capture history *before* it (avoids a duplicate
   user turn), then `reply.hijack()`.
4. Stream `meta` → agent events → `message_done` with the persisted assistant
   message → `done`.
5. On error, stream `error` and persist a balanced `⚠️ …` assistant message so
   history remains user/assistant alternating.

### SSE protocol (`stream.ts` + shared types)

Each frame is `event: <type>\ndata: <json>\n\n`. The `ChatStreamEvent` union
(in `packages/shared`) is: `meta`, `text` (delta), `tool_start`, `tool_end`,
`message_done`, `error`, `done`. The frontend's `sseEvents()` generator parses
these frames and the store folds them into live UI state.

## Frontend

- `stores/app.ts` — single source of truth; owns config, workspaces, copilots,
  sessions, messages, active selections, provider/model, and the streaming
  buffer. `sendMessage()` is optimistic: push a user bubble, then iterate the
  SSE stream and update a transient assistant entry until `message_done`.
- `components/` — `Sidebar` (workspace/session/copilot nav), `ChatView`
  (topbar + messages), `MessageItem` (markdown + tool cards), `ToolCallCard`
  (collapsible args/result), `Composer`, and three dialogs.
- `utils/markdown.ts` — markdown-it with `html:false` (raw HTML escaped) and
  highlight.js code highlighting.