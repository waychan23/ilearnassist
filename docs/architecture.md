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
                                          │    users/<slug>/sources/{raw,parsed}│
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
- `copilots` — id, user_id (FK, CASCADE, **nullable**), name, description,
  system_prompt, tools (JSON), settings (JSON), visibility (`private` | `public`),
  timestamps
- `sessions` — id, workspace_id, copilot_id (FK, `SET NULL`, nullable), copilot_name,
  system_prompt, tools (JSON), title, title_source, settings (JSON), timestamps
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

Copilots are owned, with one extra degree of freedom: `visibility` widens the **reads** to the
caller's own rows plus every public one (`listCopilotsForUser`, `getCopilotForUser`), while the
**writes** keep `id = ? AND user_id = ?` (`getOwnedCopilot`, `updateCopilotForUser`,
`deleteCopilotForUser`). That asymmetry is the whole policy — a public Copilot is usable by
every account and editable by its owner alone — and it is why neither write is written as
"read the row, then compare its owner". An id that is another account's private Copilot answers
404 rather than 403, so there is no way to probe for one.

Accounts are real: `auth.ts` finds or creates one by username, and every route is scoped to
the caller (see [Authentication](#authentication-authts)). A Copilot's owner is that account,
exactly as a workspace's is.

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

One migration is a **one-off** rather than an `ensureColumn` call with no follow-up, and it is
why that function returns whether it added anything. On the single boot that gives Copilots an
owner, the existing rows are deleted (`DELETE FROM copilots`) — they have no owner and no way
to infer one, so they are dropped rather than guessed at. `foreign_keys` is ON, so this fires
`sessions.copilot_id`'s `ON DELETE SET NULL` and **no conversation is removed**. Two
consequences are worth knowing before upgrading an existing data root. A conversation keeps
its copied generation `settings` but loses its Copilot's persona, falling back to the built-in
system prompt. And a conversation that was running under a **tool-restricted** Copilot becomes
unrestricted, because it has no snapshot and `all_tools` defaults to 1. That widening is real;
it is accepted here because the alternative was refusing the database outright.

`copilots.user_id` is nullable **on purpose**, in the DDL and in the migration that adds it:
`ALTER TABLE ADD COLUMN` with `NOT NULL` demands a default, and any default is a landmine for a
later insert that forgets the owner. Every read names the owner in its `WHERE`, so an ownerless
row is matched by nothing and goes missing rather than being handed to whoever asked. Fail
closed.

`settings` on both `copilots` and `sessions` is a `SessionSettings`:
`{ providerId, modelId, temperature, topP, maxTokens, maxContextMessages, maxSteps }`.

**A conversation snapshots its Copilot; it does not reference it.** All four parts of the
definition — `system_prompt`, `tools`, `settings` and the name — are copied into the session at
creation, so editing or deleting a Copilot later leaves conversations already underway exactly
as they were. `copilot_id` stays only as a link for the UI: nullable, `ON DELETE SET NULL`, and
allowed to dangle, while `copilot_name` is what the badge reads precisely because it survives
that. `systemPrompt` and `tools` joined the copied `settings` for the same reason, and each is
independently editable afterwards through `PATCH /api/sessions/:id` — that is what "the
conversation owns its persona" means in practice. A turn reads the session and nothing else:
`turnContext()` takes no Copilot, so an allowlist that narrowed the tool set cannot evaporate
because the Copilot it came from was deleted.

### Widgets (`widget_instances`)

One row per `(scope, scope_id, widget_id)`, with `enabled`. **The row's existence is the record
that somebody decided something, and `enabled` is what they decided** — which is why uninstalling
writes `0` and never deletes. A deleted row would fall back to the level's default and silently
reinstall a widget the user had turned off, and an object that has already said no is exactly the
case that cannot be told apart from one that never chose. The primary key's leading columns are
the whole lookup, so there is no secondary index; the write is an `INSERT … ON CONFLICT DO UPDATE`
so install / uninstall / install on the same pair is one row rather than a duplicate-key error.

There is deliberately **no copilot scope**: a Copilot's selection lives in `copilots.widgets` and
is *copied* into the session it starts, exactly as `settings` and `tools` are. That column is
**nullable**, and for the `all_tools` reason — `NULL` means "never set, use the defaults" while a
JSON array (including `[]`) is an explicit selection. A `NOT NULL DEFAULT '[]'` would have told
every Copilot written before the column existed that it installs nothing, a decision its owner
never made; `mapCopilot` resolves `NULL` to `DEFAULT_WIDGET_IDS` instead.

Reads iterate the **registry** rather than the rows, so one entry comes back per widget this build
knows at that level and a stored row is indistinguishable from a defaulted one. A row naming an id
a downgrade removed is dropped rather than handed to a client that cannot render it — the same
move `all_tools` makes against a stale `tools` list. Writes assert the owner in the statement
(`SELECT … FROM workspaces WHERE id = @scopeId AND user_id = @userId`), so a caller that forgot
its scoped read still cannot touch another account's row; a session reaches its owner through its
workspace by join, as `sessions` itself does.

The new table needed **no `SCHEMA_VERSION` bump** — the DDL runs on every open, so a database
created before it simply gains it (the `counters` precedent, pinned by a test). `copilots.widgets`
came in through `ensureColumn` for the same reason.

#### Widget-bound tools

A widget may declare `boundTools` in `WIDGETS`: tools that are assembled for a turn **iff the
widget is installed on the session**, read fresh per turn from `widget_instances` in
`turnContext()`. They bypass the session's tool allow-list in all three of its states —
"every tool", a named list, and the empty "no tools" list — because the widget install is the
single switch and the tools are deliberately absent from the Copilot tool checklist
(`isWidgetBoundTool`). Like `read_document`, they are still only assembled when their per-turn
context exists (`plan?: PlanToolContext`): an allow-list can never switch them on for a
conversation without the widget. The first consumer is the **plan** widget.

### The plan widget (`plans.ts`, `planTools.ts`)

One versioned study plan per session, written only by the model and rendered by the
session-scoped plan widget. The split is:

- **Versions are structural snapshots.** `plan_versions.tree_json` is the full tree
  (id/title/children) each edit produced, and is all a history browse shows. **Progress lives
  once, on `plan_nodes`**, keyed by a server-assigned UUID that survives renames and moves, so
  the current tree carries live status while old versions never change and need no node-level
  version number.
- **Deletion is a status, not a row deletion.** A node missing from a new submission becomes a
  tombstone (`status='deleted'`, `removed_version` set, last parent/position frozen): it drops
  out of that version's snapshot while the current view renders it struck through where it used
  to be. Reusing a tombstone id is refused; a replacement is a new node without an id.
- `ila_make_plan` creates V1 (no ids) or edits (ids from `ila_read_plan`); a fresh-looking
  submission against an existing plan is the third suspending tool — the turn ends on a choice
  card, and `POST /answers` commits either fork ("edit this plan" or "new conversation", which
  snapshots the session, installs the widget, writes V1, and streams `plan_session_created`).
- `ila_update_plan_progress` batches node status changes. The node's **start anchor** is the
  `in_progress` call placed before its content (tool call id, in the `done_tool_call_id`
  column — widened without a rename): kept through completion, cleared when the node returns
  to not-started/skipped, and what the panel's click scrolls to (the tool-call card, not the
  message top). The plan auto-completes when every live node is completed; `deleted` is
  unreachable from this tool. The tool description carries the *mark-before-teaching* timing
  rule, which is what makes the anchor meaningful rather than a completion marker.
- The panel's two user actions reduce to a user message on the ordinary `/chat` path. The
  footer "adjust plan" composer sends `调整计划：<text>`; "jump to chapter" first POSTs
  `/plan/nodes/:id/jump`, which in one transaction marks every prior undone node `skipped`
  (including the chapter currently in progress) and opens the target plus its containing
  chapters, then sends `调整进度，跳到章节<number> <title>`. `planNodeNumbers` derives the
  `1` / `1.1` ordinals from sibling position, for both the tree view and that message.
- While the widget is installed the turn's system prompt also gets `PLAN_GUIDANCE`: mark a
  node before teaching it, stay on the plan at node boundaries, and after an off-plan detour
  ask the user whether to return to the track.

### The thread widget (`threads.ts`, `agent/threads.ts`)

The third session widget derives topic chains — a message belongs to one `session_threads`
row through `messages.thread_id` — by classifying each *turn* (a user message plus its
assistant replies) with an out-of-band model call after the turn finishes. The call
**streams** (a non-streaming 20s timeout aborted slow reasoning runs — healthy calls already
took 14–18s, and a backfill once made the model think for 109s and emit nothing) with a 60s
backstop; the main-loop shape rather than the titler's buffered call. It runs after every
finished turn while the widget is installed, is never awaited (fire-and-forget from
`finishTurn`, so `done` does not wait), and joins one in-flight promise per session.
Turns are the oldest run of unassigned messages, at most five per call (messages clipped
to 350 chars). Turns whose own `ila_update_plan_progress` tool call named a plan node are
placed deterministically *without a model call* — the node comes out of the turn's own
calls, not the plan's current status, which would be a lie during backfill — and only
ambiguous turns (background, digressions) are sent. A failed/empty/unusable answer blocks
just those turns; deterministic ones in the same chunk still land, and the identical
idempotent call retries the rest, so backfill and keeping up are one code path. The
`计划`/`其他` headings are rendered, not stored —
their labels are translated and the plan branch nests off the live plan tree on the client
(`utils/threadTree.ts`), so a renamed node never freezes a title. A widget **group** bundles
widgets only in the install UI (`WIDGET_GROUPS`, client-side): one master button loops the
ordinary per-widget writes; there is deliberately no group row or route.

### Notes (`notes.ts`)

What the learner marked and what they wrote about it, one row per note, reached at
`/api/sessions/:id/notes`. **`session_id` is `NOT NULL` and `message_id` is nullable, and that
asymmetry is the entity**: a note belongs to a conversation always and to a message only when
something was annotated, which is what makes a note the user typed from the panel the same kind
of thing as one made by dragging over a sentence. `message_id` deliberately carries **no foreign
key** — a regenerate or a tail delete soft-deletes a message, and the note is the user's own
writing, so it must survive with the quote it recorded. `messageMissing` is how a read says so:
a `LEFT JOIN messages … AND m.deleted_at IS NULL` in the same query that fetches the note, rather
than a guess from the client's message list, which only ever holds the conversation on screen.
The row is soft-deleted like every other user-authored entity, and its bytes stay.

**The anchor is a text quote plus which occurrence of it**, not a pair of character offsets,
because the offsets a browser reports are offsets into rendered HTML and mean nothing after the
next `v-html` assignment replaces every text node in the message. It is counted over the
message's **visible** text: KaTeX emits each formula twice by default — glyph spans and hidden
MathML — so a raw walk would see every formula double and could place a mark in the copy nobody
can see (`utils/noteAnchor.ts`, and the cases pinned in `test/utils/noteAnchor.test.ts`). An
anchor is validated against a real message of the named conversation and refused when it arrives
half-formed, since a message with no quote has nothing to put back on screen.

Notes bring **no tools**: the model neither reads them nor writes them. They are the learner's own
writing, and nothing in a turn's context is built from them.

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
| `read_document` | page through an uploaded file's extracted text | per-turn whitelist: the conversation's sources ∪ its workspace's |
| `ask_user`      | put a question to the user and end the turn until they answer | — |

`buildTools({ workspaceDir, webSearch, webFetch, fileToolsEnabled, allowedNames, documents })`
returns the active set for a run, honoring config switches and the conversation's own
tool allow-list (the snapshot copied from its Copilot at creation). `allowedNames` is
**absent** when the conversation may use every tool and an array otherwise — `session.allTools`
decides which, and an empty array is a real answer meaning "no tools", not a synonym for
"unrestricted". The two readings were the same thing once, which made the narrowest possible
selection behave as the widest.
`web_search`, `web_fetch`, `read_document` and `ask_user` survive
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

1. Compose messages: `SystemMessage` (the conversation's own system prompt — copied
   from its Copilot at creation, or the built-in assistant prompt when empty — plus a
   note that file tools are scoped to the workspace) → prior history → current
   `HumanMessage`.
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

### Uploaded files (`attachments.ts`)

Bytes live at `<userRoot>/sources/raw/<sourceId>.<ext>` — deliberately outside the
workspace, so chat uploads never pollute the user's project directory or appear in the
agent's `list_files`. `resolveInSources()` mirrors the `resolveInWorkspace` guard, refusing
anything that escapes the account's sources tree, and it is applied on **every** read of a
stored path — including one that came out of the database, because a row is not a trust
boundary.

A file is a **source**: owned by the account, indexed by the `sources` table, and
*referenced* by conversations and workspaces rather than owned by them. Two consequences
worth knowing before reading the rest of this section:

- **Identical bytes are one source.** `UNIQUE (user_id, sha256)`, with the hash scoped to the
  account — a lookup by hash alone would hand one account's file to another who uploaded the
  same content. Re-uploading a PDF reuses the row, the file and whatever parse it already has.
- **A file can outlive every conversation that referenced it.** Deleting a conversation
  cascades its links away and touches nothing on disk; `DELETE /api/sources/:id` is the one
  that deletes bytes.

The sources tree is **passed in** as a `UserLayout`, not a module constant: it belongs to an
account under a data root the process chose at launch, so there is nothing to compute at
import time. That is also what keeps `config.ts` importable by the test suite — see "Config"
above.

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

PDF and Office files are converted to text before they reach the model. Local extraction is
always available; cloud parsers are optional and configured like LLM providers.

```
<userRoot>/sources/
  raw/<sourceId>.pdf        the original bytes
  parsed/<sourceId>.txt     extracted text
```

**Parse state is not there.** It lives in columns on the `sources` row — that is the "index
it in the database" half of the design, and it buys two things a `parsed/<id>.json` sidecar
could not: a reparse is visible in **every** conversation that references the file at once,
rather than only in the messages written after it; and a file referenced by two conversations
is parsed **once**, not once per reference. Only the extracted text stays a file: it is large,
and `read_document` streams it by offset.

The two directories are siblings, which used to be *load-bearing*: `findStoredAttachment()`
located an attachment by globbing `<id>.*` in the session directory, and `txt` is a legitimate
extension in the MIME table — so a flat `<id>.txt` could be found ahead of the original PDF
and the download endpoint would serve extracted text instead of the file. Nothing globs any
more, because the path is a column, so that collision is unreachable rather than merely
avoided. The split stays because raw bytes and derived text are different kinds of thing.

**Extraction is asynchronous.** A cloud job routinely takes tens of seconds (five
minutes is the ceiling), so the upload endpoint answers immediately with `parseStatus:
"pending"` and a background `DocumentService` queue does the work — keyed by **source id**,
because the work belongs to the file rather than to the conversation that happened to upload
it. The client polls `GET /api/sessions/:id/sources` and the composer **blocks sending until
every staged attachment has settled** — the text is injected when the message is built, so
sending early would produce a turn where the model never saw the document the user attached.

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

### Authentication (`auth.ts`)

**A password, and a bearer token.** `POST /api/auth/login` takes a name and a password and
answers with a pair of opaque tokens; every other request carries the access one in an
`Authorization: Bearer` header. The token is not a JWT, and that is the load-bearing choice:
a JWT is self-describing, so a server that has signed one can no longer refuse it, and "sign
this account out everywhere" becomes a key rotation that signs out everybody. Here the token's
**SHA-256 is a row in `auth_tokens`**, so revocation is one `UPDATE` — which is what the
console's kick button is, and why it takes effect on the next request rather than at the next
restart.

What that costs is a database read per request: one indexed lookup against a local SQLite
file, the same order of work as the session-secret lookup it replaced.

Two lifetimes, and the split is the whole point of having two:

- **Access — a day.** Sent on every request, so the one most likely to be observed.
- **Refresh — a week, rotated on every use.** Redeeming one revokes it and issues a fresh
  pair, so a stolen refresh token is worth exactly one exchange and the theft shows up as the
  real client being refused. Because each exchange resets the week, a client that keeps
  working never signs in again — "stay signed in" without a token that lives forever.

Both are stored **hashed**, and only hashed: a copy of the database is a list of spent digests
rather than a list of working credentials. The hash is a plain SHA-256 rather than a KDF, and
deliberately — the input is 256 bits of CSPRNG output, so there is no guessable space for a
slow hash to protect, and the lookup is on the request path.

Passwords are `scrypt` from Node's own `crypto` with the parameters stored *inside* the hash,
so raising them later still verifies what was written before.

**Roles are a JSON array on the account**, because the checks are written as "does this account
hold role R" — so a third role, or an account holding two, is a row that changes and nothing
else. Three exist: `superadmin` (the single account the installation was bootstrapped with,
and the only one that may appoint an ordinary administrator), `admin` (granted by a
superadmin, and the role that runs the installation), and `user`. Exactly one superadmin
exists: it is made by the desktop control panel with the server stopped (`cli create-admin`,
which itself refuses once an enabled superadmin exists), and the HTTP routes refuse to grant
the role to anyone — `SUPERADMIN_NOT_GRANTABLE` is the answer for every caller, so there is no
second mint path through the console.

**Either administrator role reaches the platform console, and either may write the
installation-wide settings.** Providers, document parsers, the parsing policy and the app
defaults are shared by every account, so their writes are an administrator's while their reads
stay open for the composer. The split the feature is built on is *configure versus choose*: an
administrator configures the models, and an ordinary account chooses among them. That is a
security boundary rather than a preference — a provider's `baseURL` is where every
conversation's prompts go, and testing a parser makes the *server* fetch a URL the caller chose.
What the two tiers differ in is *accounts*: an ordinary administrator runs the ordinary
accounts, and may not touch one that holds an administrative role — not the superadmin, and not
another administrator. Only the superadmin reaches those rows.

**Every route requires a session unless it says `config: { public: true }`.** One `onRequest`
hook, deny by default, so a route added without a thought about auth is refused rather than
open — the same move as the `read_document` whitelist. Five routes opt out: `health`,
`auth/login`, `auth/refresh`, `auth/logout` and `auth/me` (obtaining a token, spending one,
and asking whether you already hold a session). The same hook enforces the **pending password
change**: while
an account owes one, every route but `auth/me`, `auth/password` and `auth/logout` answers
403, which is what makes "change it first" a rule rather than a screen.

The hook belongs to the `routes` plugin, so it covers the API and stops there. The built
frontend is served by a sibling plugin and stays public, which it has to be: a browser cannot
present a token in order to fetch the page that would give it one.

**The first administrator is created by the control panel, not the web app — and not through
the API.** A login screen is reachable over the network the moment LAN sharing is on, so an
in-app create-administrator route would be a `public` route anyone on that network could
claim during the one window in which the installation has no owner. Instead the panel spawns
the server package's administrator CLI (`apps/server/src/cli.ts`, bundled to
`dist/server/cli.mjs`) as a one-shot child that writes the account with the server
deliberately stopped, and `main()` refuses to listen until an *enabled superadmin* exists.
The same CLI is the headless path on a machine with no panel (`pnpm --filter @ilearnassist/server
cli create-admin …`). It adopts a passwordless account of the same name rather than making a
second one, because on an installation carried over from the build where a username was the
credential that row owns the workspaces. The check and write run in one `BEGIN IMMEDIATE`
transaction, so two processes racing to bootstrap make exactly one administrator.

