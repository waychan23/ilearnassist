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

## `config.patch.json` — the deployment's overlay

`config/config.yaml` belongs to the *install*: for a packed desktop build it lives inside the
application bundle and is replaced wholesale on every update. A deployment that needs to change a
value without forking the install writes `<dataRoot>/config.patch.json` instead — beside the
database and the workspaces, and surviving an update for the same reason they do.

```json
{
  "server": { "port": 3720 },
  "tools": { "webFetch": { "maxChars": 12000 } },
  "prompts": { "chat.system.persona": "You are a patient physics tutor. …" }
}
```

- **Read once per process**, so a change takes effect on the next restart.
- **Deep-merged over the YAML by key.** Arrays replace rather than concatenate, which is what makes
  "this list, not that one" expressible — a patched `providers` list is the whole list.
- **`${ENV_VAR}` is resolved inside a patch**, the same as in `config.yaml`.
- **The result goes through the ordinary validation.** A patch cannot smuggle in a broken install:
  a `defaultProvider` that names nothing is refused at boot, exactly as it would be from the YAML.
- **Malformed JSON throws, naming the file.** A patch that silently does nothing is the failure this
  mechanism exists to prevent.
- **The `prompts` key is read by the prompt catalog**, not by the config layer — see
  [prompts.md](prompts.md). It is one key among any others; the file is a general overlay, not a
  prompt feature with a config-shaped wrapper.

## Where the data lives

`ILA_DATA_DIR` names the data root — the sqlite database, every account's workspaces, and the
files they upload. **It is required, and the server refuses to start without it.**

| Variable | Effect |
| --- | --- |
| `ILA_DATA_DIR` | The data root. **Required.** No default, deliberately: that path decides how much of your work survives an uninstall, so the code will not guess one. |
| `ILA_CONFIG_PATH` | Replace the path of the *overlay* normally read from `config/config.local.yaml`. `config/config.yaml` is still the base. Exists for tests and the e2e run. |
| `ILA_LAUNCHED_BY_PANEL` | **Set by the control panel, never by hand.** Not a secret and it grants nothing: it only decides whether a refusal to start without an administrator names the panel's button or the CLI command. Anyone who can set it can already read the database. See `docs/desktop.md`. |

```
<dataRoot>/
  db/sqlite/ilearnassist.sqlite
  users/<name>/workspaces/<name>/     workdir/ is the agent's sandbox; sessions/ is reserved
  users/<name>/sources/               reserved for uploaded files
  users/<name>/sources/raw|parsed/    every file that account uploaded
```

