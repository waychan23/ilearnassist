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
                                              │  ├─ tools/ (files+web+doc)   │
                                              │  ├─ attachments.ts (uploads) │
                                              │  ├─ documents/ (parsing)     │
                                              │  ├─ workspace.ts (sandbox)   │
                                              │  └─ db.ts (SQLite)           │
                                              └──────────────┬───────────────┘
                                                             │
                                          ┌────────────────────────────────────┐
                                          │  <dataRoot>/ (chosen at launch)     │
                                          │    db/sqlite/ilearnassist.sqlite    │
                                          │    users/<slug>/workspaces/<slug>/  │
                                          │    users/<slug>/sources/ (reserved) │
                                          │    uploads/<sess>/                  │
                                          └────────────────────────────────────┘
```

`<dataRoot>` is **required** and has no default: it is the `ILA_DATA_DIR` the launcher
supplies, and the server refuses to start without it. See "Config" below for why.

The frontend is a thin client: all state lives in a single Pinia store
(`apps/web/src/stores/app.ts`). It talks to the backend over JSON for CRUD and
over **Server-Sent Events** for chat streaming.

## Components

### Config (`config.ts`)

`loadConfig()` reads `config/config.yaml`, overlays `config/config.local.yaml`
(git-ignored), then resolves every `${ENV_VAR}` reference against `.env` +
real environment variables (real env wins). Missing env vars resolve to `""`.
The result is a typed `AppConfig` with providers, models and tool settings. A
separate `publicConfig()` strips `apiKey` before sending it to the client.

**Where the data lives is not in the config file.** `ILA_DATA_DIR` names the data root —
the database, every account's workspaces, their uploads — and `resolveDataRoot()` throws
without it. There is deliberately no default: that path decides how much of the user's work
survives an uninstall, so it is not the code's to choose. It is an environment variable
rather than a YAML key for the same reason `ILA_HOST` is — the launcher sets it per launch,
and a value in a config file cannot differ between two runs of the same install, which is
exactly what the desktop app's folder picker has to do. `.env` counts as the environment:
`loadDotEnv()` runs at module scope (not inside `loadConfig()`, where it used to live) so
that a checkout can supply the value in `.env` without the code carrying a fallback. A
relative value resolves against the *project root*, not the working directory — `pnpm dev`
runs the server with cwd set to `apps/server`, so "relative to cwd" would mean something
different from one launcher to the next.

The config file therefore holds no `data:` or `workspaces:` key. Where a workspace lives is
derived from the chosen root, the account and the workspace slug, all in
`apps/server/src/paths.ts`.

**`config.yaml` is bootstrap + seed data, not live config.** Providers, models and
document parsers are seeded into SQLite on first boot (`seedFromConfig`,
`seedDocumentParsersFromConfig`); after that the settings UI is the source of truth
and the YAML is never re-applied (so editing it cannot clobber what was saved in the
UI, and deleting an entry in the UI sticks). `config.yaml` remains the only way to
supply a key via `${ENV_VAR}` instead of typing it into the browser.
Server/workspaces/tools settings are still read from YAML on every boot.

Parsers are seeded behind an explicit **`documentParsing.seeded` marker** rather than
the "table is empty" signal providers use — running with zero cloud parsers is a
legitimate configuration (local-only), so an empty table must not be read as "never
seeded", or every boot would resurrect entries the user deliberately deleted.

### Database (`db.ts`)

`better-sqlite3` with `journal_mode=WAL` and `foreign_keys=ON`. Tables in
snake_case, mapped to camelCase objects in code:

- `users` — id, username (unique, `COLLATE NOCASE`), slug (unique), created_at
- `workspaces` — id, user_id (FK, CASCADE), name, slug, dir_path, created_at;
  `UNIQUE (user_id, slug)` — the slug is only unique among one account's workspaces
- `copilots` — …, system_prompt, tools (JSON), settings (JSON), timestamps
- `sessions` — id, workspace_id, copilot_id, title, title_source, settings (JSON), timestamps
- `messages` — id, session_id, role, content, reasoning, tool_calls (JSON),
  attachments (JSON), usage (JSON), created_at
- `providers` — id, name, base_url, api_key, sort_order, timestamps
- `models` — id, provider_id (FK, CASCADE), model_id, name, context_window,
  max_output, capabilities (JSON), sort_order
- `document_parsers` — id, name, kind, base_url, api_key, enabled, sort_order, timestamps
- `app_settings` — key/value (`defaultProvider`, `defaultModel`, and the
  `documentParsing.*` policy keys)

**Ownership is scoped in the query, not checked afterwards.** Every user-owned read is
named `...ForUser`, takes the owner, and puts it in the `WHERE` — so another account's id is
simply not found, and a route turns that into a 404 like any other missing row. `sessions`
and `messages` carry no `user_id`: they reach their owner through `workspaces` by join,
because a second copy of the owner is a second thing that has to stay in agreement. The few
accessors that do take a bare session id are documented as such in `AppDb` — every caller
reaches them after a scoped read has already resolved the session.

There is no account yet beyond a username: the server runs as one well-known account
(`ensureBootstrapUser` in `server.ts`) and the login screen comes next.

Schema changes follow one of two rules, and they are for different things:

- **Adding** a column goes through `ensureColumn()` (`PRAGMA table_info` +
  `ALTER TABLE ADD COLUMN`), because `CREATE TABLE IF NOT EXISTS` silently skips tables that
  already exist — an existing database would otherwise never gain it.
- **Changing what an existing column means** bumps `SCHEMA_VERSION` in `schema.ts`, which
  refuses the file outright with a message naming both versions. No missing column can
  signal that kind of change, and without a version the file is simply opened and read wrong
  — `dir_path` resolving somewhere else, ids referring to a different kind of thing — with
  no error to explain it. The guard reads `PRAGMA user_version`, which lives in the file
  header and is therefore readable *before* anything is created; a version row in
  `app_settings` cannot be, because reading it means having already touched the file you
  meant to refuse. A file with tables but `user_version = 0` predates versioning and is
  refused rather than adopted.

`settings` on both `copilots` and `sessions` is a `SessionSettings`:
`{ providerId, modelId, temperature, topP, maxTokens, maxContextMessages, maxSteps }`.
A Copilot's copy is *copied into* a new session, not referenced — editing a
Copilot later must not rewrite conversations already underway.

### The workspace file browser (`files.ts`)

The sidebar's second panel: a read-only tree of the active workspace, expanded one level at a
time. It is the only part of the app that reads the workspace *for a human* rather than for a
model, which is why it is a module of its own rather than a set of extra routes.

- **`GET /api/workspaces/:id/files?path=`** — one level, directories first then files, each
  `localeCompare`-sorted, exactly as the agent's `list_files` orders them so the two ways of
  looking at a workspace agree. Capped at 2,000 entries with `truncated` set, because a
  listing that quietly stops reads as "this directory has 2,000 files".
- **`GET /api/workspaces/:id/files/content?path=`** — `{ path, name, size, modifiedAt, kind,
  text, truncated }`. `kind` is `text`, `markdown` or `unsupported`; `text` is null for the
  last, which is the whole point — bytes that cannot be rendered are never sent, so no caller
  can accidentally show a binary as mojibake.

`kind` is decided by the server, by extension first and content second. A known-binary
extension is refused without reading at all; Markdown is named; everything else is sniffed for
a NUL byte and decoded as UTF-8, which is what makes an extensionless `Makefile`, `LICENSE` or
`Dockerfile` readable — most of what a workspace actually holds. Past `MAX_PREVIEW_BYTES`
(256 KB) the reply is still a 200 with `truncated: true`: a 2 GB log is the file someone opens
to look at the top of, and the read is bounded with `open`+`read` so the whole thing is never
in memory.

**The sandbox is stricter here than for the tools, on purpose.** Both go through
`resolveInWorkspace`; the browser additionally `realpath`s the result, because that check is
lexical and says nothing about a symlink inside the workspace pointing outward — and in a
browser, one click follows it. The agent's tools keep the lexical behaviour: the model has no
tool that creates a symlink, so reading through one is the user's own decision about their own
machine, whereas a click is not. That is a product decision, deliberately left asymmetric.

### Workspace sandboxing (`workspace.ts`)

Each account has a workspaces root (`users/<slug>/workspaces/`) holding one directory per
workspace, and a workspace's directory holds two things: `workdir/`, which is what the agent's
tools are sandboxed to, and `sessions/`, reserved for per-conversation files.

`resolveInWorkspace(dir, userPath)` resolves a tool-supplied path against the workspace and
**rejects any result outside the workspace** via a `path.relative` check — this is the security
boundary that prevents a model from reading `/etc/passwd` or escaping with `../..`. Deletes are
additionally guarded to only remove direct children of the workspaces root, which is why
`Workspace.dirPath` stores the workspace's *own* directory rather than `workdir/`: deleting
`workdir/` alone would strand `sessions/`, and the guard would not recognise the deeper path.

Because the sandbox root and the workspace's own directory are different things, both are
carried on the `Workspace` type. The agent's system prompt names `workdirPath`; `DELETE`
removes `dirPath`.

### Tools (`tools/`)

| Tool            | Purpose                                   | Sandboxed |
| --------------- | ----------------------------------------- | --------- |
| `list_files`    | list `dist`-style entries under a path    | workspace |
| `read_file`     | read file text (capped at 40k chars)      | workspace |
| `write_file`    | write/overwrite a file                    | workspace |
| `create_directory` | mkdir -p                              | workspace |
| `delete_file`   | delete a file/dir inside the workspace    | workspace |
| `web_search`    | search the web (bing/duckduckgo/tavily/searxng) | —   |
| `web_fetch`     | fetch a URL and return its readable text  | SSRF guard |
| `read_document` | page through an attachment's extracted text | turn's attachments |
| `ask_user`      | put a question to the user and end the turn until they answer | — |

`buildTools({ workspaceDir, webSearch, webFetch, fileToolsEnabled, allowedNames, documents })`
returns the active set for a run, honoring config switches and the Copilot's tool
allow-list. `web_search`, `web_fetch`, `read_document` and `ask_user` survive
`fileTools.enabled: false` because none of them touches the workspace.

**`read_document` is registered per turn and only when the turn has document
attachments.** A model is never offered a tool with nothing to read. It is bound to a
whitelist of *that turn's* attachment ids rather than to the uploads root — ids are
guessable enough that a bare-id tool would let a model wander into another session's
uploads. The check lives where the data crosses the boundary, matching the
`resolveStoredPath` discipline used for uploads.

#### `ask_user` and the suspended turn

`tools/askUser.ts` is the one tool whose success **ends the turn**. The model asks 1–4
questions with 2–4 options each; the client renders them as a card (tabs, one question at
a time, an automatically appended free-text "other" choice, a single submit at the end).

It works by throwing. `AskUserSuspension` is control flow, not failure — the same device
LangGraph's `interrupt()` uses, and for the same reason: a tool cannot return "pause the
loop now" through its return value without a sentinel string that every other reader of a
tool result then has to know about. `runAgentStream` catches that class *before* its
generic tool-error arm, so it never becomes a `Tool error:` string; a catch that swallowed
it would turn a question into a silent no-op.

A suspension is recorded, not answered:

- The call goes into `RunAgentResult.toolCalls` with `status: "awaiting"` and **no
  `output`**. That absence is the whole mechanism — `buildHistoryMessages()` replays only
  tool calls that have an `output`, so a pending question is automatically absent from the
  model's context, and gains one the moment it is answered.
- A `tool_start` is emitted and **no `tool_end`**: there is no result to report, and
  reporting one would render the card as a finished, answer-less question.
- The route persists the assistant message and closes the stream normally. Nothing about
  the pending state lives in the process, which is what lets a question be answered after
  a page reload or a server restart.
- **The message holds the last step's text, not every step's.** `finalContent` accumulates
  as it streams, and the branch that trims it belongs to the final-answer path — which a
  turn ending on a tool call never reaches. Left alone, the narration from one step and the
  sentence introducing the questions from the next were joined with no separator
  (`"Let me look at the workspace.我先确认几件事："`), so a Chinese question appeared to open
  with an English fragment. This is not about language: two utterances run together like
  that read as one broken sentence whatever they say. The live stream still shows both —
  that asymmetry is the one the final-answer path already makes.

The turn resumes on `POST /api/sessions/:id/answers`, which writes the answers onto the
tool call (`output` for the model, `answer` for the card) and then runs a **fresh agent
run with `userMessage: null`**. Its history already ends in the assistant's `tool_calls`
block followed by the matching `ToolMessage` — a valid request on its own — so no
synthetic user turn is invented. `buildHistoryMessages()` reconstructs that pair from the
database, which is why a turn split across two requests needs no checkpointing framework.

Within a step, the other tool calls still run: `ask_user` is executed in order, so a step
that asks *and* reads a file does both, and nothing the model asked for is silently
dropped. A second `ask_user` in the same step becomes an ordinary tool error — two live
question sets is a state the card cannot present.

#### `web_fetch` and its SSRF guard

`tools/webFetch.ts` is the only place a model can make the server issue an
arbitrary outbound request, so it enforces a real boundary:

- Only `http:`/`https:` — everything else (`file:`, `gopher:`, …) is refused.
- The host is resolved via DNS and **every** returned address is checked against
  loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local
  (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`) and reserved ranges, plus
  IPv6 loopback/ULA and IPv4-mapped forms. Checking the resolved address, not the
  hostname string, is what catches `localtest.me`-style names.
