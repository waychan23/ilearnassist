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
- `workspaces` — id, user_id (FK, CASCADE), name, slug, dir_path, settings (JSON),
  description, created_at; `UNIQUE (user_id, slug)` — the slug is only unique among one
  account's workspaces
- `copilots` — id, user_id (FK, CASCADE, **nullable**), name, description,
  system_prompt, tools (JSON), settings (JSON), visibility (`private` | `public`),
  timestamps
- `sessions` — id, workspace_id, copilot_id (FK, `SET NULL`, nullable), copilot_name,
  system_prompt, tools (JSON), title, title_source, settings (JSON), description, timestamps
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

Schema changes follow one of three rules, and they are for different things. The full version is
[migrations.md](migrations.md); this is what a reader of the data model needs:

- **Adding** a table or an index is a `DDL` edit and nothing else — the DDL is applied on every
  open and every statement in it is `CREATE … IF NOT EXISTS`, so an existing database gains it on
  the next start.
- **Adding** a column is that *and* an `ensureColumn()` call (`PRAGMA table_info` +
  `ALTER TABLE ADD COLUMN`), because `CREATE TABLE IF NOT EXISTS` silently skips tables that
  already exist — an existing database would otherwise never gain it. Two edits, for two
  audiences: the DDL is what a fresh install gets, and `ensureColumn` is how an existing one
  catches up.
- **Anything the idempotent DDL cannot express** — changing what a column means, a drop, a data
  rewrite — bumps `SCHEMA_VERSION` in `schema.ts` **and** adds a step to `MIGRATIONS`, which walks
  an older file forward. No missing column can signal that kind of change, and without a version
  the file is simply opened and read wrong — `dir_path` resolving somewhere else, ids referring to
  a different kind of thing — with no error to explain it. The guard reads `PRAGMA user_version`,
  which lives in the file header and is therefore readable *before* anything is created; a version
  row in `app_settings` cannot be, because reading it means having already touched the file you
  meant to refuse. A file with tables but `user_version = 0` predates versioning and is refused
  rather than adopted.

A file **newer** than this build is still refused outright, and versions 2–4 still are too: their
steps would have to invent values the rows do not determine. A walk also cannot go backwards, so
"refuse" is the only honest answer to a file from the future.

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

The default is **not empty**: `DEFAULT_WIDGET_IDS` names `notes` and `sources`, the two panels that
are views over what a conversation already holds — what the learner wrote, and what the
conversation is working from. Both are useful before anybody asks, which is what separates them
from the ones that report something a conversation has *produced*. The consequence to keep in mind
is that this is a decision about **absence**, so it reaches every object nobody has answered for
rather than only future ones, and it is why the create dialogs seed their checkboxes from the same
list: they always send what they hold, and a named list is honoured literally.

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

#### Widget tools, and the two modes

A widget may declare `tools: { names, mode }` in `WIDGETS`, and the mode is the widget's own
decision about how its tools relate to its install.

**`required`** — assembled for a turn **iff the widget is installed on the session**, read fresh
per turn from `widget_instances` in `turnContext()`. They bypass the session's tool allow-list in
all three of its states — "every tool", a named list, and the empty "no tools" list — because the
widget install is the single switch, and they are deliberately absent from the Copilot tool
checklist (`isWidgetBoundTool`). Like `read_document`, they are still only assembled when their
per-turn context exists: an allow-list can never switch them on for a conversation without the
widget. The **quiz** widget is `required`.

**`auto-install`** — ordinary tools, governed by the allow-list and pickable in a Copilot, whose
call **installs the widget** in that conversation. `turnContext()` therefore passes their context
unconditionally rather than using it as a switch, and `RunAgentInput.onToolUsed` reports a call
that resolved so the route's closure can write the install before the turn's `tool_end` goes out.
The **plan** and **diagram** widgets are `auto-install`.

The mode exists because the two answers are both right for different widgets. A quiz is a
capability whose *home* is its panel — its questions come from a card and its answers live in the
list — and `ila_quiz` suspends the turn, so it could not be what installs the panel. A plan or a
diagram is a capability whose data the tool *produces*: with `required`, the tool would exist only
where the panel already was, so a conversation nobody had installed anything into could neither
make a plan nor ever come to have the panel. `auto-install` is what lets the capability introduce
itself, and it installs from silence only — never over a stored `enabled = 0`, so a panel somebody
closed stays closed.

There is a deliberate third form — a tool that reaches a widget's data while belonging to no widget
at all — and `ila_query` is it: one ordinary allow-listable tool reading plan, quizzes, threads,
notes and diagrams alike. A `required` binding would hide the conversation's own record from every
conversation that had not installed the relevant panel, and `auto-install` has no single panel to
name, because the five kinds answer for five of them.

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

### The insight pass (`insights.ts`, `agent/insights.ts`)

The reflection behind the insight panel: one out-of-band model call over the conversation's own
record — the plan and its progress, the quiz questions with their verdicts, the topic threads,
the learner's notes, and the diagrams it drew — answering with typed observations
(`INSIGHT_TYPES`) about the learner rather than about the material.

