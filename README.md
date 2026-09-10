# guided-learning

A self-hosted, single-user agent product with a chatbox-style UI. Give the
agent a **workspace** (a sandboxed directory), pick a **Copilot** (a preset
system prompt + allowed tools), choose a **provider/model**, and chat. The agent
runs a ReAct loop and can search the web and read/write files inside its
workspace.

Browser/Server architecture: a Node/TypeScript backend (Fastify + SQLite +
LangChain.js) and a Vue 3 frontend.

## Features

- **Agent loop** — a manual ReAct loop (`model.bindTools` → stream → run tools →
  feed `ToolMessage` back), streaming responses token-by-token over SSE.
- **Workspaces** — sessions are scoped to a workspace; all file tools are
  sandboxed to that workspace directory. Creating a workspace auto-creates its
  sub-directory under a global `workspaces/` root.
- **Tools** — `list_files`, `read_file`, `write_file`, `create_directory`,
  `delete_file` (workspace-sandboxed) and `web_search` (Bing / DuckDuckGo /
  Tavily / SearXNG).
- **Copilots** — GPTs-style presets: a name, description, system prompt, an
  optional model override, and an allow-list of tools. Select one to shape the
  conversation.
- **Provider/model config** — any OpenAI-compatible endpoint (DeepSeek, OpenAI,
  Moonshot, Ollama, LM Studio, vLLM, …) configured via YAML, no code changes.
- **Streaming chat UI** — markdown rendering, syntax-highlighted code,
  collapsible tool-call cards, dark theme.

## Quick start

Prerequisites: Node.js ≥ 20 and pnpm ≥ 9 (repo uses corepack/lockfile on 12.x).

```bash
pnpm install

# Configure credentials
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY=… (or OPENAI_API_KEY=…)

pnpm dev
```

Open <http://localhost:5173>. The backend listens on `127.0.0.1:3720`.

> The default config ships with DeepSeek as the default provider and Bing as the
> web-search provider (both keyless on the search side). Edit
> [`config/config.yaml`](config/config.yaml) to switch models/providers. See
> [docs/configuration.md](docs/configuration.md).

## Tests

The suite is offline — no API keys and no network. The agent is driven against a
local fake OpenAI-compatible server, and the browser end-to-end run starts the
real backend on a throwaway database.

```bash
pnpm test          # unit + integration (vitest, server + web)
pnpm test:coverage # the same, with a coverage report
pnpm exec playwright install chromium   # once
pnpm test:e2e      # browser end-to-end (playwright)
```

New behaviour is expected to arrive with tests; see the Testing section of
[CLAUDE.md](CLAUDE.md), which also explains how to test agent behaviour without
calling a real model.

## Project structure

```
apps/server/      Fastify backend — config, SQLite, agent loop, tools, routes
apps/server/test/ unit + integration tests
apps/web/         Vue 3 frontend — Pinia store, chat UI, SSE client
apps/web/test/    unit tests
packages/shared/  dependency-free types shared across the API boundary
e2e/              Playwright specs + the e2e config overlay
config/           config.yaml (+ optional config.local.yaml override)
```

## Documentation

- [Architecture](docs/architecture.md) — system overview, agent loop, sandboxing,
  data model, SSE protocol.
- [Configuration](docs/configuration.md) — full `config.yaml` reference and
  provider/search setup.
- [Reference (chatbox)](docs/reference.md) — the upstream project this app is
  modeled on, and where to find relevant code in the local clone.

## License

Private / self-hosted. Not for redistribution.