Put it somewhere outside the checkout and outside the application bundle, and somewhere you
back up. **`config/` and `.env` are not inside it** — they live under the project root (the
desktop app's `userData` directory when packed), so "move my data to a new machine" means
copying both.

A *relative* value resolves against the project root, not the working directory: `pnpm dev`
runs the server with its cwd set to `apps/server`, so "relative to cwd" would mean something
different from one launcher to the next. The desktop app asks for a folder on first launch and
passes an absolute path down — see [desktop.md](desktop.md).

Both variables are read once, when the config module is first imported — set them before the
server starts, not at runtime. `.env` counts: `loadDotEnv()` runs at module scope, before
anything reads the environment, so a checkout can put `ILA_DATA_DIR` there.

Note that `${…}` placeholders are substituted *after* YAML parsing, so a numeric
field written as `port: ${PORT}` arrives as a string — numeric fields accept a
numeric string for exactly this reason.

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

**`ila_diagram` goes with them.** It writes outside the workspace — a diagram's
source lands in the conversation's own `sessions/<sessionId>/` folder — but a
diagram whose file was never written is half the feature, so the switch that means
"this agent does not write files" is what turns diagrams off too. That is a
deliberate entry in the tool assembly rather than an oversight: see the
`NON_FILE_TOOLS` note in `apps/server/src/tools/index.ts`.

**`ila_table` does not, and the difference is the line this switch is drawn on.**
The question is not "does this tool touch the workspace" but "does this agent write
files", and a table writes a database row and nothing else — its display is the
reply's own Markdown. So it stays, like `ila_query` and `ila_explore`, both of which
read without writing. Turning the file tools off removes diagrams and not tables;
`docs/tables.md` has the rest.

## The upload limit

The largest file an account may upload is an installation-wide setting an administrator owns, not
a constant. It lives in `app_settings` under `upload.maxFileBytes` and is edited from the console's
**上传设置** section; `PUT /api/upload-settings` writes it, `GET /api/config` carries it back as
`PublicConfig.maxUploadBytes`, and the client refuses past it *before* a request is made — which is
the point of making it a setting, since a raised limit that is still refused by the browser at the
old constant is worse than no setting at all.

Nothing in `config.yaml` seeds it, deliberately: the default is `MAX_ATTACHMENT_BYTES` (10 MB),
which both sides already share, so an installation that has never been touched behaves exactly as
it did before the setting existed. The range is `MIN_UPLOAD_LIMIT_BYTES`–`MAX_UPLOAD_CEILING_BYTES`
(1–100 MB), refused rather than clamped at either end.

**The ceiling is a consequence of how routes are built, and it is worth knowing.** Fastify's
`bodyLimit` is a number fixed when a route is registered, so the value in force cannot be what the
route reads. The route therefore carries the *ceiling* and the handler compares against the setting
— the two agree for everything an administrator can save, and a body past the ceiling is refused by
Fastify before the handler runs, which is the one refusal on this path that does not carry
`FILE_TOO_LARGE`. The same route/`limitMb` pairing is why both upload routes now name the limit
they applied: the workspace-upload route used to omit it, which was harmless while the number was
a constant and is not now.

`MAX_FILE_PREVIEW_BYTES` (32 MB) is untouched and unrelated: what may be *uploaded* and what may
be *previewed* are different questions, and the second is a memory bound on the tab.

## Copilots

A Copilot is a reusable persona: a system prompt, a tool allow-list and default
generation parameters. One is chosen when a conversation is created — the
new-conversation dialog lists every published Copilot and then the account's own —
and Copilots themselves are managed in the UI (the **助理** dialog, opened by the
助理 row at the foot of either sidebar) or via `POST /api/copilots`. They are **owned by the account that created them**
(`copilots.user_id`) and carry:

- `name`, `description` — shown in the picker and the manager list.
- `systemPrompt` — becomes the conversation's system message; empty falls back to
  the built-in general-assistant prompt.
- `allTools` — whether every tool is available. **Authoritative over `tools`**, and `true`
  unless the request says otherwise, which is what an untouched Copilot has always meant.
- `tools` — the tool names allowed, meaningful only when `allTools` is false — and then
  exhaustive, so an empty list means **no tools at all**. This is the state the flag was added
  for: an empty list used to mean *every* tool, which made a Copilot with no tools selected
  silently the most permissive kind, and left "deny everything" unexpressible. `POST` clears
  `tools` whenever it stores `allTools: true`, so a stored Copilot cannot disagree with itself.
- `settings` — default generation parameters (`providerId`, `modelId`,
  `temperature`, `topP`, `maxTokens`, `maxContextMessages`, `maxSteps`).
- `visibility` — `private` (the default) or `public`. Both `POST /api/copilots` and
  `PUT /api/copilots/:id` accept it, and anything other than `"public"` means
  private, because publishing puts a persona in front of every account and is
  something the owner opts into rather than a default they discover later.

**There is no separate "platform" tier.** A Copilot the operator wants every account
to have is simply one they published — no admin role, no separate storage. A public
Copilot is visible and usable by every account, while editing and deleting stay
**owner-only**; a public Copilot someone else wrote can be copied into an editable
private one of your own. The read a route takes is the whole policy: `GET /api/copilots`
answers with this account's own Copilots plus every public one, a Copilot is *usable*
if it is either, and another account's private Copilot answers **404 rather than 403**,
so an id cannot be probed.

All of `name`, `systemPrompt`, `allTools`, `tools` and `settings` are **copied into** a new
conversation, not referenced: editing or deleting a Copilot does not change the
conversations already underway. `sessions.copilot_id` stays only as a link for the
UI — nullable and allowed to dangle (`ON DELETE SET NULL`) — while the badge reads
the copied `copilot_name`, which is what survives the Copilot being deleted.
Changing a conversation's behaviour afterwards is an edit of that conversation:
`PATCH /api/sessions/:id` with `systemPrompt` (and `allTools`/`tools`). There is deliberately
no mid-conversation Copilot switch, because the persona is a copy — re-pointing the link
would move the label and leave the behaviour behind.

**Opening a data root written by an earlier build** runs one migration on that boot: the
Copilot rows written before they had an owner are deleted, because they have no owner and
no way to infer one — they are dropped rather than guessed at. No conversation is removed
(`sessions.copilot_id` goes NULL), but two things change. A conversation keeps its copied
generation `settings` and loses its Copilot's persona, falling back to the built-in system
prompt. And a conversation that was running under a **tool-restricted** Copilot becomes
unrestricted, because it has no snapshot and `all_tools` defaults to 1. That widening is real,
which is why it is stated here.

Tool names — one list, `ALL_TOOL_NAMES` in `packages/shared`, because the client writes the
allow-list and the server reads it, so a name the two disagree about is either a tool that
cannot be selected or a selection that matches nothing:
`web_search`, `web_fetch`, `list_files`, `read_file`, `write_file`, `create_directory`,
`delete_file`, `read_document`, `ask_user`.

## Conversation titles

A new conversation is called **（未命名）会话** / **(Untitled) Session** until a model can name it
from what is actually in it. The generated title is capped at 6 words / 20 characters (60
characters hard limit, beyond which it is truncated) and is asked to match the language of the
conversation.

That placeholder is written by the **client**, from `session.fallbackTitle`, so it is in the
language the account is reading. The server's `DEFAULT_SESSION_TITLE` is the same string in
English and is only what a caller that names nothing gets — the CLI, a script, another client.
It stays `titleSource: "auto"`, which is what makes it a placeholder rather than a name.

**The titler runs after every turn until it produces a title, not only after the first.** A
conversation that opens with `你好` has nothing to be named after, so it may answer `NO_TITLE`
rather than inventing one — and then the conversation keeps its placeholder and the **next** turn
asks again. That is the whole mechanism: asking is the only way to find out, and the first asking
can only be answered "not yet". What it reads is the conversation as it now stands, not the first
exchange: the opening question and the most recent messages, capped
(`conversationExcerpt` in `agent/title.ts`).

Pinned in `sessions.title_state`, which says *how the pass fared* — a different question from
`title_source`, which says who owns the title:

| `title_state` | after a turn | on leaving | meaning |
| --- | --- | --- | --- |
| absent | asks | asks | never asked — no reply with text in it yet |
| `"unnamed"` | asks | — | asked, and there was nothing to name yet |
| `"fallback"` | asks | asks | the call failed |
| `"model"` | — | — | named; nothing left to do |

So a title can be written on any turn, and a conversation is never given one that says nothing
about it. A turn the reader stopped before it produced text, and a turn that only called tools,
leave no prose — so there is nothing to name from and the state simply does not move.

**Leaving a conversation tries once more.** The client debounces three seconds and reports
`POST /api/sessions/:id/leave`, which runs the titler again over the same excerpt. What it adds is
the chance a turn cannot give: a conversation whose titling call *failed* — no key, a rate limit, a
reasoning model that spent its whole budget thinking — is showing the user's own clipped words, and
this retries it. A conversation whose state is `"unnamed"` is deliberately **not** retried: that
state means the turn that just ended asked about *this* conversation, and nothing has happened
since, so the answer would be the same and the call would be paid for twice.

It is deliberately undramatic: nothing waits on it, nothing is said when it fails, and the next
departure tries again. A conversation the model already named is not reported at all.

Closing the tab is **not** one of the triggers. It would need a `keepalive` request of its own,
since the bearer token cannot ride a `sendBeacon`, and the case is already covered from the other
side: the retry is idempotent and cheap, so the next time the reader leaves that conversation —
from any device — it is tried again.

**Two conversations in one workspace never share a title.** Creation, a rename and the
auto-titler all pass through `uniqueSessionTitle` (`apps/server/src/sessionTitles.ts`), which
numbers a collision the way a file manager does — `学习计划`, `学习计划 (2)`, `学习计划 (3)` —
taking the lowest free number and continuing from one a name already carries. It is applied on
the server because that is the only place all three paths meet. A rename is therefore
*suffixed rather than refused*: an empty title is the one this rejects, because there is no name
to number.

Editing the title yourself — double-click it in the sidebar, or click the pencil in the chat
header — marks the conversation as user-titled, and **the auto-titler never touches it
again**. The chat header shows a small `AI` badge while a title is still machine-written. The
same dialog the composer's sliders button opens also carries the title and a free-text
**description**, which is display-only — it reaches no prompt.

The titler gets a 512-token output budget on purpose. Reasoning models
(`deepseek-v4-pro`, `deepseek-reasoner`, o-series) spend that budget on chain-of-thought
*before* emitting any content, so a tight cap yields `finish_reason: "length"` with an
empty answer and no title at all.

**A call that fails is not a decline.** When the titler cannot run — no key, rate limit, a model
that returns nothing at all — the conversation is named from the user's own first message instead,
collapsed to one line and trimmed to ~40 characters, and recorded as `"fallback"` so the next turn
asks again. The distinction matters in both directions: an empty answer means nothing was learned
about whether the conversation has substance, while `NO_TITLE` is the model *having looked and
said no*. A failed turn therefore leaves a usable name where a decline deliberately leaves the
placeholder. Neither can fail the chat turn.

## Conversation parameters

Each conversation has its own `settings`, editable from the 🎛 button in the
composer. Resolution is most-specific-first, and a blank value means "inherit":

```text
per-request override  ⊳  session settings  ⊳  app default
```

The Copilot tier that used to sit between the session and the app default is gone:
a Copilot's defaults were merged into `session.settings` when the conversation was
created, so a turn resolves against the session alone and nothing reads a Copilot at
turn time. The same dialog holds the conversation's own `systemPrompt` (and
`tools`), which is where a conversation's persona is changed.

