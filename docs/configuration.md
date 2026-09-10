# Configuration

`config/config.yaml` holds two kinds of setting, and they behave differently.
A git-ignored `config/config.local.yaml` may override any key, and secrets may be
referenced as `${ENV_VAR}` (resolved from `.env` + the real environment; real env
vars win).

| Kind | Keys | Where it is edited | Apply |
| --- | --- | --- | --- |
| **Bootstrap** | `server`, `workspaces`, `tools` | `config.yaml` | restart the backend |
| **Seed** | `providers`, `defaultProvider`, `defaultModel` | Settings → Providers in the UI | immediate |

Providers and models are copied into SQLite on first boot. After that the UI is
the source of truth: editing the YAML later does **not** overwrite what the UI
saved, and a provider deleted in the UI stays deleted. To re-seed from the YAML,
delete all providers in the UI and restart. The YAML stays useful as the only way
to supply a key through `${ENV_VAR}` rather than typing it into the browser.

## Top-level keys

```yaml
server:
  host: 127.0.0.1        # bind address
  port: 3720             # backend port (Vite proxies /api here)

workspaces:
  rootDir: ./workspaces  # global dir; each workspace becomes a sub-directory

defaultProvider: deepseek   # seed value; change it in the UI afterwards
defaultModel: deepseek-chat # seed value; change it in the UI afterwards

providers: [ … ]            # OpenAI-compatible endpoints (seed data, see below)

tools:
  webSearch: { … }
  webFetch: { … }
  fileTools:
    enabled: true
```

## Providers

Each `providers[]` entry is an OpenAI-compatible endpoint. On first boot these
become rows in the `providers`/`models` tables; the entry's `id` is kept as the
provider's record id, so a `defaultProvider` referring to it stays valid.

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
`hasApiKey: boolean` per provider. The same holds for the provider CRUD
endpoints: a `PUT` with no `apiKey` field leaves the stored key untouched, which
is how the UI can save edits to a provider whose key it is not allowed to read.
An empty string clears the key.

Models added in the UI carry a display name, an optional context window and max
output (used by the context-usage indicator), and capability flags:

| Capability | Effect |
| --- | --- |
| `vision` | attachments sent as real `image_url` content blocks; without it images degrade to a text placeholder |
| `reasoning` | UI badge only |
| `tool_use` | UI badge only |

Chain-of-thought is shown whenever the provider sends it, regardless of these flags —
`reasoning_content` (DeepSeek and most OpenAI-compatible gateways), `reasoning`
(OpenRouter), or a `reasoning`/`thinking` content block.

Models seeded from YAML get a best-effort guess from the model id
(`guessCapabilities`); correct it in Settings → Providers if it is wrong.

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

## Web fetch

```yaml
tools:
  webFetch:
    enabled: true     # default on
    maxChars: 20000   # cap on extracted text handed to the model
```

Lets the agent read the contents of a specific URL (typically a `web_search`
result). Requests to loopback, private, link-local, CGNAT and reserved addresses
are refused, and every redirect hop is re-validated — see the SSRF guard notes in
`docs/architecture.md`. If the address is correct and it still fails, the guard
message says exactly which check rejected it.

## File tools

```yaml
tools:
  fileTools:
    enabled: true
```

File tools are always sandboxed to the active workspace directory and cannot
escape it (see `resolveInWorkspace` in `apps/server/src/workspace.ts`). Turning
this off removes all file tools; `web_search` and `web_fetch` remain available,
since neither touches the workspace.

## Copilots

Copilots are managed in the UI (the **Copilots** button in the sidebar footer) or
via `POST /api/copilots`. They carry:

- `name`, `description` — shown in the picker and the manager list.
- `systemPrompt` — prepended to every turn as the system message; empty falls
  back to the built-in general-assistant prompt.
- `tools` — an allow-list of tool names; empty = all available tools.
- `settings` — default generation parameters (`providerId`, `modelId`,
  `temperature`, `topP`, `maxTokens`, `maxContextMessages`, `maxSteps`). These are
  **copied into** a new conversation, not referenced: editing a Copilot does not
  change conversations already underway.

Tool names: `web_search`, `web_fetch`, `list_files`, `read_file`, `write_file`,
`create_directory`, `delete_file`.

## Conversation titles

A new conversation is called **New conversation** until its first reply arrives, at which
point a model writes a short title from that first exchange and the sidebar updates. The
generated title is capped at 6 words / 20 characters (60 characters hard limit, beyond
which it is truncated) and is asked to match the language of the conversation.

Editing the title yourself — double-click it in the sidebar, or click it in the chat
header — marks the conversation as user-titled, and **the auto-titler never touches it
again**. The chat header shows a small `AI` badge while a title is still machine-written.

The titler gets a 512-token output budget on purpose. Reasoning models
(`deepseek-v4-pro`, `deepseek-reasoner`, o-series) spend that budget on chain-of-thought
*before* emitting any content, so a tight cap yields `finish_reason: "length"` with an
empty answer and no title at all.

If the titler still fails — no key, rate limit, a model that returns nothing — the
conversation is named from the user's own first message instead, collapsed to one line and
trimmed to ~40 characters. A first turn therefore always ends with a usable name; it can
never leave the placeholder, and it can never fail the chat turn.

## Conversation parameters

Each conversation has its own `settings`, editable from the 🎛 button in the chat
header. Resolution is most-specific-first, and a blank value means "inherit":

```text
per-request override  ⊳  session settings  ⊳  Copilot defaults  ⊳  app default
```

`maxContextMessages` caps how many prior messages are replayed into the model
context (blank = the whole history); `maxSteps` caps how many model → tool rounds
a single turn may take (default 15). `temperature`, `topP` and `maxTokens` are
passed to the provider only when set, so unset values keep ChatOpenAI's own
defaults.

## Attachments

Files and images can be attached in the composer (paperclip, or paste a
screenshot). Bytes are stored under `data/uploads/<sessionId>/` — outside the
workspace, so they never appear in the agent's `list_files`. Each file is capped
at 10 MB, and only a known set of MIME types is accepted (images, text-like files
and PDF). Images are sent to the model as real multimodal content when the
selected model is marked `vision`; text-like files are inlined; binaries are
named but not parsed. Deleting a conversation deletes its uploads.