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
                                          ┌──────────────────┴───────────────┐
                                          │  filesystem:  workspaces/<slug>/  │
                                          │  data/:        app.sqlite (WAL)   │
                                          │                uploads/<sess>/    │
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

- `workspaces` — id, name, slug, dir_path, created_at
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

Schema changes are applied **in place** by `ensureColumn()` (`PRAGMA table_info`
+ `ALTER TABLE ADD COLUMN`), because `CREATE TABLE IF NOT EXISTS` silently skips
tables that already exist — an existing database would otherwise never gain a new
column. A legacy `copilots.model` column is folded into `settings.modelId` on
open and then left dormant (`DROP COLUMN` is version-sensitive in SQLite).

`settings` on both `copilots` and `sessions` is a `SessionSettings`:
`{ providerId, modelId, temperature, topP, maxTokens, maxContextMessages, maxSteps }`.
A Copilot's copy is *copied into* a new session, not referenced — editing a
Copilot later must not rewrite conversations already underway.

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
| `list_files`    | list `dist`-style entries under a path    | workspace |
| `read_file`     | read file text (capped at 40k chars)      | workspace |
| `write_file`    | write/overwrite a file                    | workspace |
| `create_directory` | mkdir -p                              | workspace |
| `delete_file`   | delete a file/dir inside the workspace    | workspace |
| `web_search`    | search the web (bing/duckduckgo/tavily/searxng) | —   |
| `web_fetch`     | fetch a URL and return its readable text  | SSRF guard |
| `read_document` | page through an attachment's extracted text | turn's attachments |

`buildTools({ workspaceDir, webSearch, webFetch, fileToolsEnabled, allowedNames, documents })`
returns the active set for a run, honoring config switches and the Copilot's tool
allow-list. `web_search`, `web_fetch` and `read_document` survive
`fileTools.enabled: false` because none of them touches the workspace.

**`read_document` is registered per turn and only when the turn has document
attachments.** A model is never offered a tool with nothing to read. It is bound to a
whitelist of *that turn's* attachment ids rather than to the uploads root — ids are
guessable enough that a bare-id tool would let a model wander into another session's
uploads. The check lives where the data crosses the boundary, matching the
`resolveStoredPath` discipline used for uploads.

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
     accumulating `AIMessageChunk`s.
   - Reduce chunks into a full `AIMessage`; read its `tool_calls`.
   - Accumulate `usage_metadata` (input/output/total/cached). The summed figures
     are what was billed; `contextTokens` records the *final* step's input+output
     instead, since that is how large the context had grown.
   - For each tool call: emit `tool_start`, `await tool.invoke(args)` with a
     JSON-safe result, emit `tool_end`, and append a `ToolMessage`.
4. Emit `{ type: "usage" }` when the provider reported anything, then return
   `{ content, reasoning, toolCalls, usage }` for persistence.

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

Bytes live at `data/uploads/<sessionId>/<attachmentId>.<ext>` — deliberately
outside the workspace, so chat uploads never pollute the user's project directory
or appear in the agent's `list_files`. `resolveStoredPath()` mirrors the
`resolveInWorkspace` guard, refusing anything that escapes the uploads root, and
`findStoredAttachment()` derives the MIME type from the directory listing rather
than trusting the client.

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
data/uploads/<sessionId>/
  <attachmentId>.pdf        the original bytes
  parsed/
    <attachmentId>.txt      extracted text
    <attachmentId>.json     { status, error?, parserId?, parsedChars?, pageCount? }
```

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
| `GET /api/config` | public config: providers (keyless), defaults, workspaces root |
| `PUT /api/defaults` | set the global default provider/model |
| `GET/POST /api/providers`, `PUT/DELETE /api/providers/:id` | provider CRUD |
| `POST /api/providers/:id/models`, `DELETE /api/providers/:providerId/models/:modelId` | model CRUD |
| `POST /api/workspaces/:workspaceId/sessions` | create a conversation (copies the Copilot's defaults in) |
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

Provider responses **never** include `apiKey` — only `hasApiKey: boolean`. `PUT`
treats an absent `apiKey` field as "leave unchanged" (an empty string clears it),
which is what lets the UI round-trip a provider whose key it cannot read.
Deleting the last provider or the current default returns 409.

The chat endpoint is the interesting one:

1. Resolve effective provider/model — explicit request override ⊳ session
   settings ⊳ the Copilot's defaults ⊳ app default. A candidate only wins if it
   still exists, so a deleted provider degrades instead of erroring.
2. Build the sandboxed tool set.
3. Persist the user message, capture history *before* it (avoids a duplicate
   user turn), then `reply.hijack()`.
4. Stream `meta` → agent events → `usage` → `message_done` with the persisted
   assistant message → `done`.
5. On error, stream `error` and persist a balanced `⚠️ …` assistant message so
   history remains user/assistant alternating.

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
- Hidden below 900px viewport width, where the preview card would have nowhere to go.

Previews are capped at 300 characters (`MINIMAP_PREVIEW_MAX_LENGTH`). Building them from
full message text would re-scan the whole conversation on every streaming chunk, which is
the bug chatbox documents as feedback 1589.