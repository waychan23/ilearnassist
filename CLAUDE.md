# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**ilearnassist** is a self-hosted agent product for one person, with accounts
(Browser/Server architecture). It provides a chatbox-like UI over a manual ReAct
agent loop with tool calling. Three apps share a types package:

- `apps/server` — Fastify 5 + better-sqlite3 + LangChain.js (`@langchain/core`,
  `@langchain/openai`). Runs the agent loop, streams results over SSE, and serves
  the built frontend when there is one.
- `apps/web` — Vue 3 (Composition API) + Pinia + Vite. Renders the chat UI.
- `apps/desktop` — Electron. A "control panel" that starts/stops the server and opens
  the app, packaged as a Mac `.dmg` for people who do not want a terminal. Supervises
  the server as a child process; reimplements none of it. See `docs/desktop.md`.
- `packages/shared` — dependency-free API/domain types used by both sides.

The name the product **displays** is 交互式学习助理 / Interactive Learning Assistant
(`app.title` in the two catalogs; the browser tab is set from it by `composables/locale.ts`). Every
*identifier* keeps `ilearnassist`: the package names, `app.setName`, the
`~/Library/Application Support/ilearnassist` userData directory, `ilearnassist.sqlite`, and the
`[ilearnassist] listening on` line the desktop panel parses to know the server is up. That split is
deliberate and load bearing — two of those decide where a user's data already lives — so renaming
the display name is one value in two catalogs, while renaming the *product* is a migration.

Everything a person makes lives in a **data root they choose at launch**, not next to the
code — so uninstalling the app leaves it behind. `apps/server/src/paths.ts` is the one
description of that tree:

```
<dataRoot>/
  users/<userSlug>/
    workspaces/<wsSlug>/
      workdir/                 the agent's file-tool sandbox and the file browser's root
      sessions/<sessionId>/    a conversation's own files — diagrams, and anything else
      trash/<sourceId>/        a file deleted from the file manager, bytes kept
    sources/
      raw/<sourceId>.<ext>     an uploaded file, one per distinct content per account
      web/<sourceId>.<ext>     a page the agent fetched and kept
      parsed/<sourceId>.txt    its extracted text, for every kind of source
  db/sqlite/ilearnassist.sqlite
```

`sessions/<sessionId>/` is a conversation's **own** folder, and it has **two writers**: the file
tools, when a write is aimed there (or when it is where the conversation's default points), and
`ila_diagram`. It is a sibling of `workdir/` rather than a corner of it, deliberately: the
workdir is the tree every conversation in the workspace shares, and a conversation's own files
are not the same kind of thing. The rule that used to stand here — "nothing in it that a typed
tool did not write", argued from `write_file` being unable to *reach* it — is restated rather
than kept: what matters is that **every file in it is a source row**, addressable by id, which
is what `sourcePaths.ts` refusing the traversal still guarantees in the other direction (a
workspace-relative path cannot climb into `sessions/`). See `docs/sources.md`, `docs/diagrams.md`.

**Every file and every page is a `source`** — one table, one id space, one registry
(`sources.ts`). An upload, a fetched page, a file the agent wrote into either sandbox: all four
carry `origin` (how it came to exist), `storage` (which root its bytes are under) and `category`
(what it is). `docs/sources.md` is the reference.

## Commands

```bash
pnpm install           # first time — see "Gotchas" below
pnpm dev               # run server + web together (backend :3720, web :5173)
pnpm dev:server        # tsx watch src/index.ts (backend only)
pnpm dev:web           # vite (frontend only)
pnpm dev:restart       # stop this repo's leftover dev servers, then start (see Gotchas)
pnpm dev:stop          # stop them and start nothing
pnpm dev:status        # report what is running and which ports are held
pnpm typecheck         # tsc (server) + vue-tsc (web) + the e2e specs
pnpm test              # vitest: unit + integration (server + web), no network
pnpm test:coverage     # the same, with a coverage report (see "Testing")
pnpm test:e2e          # playwright: real browser + real server + a fake LLM
pnpm build             # production build of the web app
pnpm desktop:dev       # bundle and launch the Electron control panel
pnpm desktop:package   # build a Mac .dmg (apps/desktop/release/)
```

TypeScript is strict (`strict`, `noUncheckedIndexedAccess`, `isolatedModules`,
`moduleResolution: Bundler`, ESM). Run `pnpm typecheck` before finishing; a
clean typecheck is the bar for "done".

### Typecheck workaround

`pnpm typecheck` can be blocked by a host-level pnpm supply-chain policy
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) shortly after packages like
`@langchain/core` are published. This is transient (resolves within a day) and
is not a code problem. To typecheck without hitting the policy, invoke the
binaries directly:

```bash
( cd apps/server && ./node_modules/.bin/tsc --noEmit )
( cd apps/web    && ./node_modules/.bin/vue-tsc --noEmit )
```

## Testing

**Every change ships with tests.** New behaviour needs a test that fails without it; a bug
fix needs a regression test that fails on the old code. `pnpm test` and `pnpm typecheck`
must both be clean — CI (`.github/workflows/ci.yml`) enforces it, so a red run is not
mergeable. The whole suite is offline: no API keys, no network.

```bash
pnpm test              # vitest, both apps (~670 tests, a few seconds)
pnpm test:watch        # same, in watch mode
pnpm test:coverage     # with a report; HTML lands in coverage/
pnpm test:e2e          # playwright (needs: pnpm exec playwright install chromium)
```

### Where tests live

| Path | What belongs there |
| --- | --- |
| `apps/server/test/` | unit + integration, mirroring `src/` |
| `apps/web/test/` | unit tests for utils, the API client, the composables and the Pinia store (jsdom) |
| `apps/web/test/i18n/` | catalog and hardcoded-text guards (see below) |
| `apps/desktop/test/` | the control panel's paths, launch spec, process supervision and catalogs |
| `e2e/*.spec.ts` | browser flows against the real stack |
| `e2e/workspaces.ts` | `enterWorkspace()` / `leaveWorkspace()` — the front door, for specs |
| `e2e/auth.ts` | the account the suite acts as, `signIn()` / `forgetSession()`, and `ensureUser()` for a second one |
| `e2e/fixtures.ts` | the suite's `test` — the saved token on its `request` fixture |
| `e2e/auth.setup.ts` | the `setup` project: signs in as the CLI-created administrator, saves `storageState` |

Each app's `tsconfig` includes its `test/` directory, so **`pnpm typecheck` checks the
tests too**. For `apps/web` that also means `pnpm build` (which runs `vue-tsc`) fails on a
test type error. That is deliberate.

### Testing the agent without a model

Never call a real provider from a test. `apps/server/test/helpers/fakeLlm.ts` is a
scriptable OpenAI-compatible server: point a provider's `baseURL` at it and the *real*
`ChatOpenAI` → `createReasoningFetch` → `runAgentStream` → SSE route path runs end to end,
deterministically and offline.

```ts
const llm = await startFakeLlm();
const env = await startTestServer({ providers: [providerFor(llm)] });
llm.setTurns([{ reasoning: "hmm", content: "the answer" }]);
// …POST to /api/sessions/:id/chat via env.server.app.inject() and parse the SSE frames
```

It also runs standalone (`pnpm --filter @ilearnassist/server fake-llm`), which is how
the Playwright suite scripts it over HTTP.

`apps/server/test/helpers/fakeParser.ts` is the same idea for document parsing: a
scriptable stand-in that speaks all three cloud-parser protocols (`sync` multipart,
MinerU's presigned-upload-and-poll, LlamaParse's multipart-and-poll), so the *real*
drivers run — presigned `PUT`, job polling, ZIP extraction, Bearer auth, error mapping —
with no account at any vendor. It runs standalone too
(`pnpm --filter @ilearnassist/server fake-parser`), and the Playwright harness starts
one so the cloud fallback is exercised in a browser.

Reuse these rather than re-inventing them:

- `startTestServer()` — a real server on a **throwaway temp directory**; never the repo's
  `data/` or `workspaces/`.
- `parseSse()` / `eventTypes()` — SSE transcript → typed events, mirroring the browser
  client's parser.
- `providerFor(llm)` / `keylessProvider()` — provider records with and without a key.

### Testing the HTTP layer

`app.inject()` captures a hijacked SSE response in full (status, headers and body), so
route and chat tests need no port and no network — see
`apps/server/test/chat-sse.test.ts`. Use a real `listen({ port: 0 })` only when a browser
is the client.

### Testing the i18n catalogs

`apps/web/test/i18n/` is a set of guards rather than feature tests, and adding a string
means satisfying all of them:

- **`catalog.test.ts`** — key symmetry both ways, no empty values, no untranslated Chinese
  left in `en.ts`, placeholder parity across plural branches, a message for every
  `ApiErrorCode`/`ParseErrorCode`, every statically-written key resolves, and no dead keys.
  Keys built by concatenation are recognised by their trailing dot and matched against an
  explicit dynamic-prefix allowlist — keep that list narrow, since a broad prefix is where
  a typo hides.
- **`no-hardcoded-text.test.ts`** — fails on a user-facing CJK string anywhere outside
  `src/locales/`. Mark a legitimate exception with a `// i18n-exempt: <reason>` line
  comment, on the line or the one above; `grep -rn "i18n-exempt" apps/web/src` should
  return exactly one file. If it returns more, the guard is being routed around.

Tests that assert on wording must **pin the locale** (`i18n.global.locale.value = "zh-CN"`)
rather than inherit jsdom's `en-US` navigator — otherwise they pass against the English
catalog, which is a test passing for the wrong reason.

In Playwright, `locale: "zh-CN"` is pinned on the project in `playwright.config.ts`, so
every spec renders Chinese and inherits the pin. `e2e/i18n.spec.ts` is the only place the
other locales are exercised, and it scopes its `test.use({ locale })` overrides to its own
`describe` blocks.

**Every browser spec starts signed in, and does not have to say so.** The server refuses to
listen without an administrator, so the Playwright config chains the idempotent
`cli ensure-admin` ahead of the server's own command (`globalSetup` runs *after* the webServers
and so cannot do this); the `setup` project then signs in through the form and saves the token
as `storageState`, which both real projects load. That is why ~70 specs that are not about
authentication needed no edit when sign-in arrived. A new spec inherits it and should not
think about it; the one file that must *not* — `e2e/login.spec.ts` — clears the browser state
with a file-scoped `test.use({ storageState: { cookies: [], origins: [] } })`, which is why it
is a file of its own rather than a `describe` block: a `describe`-scoped override can be
inherited by a sibling that did not mean to. Two consequences of the session being a token
rather than a cookie: specs get their `request` fixture from `e2e/fixtures.ts`, which puts the
saved token on it (Playwright can only carry cookies into an `APIRequestContext`), and a spec
that needs to *sign out* calls `forgetSession()` first and signs in for a session of its own —
signing out revokes the shared one server-side, which would sign out every spec after it. It is also a project **dependency** rather than a
`globalSetup`, because a `globalSetup` may run before the `webServer` entries are up and this
has to reach one.

### What is deliberately *not* unit tested

The Vue components. The Playwright suite covers them, which is why the Vitest coverage
config excludes `*.vue` — a browser run's coverage cannot be merged into that report, so
counting them there would only produce a number nobody acts on. Add a `data-testid` to any
component a flow needs to select.

## Layout

```
config/config.yaml        # bootstrap (server/workspaces/tools) + seed data (providers/models)
vitest.config.ts          # root vitest entry (server + web projects; coverage scope)
playwright.config.ts      # starts the fake LLM, the server and vite for e2e
e2e/                      # playwright specs + the e2e config overlay + teardown
scripts/dev.sh            # restart `pnpm dev` from a clean slate — see Gotchas
apps/desktop/src/
  shared/panelApi.ts      # the IPC contract (channels, ServerStatus, PanelApi)
  shared/messages.ts      # the panel's two catalogs + fault → sentence
  main/main.ts            # Electron: windows, menu, IPC handlers, the needsAdmin gate on Start
  main/serverProcess.ts   # supervises the long-lived server child (start/stop/crash/timeout)
  main/oneShot.ts         # runs the one-shot CLI child, feeds stdin, collects stdout/stderr
  main/admin.ts           # wraps the CLI: parse its envelope into typed create/status results
  main/paths.ts           # per-user layout + idempotent first-run seeding
  main/launch.ts          # child env (ELECTRON_RUN_AS_NODE, ILA_*) + stdout parsing + adminEntryFor
  main/lan.ts             # which address a phone can reach, ranked
  main/settings.ts        # the panel's own preferences (LAN sharing)
  shared/qr.ts            # URL → module square, and → drawable runs
  preload/preload.ts      # contextBridge surface — every command, nothing else
  renderer/               # the panel page (plain HTML/CSS + one bundled IIFE)
apps/server/src/
  index.ts                # bootstrap + assertHasAdministrator + the listening line + SIGTERM
  cli.ts                  # the administrator CLI entry (argv/stdin/exit codes; rules in adminCli.ts)
  adminCli.ts             # status/create-admin/reset-admin rules, no process access; the boot gate too
  webApp.ts               # serves the built frontend beside the API, when there is one
  config.ts               # YAML + ${ENV} + .env + resolveDataRoot + the config.patch.json overlay
  paths.ts                # the on-disk layout: data root → users/<slug> → workspaces, sources, db
  prompts.json            # every system prompt and guidance block, keyed — see docs/prompts.md
  prompts.ts              # the catalog: rendering, {{placeholders}}, and config.patch.json overrides
  schema.ts               # the DDL, schemaProblem, and the user_version guard (one transaction)
  apiError.ts             # the { error: { code, message, params } } envelope, shared with the CLI
  auth.ts                 # accounts: scrypt passwords, credential policy, bearer tokens, the gate
  db.ts                   # better-sqlite3 CRUD (snake_case cols), user-scoped accessors
  workspace.ts            # resolveInWorkspace sandboxing + dir mgmt + slug rules
  files.ts                # the file browser's read side, for both roots: one level, one file
  attachments.ts          # multimodal content building (the MIME vocabulary moved out)
  sourcePaths.ts          # where a source's bytes are, the MIME table, the blob derivations
  sourceCategory.ts       # what a file is: one MIME type and one category, from a name
  sources.ts              # the registry: registerFileSource/rename/reconcile, the page row
  fileOps.ts              # the file manager's writes: create, upload, move, delete-to-trash
  migrations.ts           # the version walk (v2 -> v3), canMigrate, openRefusal
  writeLocation.ts        # the four-level chain deciding which sandbox a write goes to
  routes.ts               # Fastify routes (workspaces/copilots/sessions/providers/attachments/chat)
  stream.ts               # SSE framing helper
  agent/loop.ts           # manual ReAct loop (model.bindTools → stream → run tools)
  agent/clock.ts          # what time it is where the user is, for the turn's prompt
  agent/model.ts          # ChatOpenAI builder + reasoning SSE tap
  agent/title.ts          # auto-generated conversation titles
  agent/mediaSummary.ts   # one line about an image, from the model that saw it
  agent/threads.ts        # the out-of-band topic classifier call
  agent/insights.ts       # the out-of-band insight pass call
  agent/reasoning.ts      # the `thinking` body field, capability-gated (both calls above)
  modelJson.ts            # fence-and-bracket stripping for an out-of-band answer (pure)
  modelLog.ts             # the append-only observation logs, one file per call kind
  documents/              # document → text: local extractors, cloud drivers, policy
  documents/local/        # pdfjs (PDF) + an OOXML/ODF reader over fflate
  documents/drivers/      # one file per wire protocol (sync / mineru / llamaparse)
  tools/index.ts          # tool assembly + ALL_TOOL_NAMES
  tools/fileTools.ts      # list/read/write/create_dir/delete_file (sandboxed)
  tools/documentTools.ts  # read_document — pages through a source's text, by whitelist
  tools/webSearch.ts      # bing / duckduckgo / tavily / searxng
  tools/webFetch.ts       # fetch a URL as text (SSRF-guarded)
  tools/askUser.ts        # ask_user — suspends the turn on a question; its result shape
  tools/collectPage.ts    # ila_collect_page — keeps a fetched page as a source
  tools/diagram.ts        # ila_diagram — writes a mermaid source (and its row) into the session
  tools/query.ts          # ila_query — the agent reads the conversation's own record, by kind
  tools/explore.ts        # ila_explore — the agent reads the `@`-granted workspaces: files, messages
  tools/resultPage.ts     # the paging engine ila_query and ila_explore share: clip, renderPage
  workspaceScope.ts       # the `@` grant: one resolver, the only reader of the stored setting
  diagrams.ts             # diagram rows: naming, registerDiagram, the thread join, fileMissing
  widgets.ts              # sumUsage + the widget-selection validator (pure)
  notes.ts                # the notes widget's records: what a body may become a note (pure)
  insights.ts             # the insight pass: prompt, defensive parse, the wipe-then-insert write
apps/web/src/
  stores/app.ts           # Pinia store (all state + actions)
  router/index.ts         # the route table + the RouterMeta augmentation (lazy view imports)
  router/guards.ts        # the only bridge between a URL and the store: gate, load, teardown
  api/client.ts           # fetch helpers + SSE parser (normalizes errors → ApiError)
  i18n.ts                 # vue-i18n instance + the localStorage key
  locales/                # zh-CN.ts (source of truth) + en.ts (typed against it)
  composables/confirm.ts  # promise-returning confirm() for destructive UI actions
  composables/openSession.ts  # "open this conversation": address it, or re-read the one already open
  composables/locale.ts   # language selection (sibling of theme.ts, not a store)
  composables/messageNotes.ts   # the message list ↔ notes widget capability + its claim
  composables/messageSelection.ts  # noticing a selection inside one message
  composables/notes.ts    # the notes widget's data (module singleton, not a store)
  composables/relativeTime.ts  # a timestamp as "3 分钟前", from the shared time.* keys
  composables/theme.ts    # light/dark/auto
  composables/widgetActivation.ts  # which widget is live on what is on screen (onActive)
  composables/widgetEvents.ts  # the widget event bus (no store import, so no cycle)
  composables/widgetPanel.ts   # the panel's persisted preferences + width clamping
  utils/apiError.ts       # server code → user-facing message
  utils/fileTree.ts       # the tree's arithmetic: flatten, move, find the parent row
  utils/fileViewer.ts     # the preview viewer's gate + theme/locale mapping (no DOM, no chunk)
  utils/openFileViewer.ts # the lazy viewer chunk + its vendor sheet — the only importer of it
  utils/locale.ts         # browser-language detection + the alias table
  utils/mermaid.ts        # the lazy mermaid chunk: theme variables, parse, render
  utils/noteAnchor.ts     # selection → quote + occurrence, and back (pure, DOM-only)
  utils/widgetTabs.ts     # the tab strip's fit arithmetic (pure)
  widgets/registry.ts     # widget id → component, catalog keys, lifecycle hooks
  widgets/NotesWidget.vue # the notes panel: the list, the toolbar, the empty state
  widgets/DiagramWidget.vue # the diagram panel: the conversation's diagram rows, and a jump to each
  widgets/InsightWidget.vue # the insight panel: typed observations, a generate button, adopt/delete
  widgets/SourcesWidget.vue # the sources panel: what this conversation holds, filtered by category
  widgets/*Widget.vue     # the two demo widgets (workspace stats, session stats)
  utils/mention.ts        # the `@`-mention: is the caret in one, and where the name goes
  utils/referencePicker.ts # the `@` list: tabs, type pills, grouping, the flat keyboard index
  utils/workspaceScope.ts # the `@` grant's set algebra on the client (what the next value is)
  utils/sourceTree.ts     # the source browser's tree: group by origin, flatten by open set
  components/…            # App, LoginView, WorkspaceHome, Sidebar, ChatView, MessageItem,
                          #   ToolCallCard, DiagramCard, MermaidDiagram, FileViewer,
                          #   AskUserCard, Composer, SourceMentionPicker, WriteLocationField,
                          #   FileTree, WidgetPanel, AppMenu,
                          #   WidgetTabStrip, GenerationParams, NoteEditor,
                          #   MessageSelectionToolbar,
                          #   dialogs (Settings, WorkspaceSettings, SourceBrowser, AddSource,
                          #   FilePath, FilePreview, Diagram, Confirm, WidgetToggleList)
apps/server/test/         # unit + integration tests (vitest, node env)
apps/web/test/            # unit tests (vitest, jsdom)
packages/shared/src/index.ts  # all cross-boundary types (ChatStreamEvent, ToolCall, …)
```

