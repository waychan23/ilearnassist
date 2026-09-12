# ilearnassist

A self-hosted agent product for one person, with a chatbox-style UI. Sign in
under any username, give the agent a **workspace** (a sandboxed directory), pick
a **Copilot** (a reusable system prompt + tool allow-list, your own or one another
account published), choose a **provider/model**, and chat. The agent runs a ReAct
loop and can search the web and read/write files inside its workspace. Each account
has its own workspaces, conversations, Copilots and uploads, all inside a data
directory you choose.

Browser/Server architecture: a Node/TypeScript backend (Fastify + SQLite +
LangChain.js) and a Vue 3 frontend.

## Features

- **Accounts** — a username is the whole credential (no passwords yet), and each
  account owns its workspaces, conversations and uploads. Nothing one account
  creates is reachable from another.
- **Agent loop** — a manual ReAct loop (`model.bindTools` → stream → run tools →
  feed `ToolMessage` back), streaming responses token-by-token over SSE.
- **Workspaces** — sessions are scoped to a workspace, and all file tools are
  sandboxed to its `workdir/`. Each workspace lives under the account that owns it,
  inside the data directory you chose at launch.
- **Tools** — `list_files`, `read_file`, `write_file`, `create_directory`,
  `delete_file` (workspace-sandboxed) and `web_search` (Bing / DuckDuckGo /
  Tavily / SearXNG).
- **Copilots** — GPTs-style presets: a name, description, system prompt, generation
  defaults and a tool allow-list. The tools are explicit — either every tool is
  available, or exactly the ones ticked, which makes "no tools at all" a state you
  can actually choose. Owned by the account that made them and
  private by default; publish one and every account can use it, while only its
  owner can edit or delete it. A conversation **copies** the whole definition when
  it starts, so editing or deleting the Copilot later leaves that conversation
  exactly as it was — its persona is then the conversation's own, editable from the
  session settings.
- **Provider/model config** — any OpenAI-compatible endpoint (DeepSeek, OpenAI,
  Moonshot, Ollama, LM Studio, vLLM, …) configured via YAML, no code changes.
- **Streaming chat UI** — markdown rendering, syntax-highlighted code,
  collapsible tool-call cards, dark theme.

## Quick start

Prerequisites: Node.js ≥ 20 and pnpm ≥ 9 (repo uses corepack/lockfile on 12.x).

```bash
pnpm install

# Configure credentials and where your data goes
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY=… (or OPENAI_API_KEY=…)

pnpm dev
```

Open <http://localhost:5173>. The backend listens on `127.0.0.1:3720`.

It opens on a login screen: type any username and you are in, and that name becomes your
account with its own workspaces. **There are no passwords yet** — the screen says so, because
anyone who can reach the address can sign in as any name. Leave LAN sharing off unless you
mean it.

> **`ILA_DATA_DIR` is required and `.env.example` already sets it** to `./data`, relative to
> the project root. There is no default in the code on purpose: that directory holds the
> database, your workspaces and your uploads, so it is the thing to put somewhere that
> survives an uninstall of the app. Point it anywhere absolute if you would rather.
>
> The default config ships with DeepSeek as the default provider and Bing as the
> web-search provider (both keyless on the search side). Edit
> [`config/config.yaml`](config/config.yaml) to switch models/providers. See
> [docs/configuration.md](docs/configuration.md).

The desktop app asks for the data folder on first launch instead, and can be packaged as a
Mac `.dmg` — see [docs/desktop.md](docs/desktop.md).

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
apps/server/      Fastify backend — paths, SQLite, agent loop, tools, routes
apps/server/test/ unit + integration tests
apps/web/         Vue 3 frontend — Pinia store, chat UI, SSE client
apps/web/test/    unit tests
apps/desktop/     Electron control panel — starts the server, packaged as a .dmg
packages/shared/  dependency-free types shared across the API boundary
e2e/              Playwright specs + the e2e config overlay
config/           config.yaml (+ optional config.local.yaml override)
```

Your data is **not** in this tree: it lives in the directory `ILA_DATA_DIR` names. See
[docs/configuration.md](docs/configuration.md) for the layout.

## Documentation

- [Architecture](docs/architecture.md) — system overview, agent loop, sandboxing,
  data model, SSE protocol.
- [Configuration](docs/configuration.md) — full `config.yaml` reference and
  provider/search setup.
- [Reference (chatbox)](docs/reference.md) — the upstream project this app is
  modeled on, and where to find relevant code in the local clone.

## License

Private / self-hosted. Not for redistribution.