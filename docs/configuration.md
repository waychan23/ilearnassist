# Configuration

All runtime configuration lives in `config/config.yaml`. A git-ignored
`config/config.local.yaml` may override any key, and secrets may be referenced
as `${ENV_VAR}` (resolved from `.env` + the real environment; real env vars win).

After changing configuration, **restart the backend**.

## Top-level keys

```yaml
server:
  host: 127.0.0.1        # bind address
  port: 3720             # backend port (Vite proxies /api here)

workspaces:
  rootDir: ./workspaces  # global dir; each workspace becomes a sub-directory

defaultProvider: deepseek   # provider used when a turn has no override
defaultModel: deepseek-chat # model used when a turn has no override

providers: [ … ]            # OpenAI-compatible endpoints (see below)

tools:
  webSearch: { … }
  fileTools:
    enabled: true
```

## Providers

Each `providers[]` entry is an OpenAI-compatible endpoint:

```yaml
- id: myprovider
  name: "Display Name"
  baseURL: https://api.example.com/v1
  apiKey: ${MY_API_KEY}     # or a literal string
  models:
    - { id: model-a, name: "Model A" }
    - { id: model-b, name: "Model B" }
```

`baseURL` + `apiKey` are the only two things LangChain's `ChatOpenAI` needs, so
this covers OpenAI, DeepSeek, Moonshot/Kimi, Groq, OpenRouter, SiliconFlow,
together.ai, and any self-hosted server.

Self-hosted / keyless example (Ollama / LM Studio / vLLM):

```yaml
- id: local
  name: Local (Ollama)
  baseURL: http://localhost:11434/v1
  apiKey: "not-required"
  models:
    - { id: llama3.1, name: "Llama 3.1" }
```

API keys are never sent to the browser; `/api/config` exposes only
`hasApiKey: boolean` per provider.

## Environment variables (`.env`)

```bash
DEEPSEEK_API_KEY=…   # used by ${DEEPSEEK_API_KEY} in config.yaml
OPENAI_API_KEY=…
TAVILY_API_KEY=…     # only if webSearch.provider = tavily
```

Copy `.env.example` to `.env` to get started.

## Web search

```yaml
tools:
  webSearch:
    provider: bing          # bing | tavily | duckduckgo | searxng
    maxResults: 5
    # tavilyApiKey: ${TAVILY_API_KEY}
    # searxngBaseURL: http://localhost:8080
    # bingEndpoint: https://www.bing.com/search
```

| Provider   | Key required | Notes                                            |
| ---------- | ------------ | ------------------------------------------------ |
| `bing`     | no           | keyless server-side scraping of Bing results (default) |
| `duckduckgo` | no          | keyless DuckDuckGo HTML endpoint                  |
| `tavily`   | yes          | Tavily Search API — higher-quality, needs a key   |
| `searxng`  | no           | self-hosted SearXNG instance (`searxngBaseURL`)   |

Search runs server-side (not from the browser), so it works regardless of the
client's network, and stays provider-agnostic so you can switch without code
changes.

## File tools

```yaml
tools:
  fileTools:
    enabled: true
```

File tools are always sandboxed to the active workspace directory and cannot
escape it (see `resolveInWorkspace` in `apps/server/src/workspace.ts`). Turning
this off removes all file tools; `web_search` remains available.

## Copilots

Copilots are created through the UI (or `POST /api/copilots`). They carry:

- `name`, `description` — shown in the sidebar.
- `systemPrompt` — the system prompt prepended to every turn.
- `model` — optional override of `defaultModel` (empty = use default).
- `tools` — an allow-list of tool names; empty = all available tools.

Tool names: `web_search`, `list_files`, `read_file`, `write_file`,
`create_directory`, `delete_file`.