`maxContextMessages` caps how many prior messages are replayed into the model
context (blank = the whole history); `maxSteps` caps how many model → tool rounds
a single turn may take (default 15). `temperature`, `topP` and `maxTokens` are
passed to the provider only when set, so unset values keep ChatOpenAI's own
defaults.

## Uploaded files

Files and images can be attached in the composer (paperclip, or paste a screenshot). Bytes
are stored under `<dataRoot>/users/<name>/sources/raw/` — outside the workspace, so they
never appear in the agent's `list_files`. Each file is capped at 10 MB, and only a known set
of MIME types is accepted (images, text-like files, PDF and the Office/OpenDocument formats).
Images are sent to the model as real multimodal content when the selected model is marked
`vision`; text-like files are inlined; documents are parsed (see below).

**A file belongs to your account, not to the conversation you attached it in.** Uploading
the same bytes twice stores one copy — the second upload is instant and does not re-parse —
and a file uploaded in one conversation is readable from any other conversation in the same
workspace (through `read_document`, not the file tools: it is outside every workspace sandbox
by design).

That has a consequence for deleting, and it is worth knowing before you tidy up: **deleting a
conversation does not delete its files.** It removes the references and leaves the bytes where
they are, because another conversation may be reading them. Deleting a file is its own action, from the **Uploaded files** list on the home
page — and it removes the bytes everywhere at once, while the messages that were sent with it
keep showing what they were sent with.

