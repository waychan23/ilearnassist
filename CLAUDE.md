# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**guided-learning** is a self-hosted, single-user agent product (Browser/Server
architecture). It provides a chatbox-like UI over a manual ReAct agent loop with
tool calling. Two apps share a types package:

- `apps/server` — Fastify 5 + better-sqlite3 + LangChain.js (`@langchain/core`,
  `@langchain/openai`). Runs the agent loop and streams results over SSE.
- `apps/web` — Vue 3 (Composition API) + Pinia + Vite. Renders the chat UI.
- `packages/shared` — dependency-free API/domain types used by both sides.

## Commands

```bash
pnpm install           # first time — see "Gotchas" below
pnpm dev               # run server + web together (backend :3720, web :5173)
pnpm dev:server        # tsx watch src/index.ts (backend only)
pnpm dev:web           # vite (frontend only)
pnpm typecheck         # tsc (server) + vue-tsc (web) across all packages
pnpm build             # production build of the web app
```

TypeScript is strict (`strict`, `noUncheckedIndexedAccess`, `isolatedModules`,
`moduleResolution: Bundler`, ESM). Run `pnpm typecheck` before finishing; a
clean typecheck is the bar for "done".

### Typecheck workaround

`pnpm typecheck` can be blocked by a host-level pnpm supply-chain policy
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) shortly after packages like
`@langchain/core` are published. This is transient (resolves within a day) and
is not a code problem. To typecheck without hitting the policy, invoke the
binaries directly:

```bash
( cd apps/server && ./node_modules/.bin/tsc --noEmit )
( cd apps/web    && ./node_modules/.bin/vue-tsc --noEmit )
```

## Layout

```
config/config.yaml        # providers, models, tools, workspaces root (single source of truth)
apps/server/src/
  index.ts                # bootstrap
  config.ts               # YAML + ${ENV} resolution + .env loader
  db.ts                   # better-sqlite3 schema + CRUD (snake_case cols)
  workspace.ts            # resolveInWorkspace sandboxing + dir mgmt
  routes.ts               # Fastify routes (workspaces/copilots/sessions/chat)
  stream.ts               # SSE framing helper
  agent/loop.ts           # manual ReAct loop (model.bindTools → stream → run tools)
  agent/model.ts          # ChatOpenAI builder (OpenAI-compatible)
  tools/index.ts          # tool assembly + ALL_TOOL_NAMES
  tools/fileTools.ts      # list/read/write/create_dir/delete_file (sandboxed)
  tools/webSearch.ts      # bing / duckduckgo / tavily / searxng
apps/web/src/
  stores/app.ts           # Pinia store (all state + actions)
  api/client.ts           # fetch helpers + SSE parser
  components/…            # App, Sidebar, ChatView, MessageItem, ToolCallCard, Composer, dialogs
packages/shared/src/index.ts  # all cross-boundary types (ChatStreamEvent, ToolCall, …)
```

## Reference project: chatbox

This app is modeled on [chatbox](https://github.com/chatboxai/chatbox) (Electron
+ React). A clone kept for reference lives at
`/Users/waychan23/Documents/work/spaces/trae/chatbox` — treat it as a
behavioral/UX reference only (chatbox is React/Electron; guided-learning is
Vue/Fastify), so port ideas rather than copy code. Quick map:

- `src/renderer/` — chat UI, settings, Copilot/agent config screens
- `src/renderer/packages/web-search/` — keyless Bing + DuckDuckGo scraping
- `packages/chatbox-core/src/models/` — model/provider adapters
- `packages/chatbox-core/src/generation/` — agent/tool (ReAct) loop
- `features/*.feature` — higher-level feature specs

Fuller map in `docs/reference.md`.

## Invariants worth respecting

- **Workspace sandboxing is a security boundary.** All file-tool paths MUST go
  through `resolveInWorkspace` (rejects `..` escapes and absolute escapes) and
  never operate outside the active workspace directory. Do not add a file tool
  that bypasses this.
- **API keys never leave the server.** `PublicConfig` (from `/api/config`) has
  only `hasApiKey: boolean`, never the key.
- **Shared types only.** Cross-boundary payloads live in `packages/shared`. Adding
  a field to an API response means updating the type there first, then both apps
  typecheck clean.
- **SSE framing** is `event: <type>\ndata: <json>\n\n`. Chat streams via
  `reply.hijack()`; the agent emits `text` deltas, `tool_start`/`tool_end`,
  `message_done`, `error`, then `done`. The frontend expects exactly this.
- **History must stay user/assistant balanced.** On a chat error, a `⚠️ …`
  assistant message is persisted so the next turn's history is well-formed.

## Gotchas

- `pnpm-workspace.yaml` has `allowBuilds: { better-sqlite3: true, esbuild: true }`.
  Without it, `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` (native addon).
- `better-sqlite3` is a native module — it builds against your local Node. If you
  change Node versions, reinstall.
- Config loads `config/config.yaml`, overlaid by a git-ignored
  `config/config.local.yaml`, with `${ENV_VAR}` references resolved from `.env`
  + real env vars. Real env vars win over `.env`.

For the full architecture and configuration reference, see `docs/`.