## Reference project: chatbox

This app is modeled on [chatbox](https://github.com/chatboxai/chatbox) (Electron
+ React). A clone kept for reference lives at
`/Users/waychan23/Documents/work/spaces/trae/chatbox` — treat it as a
behavioral/UX reference only (chatbox is React/Electron; ilearnassist is
Vue/Fastify), so port ideas rather than copy code. Quick map:

- `src/renderer/` — chat UI, settings, Copilot/agent config screens
- `src/renderer/packages/web-search/` — keyless Bing + DuckDuckGo scraping
- `packages/chatbox-core/src/models/` — model/provider adapters
- `packages/chatbox-core/src/generation/` — agent/tool (ReAct) loop
- `features/*.feature` — higher-level feature specs

Fuller map in `docs/reference.md`.

## Invariants worth respecting

- **Sandboxing is a security boundary, and there are now two sandboxes.** All file-tool paths
  MUST go through `resolveInWorkspace` (rejects `..` escapes and absolute escapes) against the
  root the call selected — a workspace's `workdir/` or a conversation's `sessions/<id>/` — and
  never operate outside it. Do not add a file tool that bypasses this. The two are siblings, so
  the escape that matters most is the one a single-root implementation would miss: `../workdir/x`
  from a session, or `../sessions/<id>/x` from the workspace. Both are refused, and both are
  tested, in `test/tools/fileTools.test.ts`.
- **Which sandbox a write goes to is a setting, and the setting has four levels.**
  `resolveWriteLocation` reads, nearest first: this turn's own instruction, the session's
  `settings.writeLocation`, the workspace's, then `DEFAULT_WRITE_LOCATION` — which is
  **`session`**. A Copilot is deliberately not read: its value arrives as `session.settings`
  because the conversation copied it at creation, the same reason `turnContext` consults the
  session and nothing else. The system prompt names both folders and the effective default, and
  the model is told to `ask_user` when it cannot tell — guidance as a prompt string, the
  `PLAN_GUIDANCE` shape, not a code path. Two consequences are load-bearing rather than
  incidental: the *default* is `session` because a workspace directory every conversation writes
  into is a junk drawer nobody organised, and that means most new files no longer appear in the
  sidebar's file tab, which browses `workdir/`. See `docs/sources.md`.
  The read and delete rules differ on purpose: a **read** with no `location` tries the default
  and then the other root and says which it used (a model that cannot find a file it wrote last
  turn stops trusting the tools), while a **delete** refuses when the path exists in both —
  deleting the wrong file is not a mistake a tool result can walk back.
- **The file browser reads the same directory the tools do, and is stricter about how.**
  `files.ts` resolves through `resolveInWorkspace` first — the same lexical boundary — and then
  `realpath`s the result, because the lexical check cannot see a symlink inside the workspace
  pointing at `/etc/passwd`, and in a browser a single click is enough to follow one. The
  agent's own tools keep the lexical-only behaviour on purpose: the model has no tool that
  creates a symlink, so one can only be there because the user put it there, and reading
  through it is then their decision about their own machine. That asymmetry is a product
  decision, not an oversight — do not "unify" the two without deciding which way.
  An entry is never *hidden* because a read would be refused: a path that was silently
  omitted is indistinguishable from one that was never there, so an escaping symlink is
  listed and the failure is reported when it is opened.
- **The file browser reads one directory level at a time, and its two endpoints are shaped
  for the writes that come next.** `GET /api/workspaces/:id/files?path=` and
  `…/files/content?path=` are the collection and the resource; a create, a save, a rename and
  a delete are additions beside them, not a rename of them. Listing is per level on purpose:
  a workspace with a `node_modules` in it costs one `readdir` until someone opens it, and a
  refresh re-reads only the directories actually on screen.
  `?path=` is a query parameter rather than a path segment because file names legitimately
  contain `/`, `#`, `&` and CJK — and because `?path=a&path=b` parses to an *array*, which
  `files.ts` refuses rather than letting a string operation on it become a 500.
- **A file's preview `kind` is the extension point.** `FileContent.kind` is a union
  (`text` / `markdown` / `diagram` / `binary`), so the next format is a new member and a
  branch in `FilePreviewDialog` — not a second endpoint. The server decides it *as far as it can*:
  it is the side that can sniff the bytes, and an unfamiliar extension is decided by a NUL check
  and a UTF-8 decode rather than a table, which is what makes `Makefile` and `LICENSE` readable.
  Past the preview cap the reply is a 200 with `truncated: true`, never an error — a 2 GB log
  is exactly the file someone opens to see the top of.
  **`diagram` is the first member added after the fact, and it taught that "the client switches
  exhaustively" was only true of sites that switched.** The dialog dispatched on a `v-else-if`
  chain whose last branch was `<pre v-else-if="content">`, so a `.mmd` compiled cleanly and
  silently rendered as highlighted source — plausible-looking, and wrong. The chain *became* a
  `switch` with an `unhandled(kind: never)` arm in the same change, which is what makes the next
  member a `vue-tsc` error rather than a fallthrough. A new kind is only a compile error once a
  site says so; until then the fallthrough is what handles it.
- **`binary` means "not text — hand the bytes to the viewer", and `unsupported` is now the
  client's claim rather than the server's.** The rule above ("the server decides, not the
  client") is about *text versus binary*, which is the question bytes are needed for. Whether
  anything can **draw** a file is a different question whose answer lives in a plugin registry
  inside a lazily fetched browser chunk, so the old `unsupported` had the server asserting a fact
  about a table it could not see — and the day a format gained support it would have gone on
  refusing it. `FileViewer.vue` owns both gates: our `fileViewerSupported` decides whether the
  chunk is worth loading at all (a `.bin` fetches no bytes and no chunk), and the library's async
  `isPreviewSupported` is the authority once it has. Preview bytes have their own route
  (`…/files/raw`, both roots) because they cannot ride in the JSON reply, and they answer
  `application/octet-stream` + `Content-Disposition: attachment` rather than the file's real
  type — deliberately unlike `/api/sources/:id/raw`, which serves the account's own uploads to an
  `<img>` where an SVG is inert. These are *agent-authored* bytes handed to a viewer that
  re-materialises some of them as HTML. The cap is `MAX_FILE_PREVIEW_BYTES` (32 MB) and a file
  past it is a **413**, not a 400.
  **There are three sources of a file and one dialog.** A workspace file, a conversation's own
  file, and an uploaded `source` — the last addressed by id rather than by a path, because a
  source lives outside every workspace. All three end in `readPreviewFile`, which exists so that
  *what is this file* is answered once: the sandboxes differ per root and must, but two copies of
  the extension tables is how a `.mmd` gets drawn in one dialog and shown as code in another.
  Uploads are reached from `SourcesDialog`, whose rows carry an open control — the only place an
  upload's contents were ever reachable, since the file tree cannot list them.
  **The viewer is a lazy chunk and must stay one.** `@open-file-viewer/core` is a single entry
  point with no `sideEffects` field, so a static import anywhere on the eager path drags ~25
  runtime dependencies into the initial bundle — `three`, `leaflet`, `xlsx`, a second `mermaid@11`
  and its ELK layout engine. Only `utils/openFileViewer.ts` imports it, only through `import()`;
  `utils/fileViewer.ts` is the DOM-free half and is safe to import eagerly, and a unit test fails
  if the library is evaluated at import. Its stylesheet comes in `?inline` and is injected under
  `@layer ofv`, for `@layer hljs`'s reason in `composables/theme.ts`; the token overrides live in
  `style.css` rather than a new file, because `style.test.ts` globs `src/*.css` **shallowly** and a
  subdirectory would escape every design-system guard. The library ships its own i18n, so the
  toolbar is translated by passing `locale`, not by adding catalog keys. `fallbackPlugin()` must
  never be passed: it is terminal, so it would make `isPreviewSupported` true for everything and a
  `.bin` would render an empty box instead of the unsupported panel. `textPlugin` is omitted
  (unreachable — every format it claims is already `text`/`markdown`), and the CAD peers are
  omitted because `@mlightcad/libredwg-web` is GPL-3.0. See `docs/file-preview.md`.
- **A diagram is a file plus two rows — each holding what the others cannot.** The contract used
  to be stated as "one writer, and a file plus a row"; it is now two writers (the file tools can
  be aimed at `sessions/<sessionId>/` too) and three records, because a diagram is also a
  *source* like every other file. `sessions/<sessionId>/` is read by the session-files routes. The `.mmd`
  is the source of the bytes; `session_diagrams` holds only what the file cannot answer: the
  canonical `name` (the join key, so the client never derives one), the model's `summary`, the
  `tool_call_id` that wrote or last revised it, and the `thread_id` the classifier put it in.
  The one drift still unrepresentable is two copies of the bytes disagreeing — the row holds no
  source and no `source_path` (a pure function of the session and the name). Drift is bounded and
  reported at both ends: a `.mmd` nobody drew has a file but no row (the source
  browser shows it, the diagram panel does not), a row whose file is gone reads `fileMissing`. The row
  has no `deleted_at` (derived data, like `session_threads`) and no `message_id` (the assistant
  message does not exist when the tool runs). A revise upserts on `(session_id, name)`: one file,
  one row, new summary and call id, `thread_id` cleared so the new shape is judged again. The
  naming rule (`diagramFileName`, `slugify`) is server-side in `diagrams.ts`/`workspace.ts` — it
  used to be shared because the client derived a name to find the call, and the row retired that
  derivation; only `isDiagramFile` and the size/tool-name constants stay shared. The third record
  is the **source row** (`storage: "session"`, `origin: "agent_session"`, `category: "diagram"`,
  with the model's summary), written in the same transaction as the other two — without it a
  diagram would be the one file in the app that the registry, the source browser and
  `@`-reference could not see, which is exactly the split this change exists to close. See
  `docs/diagrams.md`.
  **A diagram rides the turn classification.** The thread is assigned after the turn, so the tool
  writes `thread_id = null` and `threads.ts` places each diagram inside the same transaction as
  its turn's messages, shown to the classifier under the message whose call drew it (name and
  summary, never the source). The per-diagram answer is a second, **ref-keyed** array, so a bad
  entry can never shift a turn decision; the only valid values are `continue` (the turn's own
  thread) and an existing `eN` — never `new`, because a diagram has no messages of its own — and
  a missing/unusable answer, and any diagram in a deterministically-forced plan turn, collapses
  to the turn's thread. The invariant is one sentence and testable: a diagram's `thread_id` is
  null iff the turn owning its latest call has no thread yet.
- **A table is a row and nothing else, and the 图表 panel shows both kinds.** The requirement is
  explicit that a table's display is the **reply's own Markdown**, never a tool container — so the
  feature splits in two and each half holds one copy: the reply is what a person reads, and
  `session_tables.content` is what the panel, the viewer and the clipboard read. Nothing can make
  the two agree, so the drift is *reported rather than prevented* (the rule the two diagram drifts
  already follow): the tool's result says what was **saved** and asks for the inline copy
  separately, and `TABLE_GUIDANCE` is the only mechanism that can ask — no server-side code path
  writes into a model's reply, and the tool's own description is necessarily a restriction. Four
  things are load-bearing:
  - **The row holds the content**, which inverts `session_diagrams`' rule and is the one place to
    read before "fixing" it: a diagram's bytes are a *file*, so a second copy in the row would be
    two copies free to disagree; a table has no file, so the row is the only copy. `notes.body` is
    the same shape for the same reason. It writes **no `sources` row** either — a source's
    `rel_path` is non-NULL for both sandbox storages and every consumer is path-driven, so an
    honest one is impossible — and no `.md` file in `sessions/<id>/`, which would put two full
    copies of one source on disk.
  - **`ila_table` is `NON_FILE_TOOLS`.** The switch means "this agent does not write files", and
    the comparison is `ila_query`'s, not `ila_diagram`'s: a table writes a database row. Leaving it
    out would let an operator's file-tools switch silently remove a capability that never touched a
    file.
  - **Its call renders no card at all.** `ila_table`'s artifact is the reply, so a card could only
    repeat the summary and the generic disclosure would show the whole markdown as JSON in a fold —
    the shape the requirement rules out. The rule is `CARDLESS_TOOL_NAMES` and `ToolCallCard` is its
    only reader. What that costs is the jump anchor: 定位 emits `chat.jump` with a tool-call id,
    which used to resolve to the card, so `MessageItem` writes those ids on the message row as
    `data-tool-call-anchor` and `revealToolCall` matches one with a CSS `~=`. Do not delete either
    half without moving the anchor — a control that renders and does nothing is the failure this
    repo names most often.
  - **A table keeps the one content check this repo takes on** — a header separator row, refused
    before the write so a refused revise cannot wipe the row the panel holds. Only that row: a full
    parse would be a second renderer free to disagree with the `markdown-it` that draws it, which is
    the argument against validating mermaid. And because there is no file, the model's way back to a
    table it wrote is `ila_query(kind: "table")` — without it, "call again with the same name" is
    advice it cannot follow past the history window.
  - **The classifier places tables through the same machinery**, with two wire keys (`diagrams` /
    `tables`) over one parameterised parser, `d1` / `t1` refs as the discriminant, and a **separate
    `MAX_TABLES_PER_PROMPT`**. The one thing that must not be duplicated is the ref allocation: it
    is one loop over the same `modelTurns`, which is what makes a forced turn's table collapse
    exactly as its diagram does. See `docs/tables.md`.
- **Mermaid renders in its own component, never through `renderMarkdown`.** `renderMarkdown` is a
  synchronous `string → string` on purpose — that is the reason KaTeX was chosen over MathJax —
  and mermaid's API is async, so a diagram cannot go through the markdown path, and making the
  whole pipeline async for the one case that needs it is a large change for a small feature.
  `MermaidDiagram.vue` owns the async half (source that changes, a theme that flips, an unmount
  mid-render) and `utils/mermaid.ts` holds the part with no DOM. Two of its options are security
  boundaries rather than preferences, on the same footing as `html: false` and `trust: false`:
  `securityLevel: "strict"` (the source is model-authored) and `htmlLabels: false` (SVG `<text>`,
  no `foreignObject` of HTML). Its `themeVariables` are **concrete colours read from the palette**,
  never `var()` references, because mermaid computes with them in JavaScript. A failed render shows
  its own panel and keeps the source — it never blanks the bubble, the same reasoning as KaTeX's
  `throwOnError: false`. `style.test.ts` cannot see any of this: mermaid's colours are inline SVG
  attributes, so the runtime derivation is the whole mechanism and the theme case in
  `e2e/diagram.spec.ts` is what holds it up.
- **There is one code highlighter, and `highlight.js` is it.** `markdown.ts` exposes
  `highlightFile(code, fileName)` for the preview, and `renderMarkdown`'s fenced-code path
  calls the *same* internal helper and the *same* escaper — a file and a message must not
  colour one snippet two ways, and there must not be two escapers. The syntax palette is
  injected at runtime by `composables/theme.ts` rather than imported as a stylesheet, so the
  preview's `<pre>` carries `hljs` on the **`<pre>`** and not on the `<code>` (the vendor's
  `pre code.hljs { padding }` is what the other placement wakes up). The language comes from
  the file's extension via a short alias table, deliberately short because most extensions
  already *are* the highlight.js name; `.vue` is left out on purpose, since no grammar
  describes a template plus a script plus a style, and escaped plain text beats a wrong
  colouring. Past `MAX_HIGHLIGHT_CHARS` the text is escaped rather than tokenised — the cap
  exists because a minified bundle at the 256 KB preview cap costs a third of a second in
  `hljs` alone.
- **A code block's file name and language ride the fence's info string, and the header is
  chrome rather than content.** markdown-it already splits ` ```python app.py ` and hands the
  filename to the `highlight` hook as its **third argument**; the hook used to declare
  `(str, lang)` and drop it, so a name the model wrote was parsed and thrown away on every
  render. Both halves therefore reach the post-pass as **escaped attributes on the unforgeable
  marker** — escaped with the same `md.utils.escapeHtml`, which is what keeps a model-supplied
  info string from forging one. Three things are load-bearing:
  - **The header is `data-note-skip`.** It is the only renderer-added element that carries
    *text*, and `utils/noteAnchor.ts` counts a quote's occurrences over the message's visible
    text — so counting it would shift the arithmetic for every note anchored below it, including
    notes written before the header existed. (The copy control beside it takes the other route:
    no text nodes at all.)
  - **The copy control reads `querySelector("code")`**, so a copy yields the code alone, with no
    filename line. That is the whole reason the info string was chosen over a leading comment —
    and it is why the header is built from `<span>`s. `codeCopy.test.ts` asserts it against
    `renderMarkdown`'s real output, because wrapping a name in a `<code>` would silently start
    copying it.
  - **A language is claimed only when `hljs.getLanguage` knows it**, and an unrecognised info
    word produces no header at all. ` ```app.py ` is not a language, and a pill repeating a
    filename back as one would be the app inventing a fact.
  The other half is the prompt: `chat.guidance.codeFence` tells the model to name the file, and
  it is the one **unconditional** guidance block, because it is about the *format* of a reply
  rather than about a capability. Without it the renderer would be drawing data nothing produces.