## Document parsing

PDF, Word, Excel, PowerPoint and OpenDocument attachments are converted to text
before they reach the model. **Local extraction works out of the box and needs no
configuration** — it is the only tier that runs with the machine offline. Cloud
parsers are optional and matter for scanned pages, complex layouts and formulas.

```yaml
documentParsers: []
  # - id: docling
  #   name: Docling (local)
  #   kind: sync
  #   baseURL: http://127.0.0.1:5001/v1/convert/file
  # - id: mineru
  #   name: MinerU
  #   kind: mineru
  #   baseURL: https://mineru.net/api/v4
  #   apiKey: ${MINERU_API_KEY}

documentParsing:
  localEnabled: true
  policy: local-first      # local-only | local-first | cloud-first | cloud-only
  fallbackEnabled: true
  # defaultParserId: mineru
```

### `kind` — the wire protocol

`kind` selects how the server talks to a service. The endpoint and credential come
from the record, so one `kind` covers several products and you can keep several
records of the same kind (hosted and self-hosted, for example).

| `kind` | Protocol | Works with |
| --- | --- | --- |
| `sync` | POST the file, get text/Markdown back. **No key needed.** | `docling-serve` (the easiest self-hosted option — a Docker container, CPU is fine), Marker, a self-hosted MinerU |
| `mineru` | Presigned upload → poll → download a ZIP containing Markdown | MinerU's v4 API, hosted or self-hosted. `baseURL` includes the version: `https://mineru.net/api/v4` |
| `llamaparse` | Multipart upload → poll → Markdown in the poll response | LlamaParse. Reducto is the same shape |