- Redirects are followed **manually** (max 5) so each hop is re-validated;
  `redirect: "follow"` would let a public URL bounce the server inward.
- The body is read through a byte cap, then HTML is reduced to readable text with
  cheerio and truncated to `tools.webFetch.maxChars`.

### Agent loop (`agent/loop.ts`)

A hand-written ReAct loop (not LangGraph's prebuilt agent), chosen for full
control over the streaming shape:

1. Compose messages: `SystemMessage` (Copilot system prompt + a note that file
   tools are scoped to the workspace) → prior history → current `HumanMessage`.
2. `chatModel.bindTools(tools)`.
3. Loop up to `settings.maxSteps` (default **15**). Each step:
   - `modelWithTools.stream(messages)` and emit `text` deltas as they arrive,
     accumulating `AIMessageChunk`s. **Each step's text is also kept on its own**, because
     what gets persisted is the model's *most recent utterance* and never the pile of every
     step run together: the final answer, a suspension and an exhausted budget all read from
     `lastUtterance`, and each of their fallbacks is that same utterance rather than the
     accumulation. Any ending that skipped this joined two utterances with no separator
     (`"Let me look at the workspace.我先确认几件事："`) — see
     [`ask_user`](#ask_user-and-the-suspended-turn).
   - Reduce chunks into a full `AIMessage`; read its `tool_calls`.
   - Accumulate `usage_metadata` (input/output/total/cached). The summed figures
     are what was billed; `contextTokens` records the *final* step's input+output
     instead, since that is how large the context had grown.
   - For each tool call: emit `tool_start`, `await tool.invoke(args)` with a
     JSON-safe result, emit `tool_end`, and append a `ToolMessage`. An `ask_user`
     call throws `AskUserSuspension` instead; the loop records it and, once the
     step's remaining calls have run, breaks out (see
     [`ask_user`](#ask_user-and-the-suspended-turn)).
4. Emit `{ type: "usage" }` when the provider reported anything, then return
   `{ content, reasoning, toolCalls, usage, awaiting }` for persistence.

> **Usage is read from the chunks, not the reduced message.** Scanning the step's chunks
> for the one that reports usage is the robust choice: it works whatever the provider
> does, and it does not depend on how `AIMessageChunk.concat` happens to behave in the
> installed `@langchain/core`. (As of 1.2.x `concat` *does* carry `usage_metadata`
> through, so the reduced message is no longer empty — but reading it there is a
> behaviour to re-verify on every dependency bump, whereas the chunk scan is not.)

#### Chain of thought

Chain of thought reaches the app through two independent channels, and only one of them
may be read:

- **The raw SSE tap.** `createReasoningFetch()` in `model.ts` wraps `fetch`, passes every
  byte through untouched, and scrapes `reasoning_content` / `reasoning` / `reasoning_text`
  off each `data:` frame. **This is the single source of truth.**
- **Parsed content blocks.** Some providers express reasoning as a content block typed
  `reasoning`/`thinking` instead of a delta field; `chunkReasoning()` picks those up, and
  `chunkText()` *skips* them so they can never be concatenated into the visible answer.

`chunkReasoning()` deliberately does **not** read `chunk.additional_kwargs`. LangChain
used to drop `reasoning_content` during parsing, but `@langchain/openai` 1.5.x maps it
into `additional_kwargs` — so reading both channels emitted *every* reasoning delta twice
and doubled the persisted `reasoning`. If you are tempted to add that branch back, run
`apps/server/test/agent/loop.test.ts` first: it pins one event per delta.

##### Replaying it, which thinking mode requires

Chain of thought is normally **not** replayed into history: providers ignore or reject it,
so `buildHistoryMessages()` rebuilds an assistant turn from `content` and `toolCalls`
alone. A thinking-mode provider is the exception. DeepSeek requires the reasoning back on
any replayed message that carries `tool_calls`:

```
400 The `reasoning_content` in the thinking mode must be passed back to the API
```

It is not an `ask_user` problem. *Any* second turn in a conversation that used a tool hits
it, because replaying the tool call is how the model is reminded what it did — and it is
permanent, since the offending message stays in history. `ask_user` merely surfaced it
first, being the feature that must replay a `tool_calls` block across requests to work at
all. (The same requirement in Anthropic's protocol is why Claude Code, which reaches
DeepSeek over `/anthropic`, never meets it: `thinking` is a first-class content block
there.)

`@langchain/openai` cannot send the field. Its outbound converter copies only
`function_call`, `tool_calls` and `audio` out of `additional_kwargs`, and it drops
`reasoning` / `reasoning_content` / `thinking` content blocks on purpose
([langchainjs#11175](https://github.com/langchain-ai/langchainjs/pull/11175)) because other
strict providers reject them — so upgrading the SDK makes this worse, not better. The only
place left is the wire, which is where `createReasoningFetch` already lives for the same
fight on the way **in**. So:

- `buildHistoryMessages()` records each replayed tool-call message's reasoning in a side
  map keyed by its first tool-call id, and returns it alongside the messages.
- `createReasoningFetch()` rewrites the outgoing body, setting `reasoning_content` on every
  assistant message that has tool calls — the recorded value, or `""` when the turn
  recorded none, because the field has to be *present* and an empty string is a value
  DeepSeek sends itself. It also drops the now-stale `content-length`.
- All of it is gated on the model record declaring the `reasoning` capability, so a
  provider that never used the field is never sent it.

Reasoning is persisted for display but **never replayed into history** — see
`buildHistoryMessages()`, which only reads `content` and `toolCalls`.

#### Naming a conversation

On the first turn only (`history.length === 0`), and only when the session is still
`titleSource === "auto"`, the route calls `generateTitle()` (`agent/title.ts`) — a
separate, non-streaming completion with `maxRetries: 0` and a 512-token cap. The budget is
generous because reasoning models spend it on chain-of-thought before emitting any
content; a tight cap returns an empty answer and no title. On failure the route falls back
to `fallbackTitle()` (the user's own words, one line, ~40 chars), so a first turn always
produces a usable name. Either way the title is saved and a `title` event is emitted
between `message_done` and `done`, and neither path can turn a successful chat turn into
an error.

The titler does not rely on chain-of-thought at all, streaming or not.

**History replay.** `buildHistoryMessages()` rebuilds prior turns, re-attaching
an assistant message's `tool_calls` *and* the matching `ToolMessage`s — dropping
them made the model reason about a tool result it could no longer see. Only calls
with a recorded output are replayed, because OpenAI rejects a `tool_calls` block
whose results are missing. User turns are rebuilt through `buildUserContent()`, so
an image attached several turns ago is still visible to a vision model.
`trimHistory()` then honours `settings.maxContextMessages`, dropping any leading
assistant message so the window always opens on a user turn.

The model is built by `model.ts` as a `ChatOpenAI` with
`{ model, apiKey, configuration: { baseURL } }`, which is what makes it
OpenAI-compatible with DeepSeek, OpenAI, Ollama, etc. Streaming is always on.
Generation parameters (`temperature`, `topP`, `maxTokens`) are passed through
only when explicitly set, so unset values keep ChatOpenAI's own defaults.

### Attachments (`attachments.ts`)

Bytes live at `<dataRoot>/uploads/<sessionId>/<attachmentId>.<ext>` — deliberately
outside the workspace, so chat uploads never pollute the user's project directory
or appear in the agent's `list_files`. `resolveStoredPath()` mirrors the
`resolveInWorkspace` guard, refusing anything that escapes the uploads root, and
`findStoredAttachment()` derives the MIME type from the directory listing rather
than trusting the client.

The uploads root is **passed in**, not a module constant: it sits under the data root the
process was launched with, so there is nothing to compute at import time. That is also what
keeps `config.ts` importable by the test suite — see "Config" above.

`buildUserContent()` turns a turn into model content:

- **Images** → `{ type: "image_url", image_url: { url: dataURL } }` blocks, i.e.
  real multimodal input. Without `vision` on the selected model they degrade to a
  labelled text placeholder instead of failing the run.
- **Text-like files** (`text/*`, json, csv, md, source) → inlined with a filename
  header, truncated at 20k chars with an explicit notice.
- **Documents** (pdf, docx, xlsx, pptx, odt, ods) → inlined from their extracted text.
  Past `MAX_INLINE_CHARS` only a `PREVIEW_CHARS` preview goes in, followed by a pointer
  at the `read_document` tool — or, for a model without `tool_use`, a plain note that the
  rest was omitted. Nothing is silently dropped.
- **Anything else** is named in the prompt but not parsed.

Uploads arrive as base64 JSON with a raised per-route `bodyLimit` rather than
multipart, which keeps the server dependency-free (`@fastify/multipart` is not
installed) at the cost of a ~33% larger body.

### Document parsing (`documents/`)

PDF and Office attachments are converted to text before they reach the model. Local
extraction is always available; cloud parsers are optional and configured like LLM
providers.

```
<dataRoot>/uploads/<sessionId>/
  <attachmentId>.pdf        the original bytes
  parsed/
    <attachmentId>.txt      extracted text
    <attachmentId>.json     { status, error?, parserId?, parsedChars?, pageCount? }
```

This is the arrangement today. Uploaded files are on their way to a **user-level `sources/`
tree indexed by the database**, where one file can be referenced by several workspaces
rather than belonging to the session it was uploaded in; `users/<slug>/sources/` is created
and reserved for that. The `parsed/` note below is about the current layout and will go with
it.

**The `parsed/` subdirectory is load-bearing.** `findStoredAttachment()` locates an
attachment with `entries.find(name => name.startsWith(id + "."))`, and `txt` is a
legitimate extension in `EXT_MIME` — a flat sibling `<id>.txt` could be picked ahead of
the PDF, and the download endpoint would serve extracted text instead of the original
file. Derived data in its own directory makes that collision unrepresentable.

Parse state lives on disk rather than in sqlite because the uploads tree is already the
authority for attachment bytes and MIME types, and because `removeSessionUploads()`
deletes the whole session directory — so a session delete cleans up parse state for
free, with no migration and no cascade to maintain.

**Extraction is asynchronous.** A cloud job routinely takes tens of seconds (five
minutes is the ceiling), so the upload endpoint returns `201` with `parseStatus:
"pending"` and a background `DocumentService` queue does the work. The client polls
`GET /api/sessions/:id/attachments` and the composer **blocks sending until every
attachment has settled** — the text is injected when the message is built, so sending
early would produce a turn where the model never saw the document the user attached.

#### Local extraction

| Format | Extractor | Notes |
| --- | --- | --- |
| PDF | `pdfjs-dist@4` (legacy build) | text layer only; `==== Page N ====` markers |
| docx / pptx / xlsx | built-in OOXML reader over `fflate` | paragraphs, slides, and cells via the shared-string table |
| odt / ods | built-in ODF reader | body text sits directly in `<text:p>`, with no `<t>` wrapper |

`pdfjs-dist` is pinned to **4.x** on purpose: 5.7+ and 6.x require Node ≥ 22.13, while
this project supports Node ≥ 20. `officeparser` was the obvious choice for Office but
drags in `tesseract.js` plus two `@napi-rs/canvas` binaries for OCR this feature does not
do; `fflate` is ~30 KB and has no install scripts.

A scanned PDF has no text layer and yields nothing. That is reported as `no_text_layer`
rather than an empty string — **the model must never be told it read a document it never
saw**, and the distinct code is what lets the policy hand the file to a cloud parser.

#### Cloud parsers

A parser record is `{ id, name, kind, baseURL, apiKey, enabled }`. `kind` names a **wire
protocol**, not a vendor, so two `mineru` records can point at the hosted service and a
self-hosted box without a second implementation:

| `kind` | Protocol | Covers |
| --- | --- | --- |
| `sync` | POST the file, read text/Markdown back | `docling-serve`, Marker, self-hosted MinerU |
| `mineru` | presigned `PUT` → poll → download a ZIP holding Markdown | MinerU's v4 API, hosted or self-hosted |
| `llamaparse` | multipart upload → poll → Markdown inline in the response | LlamaParse (Reducto is the same shape) |

There is **no de-facto standard** for this API — the vendors converge on "submit, poll,
get Markdown" but differ in how the result is shaped, and that difference is in the
response structure rather than the paths, so no amount of path templating bridges it.
Hence one thin driver per protocol, all sharing the `pollUntil` loop in `drivers/async.ts`.
A new self-hosted service needs no code at all, which is what makes the "just point it at
a base URL" story work.

#### Policy

```yaml
documentParsing:
  localEnabled: true
  policy: local-first     # local-only | local-first | cloud-first | cloud-only
  fallbackEnabled: true
  defaultParserId: null   # null = try every enabled parser in order
```

With `fallbackEnabled: false`, a hybrid policy degrades to its first tier only, so a
failure surfaces instead of being retried elsewhere.

**Which failures are worth retrying elsewhere** is the crux, and it is encoded in
`errors.ts`:

- **Recoverable** — `no_text_layer` (a scan is exactly what an OCR-capable parser is
  for), `too_large` (the cloud ceiling is an order of magnitude higher than the local
  one, so a file too big to parse here is the *most* likely to succeed there), `corrupt`,
  and every cloud failure.
- **Not recoverable** — `password_protected`, `unsupported_type`, `cancelled`,
  `missing_file`. No other tier can read these, so a cloud round-trip would be pure waste.

The cloud tier also fails over *within* itself: parsers are tried in order (a pinned
`defaultParserId` first), so a wrong key on one service does not cost the parse when
another works.

`no_cloud_parser` and `local_disabled` mean a tier **never ran**, which is not the same
as a file being unreadable. When both a real read failure and an unavailable tier are
present, the read failure is what the user is shown — otherwise a scanned PDF under
`local-first` with nothing configured would report "unsupported file type" instead of
"no text layer, this looks like a scan".

### Routes (`routes.ts`)

REST endpoints for config/health, workspaces, copilots, sessions, messages,
attachments, providers and app defaults.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | public config: providers (keyless), defaults, this account's workspaces root |
| `PUT /api/defaults` | set the global default provider/model |
| `GET/POST /api/providers`, `PUT/DELETE /api/providers/:id` | provider CRUD |
| `POST /api/providers/:id/models`, `DELETE /api/providers/:providerId/models/:modelId` | model CRUD |
| `POST /api/workspaces/:workspaceId/sessions` | create a conversation (copies the Copilot's defaults in) |
| `GET /api/workspaces/:id/files?path=` | one directory level of the workspace, for the sidebar's file tree |
| `GET /api/workspaces/:id/files/content?path=` | a file's metadata, and its text when it is text |
| `PATCH /api/sessions/:id` | rename and/or update per-conversation settings (a title also flips `titleSource` to `user`) |
| `POST /api/sessions/:id/attachments` | upload (base64 JSON); schedules parsing |
| `GET /api/sessions/:id/attachments` | parse state for every attachment, by id |
| `GET /api/sessions/:sessionId/attachments/:attachmentId` | serve the bytes back |
| `POST /api/sessions/:id/attachments/:attachmentId/reparse` | re-run extraction |
| `GET/POST /api/document-parsers`, `PUT/DELETE /api/document-parsers/:id` | cloud parser CRUD |
| `GET /api/document-parsers/kinds` | the protocol kinds the server implements |
| `POST /api/document-parsers/:id/test` | round-trip a throwaway document |
| `PUT /api/document-parsing` | the parsing policy |
| `POST /api/sessions/:id/chat` | the SSE chat stream |
| `POST /api/sessions/:id/answers` | answer a suspended `ask_user` call, and stream the resumed turn |

Provider responses **never** include `apiKey` — only `hasApiKey: boolean`. `PUT`
treats an absent `apiKey` field as "leave unchanged" (an empty string clears it),
which is what lets the UI round-trip a provider whose key it cannot read.
Deleting the last provider or the current default returns 409.

The two endpoints that run a turn share `turnContext()` — provider, model, Copilot and
tool set, resolved identically — and `finishTurn()` — persist the assistant message, emit
`message_done`, auto-title a first turn, emit `done`. They must agree: a resumed turn that
rebuilt its tools differently from the one that asked the question could find `ask_user`
missing from the conversation it is in the middle of.

`/chat`:

1. Resolve effective provider/model — explicit request override ⊳ session
   settings ⊳ the Copilot's defaults ⊳ app default. A candidate only wins if it
   still exists, so a deleted provider degrades instead of erroring.
2. Retire any `ask_user` call still awaiting an answer, then build the sandboxed tool set.
3. Persist the user message, capture history *before* it (avoids a duplicate
   user turn), then `reply.hijack()`.
4. Stream `meta` → agent events → `usage` → `message_done` with the persisted
   assistant message → `done`.
5. On error, stream `error` and persist a balanced `⚠️ …` assistant message so
   history remains user/assistant alternating.

`/answers` takes `{ toolCallId, action: "submit" | "cancel", answers? }`. It 409s when
the call is not awaiting (a double submit, or a card the user already skipped), 400s a
submission that skips a question or names an option the model never offered — the answers
are replayed to the model as the user's own words, so the client does not get to supply
prose — then writes `output`/`answer`/`status` onto the call and streams the resumed run.

**Retiring a question is deliberately not the same as answering it.** `skipAwaitingToolCalls`
sets `status: "skipped"` and writes no `output`, so the turn the user walked away from
leaves no trace in the model's context; `action: "cancel"` writes a `dismissed` status
*and* a tool result saying so, because dismissing is a decision the model should hear.

### SSE protocol (`stream.ts` + shared types)

Each frame is `event: <type>\ndata: <json>\n\n`. The `ChatStreamEvent` union
(in `packages/shared`) is: `meta`, `text` (delta), `reasoning` (delta), `tool_start`,
`tool_end`, `usage`, `message_done`, `title`, `error`, `done`. The frontend's
`sseEvents()` generator parses these frames and the store folds them into live UI state.

`message_done` clears the transient streaming entry as soon as it arrives, because the
authoritative message is then in `messages` — the server still has a title call to make
after that point, and rendering both would show the answer twice for as long as it takes.

## Frontend

- `stores/app.ts` — single source of truth; owns config, workspaces, copilots,
  sessions, messages, active selections, staged settings, pending attachments and
  the streaming buffer. Provider/model are **session-scoped**: the header
  selectors write to `session.settings` via `PATCH`, and before a conversation
  exists they are staged in `draftSettings` and folded in on creation. The
  effective-value computeds mirror the server's resolution order exactly.
  `sendMessage()` is optimistic: push a user bubble, then iterate the SSE stream
  and update a transient assistant entry until `message_done`.
- `components/` — `Sidebar` (workspace + session nav, inline rename, guarded deletes,
  and the **设置** button at its foot), `ChatView` (topbar with inline title editing +
  messages), `MessageItem` (markdown, tool cards, attachments, reasoning, per-turn
  token line, copy action), `ReasoningBlock`, `MessageMinimapRail` (one anchor per
  turn), `ToolCallCard` (collapsible args/result), `Composer` (paperclip/paste uploads,
  session-params button, token popover, model picker), `ModelSelector`,
  `AttachmentChips`, `TokenCountPopover`, and the dialogs: `ConfirmDialog`,
  `SettingsDialog` (Providers / Copilots / defaults tabs), `ProviderDialog`,
  `CopilotDialog`, `NewSessionDialog`, `SessionSettingsDialog`,
  `CreateWorkspaceDialog`.
- `composables/` — the few pieces of state that are not domain state and not component-local.
  `theme.ts` and `locale.ts` own the two persisted preferences; `ui.ts` holds the booleans
  more than one component needs to read or set (`settingsOpen`, `drawerOpen`); `breakpoints.ts`
  holds the media-query flags (`isCompact`, `isNarrow`, `isCoarsePointer`) as module-level
  singletons, because a viewport query is a fact about the window rather than about any one
  component. `confirm.ts` is the promise-returning confirm prompt.

  The styling conventions — the token tables, the shared classes, the breakpoints — live in
  `docs/design-system.md`, and `apps/web/test/style.test.ts` is what holds the sheet to them.

### The file tree

`Sidebar` carries two panels behind a tab strip — conversations and files — with the action
belonging to whichever is open (`+`, or refresh). The strip is the settings dialog's tier-2
`.tabs`, not a second kind of tab; the panel below it is one `.side-scroll` either way, because
the sidebar's pinned header and footer depend on there being exactly one.

`FileTree.vue` renders `store.fileRows`, which is `flattenTree` from
[`utils/fileTree.ts`](../apps/web/src/utils/fileTree.ts) computed over a flat map of
`path → listing`. The rows are a **flat list carrying their own depth**, not nested lists:
indentation is `calc(var(--depth) * var(--space-6))`, expansion is one array of paths, and
keyboard movement is an index. Everything with arithmetic in it lives in that util and in the
store, because a `.vue` file is covered by Playwright and by nothing else — and "which row does
ArrowLeft go to" is exactly the kind of thing that is wrong without anyone noticing. Focus moves
by **path**, never by row index: expanding or collapsing renumbers every row after it, and
`focus()` on a detached node silently does nothing, which leaves focus behind and makes the next
key press act on the wrong row.

`FilePreviewDialog` is hosted once in `App.vue` and teleported to `body`, like every other
overlay. It renders by `kind`: Markdown through the messages' own renderer (`html: false` is
what keeps a file from injecting markup), text syntax-highlighted into a `<pre>`, and anything
else as the file's name, size and a note that the format is not previewable yet. That last
branch is the extension point. Escape is handled on `window` and `App.vue`'s drawer handler
returns early while it is open, for the same reason the confirm prompt's does.

Highlighting is `highlight.js`, which the app already shipped for code fences — the preview
adds no dependency and no server work, because the client has the file's name and can resolve
the language itself. `markdown.ts` exposes `highlightFile(code, fileName)` beside
`renderMarkdown`, and the fenced-code path in `renderMarkdown` calls the *same* internal
highlighter and the same escaper, so a snippet cannot be coloured one way in a message and
another in a file. Extensions are looked up as language names first and run through a short
alias table second (`py`, `ts`, `yml`, `tex`), which is what keeps that table small: most
extensions already *are* the highlight.js name. `.vue` is deliberately absent — it is a
template, a script and a style in one file, and no grammar describes that, so it falls back to
escaped plain text rather than being mis-coloured. Above `MAX_HIGHLIGHT_CHARS` (120,000) the
text is likewise escaped rather than tokenised: a quarter-megabyte is the preview cap, which
makes it reachable in one click on a minified bundle, and nobody reads that much coloured
source.

**Markdown has two views, not one.** Rendered is what a document is for; *source* is what you
switch to in order to see what the agent actually wrote, and it is the only place Markdown's
own highlighting appears. They are a segmented control (`.segmented`, a tier-1 class) rather
than two buttons, because it is one choice in two states — and the switch resets per file,
because it is a property of what is on screen rather than a preference.

### Where controls live

Everything that scopes a single reply sits in the composer, as in chatbox; the topbar is
left to the conversation's identity (title, Copilot). The header selectors were removed
because a control that changes per-turn behaviour belongs next to the input.

- **Model picker** (`ModelSelector`) — a menu of *available* models: a provider is listed
  only when it has both an API key and at least one model. The one exception is the
  provider of the model currently in force, which is always shown — hiding it would make
  the button contradict the conversation's actual setting. Selecting a model writes both
  `providerId` and `modelId`, since a model id is only meaningful inside its own provider.
- **Session settings** (🎛) — temperature, context and tool-round limits for this
  conversation.
- **Global settings** — the sidebar footer. It is opened, not owned, by its callers:
  `composables/ui.ts` holds `settingsOpen` and `App.vue` mounts the dialog once, so both
  the sidebar button and the composer's "管理模型…" can reach it without prop drilling.
- `ReasoningBlock.vue` — follows chatbox's reasoning row. Collapsed it previews one
  line: the **last** line while thinking (where the model is right now) and the
  **first** line once finished (a stable summary that stops the row looking alive).
  Expanding shows the full text in a warning-bordered, scrollable panel. The elapsed
  timer is measured client-side and only exists while streaming — it is not persisted.
- **The `ask_user` card** (`AskUserCard.vue`, rendered by `ToolCallCard` in place of its
  own args/result disclosure) — a question the agent asked, and the record of what was
  answered. It is the one interactive thing inside a message, which is why it owns its
  whole presentation rather than nesting in the generic tool card.

  It renders **below the message content**, unlike every other tool card. A question is not
  an action the agent took on the way to answering — it is the last thing in the turn, and
  the sentence in front of it introduces it. `MessageItem` therefore splits the calls into
  the ones that belong above the reply and the `ask_user` ones that belong below it. Above,
  a card demanding an answer appeared before the words explaining it, and while streaming it
  read as though the message had ended and then started talking again.

  Three states, chosen by `ToolCall.status`. While `awaiting` it is a tab strip, one
  question at a time, with previous/next and a single **submit on the last question**
  (disabled until every one is answered). The free-text "other" choice is appended by the
  client, per question, and is never something the model offers — a model that could name
  it would spend one of its four slots on a button with nothing behind it.

  Picking one of the model's options **advances by itself**, because on a single-select
  question that choice *is* the answer and there is nothing left to do on the tab. Neither
  of the other two cases advances: multi-select has no "I am done" the user ever gave, and
  the free-text choice needs typing. The advance moves focus to the next tab, since the
  panel is keyed by the question and the radio that was clicked has been destroyed —
  without that, focus falls to `<body>` and a keyboard user restarts from the top of the
  page.

  Once answered it is a **summary**: one row per question with the choice, always visible
  without expanding. Behind the disclosure are the options **as they were offered, ticked
  where they were picked**, plus the typed answer as one more row when "other" was used —
  so the record shows the decision against what was on offer, not the answer alone. That
  asymmetry is the point: a tab strip is an answering affordance, and reading a
  conversation back wants the answer, not the menu it came from.

  The option inputs are keyed by the current question so Vue rebuilds them rather than
  reusing the elements. Reuse is not merely stale text: a checked radio whose `name` is
  mutated to the next question's group joins that group while still checked, and the
  browser then unchecks whatever was selected there — silently losing the answer to the
  question the user navigated back to. Answers live in the component's draft, so
  rebuilding the inputs costs nothing.

  **Between the call arriving and the turn recording it, the card shows a placeholder — not
  the summary.** It used to fall through to the summary branch, so a card full of "未回答"
  rows looked like a finished, unanswered record while the model was still streaming the
  sentence that introduces it.

- **A turn that fails must be visible on screen, in two places.** The server persists a
  balanced `⚠️ …` assistant message (so history still reloads correctly) and streams an
  `error` event; `error` is written to `streaming.error` *and* `store.error`. The banner
  lives inside the streaming message, which `ChatView` renders only while a turn is
  `active`, so on its own it flashes and vanishes the moment the turn ends — leaving a
  failed turn with nothing on screen at all. `store.error` is the toast in `App.vue`, and
  it outlives the turn. Keep both halves: a failure that is invisible is indistinguishable
  from a button that does nothing, which is exactly how one was reported. For the same
  reason the store's `answerQuestion` reports a submission it cannot place rather than
  returning silently.

- `composables/confirm.ts` — `confirm({ title, message, detail, danger })` returns
  a promise. Every destructive UI action (session, Copilot, workspace, provider)
  awaits it; `ConfirmDialog` is mounted once in `App.vue`. Enter accepts, Escape
  cancels.
- `utils/markdown.ts` — markdown-it with `html:false` (raw HTML escaped) and
  highlight.js code highlighting.
- `utils/format.ts` — byte/token formatting and the pre-send `chars/4` estimator.

### Layout

Only the message list scrolls. `html/body/#app` and `.app` are `overflow: hidden`;
`.main` is a flex column where `.topbar` and `.composer` are `flex-shrink: 0`. The
sidebar keeps exactly one `.side-scroll`, so nav and footer stay pinned.

`.messages-wrap` (`position: relative`) holds the scroller and is what the minimap rail
positions against. The rail is deliberately a **sibling** of `.messages`, not a child —
inside the scroller it would scroll away with the content. When the rail is shown,
`.messages` gains 28px of left padding so the rail never overlaps a message.

`.messages` is the scroller: `flex: 1; min-height: 0; overflow-y: auto`. The `min-height`
is load-bearing; without it the flex item refuses to shrink below its content and the list
silently stops scrolling.

### Responsive

Two breakpoints, both declared at the **end** of `style.css`. That placement is load-bearing:
a media query does not raise specificity, so an override written above the rule it means to
override loses on source order alone. `.overlay-popover` is declared in the surfaces section
near the bottom, and the narrow `position: fixed` written above it silently lost — the
popover stayed absolutely positioned and ran off the edge of the screen.

| Query | What changes |
| --- | --- |
| `(max-width: 900px)` | The sidebar becomes a drawer; the minimap rail is hidden |
| `(max-width: 560px)` | Dialogs and popovers become bottom sheets; the composer toolbar reflows; forms go single-column |

The drawer takes the sidebar **out of the grid** — `position: fixed`, translated off-canvas —
rather than re-columning it. Left as a grid item under `grid-template-columns: 1fr` it would
become an implicit second *row*, collapsing `.main`'s height and stopping the message list
from scrolling: the failure the `minmax(0, 1fr)` comment in the sheet documents.

Three things hold the drawer together and none is optional:

- `visibility: hidden` when closed, or its 6+ controls stay tabbable off-screen
- `inert` on the pane behind it while open, which is a focus trap without the state machine
- **every dialog teleported to `body`** — `position: fixed` resolves against the nearest
  transformed ancestor, and the drawer is one, so an overlay left inside the sidebar is laid
  out in the off-canvas panel and renders off-screen

Escape closes the topmost layer only: `App.vue`'s handler returns early while a confirm
prompt or Settings is up, because `ConfirmDialog` listens on `window` for the same key and
one press would otherwise close both.

The pixel values are duplicated as strings in `composables/breakpoints.ts` — a media query
cannot read a custom property and JavaScript cannot evaluate one. `breakpoints.test.ts` pins
the strings that reach `matchMedia` and `style.test.ts` pins the sheet's media query values;
change both together.

### Minimap rail

`MessageMinimapRail.vue` mirrors chatbox's rail of the same name: one anchor per **turn**
(per user message, paired with the reply it produced), built by `buildMinimapAnchors()`
in `utils/minimap.ts`.

- Anchors are `12px` apart. The bar nearest the pointer widens from 6px to 24px through a
  smoothstep falloff, which is what makes the rail feel magnetic rather than jumpy.
- Hovering (or keyboard focus) shows a preview card: the user's text clamped to 3 lines,
  then the assistant's reply truncated beneath it.
- Clicking jumps the list to that turn. `ChatView` finds the message by its
  `data-message-id` and scrolls by **rect delta** rather than `offsetTop`, which would be
  measured against whichever ancestor happened to be positioned.
- Only anchors inside the rail's scroll window (plus 8 items of overscan) are rendered, so
  a very long conversation does not put thousands of nodes in the DOM.
- Keyboard: ArrowUp/ArrowDown/Home/End with a roving `tabIndex`.
- Hidden below 900px viewport width, where the preview card would have nowhere to go. The
  value lives in `composables/breakpoints.ts` as `isCompact`, shared with the drawer so the
  two cannot disagree about what "narrow" means.

Previews are capped at 300 characters (`MINIMAP_PREVIEW_MAX_LENGTH`). Building them from
full message text would re-scan the whole conversation on every streaming chunk, which is
the bug chatbox documents as feedback 1589.