- **The file tree's freshness is the refresh button plus the end of a turn.** The post-turn
  re-read hangs off `consume()`'s `finally` in `stores/app.ts`, which is the one point every
  turn ends at, and it is gated on a tree having been loaded at all — a panel nobody opened
  must not make every turn pay for a request. It reports nothing: a turn that wrote files is
  not a turn that was about the file browser, and a toast for it would interrupt a
  conversation that worked. Failures the user *did* ask for go to `fileTreeError` (the tree
  pane) or `filePreviewError` (inside the dialog) — not the global toast.
- **The message list follows its own end only while the reader is at it.** `useScrollFollow`
  owns that state, and `following` is also what renders the "回到最新" control — so a released
  follow always has a way back, which is the difference between this and a list that simply
  stops following. Do not put the obvious version back: assigning `scrollTop = scrollHeight`
  on every streamed delta returns a reader to the end on every token, which is a list that
  fights the scrollbar for the length of a turn. The release is derived from the scroll
  position (`utils/scroll.ts`) rather than from a flag set where movement is expected, because
  the position also moves for reasons no handler caused — a resize, a late font, an earlier
  message re-laying out when its highlighting or maths lands. `BOTTOM_SLACK_PX` is a tolerance
  for the end, not a threshold for near it: a slack wide enough to swallow a wheel notch
  re-grabs the viewport from someone on their way somewhere else. A turn *starting* pins to the
  end regardless, because the reader just asked for it.
- **A turn in flight is tied to the account that started it.** Signing out does not close the
  stream, so `consume()` records an **account epoch** on the way in and stops applying events once
  `forgetAccount()` has bumped it — otherwise a signed-out turn's later deltas land in whatever
  state the *next* account has by then, which is one person's reply appearing in another's
  conversation. `forgetAccount()` resets `streaming` for the same reason, and the two re-reads in
  `consume()`'s `finally` are skipped rather than merely harmless, since they are for the account
  that was signed in. Sign out is a click in the sidebar and on the workspace home, so this is a
  reachable path and not a theoretical one. It deliberately **does not** confirm first — with no
  password to forget, a misclick costs typing a name again — and it lands on the login screen even
  when the logout request fails, because the stored token is cleared either way and leaving someone
  looking signed in is the worse of the two outcomes (the failure is surfaced, since a reload will
  sign them back in). That landing is now **structural rather than a line in `signOut`**: the
  store only clears the account, and `router/guards.ts`'s watcher takes the reader to `/login` —
  which is also what covers the 401 that arrives with nobody having navigated at all.
- **A `source` is any material the account holds, indexed by the database and owned by a
  workspace or a conversation.** Its bytes live where they *are* — an upload at
  `<userRoot>/sources/raw/<sourceId>.<ext>`, outside every workspace on purpose so chat uploads
  never show up in the agent's `list_files`; a file where the file is, in `workdir/` or
  `sessions/<id>/`. That last part is the change: "outside every workspace by construction" is
  still exactly true of `upload` and `web` storage, which is what `read_document`'s
  cross-boundary argument rests on, and a `workspace`-storage source *is* a file in the sandbox —
  which is what unification means, and no more privileged than the file already was. See
  `docs/sources.md`. Three things follow, and each is load bearing:
  - **Two identity rules, as two partial unique indexes.** Identical *uploaded bytes* are one row
    (`idx_sources_blob`, on `(user_id, sha256) WHERE sha256 IS NOT NULL`, and deliberately not
    filtered by `deleted_at` — that is what makes re-uploading a deleted file *revive* its row).
    A *file* is placed by `(user_id, owner_kind, owner_id, rel_path)` while live
    (`idx_sources_place`), so a rename is an UPDATE that keeps the id, the summary and the parse
    state, and two identical files in two directories are two sources. A file row's `sha256` is
    NULL, which is why the two indexes can never contend. The hash is *scoped* —
    `findSourceByHash(userId, hash)`, never by hash alone, or the second account to upload the
    same file would be handed the first one's bytes.
  - **No path is stored absolutely, and every one is re-validated on every read** through
    `resolveSourceBytes` in `sourcePaths.ts`. `storage` picks the root and `rel_path` says where
    in it; a blob stores neither, because its filename is `<id>.<ext>` — derived from the id and
    the MIME type, which is what `raw_path` always was a cache of, and the one stored fact a
    copied data root silently broke. It is re-validated because a database row is not a trust
    boundary: it travels through backups, and a future bug that wrote one column would otherwise
    become an arbitrary file read.
  - **Parse state is columns on the row**, not a `<id>.json` sidecar. A reparse is then
    visible in every conversation at once, and a source shared by two conversations is parsed
    once. Only the extracted *text* stays a file. `attachments.ts` has no root constant: the
    tree belongs to a user under a data directory the process chose at launch, so every
    function takes the layout — which is also what keeps any data path out of import time.
- **Every application entity is soft-deleted, and `deleted_at` is the whole of it.** Workspaces,
  sources, copilots, sessions, messages, providers, models and document parsers each carry a
  nullable `deleted_at`, added by `ensureColumn` (`CREATE TABLE IF NOT EXISTS` skips a table that
  is already there, so the DDL alone would only reach new installs). Set means gone: **every read,
  join and count filters `IS NULL`** — that is the rule, and a SELECT added without it is the one
  way this breaks. Relations are never dismantled: the cascade that used to clean up no longer
  fires, so a deleted parent's children stay and are hidden by filtering the parent
  (`sessions`/`messages` reach their owner through `workspaces`, which is why filtering one
  workspace hides a whole tree), quiz and plan rows keep their `tool_call_id` anchors, and
  `softDeleteProvider` marks its models in the same transaction because nothing else will.
  **On-disk bytes are kept too** — workspace and session directories, a source's raw and parsed
  files — so a delete costs no disk and a future restore has something to restore. Two hard
  `DELETE`s survive on purpose: `pruneAuthTokens`' housekeeping, and one-time migrations (the
  `DELETE FROM copilots` that drops rows written before ownership existed). The agent's
  `delete_file` tool is *not* an application deletion — it is a real filesystem operation inside
  the workspace sandbox, and it stays one. A source is the one entity with a rule of its own:
  `UNIQUE (user_id, sha256)` means identical bytes can never be two rows, so re-uploading a
  deleted file *revives* that row (`findDeletedSourceByHash` + `reviveSourceForUser`) rather than
  inserting beside it — and because its links survived, the file comes back everywhere it was
  used. `DocumentService.cancelSource` is per *source* rather than per session for the older
  reason: cancelling by session would abort a parse another conversation is waiting on.
- **One conversation has one writer, and the lease is keyed on a client id the browser makes up.**
  A client that opens a conversation holds its write lock; every other client of the same account
  reads it read-only. `docs/session-locks.md` is the reference, including the tolerances the
  requirement asks to be recorded. Four things are load-bearing:
  - **The holder is not the auth token.** `issueTokens()` mints a fresh access token *and a fresh
    row* on every refresh, so a lease keyed on it would change holder underneath a client that had
    merely been running for a day. The id is generated per browser tab and kept in `sessionStorage`
    — a reload keeps it, a new tab does not — and is sent on **every** request as `X-Client-Id`,
    because the write gate has to know who is asking. It is *asserted, not verified*: the lock is
    advisory, and the account check on the session is what protects the row.
  - **Acquire, renew and release are one statement each, and the statement's own `WHERE` is the
    whole of the concurrency control** (`setAutoTitleForUser`'s shape). Three things fall out of
    that rather than being branches: the holder's second call is a heartbeat, `changes === 0` means
    exactly "a live lease held by somebody else", and `acquired_at` is kept across beats. No
    `deleted_at` — the row means "held *now*", so release and expiry are real `DELETE`s — and no
    sweep job, because the upsert reclaims an expired row in place.
  - **The gate renews a lease and never takes one, and it is a route config.** A gated write by the
    holder renews it; a write on a conversation nobody holds is allowed, because there is nobody to
    conflict with. It deliberately does **not** claim a free conversation — the first shape did, and
    a second writer showed why that is wrong: any API client writing to a conversation seized its
    lock and left the reader's own tab read-only for two minutes, having no lifecycle to give it
    back. A lease exists because a client *opened* a conversation; a write is not that act. The flag
    is on every session-scoped write, the deliberate exceptions and the assertion that keeps the
    list honest are in `test/route-lock-coverage.test.ts`, and a client with no `X-Client-Id` is
    refused outright. The gate **never answers for a session that does not exist** — the
    owner-scoped lease lookup finds nothing, so it returns and lets the route 404, or a bad id would
    come back "somebody is editing this" and the "not yours and does not exist are one answer" rule
    would hold everywhere except the flagged routes.
  - **Its lifetime is the view's, not the store's.** `composables/sessionLock.ts` is an effect owned
    by `ChatView`'s setup, which is what makes 退出工作区时取消所有检测 structural rather than a flag
    somebody remembers: the view going away stops the timers and releases the lease. The heartbeat
    is derived as half the shared TTL so one missed beat is survivable, and the five-minute poll
    only *asks* through the same 2s debounce every other trigger uses. A refusal from a turn route
    re-reads the workspace's locks **and** raises the toast — unlike every other thrown-response
    failure, because a refused turn is never persisted, so the bubble's banner unmounts and nothing
    else would say what happened.
  - **A widget is told whether it may write; it never looks it up.** `WidgetContext.writable` is a
    *parameter*, set by `useWidgetActivation` from the session's lock state, and the notes widget
    obeys it — its add button, the editor's save and delete, and the selection toolbar. That is
    deliberate decoupling rather than tidiness: a widget that read the session's state to find out
    would make every widget depend on whatever the host is doing, so the session decides, the widget
    is told, and nothing on the notes path knows what a write lock is. The install hooks take
    `WidgetInstall` instead, which has no `writable` — an install is a write that already landed.
- **A message is deleted from the tail only, and deleting one is not the same as regenerating
  it.** `DELETE /api/sessions/:id/messages/:messageId` refuses anything but the conversation's
  last live message (`MESSAGE_NOT_LAST`), and `POST /api/sessions/:id/regenerate` peels the last
  assistant reply and runs the turn again. Both read the live tail and write inside **one
  transaction**: two tabs see the same "last", and without it both would pass the check and both
  would write. Regenerate is the `/answers` shape rather than `/chat`'s — the user message is
  already persisted, so history is read *after* the peel and `userMessage: null` is what keeps it
  from arriving twice, with its attachments rebuilt from the persisted row by
  `buildHistoryMessages` rather than re-sent by the client. It emits `message_removed` right after
  `meta`, because the server has already dropped the row by then and a client that waited for
  `message_done` would render the old reply and the new one together for the whole turn. The
  filter is load bearing in two places at once: `stmtListMessages` hides a deleted message from
  the conversation *and* from the model's context, because that one statement is also what
  `listMessagesOf` — and therefore `findAwaitingToolCall` and `skipAwaitingToolCalls` — reads.
  Both routes refuse while a turn is streaming (`TURN_IN_PROGRESS`); `/chat` deliberately has no
  such guard, which is a pre-existing hole and not a pattern to copy.
- **A message's attachment is a snapshot, and its two halves come from different sides.** The
  **name** is the client's, because it is the one that message used — a shared source can only
  remember the first name it ever saw. The **parse state** is the server's, re-read from the
  source row when the turn is persisted: a tab that has been open for an hour would otherwise
  write whatever it last saw into the record of a turn, and a document that failed to parse
  would reach the model as "still parsing". The snapshot is never rewritten, so a later
  reparse does not alter history; the *live* state is the overlay `stores/app.ts` keeps and
  `/api/sessions/:id/sources` feeds.
- **`web_fetch` SSRF guard is a security boundary.** It is the only tool that
  makes the server issue an arbitrary outbound request. Keep the scheme check,
  the check on *every DNS-resolved address*, and the manual per-hop redirect
  re-validation. Do not "simplify" it to `redirect: "follow"`.
- **API keys never leave the server.** `PublicConfig` (from `/api/config`) and
  every provider response has only `hasApiKey: boolean`, never the key. A `PUT`
  with no `apiKey` field means "leave unchanged" — that is what lets the UI edit a
  provider it cannot read the key of.
- **Shared types only.** Cross-boundary payloads live in `packages/shared`. Adding
  a field to an API response means updating the type there first, then both apps
  typecheck clean.
- **No user-facing string is hardcoded.** Every visible label, tooltip,
  `placeholder`, `aria-label` and `title` comes from `t()` and a key in
  `apps/web/src/locales/`. The catalogs are `zh-CN.ts` (source of truth, typed)
  and `en.ts` (typed as that schema, so `pnpm typecheck` fails on a missing key).
  Keys are **domain-first** (`chat.titleHint`, `tools.name.write_file`), never
  keyed by component file — components get split and renamed. Non-component
  modules (`stores/app.ts`, `utils/minimap.ts`, `composables/confirm.ts`)
  translate through `i18n.global.t`, not `useI18n()`.
- **Icons come from the shared set; typographic characters do not.** Every mark in the
  UI is `<Icon name="…">`, drawn from `utils/icons.ts` — a 16×16 grid, stroked,
  `currentColor`, never a character and never an emoji. What stays a character is what
  is genuinely *content*: `AI` and product names, the SI unit symbols in
  `utils/format.ts` (B/KB/MB/GB, k/M), and the `→` / `·` separators the copy is built
  from. The split is not a preference. An emoji is painted by a colour font and
  **ignores `color`**, which made `.icon-btn.danger:hover` a rule that worked on the
  dialog close buttons and silently did nothing on the delete buttons beside them; and a
  glyph inside a translated sentence cannot be sized, coloured or aligned, which is how
  `✓ Key configured` lived in the catalog while the same idea in `ModelSelector` carried
  no mark. The server's `⚠️ ` on a failed turn is persisted into history and replayed to
  the model — content, not chrome, on the same boundary as the untranslated tool strings.
  `apps/web/test/icons.test.ts` enforces all of this.
- **A product name is copy, so 助理 replaced Copilot in the catalogs' *values* and nowhere else.**
  What the user reads changed; the `copilots` table, the `/api/copilots` routes, `CopilotDefaults`,
  `openCopilots`, `COPILOT_NOT_FOUND` and the catalog **keys** (`copilots.title`, not
  `assistants.title`) all keep the word. The schema and the wire are the expensive rename — a
  migration and a breaking change for a word no user ever sees — and a key rename buys nothing,
  since a key's only job is to stand one lookup away from its value. Which is also the trap: a bulk
  edit of a catalog must match on values, because a script that rewrote keys turned `noCopilot`
  into `no助理`. The English values are "Assistant"/"Assistants", capitalised as a name rather
  than as a common noun.
- **`en` plural messages use `|`; `zh-CN` ones do not.** Both catalogs take the
  same call shape — `t(key, named, plural)` — so no component branches on the
  locale. A message containing a literal `|` must escape it as `{'|'}` or it
  becomes a plural branch. No message carries HTML: the two templates that need
  markup split the sentence into fragments and wrap them in real elements, so
  there is nothing for `v-html` to inject.
- **Server errors travel as `{ error: { code, message, params? } }`.** `code` is
  canonical and drives the client's wording (`ApiErrorCode` or `ParseErrorCode`
  from `packages/shared`); `message` is the server's own sentence, kept only for
  a client that does not know the code; `params` carries what the client needs to
  interpolate. Add a code to the runtime list first, then the route, then
  `errors.*`/`parseErrors.*` in both catalogs — `catalog.test.ts` iterates the
  list and fails otherwise. `utils/apiError.ts` is the single place a code becomes
  a message, which is why every `catch (e) { setError(e.message) }` site
  translates for free.
- **Raw SSE `error` bodies and tool-result strings are deliberately not
  translated.** The first is dynamic provider text with no code to key on; the
  second is *model input*, and translating it would change model behaviour. Both
  stay as they are — a provider failure therefore renders in the provider's
  language.
- **Language is detected, not stored, until chosen.** Absence of `gl-locale` means
  "read `navigator.languages`"; there is no `"auto"` value, unlike the theme,
  because language is chosen once rather than toggled. Anything unsupported falls
  back to English. `useLocale()` and the pre-paint script in `index.html` must
  stay in lock-step, the same obligation `theme.ts` carries.
- **SSE framing** is `event: <type>\ndata: <json>\n\n`. Chat streams via
  `reply.hijack()`; the agent emits `text` deltas, `reasoning` deltas,
  `tool_start`/`tool_end`, `usage`, `message_done`, optionally `title`, `error`,
  then `done`. The frontend expects exactly this. `message_done` carries the whole
  persisted `Message`, so a turn the user stopped arrives on the same event as any other —
  the only difference is `stopped: true` on it. There is no `stopped` event type.