New entries can also be added in **设置 → 文档解析**, which is the source of truth
after the first boot. Each row has a **测试连接** button that round-trips a
throwaway document, so a typo in `baseURL` is caught there rather than at the first
upload. API keys are write-only: the server never returns one, and leaving the field
blank on save keeps the stored value.

### `documentParsing` — the policy

| Policy | Behaviour |
| --- | --- |
| `local-only` | Never call out. Fully offline. |
| `local-first` | Local, then cloud if local cannot read the file. The default. |
| `cloud-first` | Cloud, then local if the cloud fails. |
| `cloud-only` | Always call out. |

`fallbackEnabled: false` removes the second step from the two hybrid policies, so a
failure is reported instead of being retried on the other side — useful when you want
strict control over what leaves the machine.

With `localEnabled: false` the local tier is skipped entirely; only sensible alongside
a cloud parser, since nothing else can read a PDF.

**Scanned PDFs.** Local extraction reads the text layer only. A scan has none, which is
reported as "未检测到文本层，可能是扫描件" — and under `local-first` that is exactly
the case the cloud tier exists for. It is deliberately *not* reported as an empty
document, because a model told a file was read when it was not will answer anyway.

### Operational limits (`tools.documents`)

| Key | Default | Meaning |
| --- | --- | --- |
| `localMaxBytes` | 20 MB | Above this, local extraction is skipped and the file is offered to a cloud parser (whose ceilings are far higher) |
| `maxTextChars` | 2,000,000 | Ceiling on stored extracted text |
| `concurrency` | 2 | How many documents parse at once |
| `requestTimeoutMs` | 30 s | Per-HTTP-request budget for a cloud parser |
| `jobTimeoutMs` | 300 s | Total budget for one async cloud job, polling included |
| `pollIntervalMs` | 3 s | How often an async job is polled |

Extraction runs in the background: the upload returns immediately and the composer
shows progress on the attachment chip, blocking **send** until every attachment has
settled. Sending earlier would produce a turn in which the model never saw the
document.