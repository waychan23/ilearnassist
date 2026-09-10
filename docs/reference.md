# Reference project: chatbox

guided-learning is modeled on [chatbox](https://github.com/chatboxai/chatbox), a
popular desktop chat client for LLMs. A clone of the upstream repo is kept
locally for reference during development.

- **Upstream:** <https://github.com/chatboxai/chatbox> (chatboxai/chatbox)
- **Local clone:** `/Users/waychan23/Documents/work/spaces/trae/chatbox`

chatbox is Electron + React (a monorepo: `src/` + `packages/`); guided-learning
is Fastify + Vue 3 + SQLite (our own `apps/` + `packages/shared`). Treat the
clone as a behavioral/UX reference — port ideas, don't lift code verbatim.

## Where to look

| Concern                     | chatbox path                                   | notes                                        |
| --------------------------- | ---------------------------------------------- | -------------------------------------------- |
| Chat UI / settings          | `src/renderer/`                                | React renderer; settings + agent/copilot UIs |
| Reusable components         | `packages/chatbox-react/`                      | shared React component library               |
| Model / provider adapters   | `packages/chatbox-core/src/models/`            | provider schemas, OpenAI-compatible wiring   |
| Agent / tool (ReAct) loop   | `packages/chatbox-core/src/generation/`        | stream-chunk processing, tool fallback       |
| **Web search**              | `src/renderer/packages/web-search/`            | `bing.ts`, `duckduckgo.ts`, `bing-news.ts`   |
| Native search shim          | `src/shared/services/native-web-search.ts`     | Bing-backed helper                           |
| Feature specs               | `features/*.feature`                           | e.g. `chat-streaming.feature`                |

## Key findings (verified from the clone)

- **Web search is keyless client-side scraping.** chatbox has no search API key
  and no chatbox-hosted search server. `bing.ts` scrapes
  `https://www.bing.com/search`, `duckduckgo.ts` scrapes
  `https://html.duckduckgo.com/html/`, and `bing-news.ts` hits Bing's news
  infinite-scroll endpoint — all from the Electron renderer.

  → guided-learning adopts the *same keyless scheme* but **server-side** in
  [`apps/server/src/tools/webSearch.ts`](../apps/server/src/tools/webSearch.ts)
  (default `bing`, plus `duckduckgo`/`tavily`/`searxng`). Moving it server-side
  keeps it provider-agnostic and independent of the client's network/CORS, which
  was the explicit requirement ("采用同样的方案，同时支持配置").

- **Copilot ≈ chatbox "agents".** chatbox groups a system prompt, model choice,
  and enabled capabilities into agent presets. guided-learning's `copilots`
  table (`name` / `description` / `systemPrompt` / `model` / `tools`) is the
  equivalent, surfaced in the sidebar.