It is **not a tool**, and that is the design rather than an omission. `ila_query` is how the
*agent* reads this material during a turn; a pass costs a full model call over the whole
conversation, so it is a user pressing a button. Nor would either tool mode fit: a `required` one
would exist only while the widget was installed, and an `auto-install` one would put the panel
there without a pass, so it would arrive empty and read as broken.

Three properties are worth stating because each is load-bearing:

- **The wipe happens only after a usable parse.** `replaceUnadoptedInsights` is called at the
  *end* of `generateInsights` and never at the start, so a provider outage, a timeout or an
  unreadable answer leaves every row exactly as it was. The alternative — clearing first and
  filling in after — is a user pressing a button, getting nothing, and losing the list they had.
- **A failed pass is not an empty one.** The parser returns `null` for "nothing usable" and `[]`
  for "the model genuinely said nothing", and the route reports them as `failed` and `ok`. The
  panel says different things for each, because "it looked and found nothing" is a claim about
  the conversation and a failure is a claim about the call.
- **`adopted` is the only thing that survives a rerun.** `insight_items` therefore has no
  `deleted_at` — derived data, like `session_threads`, and the one hard `DELETE` shape is
  reached from both the user's delete and the pass's wipe. The consequence is stated rather than
  hidden: a deleted observation can come back on the next pass. Delete is not suppression.
- **A pass with nothing to read does not call the model.** The readable sources are all *derived*,
  so a conversation that has just been created has none of them: `hasMaterial()` is the gate, and
  the answer is `status: "empty"` — a third outcome beside `ok` and `failed`, because zero new
  items is also what "the model looked and found nothing" returns and the two ask the reader for
  opposite things ("go and have a conversation first" against "go and fix the provider").

The prompt is bounded per source (see the caps in `insights.ts`) for the `threads.ts` reason: a
reasoning model given too much input thinks for a hundred seconds and returns nothing. Adopted
items from earlier passes are sent back under an instruction not to repeat them, which is the
whole mechanism of a second pass being useful rather than a near-duplicate of the first.

**Each pass writes one block to `<dataRoot>/logs/insights.log`** (`modelLog.ts`, configured only
in `index.ts`, so a test server writes nothing). It carries the two things a panel cannot show:
the **source counts and the prompt's size**, which is how "nothing to reflect on" is told apart
from "the model refused", and the **model's raw answer even when it was unusable** — the panel's
"produced nothing usable" is the same sentence for a fence-wrapped object the parser should have
accepted and for a refusal in prose. The block is written *after* the write, so its counts are
what the transaction committed rather than what it was about to, and the three outcomes —
skipped, failed, written — are named rather than left to be inferred from an identical empty list.

### Diagrams (`diagrams.ts`, `tools/diagram.ts`, `threads.ts`)

