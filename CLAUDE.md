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

Everything a person makes lives in a **data root they choose at launch**, not next to the
code — so uninstalling the app leaves it behind. `apps/server/src/paths.ts` is the one
description of that tree:

```
<dataRoot>/
  users/<userSlug>/
    workspaces/<wsSlug>/
      workdir/                 the agent's file-tool sandbox and the file browser's root
      sessions/<sessionId>/    a conversation's own files — the diagrams it draws
    sources/
      raw/<sourceId>.<ext>     an uploaded file, one per distinct content per account
      parsed/<sourceId>.txt    its extracted text
  db/sqlite/ilearnassist.sqlite
```

`sessions/<sessionId>/` is a conversation's **own** folder, and its one writer is `ila_diagram`
— the model draws a diagram, the source lands here as `<name>.mmd`, and the conversation renders
it. It is a sibling of `workdir/` rather than a corner of it, deliberately: the workdir is the
sandbox `write_file` and the file tree share, and `write_file` cannot reach `sessions/`
(`resolveInWorkspace` refuses the traversal), so this directory holds nothing a typed tool did
not write. See `docs/diagrams.md`.

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
  config.ts               # YAML + ${ENV} resolution + .env loader + resolveDataRoot
  paths.ts                # the on-disk layout: data root → users/<slug> → workspaces, sources, db
  schema.ts               # the DDL, schemaProblem, and the user_version guard (one transaction)
  apiError.ts             # the { error: { code, message, params } } envelope, shared with the CLI
  auth.ts                 # accounts: scrypt passwords, credential policy, bearer tokens, the gate
  db.ts                   # better-sqlite3 CRUD (snake_case cols), user-scoped accessors
  workspace.ts            # resolveInWorkspace sandboxing + dir mgmt + slug rules
  files.ts                # the file browser's read side, for both roots: one level, one file
  attachments.ts          # source paths + the sandbox guard + multimodal content building
  routes.ts               # Fastify routes (workspaces/copilots/sessions/providers/attachments/chat)
  stream.ts               # SSE framing helper
  agent/loop.ts           # manual ReAct loop (model.bindTools → stream → run tools)
  agent/model.ts          # ChatOpenAI builder + reasoning SSE tap
  agent/title.ts          # auto-generated conversation titles
  documents/              # document → text: local extractors, cloud drivers, policy
  documents/local/        # pdfjs (PDF) + an OOXML/ODF reader over fflate
  documents/drivers/      # one file per wire protocol (sync / mineru / llamaparse)
  tools/index.ts          # tool assembly + ALL_TOOL_NAMES
  tools/fileTools.ts      # list/read/write/create_dir/delete_file (sandboxed)
  tools/documentTools.ts  # read_document — pages through a source's text, by whitelist
  tools/webSearch.ts      # bing / duckduckgo / tavily / searxng
  tools/webFetch.ts       # fetch a URL as text (SSRF-guarded)
  tools/askUser.ts        # ask_user — suspends the turn on a question; its result shape
  tools/diagram.ts        # ila_diagram — writes a mermaid source into the session's folder
  widgets.ts              # sumUsage + the widget-selection validator (pure)
  notes.ts                # the notes widget's records: what a body may become a note (pure)