- **`ask_user` suspending the turn is control flow, not an error.** The tool throws
  `AskUserSuspension` (the device LangGraph's `interrupt()` uses) and `runAgentStream`
  catches that class *before* its generic tool-error arm — a catch that swallowed it would
  turn the model's own question into a `Tool error:` string. A suspended call is recorded
  with `status: "awaiting"` and **no `output`**, emits `tool_start` with **no `tool_end`**,
  and ends the turn. That missing `output` is the entire persistence mechanism:
  `buildHistoryMessages()` replays only calls that have one, so a pending question is
  absent from the model's context until it is answered, and the answer arriving from a
  later request is what puts it there. Do not "fix" either absence — no `output` and no
  `tool_end` are both deliberate. The turn resumes as a fresh run with
  `userMessage: null`, whose history already ends in the `tool_calls` + `ToolMessage`
  pair, so no synthetic user message is invented and no checkpointing is needed.
  Retiring a question (`skipped`) writes no `output` on purpose; only an explicit cancel
  gives the model a result, because only a cancel is a decision it should hear.
- **Stopping a turn is a request, not a dropped connection.** `POST /api/sessions/:id/stop`
  aborts the `AbortController` that `beginTurn()` registered for the session, and the turn's
  own request — stream still open — persists what had streamed and ends the way every turn
  does: `message_done` with `stopped: true`, then `done`. It is deliberately *not* the client
  aborting its fetch: a fetch that was aborted has no stream left to report the partial reply
  down, which would leave the client inventing a local copy or reloading to find it. Three
  things follow, and each is load-bearing:
  - **The signal reaches the provider request and every running tool**, so a stop stops
    paying for tokens. `runAgentStream` catches narrowly — only `signal.aborted` becomes
    `stopped`, and every other throw keeps its meaning, because swallowing them would dress
    a provider outage as a turn the user appeared to have stopped. The tool-level catch
    rethrows on an abort rather than reporting `Tool error: …`, which would look like the
    tool broke and would carry the loop into another step. Order it *after* the
    `AskUserSuspension` arm: `ask_user` never consults the signal, so an abort must never
    relabel a suspension as a stop.
  - **A stopped turn is persisted and still counts as the assistant's half of the exchange.**
    Dropping it would leave the next turn's history opening on a user message with no reply.
    It carries `stopped` and reports no `usage` — a half-finished step's token counts are not
    a number worth showing or summing — and it gets no `OUT_OF_STEPS` note and no auto-title,
    because a turn the user ended is not a turn that ran out of budget or that said anything
    to name a conversation after.
  - **`beginTurn()` is used by both turn routes**, so Stop works on a resumed `ask_user` turn
    as well as a fresh one — the client renders the same control for both, and a control that
    renders but does nothing is worse than no control. The same request's `close` event
    aborts too, so a closed tab stops costing tokens; `finished` keeps that from firing on a
    turn that ran to completion. `createSseWriter`'s `gone()` guard and its `error` listener
    exist for the case a stop creates, where the response outlives the client.
- **Reasoning is display-only, with one exception that is not optional.** Chain of
  thought is persisted on the message and rendered, and `buildHistoryMessages()` replays
  only `content` and `toolCalls` — most providers ignore or reject reasoning, so it must
  not be put back into the messages *LangChain* sends. **But a thinking-mode provider
  requires it back on any replayed message that carries `tool_calls`**: DeepSeek answers
  `400 The reasoning_content in the thinking mode must be passed back to the API`, and a
  session that hits it keeps hitting it, because the offending message stays in history.
  `@langchain/openai` cannot send the field at all — its outbound converter copies only
  `function_call`/`tool_calls`/`audio` out of `additional_kwargs`, and it strips
  `reasoning`/`reasoning_content`/`thinking` content blocks deliberately
  (langchainjs#11175) — so `buildHistoryMessages()` collects the reasoning into a side
  map and `createReasoningFetch()` puts it back on the wire, keyed by the message's first
  tool-call id. That is gated on the model record declaring the `reasoning` capability, so
  a provider that never used the field never sees it. This is why `createReasoningFetch`
  touches the **request** as well as the response — do not "simplify" it back to a
  read-only tap, and do not delete the side map as an unused return value.
- **Reasoning comes off the raw SSE stream, and only from there.** `createReasoningFetch()`
- **Reasoning comes off the raw SSE stream, and only from there.** `createReasoningFetch()`
  taps the fetch response and is the **single** source of chain-of-thought — do not
  "simplify" it away. Do not *also* read `chunk.additional_kwargs` in `chunkReasoning()`:
  `@langchain/openai` 1.5.x does map `reasoning_content` there, so reading both channels
  emits every delta twice and doubles the persisted `reasoning`. `chunkReasoning()` exists
  only for the content-block shape the tap cannot see. (Token usage is read from the
  step's *chunks* rather than the reduced message — `concat` does carry `usage_metadata`
  now, but the chunk scan does not depend on that staying true.)
- **Streamed text can exceed what is persisted.** On a step that emits preamble text *and*
  a tool call, the preamble is streamed as `text` deltas; when the final step produces
  content, `finalContent` is *replaced* by just that step's text. So the live view shows
  narration + answer while `messages.content` holds only the answer, and a reload drops the
  narration. Pinned by a test in `apps/server/test/agent/loop.test.ts` — changing it is a
  product decision, not a bug fix. **The exception is a call whose artifact *is* that text**,
  and `ANSWER_BEARING_TOOLS` names both: text streamed beside `ila_review_quiz` is the
  per-question verdict walkthrough, and text streamed beside `ila_table` is the table itself —
  `ila_table` renders nothing, so the prose beside the call is the whole of what the reader
  sees. `answerUtterances` keeps those and `composeWithAnswerUtterances` rejoins them ahead of
  the last utterance at every normal ending (final answer, suspension, exhausted budget); an
  utterance the last step repeats verbatim is dropped rather than doubled. The reason it
  exists is the same failure twice: a grading turn typically runs grading →
  `ila_update_plan_progress` → a final "shall we move to the next chapter?" step, and a table
  turn is the table → "需要展开哪一项？", so in both the last-utterance rule made the artifact
  vanish from the persisted message at `message_done` after streaming it live. A diagram is
  deliberately **not** in the set: its artifact is the drawing, rendered from the tool call, so
  its prose really is narration. The prompts push the model toward the safe shape too (all
  bookkeeping tool calls before the prose; the full rundown in the final message), but the loop
  rule is the deterministic backstop — do not delete one believing the other makes it redundant.
- **A message holds the model's most recent utterance, never every step's run together.**
  `finalContent` *accumulates* each step's text as it streams, and it is the `lastUtterance`
  tracked per step that every ending actually reads from — the final answer, the suspension,
  and the exhausted budget alike. The rule matters because of how it used to fail: only the
  final-answer branch replaced the pile, so any ending that did *not* go through it
  persisted every step's narration joined with **no separator**
  (`"Let me look at the workspace.我先确认几件事："`), which reads as one broken sentence
  whatever language it is in. `ask_user` is what made that reachable in normal use, being
  the first way to end a turn by asking rather than answering. Fallbacks are always the last
  *utterance*, never the accumulation, so a step that said nothing cannot resurrect the pile.
  The live stream still shows everything as it arrives; only what is persisted is trimmed.
- **A turn that was cut short says so, and it is persisted.** When the step budget runs out
  the message keeps the model's last utterance *and* appends `OUT_OF_STEPS`. The sentence
  used to appear only when the model had said nothing at all, which meant every truncated
  turn that had narrated anything — the common case — read as a finished answer. Like the
  `⚠️ ` prefix it is untranslated on purpose: it is content, replayed to the model next turn.
- **A user's title is permanent.** `session.titleSource` is `auto` until a human
  supplies a title via `PATCH /api/sessions/:id`, which flips it to `user`; the
  auto-titler must then never touch it. The titler runs on the first turn only, and
  every failure is swallowed — it must not be able to fail a chat turn.
- **Thread classification is a best-effort post-turn side effect, never part of the turn.**
  The thread widget (`apps/server/src/threads.ts` + `agent/threads.ts`) classifies *turns*
  (a user message plus its assistant replies), not individual messages, after every
  finished turn while the widget is installed. The call **streams** with a 60s backstop —
  never make it non-streaming with a short timeout again: reasoning models think long
  before answering, and that aborted healthy calls at 20s — is fire-and-forget from
  `finishTurn` (never awaited — `done` does not wait on it), and joins one in-flight
  promise per session. Turns whose own `ila_update_plan_progress` call moved a plan node
  are placed deterministically WITHOUT calling the model (read from the turn's own tool
  calls, never the plan's current status, which would be a lie during backfill); only
  ambiguous turns are sent, at most five per call, and a bad/empty answer blocks just
  those while deterministic turns in the chunk still land and the same idempotent sync
  retries the rest. That is also what makes an install-time backfill the same code path
  as keeping up. A diagram drawn in a turn rides the same pass: its `<diagram>` block (name
  and the model's summary, never the source) is answered in a second ref-keyed array with
  `continue`/`eN`, a bad entry collapses the diagram to its turn's thread, and a forced
  plan turn's diagrams land in that node's thread with no model call. The `计划`/`其他`
  headings are rendered client-side with translated labels, never stored. The classification
  process is observable through the
  append-only `<dataRoot>/logs/threads.log` (`modelLog.ts`): one human-readable block per
  real classification (context, turns, raw model answer, per-turn resolution, counts) and
  failure blocks, configured only in the process entry point so tests never write it.
  Whether this out-of-band call may think is the `ILA_THREAD_REASONING` env var
  (`auto`/`on`/`off`, parsed once in `config.ts` and read once at route registration):
  `auto` follows the model record's `reasoning` capability and sends nothing — DeepSeek V4
  defaults thinking ON — while `off` sends `thinking:{"type":"disabled"}` in the body (the
  DeepSeek/Ark shape, through `modelKwargs`) and `on` forces enabled. The field is sent
  *only* to models declared with the `reasoning` capability, the same gate the main loop's
  reasoning replay uses; an unknown body field is a 400 on strict OpenAI-compatible
  endpoints. It changes this classifier call alone — never the conversation's own turns.
- **The insight pass is a button, not a tool, and it wipes the list only after a usable parse.**
  `insights.ts` + `agent/insights.ts` run one out-of-band call over the conversation's own record
  — plan, graded quizzes, threads, notes, diagrams — and write typed observations about the
  *learner* (`INSIGHT_TYPES`, with `strength` added to the seven asked for so the panel is not a
  list of chores). It is deliberately **not** a tool: `ila_query` is how the agent reads the same
  material, while a pass costs a whole-conversation model call and the agent must not decide to
  spend that on a panel nobody may open. Three things are load-bearing and each has a test:
  `replaceUnadoptedInsights` runs at the **end** of `generateInsights` and never at the start, so
  a provider outage or an unreadable answer leaves every row exactly as it was — clearing first
  is a user pressing a button, getting nothing, and losing the list they had; the parser returns
  `null` for "nothing usable" and `[]` for "the model genuinely said nothing", and the route
  reports those as `failed` and `ok`, because those are different claims about the conversation;
  and `adopted` is the whole of the user's side, the only thing that survives a rerun.
  `insight_items` therefore carries **no `deleted_at`** — derived data, like `session_threads`,
  and one hard `DELETE` shape reached from both the user's delete and the pass's wipe. The
  consequence is stated rather than hidden: **a deleted observation can come back on the next
  pass**, because delete is not suppression. A pass also **declines to call the model when there is
  nothing to read** — every source is derived, so a fresh conversation has none — and answers
  `status: "empty"`, a third outcome beside `ok` and `failed` because zero new items is equally
  what "it looked and found nothing" returns and the two ask the reader for opposite things. It
  has its own reasoning switch (`ILA_INSIGHT_REASONING`, a second variable rather than a share of
  the classifier's) and its own log (`<dataRoot>/logs/insights.log`, from the `modelLog.ts` both
  calls write through), whose block carries the source counts and prompt size — what tells "nothing
  to reflect on" apart from "the model refused" — and the raw answer even when it was unusable.
- **History must stay user/assistant balanced.** On a chat error, a `⚠️ …`
  assistant message is persisted so the next turn's history is well-formed. An
  assistant message's `tool_calls` are only replayed into history when the
  matching results exist — OpenAI rejects the pair otherwise.
- **A failed turn must be readable after the turn has ended.** The `error` event is
  written to `streaming.error` (a banner inside the streaming message, which unmounts
  with the turn) *and* to `store.error` (the toast in `App.vue`, which does not). The
  banner alone flashes and vanishes, and a failure with nothing on screen is
  indistinguishable from a button that does nothing — which is how one was reported. The
  store's `answerQuestion` follows the same rule: a submission it cannot place is
  reported, never silently dropped.
- **Schema changes follow one of two rules, and they cover different things.** *Adding* a
  column goes through `ensureColumn` in `db.ts`: `CREATE TABLE IF NOT EXISTS` silently skips
  existing tables, so a database created before the column would never gain it. *Changing
  what an existing column means* bumps `SCHEMA_VERSION` in `schema.ts`, which refuses the
  file outright — no missing column can signal that, so without a version an old database is
  simply opened and read wrong (`dir_path` resolving to the wrong directory, ids referring to
  a different kind of thing) with no error anywhere to explain it. The guard reads
  `PRAGMA user_version`, which is in the file header and therefore readable *before* anything
  is created; a version row in `app_settings` cannot be, because reading it means having
  already touched the file you meant to refuse.
- **Every user-owned read takes the owner and puts it in the `WHERE`.** `getWorkspaceForUser`,
  `getSessionForUser`, `listMessagesForUser` — the `ForUser` suffix is the rule, and another
  account's id returns `undefined` rather than a row. Looking a row up and *then* comparing
  its owner is a check somebody will eventually forget on a new route, and the failure is
  another person's data rather than an error. "Not yours" and "does not exist" answer the
  same way on purpose: a route turns both into a 404, so an id cannot be probed. `sessions`
  and `messages` carry no `user_id` — they reach their owner through `workspaces` by join,
  because a second copy of the owner is a second thing to keep in agreement. The handful of
  accessors that *do* take a bare session id (`touchSession`, `createMessage`,
  `skipAwaitingToolCalls`, …) are documented as such in `AppDb`: every caller reaches them
  after a scoped read has already resolved the session.
- **A Copilot is owned, and "platform" is not a tier — it is a published one.** `copilots` carries
  `user_id` and a `visibility` of `private` or `public`, not an admin role, so a Copilot the
  operator wants every account to have is simply one they published, and "ordinary users cannot
  edit it" falls out of ownership rather than a privilege check. That makes it the one table whose
  rule has two sides: the *reads* take the wider predicate — `user_id = ? OR visibility =
  'public'`, through `listCopilotsForUser` and `getCopilotForUser` — while the *writes* take the
  narrower owned one (`getOwnedCopilot`, `updateCopilotForUser`, `deleteCopilotForUser`). Reaching
  a Copilot through the wrong one of those is the mistake to watch for on a new route: the wide
  read is "may use", and only the narrow one is "may change". `user_id` is deliberately nullable,
  because `ALTER TABLE ADD COLUMN` with `NOT NULL` demands a default and any default is a landmine
  for a later insert that forgets the owner — so every read *also* requires an owner to be
  present, and a row whose owner is gone matches nothing rather than being handed to whoever
  asked.
- **A Copilot is a template, and a conversation copies it.** `sessions` snapshots all five parts
  at creation — `system_prompt`, `allTools`, `tools`, `settings` and the `copilot_name` label —
  and leaves `copilot_id` as a link the UI may show but the turn path never reads. So
  `turnContext()` consults the session and nothing else, and `buildSystemPrompt` takes a string
  rather than a Copilot. Two consequences are load-bearing rather than incidental. The prompt
  used to be re-read live on every turn while only `settings` were copied, so editing a Copilot
  silently rewrote every conversation already using it — while the UI promised the opposite in so
  many words. And `tools` *had* to be snapshotted: while the allowlist was live, deleting a
  Copilot did not merely drop a restriction, it widened one. **`ChatInput` has no `copilotId` on
  purpose** — re-pointing the link would move the label and leave the persona behind — so
  changing a conversation's behaviour is `PATCH /api/sessions/:id` with a new `systemPrompt`,
  which is also what lets a conversation diverge from the Copilot it came from.
- **A tool allow-list has three states, and two of them used to be one.** `allTools` is
  authoritative over `tools`: `true` means everything (including tools added later), `false` with
  a list means those, and `false` with an empty list means **nothing**. `buildTools` mirrors that
  in its own signature — `allowedNames` **absent** is "no restriction", an **empty array** is "no
  tools" — and the two are not interchangeable. They were once, because the filter was gated on
  `length > 0`, which made a Copilot the user had locked down to no tools arrive at the model with
  *every* tool: the widest possible reading of the narrowest possible selection, and "deny
  everything" unexpressible. Do not "simplify" either half back to an emptiness test. The write
  paths store the pair coherently (`allTools: 1` clears `tools`, so a row cannot assert both), and
  readers derive from the flag rather than trusting the list. `ALL_TOOL_NAMES` lives in
  `packages/shared` for the same reason `ASK_USER_TOOL_NAME` does — the client writes the
  allow-list and the server filters by it, and the copies had already drifted: the client's list was
  missing `read_document`, which therefore could not be chosen at all.
- **A tool's parameters schema must convert to a top-level `"type": "object"`, and a zod union does
  not.** `ila_query` shipped as a `z.discriminatedUnion`, which is the better *type* — a field that
  means nothing for a kind cannot be written for it, and `switch` exhaustiveness is free — and it
  **cannot be sent**: the conversion gives `{"anyOf": […], "type": null}`, and a strict
  OpenAI-compatible endpoint refuses it with `400 Invalid schema for function 'ila_query': schema
  must be a JSON Schema of 'type: "object"', got 'type: null'`. That is a 400 on **every turn** in
  any conversation where the tool is available, whether or not it is called. Nothing saw it: the
  type system cannot see the conversion, the handler's tests call `invoke()` and never touch a
  request, and the fake LLM accepts any schema because it validates none. So a tool needing a
  discriminated set is **one flat object** with the discriminator as a `z.enum`, the per-kind field
  contract in an `ALLOWED_FIELDS` table refused by a `checkFields` guard (zod strips unknown keys,
  so without it `{kind: "plan", status: "answered"}` returns a plan and never says the `status`
  went nowhere), and the completeness check moved from the `switch` to a `Record<QueryKind, …>`
  handler table — a missing kind is still a `tsc` error. Each optional field's `describe` names the
  kind it belongs to, because the schema can no longer express the association.
  `test/tool-wire-schema.test.ts` is the guard, and it asserts the conversion for **every** tool a
  real turn sends, plus the union's failure mode itself so the next person meets the trap in a test
  rather than in production.
  **Two corollaries that trap has already produced.** A tool whose per-kind fields are
  *selector-shaped* — several optional fields that only mean something together, where one of them
  chooses what the others address — needs **its own kind**, not a two-mode field pair: that is what
  the `ALLOWED_FIELDS` table is for, and a `{kind, path?}` where `path` absent means "list instead"
  is exactly the union the flat object was built to replace. And the guard only covers tools a
  **real turn actually offers**, so a tool assembled only under a condition gets **zero** wire
  coverage until a case sets that condition up — `sendOneTurn(workspaceScope?)` takes the grant for
  this reason, and a new context-gated tool needs the same treatment or it is back to being
  invisible.
- **A workspace has two directories, and they are not interchangeable.** `Workspace.dirPath`
  is the workspace's own — the parent of `workdir/` and `sessions/`, what `DELETE` removes,
  and what the home page's card names. `Workspace.workdirPath` is `dirPath/workdir`: the
  agent's file-tool sandbox, the file browser's root, and what the system prompt names. Both
  are on the wire so that "which one do I write into" is a decision each caller makes by name;
  deriving the second by convention is how the system prompt ended up naming a directory
  containing `sessions/`. `dir_path` stores the *root* and not the sandbox because
  `removeWorkspaceDir` only removes a direct child of the user's workspaces root, and because
  removing `workdir/` alone would strand `sessions/` beside it.
- **Renaming is display-only, for accounts as well as workspaces.** A workspace's directory
  keeps the slug it was created with, and so does a user's — `users.slug` is chosen once by
  `uniqueUserSlug` and a later change to the username does not move it. Every path in the
  user's own workspaces, and every path the agent has already written into a conversation, is
  built on top of it. Uniqueness is checked against the database first and the filesystem
  second: the column is `UNIQUE`, and a filesystem-only check would race two sign-ins that
  arrive at the same instant.
- **The data root is chosen, never defaulted.** `ILA_DATA_DIR` is required and
  `resolveDataRoot()` throws without it — deliberately, because that path decides how much of
  the user's work survives an uninstall, and a default is only ever the choice nobody made. It
  is read from the environment rather than from `config.yaml`, for the same reason `ILA_HOST`
  is: the launcher sets it per launch, and a value in a config file cannot differ between two
  runs of the same install. `.env` counts as the environment (which is what keeps a checkout
  working) and a *relative* value resolves against the project root, not the working
  directory — `pnpm dev` runs the server with cwd set to `apps/server`, so "relative to cwd"
  would mean something different from one launcher to the next. The throw lives in `main()`
  and not at module scope: `config.ts` is imported by the whole test suite, and a top-level
  throw would take out every test that never starts a server.
  **Offering a folder is not defaulting one, and the difference is the whole of the panel's
  first-run prompt.** `AppPaths.defaultDataDir` is `~/ilearnassist` — in the user's home, outside
  the application bundle — and the panel names it in the first-run hint and takes it with one
  click, because making somebody work out where their data should live before they have used the
  app once is the cost the offer removes. What keeps the rule above true: nothing is created and
  nothing is recorded until that button is pressed (`ensureDataDir` is its only caller), `Start`
  with no data root raises the question rather than opening a picker the user did not ask for, and
  the server is still handed a path a human agreed to. The picker starts in that same folder, so
  there is one "suggested" location rather than two that disagree — see `docs/desktop.md`.
- **Documents cross a sandbox boundary that files cannot, and that asymmetry is deliberate.**
  `read_document` is bound to a whitelist resolved per turn — a conversation's own sources
  **unioned with its workspace's** — rather than to any root, so a guessed id fails a `Map`
  lookup before a path is touched. The file tools are sandboxed by `resolveInWorkspace`
  instead, and can never reach an *upload or a page*: those live outside every workspace by
  construction. So a document uploaded in one conversation is readable from another in the same
  workspace, while no path in that workspace could reach it as a file.
  **The whitelist stays what it always was, and the registry is not one.** A file inside a
  sandbox is readable *by path* through the file tools, so it is deliberately **not** folded
  into `listReadableSources`: a workspace with a `node_modules` in it would otherwise put
  thousands of rows into the model's context as named sources. `read_document` keeps meaning
  "material from outside the sandbox"; a file the model should read is read with `read_file`,
  and cross-workspace referencing rides `session_sources` — a link created when a user actually
  references something.
  That is defensible because a workspace is *already* a shared sandbox — every conversation in
  it can `read_file` the same tree — so a document there is not more privileged than a file
  there; and it is the whole point of the tool, since a model shown a 200-page PDF in turn one
  could not previously page through it in turn three. It rests on a workspace never being
  shared between accounts, which the `ForUser` scoping is what guarantees. Two corollaries:
  `/api/sessions/:id/sources` returns **the same union**, because the model and the chips must
  not disagree about what is available; and `buildTools` gates the tool on "the whitelist is
  non-empty" rather than "this turn has attachments", so a turn that attaches nothing can still
  read last week's file.
- **Destructive UI actions confirm first.** Session, Copilot, workspace, provider and source
  deletes go through `confirm()` from `composables/confirm.ts`. The agent's own `delete_file`
  tool is deliberately *not* gated.
- **A canned reply is the sentence, and the button sends what it shows.** The composer's chips
  (继续 / 是的 / 可以, `composer.quick.*`) send their own rendered label rather than a second
  string beside it, so the words on the button and the words in the conversation cannot drift —
  which is also why the list is built from literal `t()` calls in the component rather than from
  keys assembled out of an id, `catalog.test.ts` reading the source for those literals. Two
  rules about when the row is there, each with a reason: **not on an empty conversation**, since
  they are answers to something the assistant has not said and three buttons that cannot mean
  anything teach the user to ignore the row; and **not while a turn is streaming**, which is not
  tidiness — sending is refused then (the send button has already become Stop), so a chip on
  screen would look live and do nothing. `sendQuick` is deliberately not `send()` with an
  argument: there is nothing staged to attach, and a chip that cleared the textarea would be a
  one-click way to lose a paragraph.
- **`ConfirmDialog` sits above every other overlay, and that is a token rather than an
  ordering.** Two `.modal-overlay`s at the same `z-index` stack by DOM order, and
  `ConfirmDialog` is `App.vue`'s first child — so a confirm raised from *inside* a dialog
  (Settings deleting a provider, the sources list deleting a file) was painted underneath the
  dialog that asked for it, with its buttons visible and unclickable by pointer. `--z-confirm`
  is what fixes it; do not "tidy" the component back to sharing `--z-overlay`, and do not rely
  on where a component happens to sit in `App.vue` for paint order.
- **A dialog that is always mounted loads on *open*, not on mount.** `SourcesDialog` renders
  nothing while closed and `App.vue` has no `v-if` on it, so `onMounted` fires once at app
  start — loading there left the list as it was at boot, and the dialog opened on a correct
  empty list for an account that had files. A `watch` on the flag with `immediate: true` is the
  shape; `SettingsDialog` is `v-if`'d and so never had the problem, which is exactly why the
  difference is easy to miss.
- **The page is a URL, and `router/guards.ts` is the only bridge between it and the store.**
  `apps/web/src/router/index.ts` is the route table — `/`, `/login`, `/password`, `/account`,
  `/admin/:section?`, `/w/:workspaceId`, `/w/:workspaceId/s/:sessionId`, and a catch-all to the
  front door — and `meta.view` on each record is the successor to `uiState.view`, typed as the
  same `View` union so a route added without one is a `vue-tsc` error. This replaced a six-valued
  flag on a module singleton, which was a deliberate choice when it was made ("six views do not
  need a dependency and a route table nobody types") and the wrong one once a refresh threw the
  reader back to the front door: a page is a *place*, and places have addresses. What follows
  from it is load bearing:
  - **The guard is the only thing that crosses.** The route says where you are, the store says
    what is loaded, and `beforeEach` is what calls `selectWorkspace` / `selectSession`. Nothing
    else may assign `activeWorkspaceId` / `activeSessionId` — `selectSession` is what gives back
    the previous conversation's write lease and takes the next one's, and `ChatView` is *reused*
    when only the session changes, so `sessionLock.ts`'s own teardown never fires. Assigning an id
    directly leaves the old lease held, takes no new one, and stops the heartbeat: a conversation
    that quietly goes read-only.
  - **The four hooks, and what each is for.** `probeAccount()` (memoised) answers *who is asking*
    before anything is decided; the signed-out and password-owed refusals are redirects carrying
    `?redirect=`, which is what makes a bookmark survive the sign-in it turns out to need;
    `ensureLoaded()` fetches the account's config and lists **once**, on navigation into a
    signed-in page, and deliberately **not** in `signIn` — an account owing a password change is
    refused every route but three, and a load attempted on the way in surfaces as "that password is
    wrong" on the form. `afterEach` is the overlay teardown six `show*` helpers used to do, written
    once as a rule and skipped when `meta.view` does not change, so switching conversation does not
    dismiss an open settings dialog. A module-level `watch` on `store.account` moves the reader to
    the sign-in screen when the account goes away — the one transition no navigation causes, and
    the reason the store no longer imports the router to sign anybody out.
  - **Route components are lazy imports, and the graph depends on it.** `stores/app.ts` imports
    the router for the two navigations a *write* causes (a conversation it just created, and the
    fork a plan edit opens); a route that statically imported a view would close a cycle through
    the store. Vue reuses the instance when the vnode type is the same object, which is why both
    chat paths name the same `ChatView` import — a remount between them would drop the composer's
    textarea. `e2e/routing.spec.ts` asserts that on the DOM node.
  - **A push to the address you are already at does nothing, and one action means "read it
    again".** `composables/openSession.ts` is that rule, and it is shared by the two lists that
    offer a conversation (`Sidebar.vue`, the workspace stats widget): clicking the row you are
    already in re-reads it, which is also how a second client picks up a lease the first has just
    let go.
  - **The server needs one thing for this and only one.** `webApp.ts` answers a page-shaped
    request it has no file for with `index.html` — `Accept: text/html` and no file extension, GET
    and HEAD only, and `/api/…` still a JSON 404 — which is `registerWebApp`'s third promise now.
    Vite needs nothing: `appType: "spa"` has been its default for years.
- **The app opens on the workspace home, and a card there is the only way into a
  conversation.** The sidebar's old workspace `<select>` went in the same
  change as the home page: with the home page as the switcher it was a second, duplicate
  way to change workspace, and it could name the workspaces without saying anything about
  them. `selectWorkspace` is now reached through a card or through a URL that names a
  workspace — and nowhere else, which is what a landing directly in a conversation needs to
  mean. `e2e/workspaces.ts` is the same rule for the specs; a spec that skips it fails on a
  composer that never renders.

- **Both rails draw the same menu, from one component, and the home page now keeps only what is a
  property of the browser.** `AppMenu.vue` holds the account's rows in **two groups**, and the
  split is about the rows rather than about the layout: the upper group is everything the account
  can *reach* (the workspace's own settings when there is one, the library, the assistants, the
  console for the accounts that have it), and the lower group is *who is signed in* (the account
  page and sign out). The page that draws them places them: `WorkspaceHome.vue`'s rail has nothing
  else in it, so the groups are its two ends — upper under the brand, lower at the foot — while
  `Sidebar.vue` keeps both together at its foot, because its own content is already at the top and
  there is no second end to spread to. That is also why the **divider is the caller's**: a rule
  separates the menu from whatever is above it, and only the page knows what that is (the sidebar
  puts one above the menu, the rail on the second group, whose upper edge has only empty space
  above it). The footer's **workspaces-root path is gone from both rails** — it was a sentence
  nobody could act on, and the console's providers section still names the directory where that
  matters. **The library row is unconditional and is the only door to that browser**: the chat
  header used to carry a second button for it, which is the two-idioms-one-dialog this menu exists
  to remove, so a rail is now the one surface both pages have and both of them draw the row. One
  row is conditional, behind a prop that now says one thing with two consequences — `inWorkspace`
  ("this rail is drawn inside a workspace") draws the **workspace settings** row, which a page
  *about the list of workspaces* has no workspace to configure, *and* scopes the library row to
  the active workspace, which is the pre-filtering the removed header button used to do. Two props
  is two chances for them to disagree about the same fact. That is also why the chat header is now
  the title and nothing else on its left: the back arrow went with the same change, since the
  sidebar header's `all-workspaces` row already names it more precisely — the price, stated rather
  than hidden, is that a **collapsed** rail hides that row too, so leaving a workspace from a 52px
  rail is expand-then-click. What
  the home page *does* keep in its header is the language and the theme — properties of this browser
  rather than of the account, with nowhere else to live — and now the **nav toggle** too, because
  the rail below 900px is a drawer and something has to open it.
  **The rail is a 272px column on a wide viewport and the same drawer the sidebar is below 900px.**
  It used to be a strip across the top there — the admin console's rule for a handful of rows that
  are the page's only navigation — and that was wrong for the reason the two rails are one
  component: the *same* rows were getting two presentations according to which page you happened to
  be standing on. The drawer is the one that survives the comparison. It is `uiState.drawerOpen`,
  the sidebar's own flag, because the two pages never render together; the backdrop is one element
  in `App.vue` outside the view branch for the same reason; the Escape handler and the focus
  watcher already keyed off that flag and now serve both. Two things did have to be added: the
  pane behind it is `inert` from `WorkspaceHome.vue` itself (an attribute falling through from
  `App.vue` would land on the page root and make the drawer inert too), and the focus watcher's
  open-target selector gained `AppMenu`'s row ids — which works because the ids are the same on
  both rails, so on a conversation the panel actions win on document order and on the home page,
  where neither exists, the first menu row does. What that costs: `showChat` now closes the drawer,
  since the home page has one to carry over — a flag that used to be unreachable there.
  Two consequences of
  one component: the *rows* had to come out of `Sidebar.vue`'s scoped block (Vue attaches a
  parent's scope id to a child's root element and to nothing inside it, so a rule left there would
  have stopped applying the moment the home page drew the same row, silently), and a **collapsed**
  sidebar hides `.app-menu` as one element — it used to name one row at a time (`.side-signout`,
  and a `.side-settings` that had long since stopped existing), so three of the five rows were on
  none of those lists and the rail showed clipped icons between its toggle and the bottom of the
  column.
- **The platform console is laid out like a management back end: a menu down the left, one
  section on the right.** `AdminConsole.vue` replaced its tab strip with that shell when it grew
  a second section, and the reason is structural rather than cosmetic — a tab strip is a strip
  of *equals*, and "accounts" and "model providers" are not equal halves of one question.
  `SECTIONS` is data (an id and an icon) so a section is an entry plus a component; the section's
  *words* stay at the call site, because `i18n/catalog.test.ts` scans for `t("…")` literals and a
  key reached through an object property is invisible to it — the dead-key scan would report it
  as unused. `admin.nav.` is the one dynamic prefix it adds, over the closed section-id union.
  **The narrow viewport turns the menu into the same drawer the two rails are**, opened from a
  toggle beside the section's own title. It used to be a strip across the top — "there are a
  handful of sections and they are the page's only navigation, so hiding them would be a page you
  cannot leave" — and the drawer answers that objection without a band of screen: the way out is
  the toggle. It is `uiState.drawerOpen` like the others, so the backdrop, the Escape handler and
  the focus watcher come with it, and choosing a section closes it (unlike `Sidebar.vue`'s tabs,
  which deliberately keep it open — those choose between two views of one conversation, these
  replace the whole pane). **Its width is the shared 900px, and that was a fix**: this block was
  `720px`, a third breakpoint that existed nowhere else, in a `.vue` scoped block where
  `style.test.ts` was not looking. The drawer needs the number in JavaScript too, so a third
  constant would have followed; the guard now scans components, and the content rules that
  genuinely reflow earlier moved to 560 — which is what the design system already says that width
  is for.
- **The console's entry points all ask `store.canAdmin`, never `roles.includes("superadmin")`.**
  Two tiers means the check is a *set* question, and the call sites (the rail menu, which both
  the home page and a conversation draw, and the account page) written as a one-role comparison
  is how an ordinary administrator ends up with a console reachable from two buttons and not the
  third. It is still
  not a permission: it decides whether a button is drawn, and the routes answer 403 regardless.
- **Nothing is painted until `uiState.authReady`.** Whether anyone is signed in is the
  *server's* fact — the token may be expired, revoked or absent — so the right view is
  genuinely unknown until `/api/auth/me` answers. `view` starts on `"login"` as the safe
  guess, and `App.vue` withholds *every* branch until the flag flips, because rendering a
  signed-out screen as the initial guess would flash it at a signed-in user on every single
  refresh. The web app asks only `me()`: a running server always has an administrator (see
  the boot gate below), so there is no `auth/status` round-trip and no create-account screen.
- **Every API route requires a signed-in account unless it says `config: { public: true }`**,
  **and the same hook enforces the pending password change.** One `onRequest` hook in
  `routes.ts`, deny-by-default: a route added tomorrow without a thought about auth is refused,
  which is the same "the safe state is the one you get by doing nothing" move as the
  `read_document` whitelist. Five routes opt out with `public` — `health`, `auth/login`,
  `auth/refresh`, `auth/logout`, `auth/me` — and `auth/me`
  answering 401 is its *answer* rather than a refusal, which is why `client.ts` keeps a
  hand-written `ANSWERS_WITH_401` set rather than an `/auth/` prefix: reporting that 401 would
  open every first visit with an error about a session that never existed. The set is consulted
  **after** the refresh, not instead of it — `/auth/me` cannot tell "nobody is signed in" from
  "the access token aged out overnight", so treating its 401 as final would send somebody who
  was signed in yesterday back to the sign-in form with a good refresh token in hand. Losing
  that ordering is the quietest way to break the week-long session. `/auth/password` is
  deliberately *not* in the set: a 401 there is always an expiry, never an answer. The second refusal is `allowPendingPassword`: while an
  account owes a password change, everything but `auth/me`, `auth/password` and `auth/logout`
  answers 403 — **on the server, not on the screen**, because the account holds a working token
  and a rule the client is the only thing applying is not a rule. The hook belongs to the
  `routes` plugin, so it covers the API and stops there — `webApp.ts` serves the built frontend
  from a sibling plugin, and a guarded `index.html` is an app nobody can open.
- **The session is a bearer token in `localStorage`, and revocation is a row.** `auth_tokens`
  holds one row per issued token, keyed by its **SHA-256** — never the token — so a copy of the
  database is a list of spent digests rather than a list of working credentials. That is the
  whole reason it is not a JWT: a self-describing token cannot be refused by the server that
  signed it, so "sign this account out everywhere" would become a key rotation that signs out
  everybody. Two lifetimes, and the split is the point — access a day, refresh a week **and
  rotated on every use**, so a stolen refresh token is worth one exchange and the theft shows
  as the real client being refused. Each exchange resets the week, which is "stay signed in"
  without a token that never expires. The client stores both under one key (`AUTH_STORAGE_KEY`,
  in `packages/shared` because the e2e suite removes it to look signed out — an `<img src>`
  cannot carry a header, which is why `sourceImageUrl` fetches bytes and hands back an object
  URL), and `refreshTokens()` is a **single shared promise**: on a cold load several requests
  401 together, and letting each refresh would spend the same single-use token from several
  directions and fail all but the first.
- **A password is `scrypt`, with its parameters inside the hash.** `hashPassword` writes
  `scrypt$N$r$p$salt$digest` and `verifyPassword` reads the cost out of the string it is
  checking rather than out of the constants, so raising them does not orphan what was already
  written. A login that finds no account still runs the check, against a decoy hash: without
  it, "no such name" returns immediately and "wrong password" takes 80ms, which turns the route
  into a way to enumerate accounts. A wrong password and an unknown name share one 401 for the
  same reason; `ACCOUNT_DISABLED` is a separate 403 **because it is only reachable after a
  correct password**, so it tells the caller nothing they had not already proved.
- **The first administrator is made by the control panel, with the server stopped — and the
  server will not listen without one.** The web app has no create-account screen and no
  bootstrap route: a login form is reachable over the network the moment LAN sharing is on, so
  a `public` create-administrator route would be claimable by the whole network during the one
  window with no owner. Instead the panel spawns the server package's administrator CLI
  (`apps/server/src/cli.ts`, bundled to `dist/server/cli.mjs`) as a **one-shot child**
  (`apps/desktop/src/main/oneShot.ts` + `admin.ts`) that writes the account directly with no
  server running, and `main()` calls `assertHasAdministrator(db)` after `buildServer` and
  before `listen`, naming the fix on stderr. The predicate is **an enabled superadmin**, not
  "some account has a password" (`hasSuperadmin`/`isEnabledSuperadmin`): a credential with no
  role can sign in and can administer nothing. The CLI *adopts* a passwordless account of the
  same name (the upgrade path from the build where a username was the credential), and its
  check-and-write is one `BEGIN IMMEDIATE` transaction — two processes racing to bootstrap make
  exactly one administrator (the HTTP route's "no `await` between the check and the write"
  argument does not survive a process boundary). The same command is the headless path:
  `pnpm --filter @ilearnassist/server cli create-admin …`; `ensure-admin` is its idempotent form,
  which the Playwright config chains ahead of the server. Do not add an unauthenticated
  bootstrap route back: its guard was the panel's own process boundary, deliberately.
- **Recovery for a forgotten password is a CLI command, and there is no route for it —
  `reset-admin`, run by the panel as a one-shot child.** Every HTTP route needs somebody already
  signed in, which is exactly what a forgotten password prevents, so recovery cannot live on
  that side; and it must work **with the server stopped**, because a forgotten password is
  usually found in the same moment as something else being wrong. There used to be a route
  guarded by a per-launch secret (`ILA_PANEL_TOKEN`); it was deleted because the secret guarded
  nothing a process boundary did not already — the panel runs on the operator's machine and
  holds the CLI, and anyone who can run it can read the database file anyway — while the route
  *did* cost a dependency on a healthy server, in the one control that exists for when something
  is wrong. `ILA_LAUNCHED_BY_PANEL` replaces it, and is a **flag rather than a secret**: it only
  decides whether a no-administrator refusal names the panel's button or the CLI command.
  `resetAdmin` refuses a non-superadmin target, so it is not a way round the console's rules,
  and it deliberately does **not** run `createDb`: DDL from a second process while the server is
  up would race the schema the server already applied, so it opens the file, refuses an
  unreadable one, and runs plain `UPDATE`s in one `IMMEDIATE` transaction. The panel hands the
  operator's **chosen** password to the child (`--password-stdin`), the same assumption
  `create-admin` makes — the person at the machine is the superadmin — so no random password is
  generated or shown and the success envelope carries no password back; the terminal path keeps
  `--generate`. `cli reset-admin` requires exactly one of the two flags.
- **The upload limit is an installation-wide setting, and its ceiling is a fact about routes.**
  `MAX_ATTACHMENT_BYTES` (10 MB) is the *default*; the value in force lives in `app_settings`
  (`upload.maxFileBytes`), is written by `PUT /api/upload-settings`, and reaches the client as
  `PublicConfig.maxUploadBytes` so the composer refuses past it before a request is made. The
  ceiling (100 MB) is not a policy choice: Fastify's `bodyLimit` is fixed when a route is
  registered, so the route carries the ceiling and the *handler* compares against the setting.
  Two consequences worth keeping: a body past the ceiling is refused by Fastify without our
  envelope, and every `FILE_TOO_LARGE` refusal must name the limit that actually applied
  (`fileTooLarge(limit)`) — a sentence compiled against the constant would tell a user "10 MB" while
  refusing at 50.
- **A setting every account shares is an administrator's to change, and the split is
  "configure vs choose".** Providers and models, document parsers, the parsing policy and the app
  defaults are **installation-wide**; their *writes* carry `requirePlatformAdmin` (either tier)
  while their reads stay open — the composer needs the model list and the parse state, and a
  screen that cannot say which models exist is not one anybody can use. So an administrator
  *configures* the models and an ordinary account *chooses among* them, which is why the picker
  hides a provider with no key rather than offering one that answers nothing. This is not
  tidiness: a provider's `baseURL` is where every conversation's prompts go, so an account that
  could add one and point `/api/defaults` at it would read everybody's traffic; and
  `POST /api/document-parsers/:id/test` makes the **server** fetch a `baseURL` the caller chose,
  the capability `web_fetch` needs its SSRF guard for. Before there were roles these routes were
  everyone's because everyone was one person — that stopped being true when a second account
  existed. The rule for a new route is the console's: if it changes something every account
  shares, it is an administrator's.
  **The console is where those screens live**, and the dialog that holds the account's own
  Copilots is not: everything installation-wide the old settings dialog held answered 403 for an
  ordinary account and showed a URL the server fetches to everybody. There is no global settings
  dialog at all now — the Copilots have one of their own (`CopilotsDialog.vue`, opened from the
  助理 row of either rail — the front door has no sidebar, so the menu it does have is what
  carries it),
  and the sidebar's old 设置 row is 工作区设置 instead. The test for whether a screen belongs in
  the console is whether it changes something every account shares, or is an account itself;
  anything one account does for itself belongs in the app. A namespace outliving its dialog is
  expected rather than a smell: `settings.*` is the console's sections plus the one pointer an
  administrator sees in the Copilot list.
- **Never coerce a request field into a role or a flag.** `disabled` must be a real boolean:
  `"false"` is truthy, so a coerced `PATCH { disabled: "false" }` would store `1` while
  `disabled === true` missed the self-guard — an administrator locking themselves out past the
  check that exists to stop exactly that, with the panel's recovery then finding no enabled
  superadmin to reset. Same discipline as an unknown role in `normalizeRoles`: refuse with
  `INVALID_FIELD` rather than guess what was meant.
- **Roles are a list, and the last administrator cannot be removed.** `users.roles` is a JSON
  array and every check is "does this account hold role R", so a third role is a row that
  changes. `PATCH /api/admin/users/:id` refuses **self**-demotion and self-disable
  (`CANNOT_MODIFY_SELF`) and that refusal is the *whole* of the "somebody has to remain" rule:
  reaching the route means the caller is an enabled administrator, so one administrator always
  survives whoever else is changed. A separate last-administrator check would be a branch no test
  could cover. Users are **disabled, never deleted** — the row owns workspaces, conversations
  and uploaded files. A disabled account's live tokens stop working in the same request, and
  an administrator resetting *their own* password does not set `mustChangePassword` (they chose
  the value a moment ago) while resetting anybody else's does; either way the reset ends the
  target's sessions and hands the caller a replacement pair when the target is themselves.
- **There are two tiers of administrator, exactly one superadmin, and the split is about who
  may appoint whom.** `USER_ROLES` is `superadmin`, `admin`, `user`; `isPlatformAdmin` is the
  *set* (`PLATFORM_ADMIN_ROLES`) rather than a comparison, so the bootstrap account never needs
  a second role bolted on to keep working. A **superadmin** is the single account the
  installation was bootstrapped with — the desktop control panel's first-run card or
  `cli create-admin`, both of which refuse once an enabled superadmin exists — and it is the
  only role that may appoint an ordinary administrator. The web console cannot mint a
  superadmin at all: its create/edit UI iterates only `CONSOLE_GRANTABLE_ROLES`
  (`admin`, `user`), the superadmin row shows the tier as static text rather than a checkbox,
  and any HTTP write containing the role answers `SUPERADMIN_NOT_GRANTABLE`, whoever sent it.
  An **admin** runs the installation's ordinary accounts and its shared settings, and may not
  touch an account that administers it: not the superadmin, and not a peer either, because two
  administrators disabling each other is a race whose winner is whoever clicked second. The
  rule lives in one function, `manageRefusal`, because demote/disable/reset/kick are the same
  answer four times and four copies is four chances to forget one; `grantRefusal` is separate
  because it is about the *value being written* (an appointment) rather than the row being
  read. **Your own row is excluded from `manageRefusal`** — every route already has its own
  careful answer for the self case, and folding self in shadowed them (it made an ordinary
  administrator unable to reset their own password). Promotion is refused, not stripped down:
  a request that asked for an administrator and silently got an ordinary account reports
  success and delivers something else.
- **A superadmin's own password is reset in the control panel, and nowhere else.**
  `POST /api/admin/users/:id/password` answers `PANEL_RESET_REQUIRED` when a superadmin names
  themselves. It is a rule rather than a convenience: the web console is reached with a
  credential the caller already holds, so a self-reset there would be a second and weaker way to
  replace the one credential that can undo the installation. An ordinary administrator is not in
  that position and resets their own from the web normally.
- **A workspace's conversation count and last activity are derived, never stored.**
  `GET /api/workspaces` computes them in the same query that lists workspaces (a LEFT JOIN,
  so a workspace with no conversations still appears with `0`/`null`), and the client
  re-reads that list on the way back to the home page rather than keeping a counter. A
  stored count is a second source of truth to get wrong on every deleted turn, renamed
  session and second tab. Renaming a workspace is display-only: the directory keeps the slug
  it was created with, or every path the agent had already written into a conversation would
  break under it.
- **Styling goes through the design system.** `docs/design-system.md` is the
  spec and `apps/web/test/style.test.ts` enforces it: a new colour lands in the
  one `:root` block *and* in both light-palette blocks, and spacing, type and
  radius come from tokens rather than literals — a `padding: 8px 12px` in a
  component fails the build. Nothing but colours is restated for the light
  theme; the guard derives that from the value, so a length or a duration needs
  no light variant and a colour cannot skip one. `--scrim` is the cautionary
  tale: it was exempted as "a black that dims rather than colours", and 0.55 of
  black over a white page composites the whole thing to `#737373`.
- **A breakpoint is a literal in two languages.** `composables/breakpoints.ts`
  holds the strings that reach `matchMedia`; `style.css` holds the same values as
  media queries, and both are pinned by tests. Change them together — a mismatch
  is a drawer that opens on a screen with no toggle.
- **Every overlay is teleported to `body`.** `position: fixed` resolves against
  the nearest *transformed* ancestor, and the mobile drawer is one, so a dialog
  left inside the sidebar renders off-screen. Relatedly, do not give `.app` a
  `transform`, `filter` or `contain`: it would become the containing block for
  the fixed sidebar and every overlay at once.
- **Responsive rules live at the end of `style.css`.** A media query does not
  raise specificity, so an override written above the rule it means to override
  loses on source order alone. This has already produced one bug: the narrow
  `position: fixed` on `.overlay-popover` silently lost to the same class
  declared further down.
- **A hidden `<input type="file">` is `.hidden-input`, a *scoped* rule, not a utility class.**
  There is no global `.visually-hidden` in `style.css`, and writing one produced two file pickers
  (`FileTree`, `SourceBrowser`) that rendered as a visible "Choose File" strip in a toolbar and a
  dialog footer. The composer's is the convention to copy: `display: none`, because the button
  above it is the control and an input that stayed focusable would be a second tab stop on a
  control nobody sees.
- **A list that two things can reload concurrently needs a sequence number.** The source browser
  starts a load when it opens and another when a filter changes; responses do not arrive in order,
  so the older reply used to overwrite the newer and the list settled on the *unfiltered* answer
  while the controls said otherwise. `loadRows`/`loadScope` drop a reply that is not the latest —
  the same shape as `runPreview`'s `filePreviewSeq` in `stores/app.ts`.

- **Adding material is one door with a tab per kind, not one button per kind.** The browser's footer
  used to hold 上传资料 and 添加链接 side by side: two idioms for one *operation*, one of which fired
  a file picker the instant it was pressed, and neither of which said where the result would land.
  `AddSourceDialog` asks what is being added first, draws that kind's fields, and sends nothing
  until it is submitted — which is what a knowledge base does, and what makes "a workspace and a
  folder" expressible at all. The tabs share **where it goes** (the workspace, plus the directory
  for a file) and nothing else, which is why they are tabs of one dialog rather than two; `TABS` is
  data, so a third kind is an entry plus a branch in the body rather than a second dialog. A
  **conversation is never offered** as a target, on the rule the browser is built on: a
  conversation's own folder is written by the agent and by uploads made inside it. The file tab
  takes several files and sends **one request each**, so a partial failure names the file it failed
  on and a retry resends only what is left.
- **A `<select>` bound to `undefined` paints blank, not its placeholder option.** The browser's
  filters open from `?workspaceId=`-style props, which are absent rather than empty, and every
  control rendered as an empty box — so `asFilters` gives every key the empty string, spelled out
  as a `Record<keyof SourceFilterQuery, string>` so a new filter is a compile error there rather
  than a control that stays blank. (A *disabled* select is the same failure and is why the session
  picker renders only once a workspace is chosen.)
- **The file tree moves things two ways, and neither replaces the other.** Dragging a row onto a
  folder is the fast path; `canDropOn` refuses four things, each a move the server would reject or
  that means nothing — onto itself, onto the folder that already holds it, into its own subtree,
  and onto a *file*. The rename/move dialog stays the complete path, because a drop target can only
  be a row you can see. Dropping on the panel itself means the workspace **root**, which has no row
  to aim at and is otherwise unreachable by drag. One trap, found by the browser suite: read the
  drag state *before* clearing it — the drop handler cleared first and then asked `canDropOn`,
  which answered "no" every time.
- **A bare `@` in a catalog message is a compile-time bomb that only goes off in a browser.**
  vue-i18n reads `@:key` as its *linked-message* syntax, so a message containing one throws at
  **render time** — taking down the whole component the message is in. This is not theoretical:
  `composer.placeholder` gained "输入 @ 可引用资料" with the `@`-reference, passed `vue-tsc`,
  passed the whole catalog suite, and left the composer blank on every page. The escape is
  `{'@'}`, the same shape a literal `|` needs in a plural, and `catalog.test.ts` now fails on a
  bare one.
- **The registry is an index of the filesystem, and it is refreshed before a source listing.**
  Two mechanisms answering different questions: `reconcileListing` registers what a *directory
  listing* finds (the file browser's routes), and `reconcileFilesystem` walks the scopes a
  **source listing** is about, bounded by depth and a file cap, at the top of `GET /api/sources`.
  The second exists because the browser lists *rows*, not directories — so a file that appeared
  with no writer at all (cloned in, restored, dropped from the Finder) was invisible until
  somebody happened to open the file tree on that folder. A boot-time scan would answer "what was
  there when the server started", which is a different question from the one the reader is
  asking. The walk is capped and idempotent, so paying it per listing is affordable.
- **`ila_collect_page` keeps a page, and its identity is the reading rather than the bytes.**
  `web_fetch` stays a pure read; keeping a page is a second, deliberate call by the model — which
  is what the requirement means by "only the pages finally confirmed relevant". It fetches
  through `web_fetch`'s **exported** `fetchGuarded` (the SSRF guard has one implementation, not
  two), stores the HTML under `sources/web/`, and hashes URL **plus extracted text**: a masthead
  that changed since yesterday is the same source, an article that changed is a new one. A turn's
  fetches are cached by `buildTools`, so keeping a page the model just read costs no second
  request.
  **It also needs `COLLECT_PAGE_GUIDANCE`, and that is not decoration.** The tool is on by
  default — `webFetch.enabled` is the only switch — so a conversation gets it whether or not
  anyone thought about it, and its own description is a *restriction* ("do this only for pages
  this conversation is actually about"): a model that was never told to keep anything reads that
  as "usually do not". For a while the tool was assembled, wired, stored and tested and still did
  nothing in use, for exactly this reason. The guidance goes in the system prompt on any turn
  where the tool *survived assembly* — `routes.ts` asks the assembled array, never the config, so
  a Copilot whose allow-list excludes the tool is never given guidance for a call it cannot make.
  Its absence is the shape the requirement is about: `web_fetch` stays a pure read, and the
  decision to keep is the model's, made deliberately once per page worth keeping.
- **Every turn's system prompt states what time it is where the user is.** `agent/clock.ts`
  formats it and `buildSystemPrompt` appends it second — after the persona, before the folders —
  unconditionally, including on turns that have nothing to do with time. The reason is a failure
  rather than a nicety: a model asked about "today" without a date answers from the most recent
  date in its training data, confidently, and nothing in the reply reveals that it is wrong. What
  makes the instruction unconditional is the same failure — a model that does not know it should
  have checked will not check. Three things about it are load-bearing:
  - **The zone is the browser's, not the server's**, and it rides the request
    (`TurnRequestMeta.timezone`, shared by `/chat`, `/answers` and `/regenerate` because all three
    start a turn). The server may be on a desk while the user is on a phone in another timezone,
    so "the server's local time" is a proxy for the answer and not the answer. The *instant* is
    still the server's: the client contributes the zone and nothing else.
  - **It is a zone *name*, and the offset is derived at turn time.** An offset sent by a browser
    left open across a daylight-saving boundary would state the wrong hour for the rest of the
    session, and `Europe/London` is `UTC+01:00` in September and `UTC+00:00` in January.
  - **The zone is untrusted and unusable names are dropped, not refused.** `Intl` throws a
    `RangeError` on a zone it cannot resolve, and a throw here would fail the turn; `knownTimeZone`
    narrows it, and the fallback is the server's own zone — the same answer as sending none, and
    the right one for the desktop app where the two are the same machine.
  `clock.ts` is pure and takes `now` and the zone as arguments, which is what lets the format be
  tested at a pinned instant rather than at whatever day the suite runs.
- **Every system prompt lives in one catalog, and is read at call time — never captured in a
  constant.** `apps/server/src/prompts.json` is a **keyed object** (not an array), so a deployment's
  `<dataRoot>/config.patch.json` overriding `prompts["title.system"]` replaces exactly that entry
  through the already-exported `deepMerge`. Three things are load-bearing:
  - **`renderPrompt(key, vars)`, never `export const`.** The catalog is patched by the *process entry
    point*, which runs after every module has been evaluated, so a module-level constant would be the
    bundled text for the process's whole life and a tuned prompt would silently do nothing — the
    failure this repo names most often. That is why `THREAD_SYSTEM_PROMPT` became
    `threadSystemPrompt()` and friends. `buildSystemPrompt` keeps only the **conditions** (which
    blocks apply, which of two sandbox sentences); every **word** comes from the catalog.
  - **A missing placeholder throws; an empty one renders as nothing.** The split is what lets a block
    be dropped (an uninstalled widget supplies `""`) while a missing value is loud. The placeholder
    name is restricted to an identifier so the classifier's `{"decisions":[…]}` schema cannot be
    mistaken for one, and a test scans every entry for a `{{` the pattern does not match.
  - **`test/helpers/fakeLlm.ts` identifies out-of-band calls by a substring of their prompt prose**
    (`"topic-classification function"`, `"reflective study coach"`, `"short summary of a study
    conversation"`, `"titling function"`). Reflowing one of those four sentences breaks the *test
    harness* rather than the app, and the failure lands somewhere unrelated — so a test asserts each
    marker is still in its catalog entry, and changing such a sentence means updating the marker too.
  `config.patch.json` is **not a prompt feature**: it is deep-merged over the whole config tree, an
  unreadable file throws naming the path, and a typo'd prompt key warns at boot rather than doing
  nothing quietly. Tool descriptions and the out-of-band *user*-prompt templates stay in code — they
  are bound to schemas and to data assembly, not free-standing prompt text. See `docs/prompts.md`.
- **A referenced source is *linked*, not copied.** `ChatInput.sources` names ids; the server
  links each to the conversation (`session_sources`) and records the snapshot in
  **`messages.sources`**, a column of its own beside `attachments`. The link is what lets a later
  turn `read_document` a file the user pointed at once — and it is the same row an upload writes.
  The two columns are one array in the prompt, because to the model a reference and an attachment
  are the same thing; the split exists so a chip can say which is which.
- **An image gets one summary, written by the model that saw it.** `agent/mediaSummary.ts` runs
  fire-and-forget from `finishTurn`, writes to the `summary` column *and* `parsed/<id>.txt` (a
  summary in the column alone would be a file the model still could not read), and is gated three
  ways: `needsSummary` skips an image that already has one, `ctx.vision` skips a model with no
  vision — a description would be a claim about a picture nothing looked at, and the request
  would be an `image_url` a non-vision endpoint rejects — and every failure is swallowed, like
  the titler's.
- **The `@` picker's rule lives in `utils/mention.ts`, and its `@` must not be glued to a word.**
  `ada@example.com` is not a mention; punctuation before the `@` is allowed, so `(@report.pdf)`
  works. The picker is positioned *inside* `.composer .surface`, which is why that rule carries a
  `position: relative` — without a positioning context the menu renders off-screen, visible to
  the DOM and not to the person typing. Its query is debounced, and not only for the bandwidth:
  a fetch per keystroke replaces the rows, so a click aimed at one lands on a detached node.
- **The picker holds two kinds of reference, and the list's arithmetic is `utils/referencePicker.ts`.**
  A tab strip (`全部` | `工作区` | `资料`) filters by kind and doubles as the group headings, and a row
  of type pills (`图片` | `文本` | `代码` | `网页链接` | `其他文件`) filters the sources. Three rules are
  load-bearing rather than cosmetic. The pills are a **coarse grouping over the eight categories**,
  mapped in one `Record` so a new category is a compile error — and they filter **client-side**,
  because the picker fetches the account's whole match set and caps *per group*, so a server-side
  filter would cap before filtering and show fewer matches than exist. Selecting any pill **drops
  the workspace group**, and the pill row is **hidden** on the 工作区 tab rather than disabled: a
  workspace has no source type, and a control that provably cannot change the list is a lie.
  **Enter belongs to the picker while it is open, rows or not** — the frame is drawn before the
  debounced fetch lands, and the composer's Enter *sends*, so a guard on "are there rows" puts a
  half-typed `@repo` into the conversation. `Tab` is the exception and is taken only when there is
  a row, because it cannot send anything.
- **A workspace is the other thing `@` picks, and the grant is a setting rather than a turn field.**
  `@{工作区}` / `@所有工作区` write `SessionSettings.workspaceScope` — because a grant *persists*,
  survives a reload, and must be in force for turns nobody typed an `@` in. `all` is a **flag, not
  a snapshot** ("everything I have", not "everything I had on Tuesday"), and the two halves are
  never both meaningful. `apps/server/src/workspaceScope.ts` is the whole of its authority and the
  only reader of the stored value: it re-derives against the account's live workspaces on every
  turn, so a stored id is a *request*, not an access — a foreign or deleted one resolves to
  nothing. `turnContext()` calls it once and is the only caller of `listReadableSources`, so a
  fourth turn route that built its tools some other way loses `read_document` loudly rather than
  under-granting quietly. The write path validates **shape only** and deliberately not ownership:
  a workspace can be deleted between the chip being drawn and the save landing.
  What it opens is three things, and each needs its own mechanism — a granted workspace's linked
  uploads and pages (the `workspace_sources` arm), the material its *conversations* hold (a third
  arm, because `registerFileSource` writes a row and **no link row**), and its **files**
  (`ila_explore`, because a file is a path and `read_document` addresses ids). Read-only
  throughout: `ila_explore` contains no write call, and it is the one place that **`realpath`s
  every path** — `resolveInWorkspace` is lexical on purpose, justified by "the model has no tool
  that makes a symlink", and that argument does not survive a symlink in a granted workspace
  becoming a read path out of somebody else's conversation.
- **The server serves the built frontend, and only when one exists.** `webApp.ts`
  registers `@fastify/static` at `/` *after* the API routes, conditional on an
  `index.html` being present. `buildServer` takes `webDir` and **tests never pass it** —
  whether the machine running them happens to have run `pnpm build` must not change what
  they assert. That a concrete `/api` route still wins over the static wildcard, and that
  an unknown `/api/...` still answers with Fastify's 404 envelope, are pinned in
  `apps/server/test/web-app.test.ts`.
- **The desktop server runs on Electron's Node, not a system Node.** There is no Node on
  a user's machine, so the child is spawned from `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1`. That is also what makes `better-sqlite3`'s prebuilt N-API
  binary the right one. Do not "simplify" it to a plain `node` invocation.
- **The panel enters `running` on exactly one signal**: the server printing
  `[ilearnassist] listening on <url>`. Not a fixed port, not a timer, and not
  Fastify's own "Server listening at …" banner, which is logged from inside `listen`
  before the process is necessarily ready. A control panel that claims a server is up
  when it is not is worse than one that says nothing, because the user has no way to tell.
- **Whether Start may spawn a server is `mayStartServer(hasAdmin)`, and the field it reads is
  named in the positive.** Both are consequences of a bug that made **Start do nothing at all**
  once an administrator existed: the panel cached `needsAdmin` while both callers read it as
  "has one" and started only when it was true, so the button worked exactly once — on an empty
  data root, where the server would then refuse to listen. The rule is three inputs and two
  answers: `true` starts, `false` does not (the server would exit on its own boot gate, and the
  create card is already on screen), and **`undefined` starts anyway** — no data root, an
  unreadable database, a CLI that would not run.
  What `false` is *not* is a dead end, and that is the page's half: `startFlow` in the renderer
  reads `needsAdmin` off the state this returns, opens the create-administrator sheet, and asks
  Start again once the account exists. The split is forced — the form that collects a name and a
  password is the page's, so main cannot complete it alone — and it is why Start is no longer
  *disabled* in the needs-admin state: a button that refuses without saying what is missing is the
  failure `mayStartServer` exists to prevent, one step earlier. Trying is what keeps the button from going
  silent when the check it depends on is the thing that is broken; the server's gate is the
  backstop and says so on stderr. A predicate cannot be inverted by accident the way a boolean
  variable's meaning can, which is why this is a function and not an `if`.
- **`ServerProcess`'s data root is a *function*, like its launch spec.** The user can choose a
  different folder while the object is alive, and the panel renders the status's copy of it —
  captured by value it showed the folder from construction, which on a first choice was an empty
  box until the app was restarted. Nothing about the *supervision* changes when the root changes
  (there is no process to reconcile; `chooseDataDir` stops the server first), so the class only
  ever needs to be able to *report* the current one. `apps/web/src/stores/app.ts`'s `canAdmin`
  is the same shape of fix one layer up.
- **The desktop app never writes into its own bundle.** The *app's* state lives under
  `app.getPath("userData")`, reached through `ILA_PROJECT_ROOT`; the bundle is read-only and
  is replaced wholesale on every update. First-run seeding is idempotent and **never
  overwrites** an existing `config.yaml` or overlay — that is what keeps an API key the user
  typed into the Settings UI from vanishing on the next launch.
- **The panel's language belongs to the main process, and the page renders what it is told.**
  `desktop.json`'s `locale` is the source of truth (`""` means follow the system — the panel is
  a desktop app, so the OS already has an opinion and "back to the system" has to be expressible);
  `choosePanelLocale` is the only place that decides what a choice *means*, while `readSettings`
  only narrows a hand-edited value to something renderable. `panel:set-locale` writes it, rebuilds
  the menu and the tray, retitles the window and broadcasts, and the page adopts the `locale` off
  the broadcast — because the menu bar, the tray and every native dialog are strings Electron
  draws *outside* the page, and a page that switched on its own would leave the chrome above it
  in the old language. The renderer's `navigator.language` is only the placeholder for the
  milliseconds before the first state arrives. The three options are labelled in their own
  language — 简体中文 and English do not translate — and `apps/desktop/test/messages.test.ts`
  allows that one CJK value in the English catalog for exactly that reason.
- **The app's directory and the user's are two different directories.** The app's holds
  `config/` and `.env`; the user's holds the database, every account's workspaces and their
  uploads. That split is what makes "back up my work" a copy of one directory and "reinstall
  the app" a replacement of another, so it is worth keeping in mind whenever a path is
  added. The user's is chosen at launch and remembered in `desktop.json`
  (`DesktopSettings.dataDir`) — precedence is `ILA_DATA_DIR` first, then that file, then the
  folder picker, which is what lets `desktop:dev` and the e2e harness run without a human at a
  dialog. Two consequences worth stating: first-run seeding deliberately does **not** create a
  data folder, because an empty one looks exactly like the data root the user was supposed to
  pick; and the picker warns — but never refuses — when the chosen folder holds no database,
  because starting in a new folder is the normal first-run case and looking identical to
  "everything is gone" is the failure it prevents. `suggestedDataDir` is only where the picker
  opens.
- **The panel's LAN switch owns the bind address, and `ILA_HOST` is always set.** Including
  when sharing is off and the address is loopback. Leaving that case to `config.yaml` would
  let a hand-edited `server.host` there put the server on the network while the switch still
  read "off", and a control whose stated state and actual state can disagree is worse than
  no control. Sharing is off until asked for: turning it on makes the user's workspaces,
  conversations and provider keys reachable by anything on the network.
- **The QR code does not follow the theme, and its colours are `fill` attributes rather
  than CSS.** A scanner needs dark modules on a light field. As classes the colours live
  only as long as the stylesheet does, so a serialised or rasterised copy of the SVG falls
  back to SVG's default black fill — quiet zone included, which then paints over the whole
  code. That is what the first version did.
- **Closing the panel does not stop the server.** The window hides; only the tray item and
  a real quit reach `server.stop()`, through `before-quit`. Do not add an
  `app.on("window-all-closed", () => app.quit())`, and do not make the panel's `close`
  handler destroy anything — a phone mid-conversation is the thing this protects.
- **A LAN address is ranked, never just found.** A VPN or container address is a private
  IPv4 on an up interface and unreachable from a phone in the same room, so `lan.ts`
  excludes virtual interfaces by name and returns null rather than a code that cannot work.
  See `docs/desktop.md` → Which address goes in the code.
- **`asar: false` and `npmRebuild: false` in `electron-builder.yml` are deliberate.**
  The first, because the server resolves a native addon and an ESM package from a child
  process and neither should have to go through an asar archive. The second, because
  `better-sqlite3` v13's prebuilds are N-API and therefore already ABI-correct for
  Electron. Flip `npmRebuild` only if a dependency ships a non-N-API native module.
  Rationale in full in `docs/desktop.md`.
- **Extracted text lives in `parsed/`, beside the bytes but never mixed with them.** A
  source's derived data goes to `<userRoot>/sources/parsed/<sourceId>.txt`, never
  `sources/raw/<sourceId>.txt`. The split used to be *load-bearing* — `findStoredAttachment()`
  globbed `<id>.*` and `txt` is a valid extension in the MIME table, so a flat sibling could
  be served in place of the original PDF. That hazard is gone: nothing globs any more, because
  the path is a column. The split stays because raw bytes and derived text are different kinds
  of thing, and a reader should never have to check which it is holding. Both the retired
  hazard and the current shape are pinned in `apps/server/test/documents/store.test.ts`.
- **A document tool takes an id *and* a whitelist, or it reintroduces the hole.**
  `read_document` resolves through a `Map` built from that whitelist, so an id it was not
  handed fails before any path is touched — the discipline is the lookup, not the narrowness
  of the list (see the sandbox bullet above for what is on it). Ids are guessable; a tool that
  took a bare one would let a model read files it was never given.
- **A document that could not be read must never look like one that was.** An empty
  extraction is reported as `no_text_layer`, not as empty text — a model told it read
  a file it never saw will answer about it anyway. `parseStatus` is what the UI renders and
  what `buildUserContent` puts in the prompt, and the composer blocks sending until extraction
  has settled. A source no extraction was *needed* for reads `none`, not `ready`: the two are
  different claims and the chip shows different things.
- **`pdfjs-dist` is pinned to 4.x.** 5.7+ and 6.x require Node ≥ 22.13 while
  `package.json` advertises Node ≥ 20; bumping that floor is a separate,
  user-visible change and must not ride along with an unrelated dependency update.
- **A widget instance is a row, and an uninstall is `enabled = 0`.** The row's *existence*
  records that somebody decided something; `enabled` is what they decided. Deleting on uninstall
  would fall back to the level's default and silently reinstall the widget, and a decision cannot
  then be told apart from the absence of one. `(scope, scope_id, widget_id)` is the primary key
  and the write is an upsert, which is what makes repeated install/uninstall ordinary rather than
  a duplicate-key error. There is deliberately **no copilot scope** — a Copilot's selection lives
  in `copilots.widgets` and is *copied* into the session it starts, like `settings` and `tools`.
  That column is nullable for the `all_tools` reason: `NULL` is "never set", an array (including
  `[]`) is a selection, and a `NOT NULL DEFAULT '[]'` would have told every Copilot written before
  the column existed that it installs nothing.
- **Which level a widget accepts is declared by the widget, and an unknown id is refused, never
  dropped.** `WIDGET_IDS` / `WIDGETS` / `widgetsForScope()` live in `packages/shared` for the
  `ALL_TOOL_NAMES` reason — the client writes the id and the server filters by it — and a *dropped*
  id is a selection that looks like it worked: the user ticked a box, the request succeeded, and
  nothing was installed. A widget this build does not know is `UNKNOWN_WIDGET`; one at the wrong
  level is `WIDGET_SCOPE_UNSUPPORTED`. Reads resolve through the registry rather than the rows, so
  one entry comes back per widget at that level and a stored row is indistinguishable from a
  defaulted one.
- **Widget-bound tools are switched by the install, and bypass the tool allow-list.** A `WIDGETS` entry may name `boundTools`; `turnContext()` reads the session's installed widgets per turn and assembles those tools (context-gated like `read_document`) regardless of the `allTools`/`tools` snapshot in all three states, including the empty "no tools" list. They are filtered out of the Copilot tool checklist (`isWidgetBoundTool`), since a box there can neither enable nor remove them. The plan widget binds `ila_make_plan` / `ila_read_plan` / `ila_update_plan_progress` (session scope only).
  **A tool whose widget is a *viewer* must not be bound, and `ila_diagram` is the case that
  settles it.** Binding is the right answer only when the widget is the capability's home — a
  quiz nobody can answer, a plan nobody can see. `WIDGETS.diagram` declares its two tools
  `auto-install` rather than binding them, because a bound tool is assembled *only* when its
  widget is installed and the only widgets installed by default are the notes and sources panels:
  binding diagrams would leave the model with no way to draw one in an ordinary conversation,
  which is the complaint the tool exists to answer, and `isWidgetBoundTool` would keep the name
  out of the allow-list so it could not even be switched on. They are ordinary allow-listable
  tools, and they differ from each other on `NON_FILE_TOOLS`: `ila_diagram` is deliberately **not**
  in it — `fileTools.enabled: false` means no diagrams, because a diagram whose file was never
  written is half the feature — while `ila_table` **is**, because its comparison is `ila_query`'s
  rather than the diagram's: a table writes a row and no file, so the switch about *files* has no
  bearing on it. The panel is a viewer over **both**: it lists the conversation's diagrams (name,
  summary, thread) and its tables (name, summary, the markdown), and opens the one you pick — a
  diagram through the ordinary file preview, a table through the viewer directly, since only one of
  the two has a file. The whole folder is the source browser, which the sidebar's library row opens
  *on* this workspace — a default its own workspace picker moves, since the browser is drawn from
  that rail with every control it has — see `docs/diagrams.md` and `docs/tables.md`.
  **The insight widget is the limiting case of the same rule: it has no tool at all.** Its data
  comes from an out-of-band model call a button triggers, so there is nothing to bind — and
  binding would be wrong anyway, because a bound tool is something the *agent* can call and the
  agent must not decide to spend a whole-conversation model call on a panel nobody may open. No
  `onInstall` either: an install is not a request for a pass. It is deliberately **not in the
  `"study"` group**, whose rule is "live on install" — the plan refreshes every turn, the quiz
  poses questions mid-turn, the thread classifies after every turn, while this one shows an empty
  panel and waits, and bundled it would install a tab that looks broken beside three working ones.
  The component holds its own data and subscribes to no widget event, for the reason the widget
  events bullet gives: every change to the list is a decision it made itself. See
  `docs/widgets.md` → "An on-demand widget with no tools".
  **The sources widget settles which of a conversation's two lists a panel shows, and it is not
  the one the model reads.** It calls `GET /api/sources?sessionId=…` — held by this conversation
  *or* linked into it: its own files, its uploads, its pages, its `@`-references — and
  deliberately **not** `/api/sessions/:id/sources`, which is the session ∪ workspace union and is
  the `read_document` whitelist verbatim. A panel on that route would list a workspace's whole
  corpus beside the three files the conversation is about, because "what may be read" and "what
  this is working from" are different questions. Two consequences that look like inconsistencies
  with the browser and are not: its **category filter is client-side** with its options derived
  from the rows already fetched (one conversation, not a workspace with a `node_modules` — and it
  keeps the server's bounded `reconcileFilesystem` walk off every filter click), and it has **no
  folders, no rename, no move and no delete**, because a conversation's material is written by the
  agent and by what the user references rather than laid out by hand. `turn.finished` is the only
  event it takes: a turn is what links a reference and what a tool writes a file through, and
  there is deliberately no `source.added`, since the client is what asked for every addition.
- **A quiz question has two ids, and its row exists before the answer.** `ila_quiz` (bound to the quiz widget) numbers Qn from the session counter AND registers a `quiz_questions` row with a global UUID when it suspends: the card/model use Qn; `ila_review_quiz`, the widget, and `/sessions/:id/quizzes/:qid/answer` use the UUID. Rows go pending → answered/dismissed on `/answers`, → skipped on walk-away (a GET reconciles crash-orphaned pending rows to skipped). Make-up is open to questions the user never submitted (`skipped` walk-away and `dismissed` explicit cancel — treated alike), but not `pending` (live card) or `answered`: the make-up POST does a status-guarded UPDATE of the SAME row (never an insert, clearing stale grading), then the client drives an ordinary `/chat` turn quoting the UUID so the model grades it instead of posing a new quiz. An optional `nodeId` names the live plan node a quiz checks (invalid ⇒ tool error); absent it binds to the current `in_progress` node, and absent a plan it is a session-level question. A question may carry an answer key — `referenceAnswer` (offered labels) and `explanation` — but it is grading material, never question material: it is stripped from the suspending call the client re-renders and from every client-facing frame (`redactQuizInput` covers the raw `tool_start` and the schema-failure `tool_end`; the `QuizSuspension` record is stripped), stored server-side on the quiz row (`reference_answer_json`/`explanation`, omitted by `toView`), and handed to the model only once an answer exists — in the resumed tool result (`quizAnswerKeysForCall`) for a live submit, and in a system-prompt-only note (`renderMakeupKeyNote`, gated by `ChatInput.makeupQuizId` naming an owned **answered** row) for a make-up. While a question is unanswered the UI likewise hides the option descriptions that explain the choices — nothing in the make-up dialog but the form, and no descriptions in a skipped card's settled disclosure — so an unanswered, still-make-up-eligible question can never leak its solution.
- **A note is about a passage, or about a 图 or a 表.** `notes.target_kind` is `text` | `diagram` |
  `table` and `target_ref` holds the figure's canonical `name` — the same handle `ila_query` takes
  and the same one a 追问 reference carries. The whole object is the target and never part of it:
  a mermaid diagram renders no addressable text nodes, and a table's cells are markdown the reader
  sees but the anchor arithmetic counts over rendered geometry. `NOT NULL DEFAULT 'text'` rather
  than a nullable column, because every note written before it existed genuinely *is* a text note —
  the default preserves what those rows already meant, where NULL would say "we do not know".
  `targetMissing` mirrors `messageMissing`, and it is a pair of `NOT EXISTS` each guarded by
  `target_kind`: a diagram and a table may share a name, so without the guard one row's presence
  would make the other's absence read as present — removing it fails three tests.
- **A note belongs to a conversation, and to a message only when something was annotated.** `notes.session_id` is `NOT NULL` and `message_id` is nullable, which is what makes a note the user typed from the panel the same kind of thing as one made by dragging over a sentence. `message_id` carries **no foreign key** on purpose: a regenerate or a tail delete soft-deletes a message, and the note is the user's own writing, so it survives with the quote it recorded — `messageMissing`, resolved by a `LEFT JOIN messages … AND m.deleted_at IS NULL` in the read that fetches the note, is how a read says so (never a client guess from a message list that only holds the conversation on screen). **An anchor is a text quote plus which occurrence of it**, counted over the message's **visible** text — never character offsets, which are offsets into rendered HTML and mean nothing after the next `v-html` assignment, and never a raw text walk, which sees every formula twice because KaTeX emits glyphs *and* hidden MathML. **The model reads notes and cannot write them.** No tool creates or edits one — that half of the original rule is the half that carries the product weight, since a turn must never rewrite what the learner wrote. The read arrives through the ordinary `ila_query(kind: "note")`, deliberately not through a tool bound to the notes widget: a bound tool is assembled only while its widget is installed, and nothing installs a widget by default, so binding the read would make the learner's own notes invisible in every conversation that had not opted into the panel. What the two sides gain: a plan, a quiz and an insight pass are all richer for knowing what the learner underlined, and a note that reads like an instruction is handed over as data about the learner, never as an instruction — the tool result says so in those words.
- **A widget can own a capability of the host, and exactly one holds it at a time.** The message list implements marking-up (selection, the floating bar, `<mark>`, the window) and knows nothing about notes as records; the notes widget owns the records and knows nothing about `Range`. `composables/messageNotes.ts` is the whole of what they share: a **claim**, per *conversation* rather than per widget (the message list on screen belongs to one session while the widget is installed in a different set of them), with a refusal that names the holder. The host registers on mount and the widget claims from `WidgetModule.onActive`, in either order, because the host **reads** the claim rather than being told about it. `onActive` is not `onMount`: `WidgetPanel` mounts only the active tab, so a claim owned by the component would drop the moment the reader looked at the plan, taking every highlight with it. It is called by `composables/widgetActivation.ts` — an effect owned by `ChatView`'s setup, because the panel being rendered *is* the answer to "is a widget live", and leaving the view (the one transition no reactive input expresses) is reported by that scope stopping. It is deliberately not a store `watch`: a store's setup belongs to no lifetime, and in a test suite every abandoned store instance keeps watching module-level singletons.
  **The floating bar is the conversation's, and the claim contributes *buttons* to it.** Noticing a selection and offering 追问 on it are things every conversation does; what varies is what a widget adds. So `useMessageSelection` is enabled whenever a conversation is open, `ChatView` composes `[its own action, ...claim.actions()]`, and the bar is hidden when that list is empty — which is what keeps a conversation with nothing installed from showing a strip of nothing. The host's action is deliberately **not** part of the claim: asking the claim for it would make the one universally available gesture disappear with the panel that is not about it. `actions()` is a **function** and each action carries its own `disabled`, both for the same reason — the notes widget derives its buttons' availability from its own writability, which changes while the claim stands, so a list frozen at claim time would leave them live in a conversation this client cannot write to, and one flag for the strip would have to pick which of two unrelated causes to be wrong about. An action's `label` arrives **translated**, not as a key: a widget is a non-component module, so it names its keys literally through `i18n.global.t`, and a key the host resolved would be invisible to `catalog.test.ts`'s scan — reported as dead, correctly. The element ids keep the `note-` prefix they were born with (`messageSelection.ts` skips a `mouseup` on `[data-testid="note-toolbar"]`, without which the press that uses a button dismisses the bar) — a rename would be three silent ways to break a working control in exchange for a word.
- **A 追问 is a pointer, and only a passage is a copy.** The gesture — select a passage, or point at a diagram, a table, a note or a quiz question — stages a chip in the composer and puts the caret there; the reader types their question and sends it. `TurnReference` is what the client sends, `turnReferences.ts` resolves it against the conversation, and `renderReferenceBlock` is the one renderer that turns it into prompt text. Four things are load-bearing:
  - **A diagram, a table and a note are *named*, never copied.** The agent reads them with `ila_query`, the tool it already uses for this conversation's own record. That costs a few words and buys currency — the answer is about the figure as it is now, not as it was when the reader was looking at it — and a long table never crowds out the turn asking about it. A **passage** has no handle (a text range inside a rendered message is not addressable) so its text travels; a **quiz question** travels too, deliberately unlike a figure, because fourteen words a round trip would fetch anyway are cheaper carried, and the sentence asking for no new quiz came across from the prose template this replaced.
  - **The block goes in the user turn's content, not the system prompt.** `/regenerate` sends `userMessage: null` and rebuilds the turn from history, so a block living only in the prompt would be lost there and the model asked the same question again with no antecedent. One renderer serves the live turn and every replayed one; `referencesForHistory` resolves the stored references per run, exactly as `sourcePaths` does for attachments and for the same reason.
  - **Refused, never dropped, on the live path** — the inverse of `body.sources`, and the difference is what the two are. A source is material the model may *read*, so losing it narrows the turn and the answer is still an answer; a reference is **the object of the question**, so losing it changes what was asked. The message is not written on a refusal either: a row recording a question the server declined to run would be a turn in the conversation that never happened. On the **replay** path the rule inverts — a target that has since gone is *reported*, never refused — because a turn that happened cannot be un-happened, and a history that failed to load over a deleted diagram would break every later turn.
  - **A passage's quote is not verified against the message.** The client measured it over the *rendered* DOM, the server holds markdown, and this repo will not grow a second renderer to check itself against — so a quote that does not appear verbatim is normal rather than suspicious. What the server does verify is ownership and session, which is the part a client-supplied id must never be trusted for. The block labels the passage as the learner's own selection and as data rather than instruction, the sentence `ila_query`'s note handler already carries.
  A turn may be **nothing but references** — "what about this?" is a complete question — so the store's send guard and the route's `MESSAGE_REQUIRED` check both know about them; the two disagreeing is how a question asked by pointing gets refused by a server that never looked. `ila_query(kind: "note"|"quiz")` and the figure kind's `name` are what a reference resolves *through*, so a kind the model cannot look up is a kind it cannot be given: the quiz listing carried only the `Qn` for as long as nothing resolved the global id the old template quoted.
- **Plan versions are structural snapshots; progress lives on node identities.** `plan_versions.tree_json` holds id/title/children only — history is status-free and read-only; node status, the start-jump anchor and tombstones live once in `plan_nodes`, keyed by server-assigned UUIDs (never readable numbers or titles; the `1` / `1.1` a user sees is derived from sibling position by `planNodeNumbers`, and is display, not identity). A node dropped from an edit becomes a `deleted` tombstone: struck through in the current view, frozen in its last place, absent from that version's snapshot, still visible in older history; tombstone ids can't be reused and a progress update can't mark `deleted` (only an edit removes). The anchor is the node's **start**: the `in_progress` call placed before its content (`done_tool_call_id` column, widened without a rename), kept through completion, cleared when the node returns to not-started/skipped; a click scrolls the chat to that tool-call card. "Make a second plan" is the third suspending tool — its `SuspendingTool.commit` side-effect fork in `tools/suspending.ts` either overwrites as a new version or auto-creates a snapshot session (Copilot/settings/tools copied and the plan widget installed), writes V1 there and navigates via the `plan_session_created` SSE event. The store refreshes the panel mid-turn by emitting `plan.changed` from the existing `tool_end` arm — no extra SSE event for that — and **only `ila_make_plan` additionally opens the panel on the plan tab**, because it is the one of the three that creates or edits rather than reads or marks progress; narrowing the *event* instead would stop the tree moving on a progress update, which is the opposite of the point. The **edit** path cannot be caught at `tool_end` at all: a conflicting `ila_make_plan` suspends, and a suspended call emits no `tool_end` (the same absence that keeps a pending `ask_user` out of the model's context), so the store's own record of the user's `{choice: "edit"}` in `answerQuestion` is the only client-visible moment — a thing the client decided and holds, which is why it is not an event. The `new_session` fork's own conversation is surfaced by the `plan_session_created` tail, after the session switch. Two panel actions compose a user message and go through the ordinary `/chat` flow: the footer "adjust plan" composer, and "jump to chapter" (which first POSTs `/plan/nodes/:id/jump` — server-side skip of prior undone nodes plus open the target — then sends `调整进度，跳到章节…`). While the widget is installed the turn's system prompt also carries `PLAN_GUIDANCE` (mark a node before teaching it, stay on the plan, hand back after a detour).
- **The widget panel is a third grid track, and `--widget-w` is always set when the class is.**
  `App.vue` withholds `with-widgets` on a compact viewport, where the panel is a fixed drawer, and
  below 900px it must be withheld — the class would add a track the drawer does not occupy. The
  `var(--widget-w)` in `style.css` has **no fallback** on purpose: an unresolvable custom property
  makes the whole `grid-template-columns` declaration invalid at computed-value time and the grid
  collapses to one implicit column, which is a silent failure no test would see. Do not "fix" it
  with a default.
- **A widget's lifecycle hook runs on the client, after the write, and cannot fail it.** There is
  no server-side widget runtime — a widget is a Vue component in the web bundle — so a server hook
  would have no code to call. Running after the record is committed is what makes "cannot fail a
  config write" a property of the ordering rather than a promise, and a hook that throws is logged
  rather than toasted because the user's action *did* what they asked.
- **Widget events exist for what the store cannot see.** `composables/widgetEvents.ts` carries a
  change the *server* made — a turn ending moved the counts and the totals, and nothing local knows
  by how much. Anything the client itself decided and holds is a `watch` away and is deliberately
  not an event, because two ways to learn one fact drift. `turn.finished` comes from `consume()`'s
  `finally`, the one point every turn ends at, unconditionally within the account-epoch guard since
  a failed turn still persisted a message.
- **The panel's open tab is one global preference, and creating a conversation resets it.**
  `widgetPanel.activeId` is persisted under `gl-widget-active` and shared by every conversation, and
  the strip prefers it whenever it happens to be installed — so a tab read in one conversation used
  to decide what every later one opened on. `createSession` therefore ends by writing the strip's
  first tab, which is the same expression `WidgetPanel.active` falls back to, so the two cannot
  disagree. Every write goes through `activateWidget(id)`, which refuses an id this object does not
  have: a preference for a tab that does not exist is one the strip would silently override, so the
  stored value would be a lie until the next click. Selecting an *existing* conversation
  deliberately does not touch the tab at all — coming back to the one you last read is the point
  there, and it is what `e2e/widgets.spec.ts` pins.
- **A widget's catalog key is a literal at a call site, which is why the dynamic-prefix allowlist
  stays narrow.** `widgets/registry.ts` resolves names through a `switch` over the closed id union
  with a literal key per case, not through `t(\`widgets.${id}.name\`)` — that would have forced a
  bare `widgets.` entry into `catalog.test.ts`'s `DYNAMIC_PREFIXES`, and a prefix that broad is
  where a typo hides. A new widget is then a missing-return compile error rather than a blank tab.
  **Adding one is a recipe rather than a thing to infer: `docs/widgets.md`.**
- **A checkbox installs what does not exist yet; a toggle changes what does.** The create dialogs
  (workspace, Copilot) tick boxes for an object that is not there, so the whole selection lands in
  one write; the two settings dialogs toggle a real object, so each click takes effect immediately.
  The control follows the *deferred/immediate* distinction rather than the surface, which is why
  the Copilot editor's checkboxes and the session dialog's toggles are both correct.

## Gotchas

- **`pnpm dev` does not reliably take its children with it, and the leftovers are worse than
  nothing.** It is `pnpm --parallel` over a `tsx watch` and a `vite`, and signalling the middle
  process reparents the grandchildren to init. Two things follow, and both have happened here:
  an orphaned `tsx watch` keeps **3720**, so the next `pnpm dev` cannot bind it — and because it
  is still watching the tree it reloads through whatever edits happen next, which is how a
  half-applied change reached a real database once. An orphaned **vite** is quieter and worse:
  it does not fail, it takes the next port, so each abandoned run leaves a server one port
  further along still serving that day's code — one evening left eight of them on 5175–5182, and
  whichever port you have open answers from a build nobody is editing. `pnpm dev:restart`
  (`scripts/dev.sh`) is the answer to both: it sweeps this repo's leftover dev servers before
  starting and runs `pnpm dev` in a **process group of its own**, so one signal reaches the whole
  tree on the way out — including when the script itself is killed. `pnpm dev:status` reports
  what it sees without touching anything. A process is only ever a candidate when its working
  directory is this repo's `apps/server` or `apps/web`, so another project's vite on the same
  port, or an editor's tooling, is left alone.
- `pnpm-workspace.yaml`'s `allowBuilds` gates every package whose postinstall does real
  work. Without the entries it fails with `ERR_PNPM_IGNORED_BUILDS`. `better-sqlite3` and
  `esbuild` are native/bundler; `electron` downloads the ~130 MB binary the desktop app
  runs on. `electron-winstaller` is explicitly `false` — it is Windows-only Squirrel
  tooling, and `pnpm install` otherwise rewrites the file with a
  `set this to true or false` placeholder that is not valid YAML.
- `better-sqlite3` is a native module — it builds against your local Node. If you
  change Node versions, reinstall.
- Config loads `config/config.yaml`, overlaid by a git-ignored
  `config/config.local.yaml`, with `${ENV_VAR}` references resolved from `.env`
  + real env vars. Real env vars win over `.env`. `ILA_CONFIG_PATH` swaps the
  *overlay* path — it exists for tests and the e2e run — and must be set before the
  config module is first imported.
- **`ILA_DATA_DIR` is required, and a bare `pnpm dev` will not start without it.** That
  is the intended failure, not a regression: the message names the variable and the two
  ways to set it. A checkout puts `ILA_DATA_DIR=./data` in `.env` (see `.env.example`);
  the desktop app asks and passes an absolute path down. The test suite and the e2e run
  each point it at a throwaway directory. Because `loadDotEnv()` runs at module scope in
  `config.ts`, `.env` is read early enough for this to work — which is also why that call
  is not inside `loadConfig()` where it used to be.
- `pnpm test:e2e` starts its own fake LLM, backend and Vite on 3898 / 3899 / 5199,
  so a `pnpm dev` instance can keep running. Its scratch data lives in the
  git-ignored `.e2e/`, removed on teardown. It bundles `apps/desktop` first, because
  `e2e/panel.spec.ts` runs against the control panel's built page.
- **`electron-builder` fetches its helper binaries from GitHub at first use, and Electron's
  binary comes from there too.** On a slow or blocked network both stall with no output at
  all, so the build looks hung rather than failing. Set the mirrors first — details in
  `docs/desktop.md` → Building from a slow network.
- `pnpm desktop:dev` runs `build.mjs --no-web`, which reuses whatever frontend is already
  staged in `dist/resources/web` and leaves it alone. Run `pnpm desktop:build` (or
  `pnpm build`) once if the panel's server has nothing to serve.

For the full architecture and configuration reference, see `docs/`. Those files that are working
references rather than background: `docs/design-system.md` for anything visual, `docs/prompts.md`
before changing any system prompt or adding one, `docs/widgets.md` before adding a widget to the
right sidebar, and `docs/session-locks.md` before touching anything that writes to a conversation
from more than one client.