**The control panel is the way back in — through the CLI, not through a route.**
`cli reset-admin` replaces a superadmin's password and ends its sessions, and it is a *child*
of the panel rather than a request to the server, so it works whether the server is up,
stopped, or refusing to start. The panel takes the new password in a two-field sheet — the
operator is assumed to be the superadmin, so they choose it, like `create-admin`, rather than
receiving a generated one; the CLI still supports `--generate` from a terminal. There is
deliberately no HTTP route for this: every route needs somebody already signed in, which is
exactly what a forgotten password prevents, and a recovery path that needs a healthy server is
not much of a recovery path. The panel could always write the database directly — it runs on
the operator's machine and holds the CLI — so a per-launch shared secret guarded nothing a
process boundary did not already.

### Routes (`routes.ts`)

REST endpoints for config/health, workspaces, copilots, sessions, messages,
attachments, providers and app defaults.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/sessions/:id/sources` | upload a file and reference it from this conversation (and its workspace) |
| `GET /api/sessions/:id/sources` | every file this conversation can read, with its parse state — **the model's whitelist too** |
| `GET /api/sources/:id/raw` | a file's bytes, for a thumbnail or a download |
| `POST /api/sources/:id/reparse` | re-run extraction |
| `DELETE /api/sources/:id` | delete the file, its text and every reference to it |
| `POST /api/auth/login` | sign in with a name and a password. Answers 409 `SETUP_REQUIRED` when the installation has no administrator, which the server itself will not serve |
| `pnpm … server cli create-admin` | create the first administrator, outside the server — the only way, and it works with the server stopped |
| `pnpm … server cli reset-admin (--password-stdin \| --generate)` | replace a superadmin's forgotten password; also outside the server, and the only place a superadmin's **own** password can be replaced |
| `POST /api/auth/refresh` | exchange a refresh token for a fresh pair, spending the one presented |
| `POST /api/auth/logout` | end this client's session — reached from **Sign out** in the sidebar footer, the workspace home and the account page |
| `GET /api/auth/me` | who the caller is; a 401 is the answer, not a refusal |
| `POST /api/auth/password` | change your own password, with the current one. Ends every session and returns a replacement pair |
| `GET /api/admin/users` | every account, with its roles and whether it is disabled |
| `POST /api/admin/users` | create one, with a generated password shown exactly once |
| `PATCH /api/admin/users/:id` | change its roles, or disable it (never delete — the row owns workspaces) |
| `POST /api/admin/users/:id/password` | replace its password without knowing the old one |
| `POST /api/admin/users/:id/revoke` | end every session it holds |
| `GET /api/config` | public config: providers (keyless), defaults, this account's workspaces root |
| `PUT /api/defaults` | set the global default provider/model |
| `GET/POST /api/providers`, `PUT/DELETE /api/providers/:id` | provider CRUD |
| `POST /api/providers/:id/models`, `DELETE /api/providers/:providerId/models/:modelId` | model CRUD |
| `GET /api/copilots` | this account's Copilots plus every public one |
| `POST /api/copilots`, `PUT/DELETE /api/copilots/:id` | Copilot CRUD — owner-only; `visibility` on create and update, and 404 for someone else's |
| `POST /api/workspaces/:workspaceId/sessions` | create a conversation (copies the Copilot's whole definition in) |
| `GET /api/workspaces/:id/files?path=` | one directory level of the workspace, for the sidebar's file tree |
| `GET /api/workspaces/:id/files/content?path=` | a file's metadata, and its text when it is text |
| `PATCH /api/sessions/:id` | rename, update per-conversation settings, or re-persona it (`systemPrompt`, `tools`); a title also flips `titleSource` to `user` |
| `POST /api/sessions/:id/sources` | upload (base64 JSON); schedules parsing |
| `GET /api/sessions/:id/sources` | what this conversation can read, with parse state |
| `GET /api/sessions/:sessionId/attachments/:attachmentId` | serve the bytes back |
| `POST /api/sessions/:id/attachments/:attachmentId/reparse` | re-run extraction |
| `GET/POST /api/document-parsers`, `PUT/DELETE /api/document-parsers/:id` | cloud parser CRUD |
| `GET /api/document-parsers/kinds` | the protocol kinds the server implements |
| `POST /api/document-parsers/:id/test` | round-trip a throwaway document |
| `PUT /api/document-parsing` | the parsing policy |
| `POST /api/sessions/:id/chat` | the SSE chat stream |
| `POST /api/sessions/:id/answers` | answer a suspended `ask_user` call, and stream the resumed turn |
| `POST /api/sessions/:id/stop` | interrupt the turn streaming for this session; `{ ok }` says whether one was running |

Provider responses **never** include `apiKey` — only `hasApiKey: boolean`. `PUT`
treats an absent `apiKey` field as "leave unchanged" (an empty string clears it),
which is what lets the UI round-trip a provider whose key it cannot read.
Deleting the last provider or the current default returns 409.

The two endpoints that run a turn share `turnContext()` — provider, model and tool set,
resolved identically — and `finishTurn()` — persist the assistant message, emit
`message_done`, auto-title a first turn, emit `done`. It reads the **session and nothing
else**: `session.settings` for the provider/model, `session.allTools`/`session.tools` for the
allowlist, and no
Copilot at all, since the conversation carries its own copy of everything a Copilot
contributes. That is what makes the conversation independent of the Copilot it came from, and
it is also what keeps a Copilot id off this path. The two must agree: a resumed turn that
rebuilt its tools differently from the one that asked the question could find `ask_user`
missing from the conversation it is in the middle of. They also share `beginTurn()`, which
registers the turn in `activeTurns` so either can be stopped.

#### Stopping a turn

`POST /api/sessions/:id/stop` aborts the `AbortController` that `beginTurn()` registered
for the session, and answers `{ ok }` — `false` rather than 404 when nothing was running,
because the client's Stop races the stream's own `done` and losing that race means the stop
already happened.

**Stopping is an endpoint of its own, not the client aborting its own fetch.** The chat
request has to *outlive* the decision in order to report what happened: a fetch that was
aborted has no stream left to send `message_done` down, which would leave the client either
inventing a local copy of the partial reply or reloading to find it. So the stop route
aborts and returns, while the chat request — stream still open — persists what had streamed
and ends exactly as a completed turn does.

- The signal reaches the provider request (`modelWithTools.stream(messages, { signal })`)
  and every running tool (`t.invoke(args, { signal })`), so a stop stops paying for tokens.
- `runAgentStream` catches **narrowly**: only an abort becomes `stopped: true`, and any
  other throw keeps its meaning. Swallowing everything there would dress every provider
  outage up as a silent, empty turn the user appeared to have stopped. The tool-level catch
  rethrows on an aborted signal rather than reporting `Tool error: …`, which would look like
  the tool broke and would carry the loop into another step.
- The turn ends with the usual `message_done` carrying the partial text flagged
  `stopped: true`, then `done`. **No `error` event** — stopping is something the user did.
- A stopped turn is still persisted, and still counts as the assistant's half of the
  exchange, so the next turn replays it as context rather than opening on two user messages
  in a row. It reports no `usage`: the figures it has cover a half-finished step.
- The auto-titler is skipped when a stopped turn has no content — there are no words to name
  the conversation after.

The same request's `close` event aborts the controller too, so a closed tab stops costing
tokens exactly as a Stop does. `finished` separates that from a socket closing after a turn
that ran to completion, which must not abort anything.

`/chat`:

1. Resolve effective provider/model — explicit request override ⊳ session
   settings ⊳ app default. The Copilot tier that used to sit between the session
   and the app default is gone: its defaults were merged into `session.settings`
   when the conversation was created, so a turn resolves against the session alone.
   A candidate only wins if it still exists, so a deleted provider degrades instead
   of erroring.
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
  `SettingsDialog` (the account's own Copilots), `ProviderDialog`, `CopilotDialog`,
  `NewSessionDialog`, `SessionSettingsDialog`, `CreateWorkspaceDialog`. `AdminConsole` and
  its `admin/ProvidersSection` and `admin/DocumentsSection` hold the installation-wide
  screens — the ones that are nobody's alone.
- `composables/` — the few pieces of state that are not domain state and not component-local.
  `theme.ts` and `locale.ts` own the two persisted preferences; `ui.ts` holds the booleans
  more than one component needs to read or set (`settingsOpen`, `drawerOpen`, `adminSection` —
  the console's current screen, which a control *outside* the console picks) *and* the six-way
  `view` flag that picks the page — there is still no router; `breakpoints.ts`
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

Below the panel sit the account-level rows — **Settings**, **Your account**, **Platform
console** (administrators only) and **Sign out** — and they share every style except the divider,
which is above the group rather than between the rows: one footer group, not four entries of a
list. Sign out takes no confirmation, because the session is restored by signing in again and a
misclick costs only that. It lands on the sign-in screen even when the request fails, and the
stored token is cleared either way — leaving someone looking signed in is the worse of the two
outcomes. The same controls are on the workspace home, beside its settings gear, since that
page is reachable with no sidebar.

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
left to the conversation's identity (its title, and a badge naming the Copilot it was started
from). The header selectors were removed because a control that changes per-turn behaviour
belongs next to the input.

- **Model picker** (`ModelSelector`) — a menu of *available* models: a provider is listed
  only when it has both an API key and at least one model. The one exception is the
  provider of the model currently in force, which is always shown — hiding it would make
  the button contradict the conversation's actual setting. Selecting a model writes both
  `providerId` and `modelId`, since a model id is only meaningful inside its own provider.
- **Session settings** (🎛) — temperature, context and tool-round limits for this
  conversation, plus the conversation's own system prompt (the persona it copied from
  its Copilot, editable afterwards), and the widgets installed in it.
- **Workspace settings** — a dialog of its own, not a tab of the global one, because it
  configures *a workspace* rather than the installation. Two ways in: the gear on a workspace
  card, and the workspace name in the sidebar header (which is a button for that reason). The
  card's is the one that matters — it does not require entering the workspace first, so widgets
  can be installed before there is anything to look at.
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

`.app` is a grid with **two or three** tracks: the sidebar, the conversation, and — when widgets
are installed and the viewport is wide enough — the widget panel. The third is added by a class
`App.vue` puts on the element, from the same component that sets `--widget-w`, so the track and
the custom property it reads always arrive together. See
[Widgets (right sidebar)](#widgets-right-sidebar).

`.messages-wrap` (`position: relative`) holds the scroller and is what the minimap rail
positions against. The rail is deliberately a **sibling** of `.messages`, not a child —
inside the scroller it would scroll away with the content. When the rail is shown,
`.messages` gains 28px of left padding so the rail never overlaps a message.

`.messages` is the scroller: `flex: 1; min-height: 0; overflow-y: auto`. The `min-height`
is load-bearing; without it the flex item refuses to shrink below its content and the list
silently stops scrolling.

### Widgets (right sidebar)

The conversation page has a third column of **widgets**: built-in panels, each a tab, installed
per workspace or per conversation. See [`widget_instances`](#widgets-widget_instances) for the
storage, and [widgets.md](widgets.md) for the authoring contract and the steps to add one.

**A widget is a panel, with one exception so far.** The notes widget
(`id: "notes"`) also *changes how the message list behaves*: while it is installed on the
conversation on screen, selecting text in a message offers to mark it or write about it, and the
marked passages are drawn back onto the messages. That is a **capability**, and
[`composables/messageNotes.ts`](../apps/web/src/composables/messageNotes.ts) is the whole of what
the two sides share — the message list knows how to notice a selection, draw a mark and show a
window and nothing about notes as records; the widget knows about notes and nothing about `Range`
or `<mark>`. The claim is per conversation and single-holder, and it follows the widget's install
rather than the panel's visibility (`WidgetModule.onActive`, called by
[`composables/widgetActivation.ts`](../apps/web/src/composables/widgetActivation.ts) from
`ChatView`'s scope), because the panel mounts only the active tab — a claim owned by the component
would drop the moment the reader looked at the plan. The notes themselves are rows in
[`notes`](#notes), owner-scoped through the conversation and reached at
`/api/sessions/:id/notes`.

A widget declares which levels it accepts — `workspace`, `session` — and only those two exist. A
**Copilot is a third place to tick a box, not a third scope**: its selection is copied into the
conversation it starts, so "copilot level" is session level reached through a template. Three
install surfaces follow from that, and the control each uses follows from whether anything exists
to change yet:

| Surface | Control | Why |
| --- | --- | --- |
| `CreateWorkspaceDialog` | checkboxes | the workspace does not exist, so the whole selection lands in one write |
| `CopilotDialog` | checkboxes | a Copilot's selection reaches a conversation only when one is started from it |
| `WorkspaceSettingsDialog`, `SessionSettingsDialog` | install/uninstall toggles | the object exists, so each click takes effect immediately |

**The panel is a third grid track on `.app`, not a floating overlay.** It is a column beside the
conversation, so `App.vue` sets `--widget-w` on the element from `composables/widgetPanel.ts` and
adds `with-widgets`. The `var(--widget-w)` in `style.css` has **no fallback** on purpose: an
unresolvable custom property makes the whole `grid-template-columns` declaration invalid at
computed-value time, and the grid silently collapses to one implicit column. Below 900px the
class is withheld and the panel is a fixed drawer at the right instead — the same element, laid
out by a media query.

The tab strip (`WidgetTabStrip.vue`) measures its tabs and moves the ones that do not fit into a
"more" menu; the arithmetic is `utils/widgetTabs.ts`, kept pure and unit-tested because it is the
part that can be wrong in a way no screenshot shows — an off-by-one in the divider's cost only
shows up at one width. Measured sizes are **cached**, since a `v-show`n tab reports zero and
trusting that would make the strip oscillate.

The strip draws one group per level, workspace first, with a rule between them that is rendered
only when both sides have a visible tab: a rule whose right-hand side sits inside the "more" menu
would be separating a tab from a button. The divider is a real cost in the fit.

**Preferences are in `localStorage`** (`composables/widgetPanel.ts`): width, orientation and the
open tab. A panel width is a property of *this window* — a 1440px laptop wants a wide one and a
1024px one wants a narrow one — so a server-side value would impose the wrong sharing model on a
CSS length; and a synchronous read at first paint is what stops the panel jumping on every reload.
The width is clamped on **read** as well as on write, because a value that was fine when it was
set is not necessarily fine now. Collapse is deliberately not persisted, matching
`uiState.sidebarCollapsed`.

**Events exist for what the store cannot see.** `composables/widgetEvents.ts` is a small typed bus
so a widget learns about a change the *server* made — a turn ending moved the message counts and
the token totals, and nothing the client did knows by how much — plus lifecycle changes like a
conversation being created or deleted. Anything the client itself decided and holds is a `watch`
away and is deliberately **not** an event: two ways to learn one fact drift. `turn.finished` is
emitted from `consume()`'s `finally`, the one point every turn ends at, and unconditionally within
the account-epoch guard, since a failed turn still persisted a message.

**Lifecycle hooks run on the client, after the write.** There is no server-side widget runtime — a
widget is a Vue component in the web bundle — so `onInstall`/`onUninstall` are declared by the
widget's registry entry and invoked by the store once the record is committed. That ordering is
what makes "a hook can never fail a config write" a property rather than a promise; a hook that
throws is logged, and a widget whose *data* fails reports it inside its own panel, the same split
`fileTreeError`/`filePreviewError` make.

`onInstall` therefore fires at **two** moments, because a level's widgets can arrive two ways: one
at a time through `setWidgetEnabled`, or all at once in a create request — the create dialogs
choose a selection before the object exists. The creation case runs the hooks from the *resolved*
read where there is one (a conversation copies its Copilot's selection, so the request may name no
widgets at all), and from the requested list for a workspace, where what was asked for and what the
route wrote are the same list. Neither demo widget has a hook; the mechanism is covered by store
tests with a stubbed registry entry.

The two demo widgets read `GET /api/workspaces/:id/stats` and `GET /api/sessions/:id/stats`. Those
are about the object rather than about a widget — two widgets read the same route and a third will
— and the arithmetic is in `apps/server/src/widgets.ts` rather than in SQL, because `MessageUsage`'s
fields are all optional and `contextTokens` means the opposite of a sum.

Not built, deliberately: external/dynamic widget installation (there is nothing to load at
runtime — `widgetsForScope()` is the seam), any server-side event bus, and a resizable panel on a
phone.

### Responsive

Two breakpoints, both declared at the **end** of `style.css`. That placement is load-bearing:
a media query does not raise specificity, so an override written above the rule it means to
override loses on source order alone. `.overlay-popover` is declared in the surfaces section
near the bottom, and the narrow `position: fixed` written above it silently lost — the
popover stayed absolutely positioned and ran off the edge of the screen.

| Query | What changes |
| --- | --- |
| `(max-width: 900px)` | The sidebar becomes a drawer; the widget panel becomes a drawer at the right; the minimap rail is hidden |
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