apps/web/src/
  stores/app.ts           # Pinia store (all state + actions)
  api/client.ts           # fetch helpers + SSE parser (normalizes errors → ApiError)
  i18n.ts                 # vue-i18n instance + the localStorage key
  locales/                # zh-CN.ts (source of truth) + en.ts (typed against it)
  composables/confirm.ts  # promise-returning confirm() for destructive UI actions
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
  utils/diagramAnchors.ts # diagram file name → the tool call that wrote it (pure)
  utils/fileTree.ts       # the tree's arithmetic: flatten, move, find the parent row
  utils/locale.ts         # browser-language detection + the alias table
  utils/mermaid.ts        # the lazy mermaid chunk: theme variables, parse, render
  utils/noteAnchor.ts     # selection → quote + occurrence, and back (pure, DOM-only)
  utils/widgetTabs.ts     # the tab strip's fit arithmetic (pure)
  widgets/registry.ts     # widget id → component, catalog keys, lifecycle hooks
  widgets/NotesWidget.vue # the notes panel: the list, the toolbar, the empty state
  widgets/DiagramWidget.vue # the diagram panel: the folder's diagrams, and a jump to each
  widgets/*Widget.vue     # the two demo widgets (workspace stats, session stats)
  components/…            # App, LoginView, WorkspaceHome, Sidebar, ChatView, MessageItem,
                          #   ToolCallCard, DiagramCard, MermaidDiagram, AskUserCard, Composer,
                          #   TopbarControls, FileTree, WidgetPanel, WidgetTabStrip,
                          #   GenerationParams, NoteEditor, MessageSelectionToolbar,
                          #   dialogs (Settings, WorkspaceSettings, Sources, SessionFiles,
                          #   FilePreview, Diagram, Confirm, WidgetToggleList)
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

- **Workspace sandboxing is a security boundary.** All file-tool paths MUST go
  through `resolveInWorkspace` (rejects `..` escapes and absolute escapes) and
  never operate outside the active workspace directory. Do not add a file tool
  that bypasses this.
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
  (`text` / `markdown` / `diagram` / `unsupported`), so the next format is a new member and a
  branch in `FilePreviewDialog` — not a second endpoint. The server decides it, not the client:
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
- **A conversation's own directory has exactly one writer, and there is no table for what it
  holds.** `sessions/<sessionId>/` is written by `ila_diagram` and read by the session-files
  routes; `write_file` cannot reach it, so it holds nothing a typed tool did not write. The
  `.mmd` **is** the record — a `session_diagrams` table would be a second copy of bytes that
  already have a home, free to disagree with the file about its own content, and everything one
  would provide comes from somewhere else: the title from mermaid front-matter (which mermaid
  draws itself) or the file's name, the ordering from `FileEntry.modifiedAt`, the jump anchor
  from `toolCall.id` found by scanning the message list. It inherits the existing asymmetry
  rather than inventing a third: the tool resolves lexically like every agent tool, the routes
  `realpath` like every browser read. See `docs/diagrams.md`.
  The join between a call and its file is the one part that needs care — the call records the
  name the *model* chose, the folder holds what the server made of it — which is why `slugify`
  and `diagramFileName` live in `packages/shared`: the client matching them is `utils/diagramAnchors.ts`,
  and a second slug rule on the web side would be a button on the wrong row, or on none.
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
  sign them back in).
- **An uploaded file is a `source`: owned by the account, indexed by the database, and
  referenced rather than owned by a conversation.** It lives at
  `<userRoot>/sources/raw/<sourceId>.<ext>`, outside every workspace on purpose, so chat
  uploads never show up in the agent's `list_files`. Three things follow, and each is load
  bearing:
  - **`UNIQUE (user_id, sha256)`** makes identical bytes one row, one file and two
    references. The hash is *scoped* — `findSourceByHash(userId, hash)`, never by hash alone,
    or the second account to upload the same file would be handed the first one's bytes.
  - **`raw_path` is stored, and re-validated on every read** through `resolveInSources`. It is
    stored because that is what removes the directory glob an attachment lookup used to need —
    and with it a whole class of collision (see the `parsed/` note that this retired). It is
    re-validated because a database row is not a trust boundary: it travels through backups,
    and a future bug that wrote one column would otherwise become an arbitrary file read.
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
  product decision, not a bug fix. **`ila_review_quiz` is the one exception:** text streamed
  beside a grading call is the per-question verdict walkthrough — the turn's actual answer —
  not narration, so `gradingUtterances` keeps it and `composeWithGradingUtterances` rejoins
  it ahead of the last utterance at every normal ending (final answer, suspension, exhausted
  budget); an utterance the last step repeats verbatim is dropped rather than doubled. The
  reason it exists: a grading turn typically runs grading → `ila_update_plan_progress` → a
  final "shall we move to the next chapter?" step, and the last-utterance rule used to make
  the verdicts vanish from the persisted message at `message_done` after streaming them live.
  The prompts push the model toward the safe shape too (all bookkeeping tool calls before
  the prose; the full rundown in the final message), but the loop rule is the deterministic
  backstop — do not delete one believing the other makes it redundant.
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
  as keeping up. The `计划`/`其他` headings are rendered client-side with translated
  labels, never stored. The classification process is observable through the
  append-only `<dataRoot>/logs/threads.log` (`threadLog.ts`): one human-readable block per
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
- **Documents cross a sandbox boundary that files cannot, and that asymmetry is deliberate.**
  `read_document` is bound to a whitelist resolved per turn — a conversation's own sources
  **unioned with its workspace's** — rather than to any root, so a guessed id fails a `Map`
  lookup before a path is touched. The file tools are sandboxed by `resolveInWorkspace`
  instead, and can never reach a source: it is outside every workspace by construction. So a
  document uploaded in one conversation is readable from another in the same workspace, while
  no path in that workspace could reach it as a file.
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
- **The app opens on the workspace home, and a card there is the only way into a
  conversation.** There is still no router: `App.vue` renders `LoginView`,
  `WorkspaceHome` *or* the `Sidebar + ChatView` pair, chosen by `uiState.view` in
  `composables/ui.ts` — a six-valued flag, where six views do not need a dependency
  and a route table nobody types. The sidebar's old workspace `<select>` went in the same
  change as the home page: with the home page as the switcher it was a second, duplicate
  way to change workspace, and it could name the workspaces without saying anything about
  them. `selectWorkspace` is now reached only through a card, and neither the workspace nor
  the session is persisted — the app landing directly in a conversation is the regression,
  not the feature. Navigation goes through `showLogin()` / `showWorkspaceHome()` /
  `showChat()`, never a component-local flag. `e2e/workspaces.ts` is the same rule for the
  specs; a spec that skips it fails on a composer that never renders.
- **The platform console is laid out like a management back end: a menu down the left, one
  section on the right.** `AdminConsole.vue` replaced its tab strip with that shell when it grew
  a second section, and the reason is structural rather than cosmetic — a tab strip is a strip
  of *equals*, and "accounts" and "model providers" are not equal halves of one question.
  `SECTIONS` is data (an id and an icon) so a section is an entry plus a component; the section's
  *words* stay at the call site, because `i18n/catalog.test.ts` scans for `t("…")` literals and a
  key reached through an object property is invisible to it — the dead-key scan would report it
  as unused. `admin.nav.` is the one dynamic prefix it adds, over the closed section-id union.
  The narrow viewport turns the menu into a strip across the top rather than hiding it: there are
  a handful of sections and they are the page's only navigation.
- **The console's entry points all ask `store.canAdmin`, never `roles.includes("superadmin")`.**
  Two tiers means the check is a *set* question, and three call sites (the home page's header,
  the sidebar's menu, the account page) written as a one-role comparison is how an ordinary
  administrator ends up with a console reachable from two buttons and not the third. It is still
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
  **The console is where those screens live**, and `SettingsDialog` is not: it holds the
  account's own Copilots and nothing else, because everything installation-wide it used to hold
  answered 403 for an ordinary account and showed a URL the server fetches to everybody. The
  test for whether a screen belongs in the console is whether it changes something every account
  shares, or is an account itself; anything one account does for itself belongs in the app.
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
  unreadable database, a CLI that would not run. Trying is what keeps the button from going
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
  quiz nobody can answer, a plan nobody can see. `WIDGETS.diagram` deliberately names no
  `boundTools`, because a bound tool is assembled *only* when its widget is installed and nothing
  installs a widget by default (`DEFAULT_WIDGET_IDS` is empty): binding diagrams would leave the
  model with no way to draw one in an ordinary conversation, which is the complaint the tool
  exists to answer, and `isWidgetBoundTool` would keep the name out of the allow-list so it could
  not even be switched on. It is an ordinary allow-listable tool, and it is deliberately **not** in
  `NON_FILE_TOOLS` either — so `fileTools.enabled: false` means no diagrams, because a diagram
  whose file was never written is half the feature. The panel is a viewer: it lists the
  conversation's folder and draws the one you pick. See `docs/diagrams.md`.
- **A quiz question has two ids, and its row exists before the answer.** `ila_quiz` (bound to the quiz widget) numbers Qn from the session counter AND registers a `quiz_questions` row with a global UUID when it suspends: the card/model use Qn; `ila_review_quiz`, the widget, and `/sessions/:id/quizzes/:qid/answer` use the UUID. Rows go pending → answered/dismissed on `/answers`, → skipped on walk-away (a GET reconciles crash-orphaned pending rows to skipped). Make-up is open to questions the user never submitted (`skipped` walk-away and `dismissed` explicit cancel — treated alike), but not `pending` (live card) or `answered`: the make-up POST does a status-guarded UPDATE of the SAME row (never an insert, clearing stale grading), then the client drives an ordinary `/chat` turn quoting the UUID so the model grades it instead of posing a new quiz. An optional `nodeId` names the live plan node a quiz checks (invalid ⇒ tool error); absent it binds to the current `in_progress` node, and absent a plan it is a session-level question. A question may carry an answer key — `referenceAnswer` (offered labels) and `explanation` — but it is grading material, never question material: it is stripped from the suspending call the client re-renders and from every client-facing frame (`redactQuizInput` covers the raw `tool_start` and the schema-failure `tool_end`; the `QuizSuspension` record is stripped), stored server-side on the quiz row (`reference_answer_json`/`explanation`, omitted by `toView`), and handed to the model only once an answer exists — in the resumed tool result (`quizAnswerKeysForCall`) for a live submit, and in a system-prompt-only note (`renderMakeupKeyNote`, gated by `ChatInput.makeupQuizId` naming an owned **answered** row) for a make-up. While a question is unanswered the UI likewise hides the option descriptions that explain the choices — nothing in the make-up dialog but the form, and no descriptions in a skipped card's settled disclosure — so an unanswered, still-make-up-eligible question can never leak its solution.
- **A note belongs to a conversation, and to a message only when something was annotated.** `notes.session_id` is `NOT NULL` and `message_id` is nullable, which is what makes a note the user typed from the panel the same kind of thing as one made by dragging over a sentence. `message_id` carries **no foreign key** on purpose: a regenerate or a tail delete soft-deletes a message, and the note is the user's own writing, so it survives with the quote it recorded — `messageMissing`, resolved by a `LEFT JOIN messages … AND m.deleted_at IS NULL` in the read that fetches the note, is how a read says so (never a client guess from a message list that only holds the conversation on screen). **An anchor is a text quote plus which occurrence of it**, counted over the message's **visible** text — never character offsets, which are offsets into rendered HTML and mean nothing after the next `v-html` assignment, and never a raw text walk, which sees every formula twice because KaTeX emits glyphs *and* hidden MathML. Notes bring no tools: the model neither reads them nor writes them.
- **A widget can own a capability of the host, and exactly one holds it at a time.** The message list implements marking-up (selection, the floating bar, `<mark>`, the window) and knows nothing about notes as records; the notes widget owns the records and knows nothing about `Range`. `composables/messageNotes.ts` is the whole of what they share: a **claim**, per *conversation* rather than per widget (the message list on screen belongs to one session while the widget is installed in a different set of them), with a refusal that names the holder. The host registers on mount and the widget claims from `WidgetModule.onActive`, in either order, because the host **reads** the claim rather than being told about it. `onActive` is not `onMount`: `WidgetPanel` mounts only the active tab, so a claim owned by the component would drop the moment the reader looked at the plan, taking every highlight with it. It is called by `composables/widgetActivation.ts` — an effect owned by `ChatView`'s setup, because the panel being rendered *is* the answer to "is a widget live", and leaving the view (the one transition no reactive input expresses) is reported by that scope stopping. It is deliberately not a store `watch`: a store's setup belongs to no lifetime, and in a test suite every abandoned store instance keeps watching module-level singletons.
- **Plan versions are structural snapshots; progress lives on node identities.** `plan_versions.tree_json` holds id/title/children only — history is status-free and read-only; node status, the start-jump anchor and tombstones live once in `plan_nodes`, keyed by server-assigned UUIDs (never readable numbers or titles; the `1` / `1.1` a user sees is derived from sibling position by `planNodeNumbers`, and is display, not identity). A node dropped from an edit becomes a `deleted` tombstone: struck through in the current view, frozen in its last place, absent from that version's snapshot, still visible in older history; tombstone ids can't be reused and a progress update can't mark `deleted` (only an edit removes). The anchor is the node's **start**: the `in_progress` call placed before its content (`done_tool_call_id` column, widened without a rename), kept through completion, cleared when the node returns to not-started/skipped; a click scrolls the chat to that tool-call card. "Make a second plan" is the third suspending tool — its `SuspendingTool.commit` side-effect fork in `tools/suspending.ts` either overwrites as a new version or auto-creates a snapshot session (Copilot/settings/tools copied and the plan widget installed), writes V1 there and navigates via the `plan_session_created` SSE event. The store refreshes the panel mid-turn by emitting `plan.changed` from the existing `tool_end` arm — no extra SSE event for that. Two panel actions compose a user message and go through the ordinary `/chat` flow: the footer "adjust plan" composer, and "jump to chapter" (which first POSTs `/plan/nodes/:id/jump` — server-side skip of prior undone nodes plus open the target — then sends `调整进度，跳到章节…`). While the widget is installed the turn's system prompt also carries `PLAN_GUIDANCE` (mark a node before teaching it, stay on the plan, hand back after a detour).
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

For the full architecture and configuration reference, see `docs/`. Two of those files are working
references rather than background: `docs/design-system.md` for anything visual, and
`docs/widgets.md` before adding a widget to the right sidebar.