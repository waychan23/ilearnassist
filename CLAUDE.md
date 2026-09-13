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
      sessions/<sessionId>/    created with the conversation; nothing writes here yet
    sources/
      raw/<sourceId>.<ext>     an uploaded file, one per distinct content per account
      parsed/<sourceId>.txt    its extracted text
  db/sqlite/ilearnassist.sqlite
```

`sessions/` is **reserved**: it is created so the layout is a thing you can look at rather
than a thing that materialises by accident, and nothing writes into it yet.

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
| `e2e/auth.ts` | `signIn()` + the account and state-file the browser suite shares |
| `e2e/auth.setup.ts` | the `setup` project: signs in once, saves `storageState` for the rest |

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

**Every browser spec starts signed in, and does not have to say so.** The API refuses
everything without a session, so the `setup` project signs in once and saves the cookie as
`storageState`, which both real projects load. That is why ~70 specs that are not about
authentication needed no edit when sign-in arrived. A new spec inherits it and should not
think about it; the one file that must *not* — `e2e/login.spec.ts` — clears the cookie with a
file-scoped `test.use({ storageState: { cookies: [], origins: [] } })`, which is why it is a
file of its own rather than a `describe` block: a `describe`-scoped override can be inherited
by a sibling that did not mean to. It is also a project **dependency** rather than a
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
  main/main.ts            # Electron: windows, menu, IPC handlers
  main/serverProcess.ts   # supervises the server child (start/stop/crash/timeout)
  main/paths.ts           # per-user layout + idempotent first-run seeding
  main/launch.ts          # child env (ELECTRON_RUN_AS_NODE, ILA_*, ILA_HOST) + stdout parsing
  main/lan.ts             # which address a phone can reach, ranked
  main/settings.ts        # the panel's own preferences (LAN sharing)
  shared/qr.ts            # URL → module square, and → drawable runs
  preload/preload.ts      # contextBridge surface — seven commands, nothing else
  renderer/               # the panel page (plain HTML/CSS + one bundled IIFE)
apps/server/src/
  index.ts                # bootstrap + the listening line + SIGTERM (resolves the data root first)
  webApp.ts               # serves the built frontend beside the API, when there is one
  config.ts               # YAML + ${ENV} resolution + .env loader + resolveDataRoot
  paths.ts                # the on-disk layout: data root → users/<slug> → workspaces, sources, db
  schema.ts               # the DDL + the `user_version` guard that refuses a foreign database
  auth.ts                 # accounts: the signed session cookie, and find-or-create by name
  db.ts                   # better-sqlite3 CRUD (snake_case cols), user-scoped accessors
  workspace.ts            # resolveInWorkspace sandboxing + dir mgmt + slug rules
  files.ts                # the workspace browser's read side: one level, one file
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
  widgets.ts              # sumUsage + the widget-selection validator (pure)
apps/web/src/
  stores/app.ts           # Pinia store (all state + actions)
  api/client.ts           # fetch helpers + SSE parser (normalizes errors → ApiError)
  i18n.ts                 # vue-i18n instance + the localStorage key
  locales/                # zh-CN.ts (source of truth) + en.ts (typed against it)
  composables/confirm.ts  # promise-returning confirm() for destructive UI actions
  composables/locale.ts   # language selection (sibling of theme.ts, not a store)
  composables/theme.ts    # light/dark/auto
  composables/widgetEvents.ts  # the widget event bus (no store import, so no cycle)
  composables/widgetPanel.ts   # the panel's persisted preferences + width clamping
  utils/apiError.ts       # server code → user-facing message
  utils/fileTree.ts       # the tree's arithmetic: flatten, move, find the parent row
  utils/locale.ts         # browser-language detection + the alias table
  utils/widgetTabs.ts     # the tab strip's fit arithmetic (pure)
  widgets/registry.ts     # widget id → component, catalog keys, lifecycle hooks
  widgets/*Widget.vue     # the two demo widgets (workspace stats, session stats)
  components/…            # App, LoginView, WorkspaceHome, Sidebar, ChatView, MessageItem,
                          #   ToolCallCard, AskUserCard, Composer, TopbarControls, FileTree,
                          #   WidgetPanel, WidgetTabStrip, GenerationParams,
                          #   dialogs (Settings, WorkspaceSettings, Sources, FilePreview,
                          #   Confirm, WidgetToggleList)
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
  (`text` / `markdown` / `unsupported`), so the next format is a new member and a branch in
  `FilePreviewDialog` — not a second endpoint. The server decides it, not the client: it is
  the side that can sniff the bytes, and an unfamiliar extension is decided by a NUL check and
  a UTF-8 decode rather than a table, which is what makes `Makefile` and `LICENSE` readable.
  Past the preview cap the reply is a 200 with `truncated: true`, never an error — a 2 GB log
  is exactly the file someone opens to see the top of.
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
  when the logout request fails, because the cookie is HttpOnly, a failed logout cannot be retried
  locally, and leaving someone looking signed in is the worse of the two outcomes (the failure is
  surfaced, since a reload will sign them back in).
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
- **A source's bytes outlive the message that referenced them, and deleting is two different
  acts.** `DELETE /api/sessions/:id` removes the conversation's *references* — the links
  cascade with the row — and leaves the files alone, because another conversation may be
  reading them. `DELETE /api/sources/:id` is the one that means "delete this file": it removes
  the bytes, the extracted text and every reference. So the deletion matrix is asymmetric on
  purpose, and `DocumentService.cancelSource` is per *source* rather than per session for the
  same reason — cancelling by session would abort a parse another conversation is waiting on.
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
  product decision, not a bug fix.
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
  `composables/ui.ts` — a three-valued flag, where three views do not need a dependency
  and a route table nobody types. The sidebar's old workspace `<select>` went in the same
  change as the home page: with the home page as the switcher it was a second, duplicate
  way to change workspace, and it could name the workspaces without saying anything about
  them. `selectWorkspace` is now reached only through a card, and neither the workspace nor
  the session is persisted — the app landing directly in a conversation is the regression,
  not the feature. Navigation goes through `showLogin()` / `showWorkspaceHome()` /
  `showChat()`, never a component-local flag. `e2e/workspaces.ts` is the same rule for the
  specs; a spec that skips it fails on a composer that never renders.
- **Nothing is painted until `uiState.authReady`.** The session cookie is HttpOnly, so the
  page cannot tell whether anyone is signed in until `/api/auth/me` answers — which means
  the right view is genuinely unknown for the first moments after a reload. `view` starts on
  `"login"` as the safe guess, and `App.vue` withholds *both* branches until the flag flips,
  because rendering the login screen as the initial guess would flash it at a signed-in user
  on every single refresh.
- **Every API route requires a signed-in account unless it says `config: { public: true }`.**
  One `onRequest` hook in `routes.ts`, deny-by-default: a route added tomorrow without a
  thought about auth is refused, which is the same "the safe state is the one you get by
  doing nothing" move as the `read_document` whitelist. Exactly four routes opt out —
  `health`, `auth/login`, `auth/me`, `auth/users` — and `auth/me` answering 401 is its
  *answer* rather than a refusal, which is why `client.ts` exempts `/auth/*` from the
  session-expiry handler: routing that 401 into "your session expired" would open every first
  visit with an error about a session that never existed. The hook belongs to the `routes`
  plugin, so it covers the API and stops there — `webApp.ts` serves the built frontend from a
  sibling plugin, and a guarded `index.html` is an app nobody can open.
- **There is no password yet, and the login screen says so.** A username is the whole
  credential, so the server's job is to *identify* the caller rather than to authenticate
  anyone. Two things are nonetheless built the way they would be with a password, because
  they are the parts that would be painful to retrofit: the cookie is an HMAC-signed
  `<userId>.<signature>` rather than a bare id, and the secret lives in `app_settings` — so it
  travels with the data root, and rotating it (delete the row) logs everyone out *immediately*,
  since it is read per request rather than captured at boot. When passwords arrive the cookie
  carries an opaque token id and only `currentUser` learns to look it up. Until then, **the
  panel's LAN switch is the control that decides who can reach the address**, and the login
  screen states the no-password property rather than leaving a user to assume a privacy it
  does not have.
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
- **The desktop app never writes into its own bundle.** The *app's* state lives under
  `app.getPath("userData")`, reached through `ILA_PROJECT_ROOT`; the bundle is read-only and
  is replaced wholesale on every update. First-run seeding is idempotent and **never
  overwrites** an existing `config.yaml` or overlay — that is what keeps an API key the user
  typed into the Settings UI from vanishing on the next launch.
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