A diagram is a `.mmd` file in `sessions/<id>/` **plus** a `session_diagrams` row; each half holds
what the other cannot. The file is written first, through `registerFile`, and the row
(`name`, the model's `summary`, `tool_call_id`, `thread_id`, **`file_id`**) is upserted on
`(session_id, name)` second, so a failed or refused call leaves the previous revision alone.
The row carries no `source` (the bytes are the file the `file_id` points at; a second copy is the
one drift the split exists to prevent), no `path` (the file row already carries one), no
`message_id` (the assistant message does not exist when the tool runs), and no `deleted_at` — it is
derived data like `session_threads`, not the learner's writing. It gets **no work resource**, which
is the file/reference split's one real use: the drawing is read in the 图表 panel and is
deliberately absent from the library. `GET /api/sessions/:id/diagrams` is the panel's read model
and answers `fileMissing` by statting each file; the session-files content route attaches a
diagram's `summary` by name on the session root only.

`thread_id` is not set at write time. The classifier above is given each turn's diagrams — name
and summary inside `<diagram>` blocks under the message that drew them — and answers a second,
ref-keyed `diagrams` array alongside `decisions`. Only `continue` and an existing `eN` are valid
(a diagram never starts a thread), a bad entry drops just that diagram, and both the dropped ones
and the diagrams of a deterministically-forced turn inherit their turn's thread. That collapse is
what makes a diagram's `thread_id` null iff its turn is unclassified, since the classifier's work
list is pending messages and never revisits an assigned turn. A revise clears `thread_id`; the
next sync re-judges the new shape.

### Tables (`tables.ts`, `tools/table.ts`)

A table is **one row and no file**, and that inversion of the rule above is the whole of its
design. `session_tables` (`name`, the model's `summary`, `content`, `tool_call_id`, `thread_id`)
is upserted on `(session_id, name)` like a diagram's, so calling the tool again with the same name
corrects that table rather than adding a second. It holds the markdown because there is no file
for the bytes to live in and nothing for a second copy to disagree with; `session_diagrams`' row
holds only what its file cannot answer, which is the opposite arrangement for the opposite reason.
No file and so **no reference** either — a reference is what puts material in the library and the
`@` picker, and every consumer of one is path- or entity-driven — and no `deleted_at`, like the
derived rows above.

The **display** is the assistant's reply: `ila_table`'s guidance asks the model to write the same
table as ordinary Markdown, because nothing on the server can put text into a model's output. The
row is what the 图表 panel lists and the viewport re-renders, so a regenerated message does not
lose the table. `GET /api/sessions/:id/tables` is the panel's read model; `ila_query(kind:
"table")` is the model's, which is what lets it revise one past the history window. Tables ride the
thread classifier exactly as diagrams do — the same ref-keyed array pattern under their own wire
key — and `docs/tables.md` is the full reference.

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

Notes bring **no tools of their own**: nothing creates, edits or deletes one, so a turn can never
rewrite what the learner wrote. The model *reads* them through the ordinary `ila_query` —
`kind: "note"`, in `tools/query.ts` — which was a deliberate reversal of the rule that used to
stand here. The read names no widget, in either mode: a `required` one would be assembled only
while the notes panel is installed, hiding the learner's own notes from every conversation that had
not opted in, and `auto-install` has nothing to install — the notes already exist, because the
learner wrote them. The tool result frames them as data *about* the learner rather than
instructions, because a note is free text the learner wrote for themselves.

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
| `read_document` | page through a referenced document's extracted text, by **reference id** | per-turn whitelist: `listReadableWorkResources` — the conversation's references ∪ its workspace's ∪ any `@`-granted workspaces' |
| `ask_user`      | put a question to the user and end the turn until they answer | — |
| `ila_query`     | read the conversation's own record (plan / quizzes / threads / notes / diagrams / tables) | owner-scoped by the turn's account |
| `ila_explore`   | read the workspaces the user opened with `@`: their files, their conversations' messages, and a search across both | the resolved `@` grant, and read-only |
| `ila_diagram`   | draw a diagram: a `.mmd` in the conversation's folder plus its row | off with `fileTools.enabled` |
| `ila_table`     | record a table: one row, whose display is the reply's own Markdown | not gated by `fileTools.enabled` — it writes no file |

`buildTools({ workspaceDir, webSearch, webFetch, fileToolsEnabled, allowedNames, documents })`
returns the active set for a run, honoring config switches and the conversation's own
tool allow-list (the snapshot copied from its Copilot at creation). `allowedNames` is
**absent** when the conversation may use every tool and an array otherwise — `session.allTools`
decides which, and an empty array is a real answer meaning "no tools", not a synonym for
"unrestricted". The two readings were the same thing once, which made the narrowest possible
selection behave as the widest.
`web_search`, `web_fetch`, `read_document`, `ask_user`, `ila_query` and `ila_explore` survive
`fileTools.enabled: false` because none of them writes a file — the switch means "this
installation's agent does not write files", and `ila_explore` reads granted workspaces' folders
while writing nothing at all. Its context is present only when the conversation holds an `@`
grant, so the absence of the tool is the ordinary case.

**`turnContext()` resolves the `@` grant and is the only caller of `db.listReadableWorkResources`.**
That is a deliberate consolidation: the three turn routes used to each compute the whitelist, and
the scope has to be resolved exactly once per turn so that `/answers` and `/regenerate` cannot
grant less than the turn that asked the question. A future route that built its tools some other
way now also loses `read_document` entirely — failing loudly rather than quietly under-granting.
See [resources.md](resources.md#reading-across-workspaces).

**A tool's parameters schema must arrive as a top-level object.** The one shape that does not is a
zod union: it converts to `{"anyOf": […], "type": null}`, which a strict OpenAI-compatible endpoint
refuses outright — `400 Invalid schema for function …: schema must be a JSON Schema of 'type:
"object"', got 'type: null'` — on every turn where the tool is offered, called or not. So a
discriminated set is **one flat object** with the discriminator as a `z.enum`, a table for which
fields each value accepts, and a handler `Record` for the completeness a `switch` used to give
(`tools/query.ts` is the worked example, and why it is shaped that way). `test/tool-wire-schema.test.ts`
sends one real turn and asserts the conversion for every tool in it.

**`ila_query` is the agent's read of the conversation's own record** (`tools/query.ts`): one
tool with a `kind` discriminator over plan, quiz, thread, note and diagram, rather than five
tools competing for the same slot in the model's attention and five allow-list boxes for one
capability. It is **ordinary and allow-listable, and belongs to no widget**, on the
`ila_diagram` argument and for a stronger reason — a `required` read exists only while its widget
is installed, and one tool cannot `auto-install` five panels — so every kind delegates to the read
its widget's route already uses and returns what that returns. `kind: "quiz"` is the load-bearing
case: it reads through
`listQuizQuestionViews`, so the answer key's secrecy is *inherited* from `toView` rather than
re-implemented, and a second read would be a second chance to leak it. Only
`kind: "diagram"` with a `name` returns file content — the conversation's own `.mmd`, which
`read_file` structurally cannot reach. Answers carry `truncated` and shrink the page rather
than the text, because a cut JSON string is not a smaller answer.

`kind: "resource"` must see the `@` grant too, and that is not a detail: it is the model's only
index of what it may read, so a whitelist widened by a grant this read could not see would leave
the model with material it cannot enumerate — and the only remaining way to find it is guessing
ids, which is exactly the wandering the whitelist exists to prevent, reachable by a model that is
now *allowed* to wander. (`ila_query`'s kind was `source` until v4; the id it takes is a
reference's either way, which is why only the name moved.)

**`ila_explore` is the one tool that leaves the conversation's own workspace**
(`tools/explore.ts`). One flat object with a `kind` discriminator over `workspaces` / `sessions` /
`messages` / `message_search` / `files` / `file`, assembled only when the conversation holds an `@`
grant. `workspaces`
is the index rather than a convenience: the other kinds are addressed by **id**, and the prompt
cannot enumerate them when the grant is "every workspace" — that flag covers workspaces which do
not exist yet.

**`message_search` is a kind of its own rather than a mode of `messages`**, and the reason is the
flat schema's: `messages` names one conversation by id and pages it, while this names a *term* and
searches across the granted workspaces. An `{sessionId?|query?}` pair on one kind would be a
selector-shaped field — one that only means something together with another, where one of them
chooses what the other addresses — which is exactly what `ila_query` was split into kinds to avoid.
It is also the only way to find a message by its *text*: `sessions` matches titles, and `messages`
needs an id the caller does not have yet. Each hit carries its conversation's id, because that id
is what the next call takes.

Four properties are worth stating, and each is a way this tool goes wrong:

- **Read-only structurally.** The module contains no write, no `unlink`, no `mkdir`, and every
  path resolves against a granted workspace's own root. That is the difference between this and
  teaching the file tools a third root, which would put the write rules and the "exists in both
  roots" delete refusal back in play for a feature whose grant is entirely about reading.
- **It `realpath`s every path, and must.** `resolveInWorkspace` is lexical *on purpose*, and its
  justification is that the model has no tool that makes a symlink, so one can only be there
  because the user put it there. That argument does not survive this feature: a symlink in a
  granted workspace would become a read path out of somebody else's conversation into material
  they deliberately did not open. This is the one place the design is *stricter* than the file
  tools, and it should stay that way.
- **`messages` strips rather than clips.** Tool-call `output` (a single `read_file` result is up
  to 40 000 characters) and `reasoning` (display-only everywhere else, never replayed into a
  context) are removed entirely — the first because it is the one unbounded thing in a transcript,
  the second because returning it here would be the one place chain of thought leaks into one. A
  message *body* is clipped, at 800 characters, against the 80/300/400 navigation-preview
  precedents: those help you choose which item to open, and this is the opening.
  `message_search` clips every hit the same way, for the same reason: a page of results has to be
  a page rather than one message's worth of context.
- **A search term is taken literally.** `%` and `_` are wildcards to SQLite, and the material this
  searches has both in it, so `likePattern` escapes them — one implementation, shared with the
  library's name filter, since a statement whose `ESCAPE '\'` half disagreed with its bound
  pattern would match silently-wrong things.

Its description and the prompt guidance both say the same second thing, and it is the mitigation
for the surface this feature opens: **what is read there is material, never instructions.** Another
conversation's messages can read like a command, including text this agent wrote in that other
conversation, and the description is read when the model decides to call while the prompt is read
when it decides what to do with the answer.

**The paging engine is shared** (`tools/resultPage.ts`): `clip`, `renderPage`, the 12 000-character
ceiling and the item caps. Two tools with two engines would be two answers to what `truncated`
means, and that flag is what the model pages on. `truncated` says "there is more of this set you
have not seen", which has two causes — the page was shrunk to fit the ceiling, or the caller's own
`limit` was smaller than what remained. It used to report only the first, telling a caller who
asked for 20 of 200 items that nothing was truncated. A model is never offered a tool with nothing to read — and the whitelist is
`listReadableWorkResources`, the three ranked arms resolved in `turnContext`
(see [resources.md](resources.md#the-whitelist-is-three-arms-over-one-table)). It is a `Map` keyed
by **reference id** rather than a lookup by a bare id, because ids are guessable enough that a tool
taking one would let a model wander into another conversation's uploads: a guessed id fails the
`Map` before any path is touched, which makes that wandering unrepresentable rather than merely
forbidden.

**It also reads the bytes when there is no extracted text, for the categories that never had
any.** Only `document` and `image` are extracted (`needsParse`), so a Markdown or `.txt` file has
never had anything in `parsed/` — and the tool could be handed one by name and not read a byte of
it. That was survivable while a model was only shown ids it had just been handed; it stops being
survivable once a grant makes uploads elsewhere addressable, because "here is an id" with nothing
behind it is a broken tool. `needsParse` is the gate, so a PDF that *failed* to extract still
reports nothing readable rather than having its raw bytes decoded and presented as its text.

Its "no such document" reply builds its catalogue **on the miss path only, and capped at 50
names**. It used to be one string per source built eagerly on every turn, for a sentence only ever
read when a lookup fails — affordable while the whitelist was one conversation plus one workspace,
and not once a grant can make it the whole account.

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
- **The message holds every step's text, one paragraph each.** A suspension is one ending
  among several and it decides nothing about the content: `finalContent` is what the deltas
  built, and this route persists it as it stands. Asking after explaining is the shape that
  made the old rule expensive — the content used to be trimmed to the last utterance here,
  which argued that a question is introduced by the sentence just before it. It is, and that
  is how a chapter's lecture delivered in an earlier step was deleted the moment the model
  asked a question about it. What the trim was really avoiding was two steps' text joined
  with no separator (`"Let me look at the workspace.我先确认几件事："`, where a Chinese
  question appeared to open with an English fragment); the step break answers that for every
  ending at once, which is why there is no longer a per-ending rule here to get wrong.

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
   from its Copilot at creation, or the built-in assistant prompt when empty — then, in
   order: **the current date, time and timezone**, a note naming the two writable folders
   and the effective write default, and whatever guidance the turn's widgets and tools
   contribute) → prior history → current `HumanMessage`.
2. `chatModel.bindTools(tools)`.
3. Loop up to `settings.maxSteps` (default **15**). Each step:
   - `modelWithTools.stream(messages)` and emit `text` deltas as they arrive,
     accumulating `AIMessageChunk`s. The message's text is built *here and only here*:
     `finalContent` is the concatenation of every delta emitted, so **what is persisted is
     exactly what the client rendered**. A step boundary is a paragraph break
     (`STEP_SEPARATOR`), folded into the step's first delta rather than sent as an event of
     its own, which is what keeps the two strings identical and an abort mid-step safe. Two
     steps' utterances run together with nothing between them read as one broken sentence
     (`"Let me look at the workspace.我先确认几件事："`) — the break is the answer to that,
     and no ending trims — see [`ask_user`](#ask_user-and-the-suspended-turn).
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

> **The clock is stated on every turn.** `agent/clock.ts` formats it; the *zone* comes from the
> client (`TurnRequestMeta.timezone`), read from the browser rather than from the server, which
> may be on a desk while the user is on a phone in another timezone. The reason is a failure
> rather than a nicety: a model asked about "today" without a date answers from the most recent
> date in its training data, and nothing in such a reply reveals that it is wrong. That is also
> why it is unconditional — it rides turns that have nothing to do with time, because the
> failure being fixed is a model that does not know it should have checked.

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
- **The refusal itself is the net under that gate.** The gate is right in principle and wrong
  about particular providers: DeepSeek V4 turns thinking on by default, and its model id contains
  none of the words `guessCapabilities` looks for — so a V4 entry added by hand got `["tool_use"]`
  and failed every turn that replayed a tool call. `createReasoningFetch` therefore watches for a
  400 whose body carries this sentence, echoes the field on a single retry of that request, and
  remembers for the rest of the turn. A refusal that says something else is passed through
  untouched: retrying an error the message did not describe is a second request sent for no
  reason. `guessCapabilities` stays as it is, and deliberately: guessing `reasoning` for the
  `deepseek-v4` family would guess wrong for a gateway serving the same id that rejects an unknown
  field — a failure the app cannot recover from — so the record declares it and the refusal is the
  net for everything a guess would have to get right twice.

Reasoning is persisted for display but **never replayed into history** — see
`buildHistoryMessages()`, which only reads `content` and `toolCalls`.

#### Naming a conversation

After **every** turn whose conversation is still `titleSource === "auto"` and not yet
`title_state === "model"`, the route calls `generateTitle()` (`agent/title.ts`) — a separate,
non-streaming completion with `maxRetries: 0` and a 512-token cap. The budget is generous because
reasoning models spend it on chain-of-thought before emitting any content; a tight cap returns an
empty answer and no title. What it reads is the conversation as it now stands (the opening message
plus the most recent — `conversationExcerpt`), so a conversation that opens with a greeting can be
named on a later turn, which is the whole reason the gate is not "the first turn".

Three answers, and the caller must tell them apart:

- **a title** — saved, and a `title` event is emitted between `message_done` and `done`;
- **`NO_TITLE`** — the model read the conversation and there is nothing to name in it yet. No title
  is written, `title_state` becomes `"unnamed"`, and the **next turn asks again**;
- **a throw** — the route falls back to `fallbackTitle()` (the user's own words, one line, ~40
  chars) and records `"fallback"`, so the next turn and the leave path both try again.

Neither failure can turn a successful chat turn into an error, and a decline is not a failure: the
difference is between a call that never worked and a model that looked and said no. `title_state`
(`'model'` / `'unnamed'` / `'fallback'`, absent for never attempted) is a third question beside
`title_source`; without it a model-written title and the user's own clipped words were the same
value to every reader, and a decline had nowhere to be expressed at all.

The writes are guarded — `title_source = 'auto'` is in the statement's own `WHERE`, not in its
callers' checks — because a rename landing between the read and the write is otherwise an
automatic title overwriting the name a person chose; `changes === 0` is how the caller learns it
lost that race, and the SSE event is sent only when the title write landed. Recording a decline
(`setTitleStateForUser`) is the same statement with the title column left out of the `SET`, and
deliberately does **not** bump `updated_at`: a conversation nobody has said anything in has not
moved, and a decline reordering the sidebar would say it had.

**A titling that failed gets a second chance when the reader leaves**, through
`POST /api/sessions/:id/leave`. The trigger is the client's, because only the browser knows the
reader has gone and the server's own hook (`finishTurn`) is a turn ending rather than a reader
leaving; the answer comes back on that response rather than on an SSE stream that no longer
exists. Three things it deliberately is not: it never blocks the leave (the client reports and
forgets), it cannot fail one (every failure is a 200, and the client says nothing), and it does
**not** write the fallback — repeating that string would be a no-op that also marked the row as
attempted. It is also not asked of a conversation whose state is `'unnamed'`: that means the turn
which just ended put *this* conversation to the titler and was told there was nothing to name, so
the second look would buy the same answer twice. One in-flight attempt per conversation is joined
rather than duplicated, and the client gates on the same predicate *before* reporting — reading the
live row rather than the one it was handed, since `loadSessions` replaces the list at the end of
every turn. `composables/sessionLeave.ts` holds the debounce.

The name is then run through `uniqueSessionTitle` (`sessionTitles.ts`) against its siblings in
the workspace, which is why the answer that is *stored* may carry a `(2)` the model never
wrote — and why the `title` event carries the numbered one, so the sidebar and the database
never disagree. Creation and `PATCH /api/sessions/:id` go through the same call; see
`docs/configuration.md` → Conversation titles for the rule.

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

Bytes live at `<userRoot>/sources/raw/<fileId>.<ext>` — deliberately outside the
workspace, so chat uploads never pollute the user's project directory or appear in the
agent's `list_files`. What is stored is a `files.path` relative to the user root, and
`resolveFilePath` (`resourcePaths.ts`) validates it on **every** read — refusing an escaping,
absolute or empty path — including one that came out of the database, because a row is not a trust
boundary. The tree is **passed in** as a `UserLayout`, not a module constant: it belongs to an
account under a data root the process chose at launch, so there is nothing to compute at import
time. That is also what keeps `config.ts` importable by the test suite — see "Config" above.

The v4 split is at its clearest here. The bytes and the title are a **file**, owned by the
account; the conversation working from it holds a **work resource** — a reference. Two
consequences worth knowing before reading the rest of this section:

- **Identical uploaded bytes are one file.** `UNIQUE (user_id, sha256)`, narrowed to `upload` and
  `attachment` so two parse results that happen to be byte-identical cannot collide, and with the
  hash scoped to the account — a lookup by hash alone would hand one account's file to another who
  uploaded the same content. Re-uploading a PDF reuses the row and the bytes; what it does **not**
  reuse is the parse, which lives on the reference, so a second conversation uploading the same PDF
  parses it again.
- **A file outlives every reference to it.** Deleting a reference removes *this owner's* use and
  touches nothing on disk — a sibling conversation holding its own reference can still read the
  file. `DELETE /api/resources/:id` deletes a reference; the file manager's delete is the one that
  moves bytes to `workspaces/<slug>/trash/<fileId>/`.

An `Attachment` carries **three ids**, and each answers its own question: `id` is the **file**
(where the bytes are, and what an image is fetched by), `resourceId` is the **reference** (what
`read_document` takes, and whose parse state is current), and `parsedFileId` is the **file holding
the extracted text**. Using one where another belongs is the mistake the trio exists to make
visible.

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
  raw/<fileId>.pdf        the original bytes
  parsed/<fileId>.txt     extracted text — a `files` row of its own, with no reference
```

**Parse state is not there.** It lives in columns on the **`work_resources`** row — the reference
— which is the "index it in the database" half of the design, and it buys what a
`parsed/<id>.json` sidecar could not: a reparse is visible immediately, from every surface that
reads the reference. Only the extracted text stays a file: it is large, and `read_document`
streams it by offset. That text is a `files` row reached through the reference's `parsed_file_id`
— registered and deliberately **not** referenceable, so no parse result ever appears in the
library.

The cost of putting the parse on the reference rather than the entity is stated rather than
hidden: **the same file referenced by two owners is parsed twice.** v3 parsed it once and showed
the reparse to both; here each reference owns its run and its text, because that is the row the
requirement asks the state to describe.

The two directories are siblings, which used to be *load-bearing*: `findStoredAttachment()`
located an attachment by globbing `<id>.*` in the session directory, and `txt` is a legitimate
extension in the MIME table — so a flat `<id>.txt` could be found ahead of the original PDF
and the download endpoint would serve extracted text instead of the file. Nothing globs any
more, because the path is a column, so that collision is unreachable rather than merely
avoided. The split stays because raw bytes and derived text are different kinds of thing.

**Extraction is asynchronous.** A cloud job routinely takes tens of seconds (five
minutes is the ceiling), so the upload endpoint answers immediately with `parseStatus:
"pending"` and a background `DocumentService` queue does the work — keyed by **reference id**,
because the parse belongs to one owner's use of the file rather than to the file. `cancelResource`
takes that same id, so deleting one reference stops its parse and leaves every other owner's row
running. The client polls `GET /api/sessions/:id/resources` and the composer **blocks
sending until every staged attachment has settled** — the text is injected when the message is
built, so sending early would produce a turn where the model never saw the document the user
attached.

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
| `POST /api/sessions/:id/resources` | upload a file and reference it from this conversation |
| `GET /api/sessions/:id/resources` | every reference this conversation may read, with its parse state — **the model's whitelist too** |
| `GET /api/resources` | the account's references, filtered by resource type, owner, category, mime, name, workspace and conversation |
| `GET /api/resources/:id/preview` | one reference, described the way a workspace file is |
| `GET /api/files/:id/raw` | a **file's** bytes, for a thumbnail or a download — by file id, because "which reference" has no answer when a file has several |
| `POST /api/resources/pages` | add a page by URL, to a workspace — fetched through `web_fetch`'s guard |
| `POST /api/resources/:id/reparse` | re-run extraction for one reference |
| `DELETE /api/resources/:id` | remove **this owner's reference**; the bytes and every other owner's reference stay |
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
| `POST /api/workspaces/:workspaceId/sessions` | create a conversation (copies the Copilot's whole definition in); the title is numbered against its siblings |
| `PATCH /api/workspaces/:id` | rename, describe, and/or replace the workspace's own defaults — each field independent |
| `GET /api/workspaces/:id/files?path=` | one directory level of the workspace, for the sidebar's file tree |
| `GET /api/workspaces/:id/files/content?path=` | a file's metadata, and its text when it is text |
| `PATCH /api/sessions/:id` | rename (numbered against its siblings), describe, update per-conversation settings, or re-persona it (`systemPrompt`, `tools`); a title also flips `titleSource` to `user` |
| `POST /api/sessions/:id/resources` | upload (base64 JSON); schedules parsing for this reference |
| `GET /api/sessions/:id/resources` | what this conversation can read, with parse state |
| `GET /api/files/:id/raw` | serve a file's bytes back |
| `POST /api/resources/:id/reparse` | re-run extraction |
| `GET/POST /api/document-parsers`, `PUT/DELETE /api/document-parsers/:id` | cloud parser CRUD |
| `GET /api/document-parsers/kinds` | the protocol kinds the server implements |
| `POST /api/document-parsers/:id/test` | round-trip a throwaway document |
| `PUT /api/document-parsing` | the parsing policy |
| `POST /api/sessions/:id/chat` | the SSE chat stream |
| `POST /api/sessions/:id/answers` | answer a suspended `ask_user` call, and stream the resumed turn |
| `POST /api/sessions/:id/stop` | interrupt the turn streaming for this session; `{ ok }` says whether one was running |
| `POST /api/sessions/:id/leave` | the reader has gone — try the titler again; `{ status: "titled" \| "skipped" \| "failed", title? }`, always 200 |
| `POST /api/sessions/:id/lock` | take or renew this conversation's write lock; 409 `SESSION_LOCKED` when another client holds it |
| `DELETE /api/sessions/:id/lock` | give it back; always 200, `{ released }` says whether there was anything of this client's to give back |
| `GET /api/workspaces/:workspaceId/locks` | every **live** lease in the workspace, `mine` computed from the caller's client id — one request, not one per conversation |

The three lock routes are documented in `docs/session-locks.md`, which also states what the lease
deliberately does not guarantee. Every session-scoped write carries the `requiresSessionLock` route
config and is checked by a shared hook; the routes that deliberately do not are asserted by
`test/route-lock-coverage.test.ts`.

Provider responses **never** include `apiKey` — only `hasApiKey: boolean`. `PUT`
treats an absent `apiKey` field as "leave unchanged" (an empty string clears it),
which is what lets the UI round-trip a provider whose key it cannot read.
Deleting the last provider or the current default returns 409.

The two endpoints that run a turn share `turnContext()` — provider, model and tool set,
resolved identically — and `finishTurn()` — persist the assistant message, emit
`message_done`, auto-title the conversation while it has no name yet, emit `done`. It reads the **session and nothing
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
- `components/` — `WorkspaceHome` (the front door: a card per workspace, and a rail whose
  foot is the account's menu), `Sidebar` (workspace + session nav, inline rename, guarded
  deletes, and that same menu at its foot), `AppMenu` (the account's two groups of rows — what it
  can reach, and who is signed in — drawn by *both* rails, so the two cannot drift), `ChatView` (topbar
  with inline title editing + messages), `MessageItem` (markdown, tool cards, attachments,
  reasoning, per-turn token line, copy action), `ReasoningBlock`, `MessageMinimapRail` (one
  anchor per turn), `ToolCallCard` (collapsible args/result), `Composer` (paperclip/paste
  uploads, session-params button, token popover, model picker), `ModelSelector`,
  `AttachmentChips`, `TokenCountPopover`, `LibraryBrowser` (every reference the account holds,
  filterable, with one add entry), and the dialogs: `ConfirmDialog`, `CopilotsDialog` (the
  account's own Copilots) with `CopilotDialog` as its editor, `AddResourceDialog` (a tab per
  kind of material), `ProviderDialog`, `NewSessionDialog`, `SessionSettingsDialog`,
  `WorkspaceSettingsDialog`, `CreateWorkspaceDialog`, `FilePreviewDialog`. `AdminConsole`
  and its `admin/ProvidersSection` and `admin/DocumentsSection` hold the installation-wide
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
belonging to whichever is open (`+`, or refresh). The strip is the shared `.tabs` the ask_user
and quiz cards also draw, not a second kind of tab; the panel below it is one `.side-scroll`
either way, because the sidebar's pinned header and footer depend on there being exactly one.

Below the panel sit the account-level rows — **工作区设置**, **Copilot**, **Your account**, **Platform
console** (administrators only) and **Sign out** — and they share every style except the divider,
which is named on the first row rather than expressed as `:first-of-type`: that would match the
header's back button, since it is the sidebar's first `<button>` and these are several siblings
further down. One footer group, not five entries of a list. Sign out takes no confirmation,
because the session is restored by signing in again and a misclick costs only that. It lands on
the sign-in screen even when the request fails, and the stored token is cleared either way —
leaving someone looking signed in is the worse of the two outcomes. The workspace home carries
the same destination for the two rows that make sense without a workspace — Copilot and Your
account — since that page is reachable with no sidebar at all.

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
- **Workspace settings** — a dialog of its own, not a tab of anything else, because it
  configures *a workspace* rather than the installation. Three ways in, and each earns its place:
  the gear on a workspace card (which does not require entering the workspace first, so widgets
  can be installed before there is anything to look at), the workspace name in the sidebar header
  (a button for that reason), and the 工作区设置 row at the foot of the sidebar — the labelled copy
  of the header shortcut, for someone who does not already know the name opens it. Both sidebar
  entries call the same function, so they cannot diverge in what they open. The row is the one
  entry the workspace home's rail does *not* draw: that page is about the list of workspaces and
  has no workspace in hand, so its entry is the gear on the card, which knows which one it means.
- **The 助理 list** — the row both rails draw, at the foot of a conversation's sidebar and at the
  foot of the workspace home's rail. Two surfaces, one component (`AppMenu.vue`), and the second is
  not a convenience: the home page has no sidebar, so without it an account that has not entered a
  workspace yet could not manage the assistants it made. That is exactly the access the header button protected when it opened the settings dialog
  it used to — the button outlived the dialog because the reason did. Like every other overlay it
  is opened, not owned, by its callers: `composables/ui.ts` holds `copilotsOpen` and `App.vue`
  mounts the dialog once, so neither entry point needs a prop chain.
- **Nothing is a "global settings" dialog any more.** What that dialog held was either
  installation-wide — providers and models, document parsers, the app defaults, all of which are
  the platform console's screens, since they are shared by every account and only an administrator
  may write them — or the account's own Copilots, which have the dialog above. What is left of the
  `settings.*` catalog namespace is the console's sections plus one pointer the Copilot list shows
  an administrator, which is why the namespace survives its dialog.
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

**One widget produces its data on demand, and it is the only one that does.** The insight panel
(`id: "insight"`) shows typed observations from the [insight pass](#the-insight-pass-insightsts-agentinsightsts),
which runs when the reader presses a button — no install hook, no load-time fetch of anything but
the list, and no widget event to subscribe to, since every change to it is a decision the component
itself made. Its row carries `adopted`, which is the only thing that survives the next pass. That
is also why it is not in the `"study"` group: the group's rule is "live on install" and this one
waits to be asked (see [widgets.md](widgets.md#an-on-demand-widget-with-no-tools-the-insight-widget)).

**A panel over the registry shows the conversation's material, not the model's whitelist.**
The resources panel (`id: "sources"` — the id is a key and did not move with the wording) reads
`GET /api/resources?sessionId=…` — the references this conversation holds — rather than
`GET /api/sessions/:id/resources`, which is the three-arm whitelist and is exactly what
`read_document` is bound to. The two are one route apart and answer different questions: what a
panel should show is what the conversation is working from, and the whitelist would put a granted
workspace's whole corpus beside the three files it is about. It filters by category
**client-side**, from the rows it already has, because one conversation's list is small and the
option list is the one thing the server cannot answer in the same request — see
[resources.md](resources.md) and
[widgets.md](widgets.md#a-viewer-over-the-registry-the-resources-widget).

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

The open tab is **one global preference, and that is why a conversation's creation writes it.**
The strip prefers the remembered id whenever it happens to be installed, so a tab read in one
conversation would win over the panel's own `ids[0]` fallback in every later one — the reported
"a new conversation opens on the wrong tab". `createSession` therefore ends by writing the strip's
first tab (`activateFirstWidget`), which is the same expression the fallback computes, so the fix
and the fallback cannot disagree. Selecting a conversation that already exists deliberately does
**not** touch it: that is where coming back to the tab you last read is the point. The write is
guarded (`activateWidget`) because an id the object does not have is a preference for a tab that
does not exist — a stored id nothing can draw is a lie until the next click.

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
at a time through `setWidgetEnabled`, or all at once in a create request — the create dialog
chooses a selection before the object exists. The creation case runs the hooks from the *resolved*
read, because a conversation copies its Copilot's selection and the request may name no widgets at
all. The hook mechanism is covered by the store tests with a stubbed registry entry
(`WIDGET_MODULES.thread`), since a hook that has to exist for the test to run would be asserting
itself.

**The workspace level has no widgets.** It kept its routes, its `widget_instances` rows, its
dialogs and its half of `WIDGET_SCOPES` when the two demo statistics panels were removed, so
`widgetsForScope("workspace")` is `[]`: the strip draws one group, no divider, and the workspace
dialogs hide their widget sections. A stored workspace row is not an error — reads resolve through
the registry, so it is simply never returned — and `apps/server/test/widgets.test.ts` is where
that state is asserted rather than assumed.

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