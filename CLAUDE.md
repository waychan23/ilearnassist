# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**guided-learning** is a self-hosted, single-user agent product (Browser/Server
architecture). It provides a chatbox-like UI over a manual ReAct agent loop with
tool calling. Three apps share a types package:

- `apps/server` — Fastify 5 + better-sqlite3 + LangChain.js (`@langchain/core`,
  `@langchain/openai`). Runs the agent loop, streams results over SSE, and serves
  the built frontend when there is one.
- `apps/web` — Vue 3 (Composition API) + Pinia + Vite. Renders the chat UI.
- `apps/desktop` — Electron. A "control panel" that starts/stops the server and opens
  the app, packaged as a Mac `.dmg` for people who do not want a terminal. Supervises
  the server as a child process; reimplements none of it. See `docs/desktop.md`.
- `packages/shared` — dependency-free API/domain types used by both sides.

## Commands

```bash
pnpm install           # first time — see "Gotchas" below
pnpm dev               # run server + web together (backend :3720, web :5173)
pnpm dev:server        # tsx watch src/index.ts (backend only)
pnpm dev:web           # vite (frontend only)
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

It also runs standalone (`pnpm --filter @guided-learning/server fake-llm`), which is how
the Playwright suite scripts it over HTTP.

`apps/server/test/helpers/fakeParser.ts` is the same idea for document parsing: a
scriptable stand-in that speaks all three cloud-parser protocols (`sync` multipart,
MinerU's presigned-upload-and-poll, LlamaParse's multipart-and-poll), so the *real*
drivers run — presigned `PUT`, job polling, ZIP extraction, Bearer auth, error mapping —
with no account at any vendor. It runs standalone too
(`pnpm --filter @guided-learning/server fake-parser`), and the Playwright harness starts
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
apps/desktop/src/
  shared/panelApi.ts      # the IPC contract (channels, ServerStatus, PanelApi)
  shared/messages.ts      # the panel's two catalogs + fault → sentence
  main/main.ts            # Electron: windows, menu, IPC handlers
  main/serverProcess.ts   # supervises the server child (start/stop/crash/timeout)
  main/paths.ts           # per-user layout + idempotent first-run seeding
  main/launch.ts          # child env (ELECTRON_RUN_AS_NODE, GL_*, GL_HOST) + stdout parsing
  main/lan.ts             # which address a phone can reach, ranked
  main/settings.ts        # the panel's own preferences (LAN sharing)
  shared/qr.ts            # URL → module square, and → drawable runs
  preload/preload.ts      # contextBridge surface — seven commands, nothing else
  renderer/               # the panel page (plain HTML/CSS + one bundled IIFE)
apps/server/src/
  index.ts                # bootstrap + seedFromConfig + the listening line + SIGTERM
  webApp.ts               # serves the built frontend beside the API, when there is one
  config.ts               # YAML + ${ENV} resolution + .env loader
  db.ts                   # better-sqlite3 schema + migrations + CRUD (snake_case cols)
  workspace.ts            # resolveInWorkspace sandboxing + dir mgmt
  files.ts                # the workspace browser's read side: one level, one file
  attachments.ts          # upload storage + multimodal content building
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
  tools/documentTools.ts  # read_document — pages through an attachment's text
  tools/webSearch.ts      # bing / duckduckgo / tavily / searxng
  tools/webFetch.ts       # fetch a URL as text (SSRF-guarded)
  tools/askUser.ts        # ask_user — suspends the turn on a question; its result shape
apps/web/src/
  stores/app.ts           # Pinia store (all state + actions)
  api/client.ts           # fetch helpers + SSE parser (normalizes errors → ApiError)
  i18n.ts                 # vue-i18n instance + the localStorage key
  locales/                # zh-CN.ts (source of truth) + en.ts (typed against it)
  composables/confirm.ts  # promise-returning confirm() for destructive UI actions
  composables/locale.ts   # language selection (sibling of theme.ts, not a store)
  composables/theme.ts    # light/dark/auto
  utils/apiError.ts       # server code → user-facing message
  utils/fileTree.ts       # the tree's arithmetic: flatten, move, find the parent row
  utils/locale.ts         # browser-language detection + the alias table
  components/…            # App, WorkspaceHome, Sidebar, ChatView, MessageItem, ToolCallCard,
                          #   AskUserCard, Composer, TopbarControls, FileTree, dialogs
apps/server/test/         # unit + integration tests (vitest, node env)
apps/web/test/            # unit tests (vitest, jsdom)
packages/shared/src/index.ts  # all cross-boundary types (ChatStreamEvent, ToolCall, …)
```

## Reference project: chatbox

This app is modeled on [chatbox](https://github.com/chatboxai/chatbox) (Electron
+ React). A clone kept for reference lives at
`/Users/waychan23/Documents/work/spaces/trae/chatbox` — treat it as a
behavioral/UX reference only (chatbox is React/Electron; guided-learning is
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
- **Uploads are sandboxed too.** Attachment paths go through `resolveStoredPath`
  over `data/uploads/`, and stored files are located by directory listing rather
  than by anything the client claims. Uploads live outside the workspace on
  purpose, so chat attachments never show up in the agent's `list_files`.
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
  then `done`. The frontend expects exactly this.
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
- **Schema changes need `ensureColumn`.** `CREATE TABLE IF NOT EXISTS` silently
  skips existing tables, so an existing database would never gain a new column.
- **Destructive UI actions confirm first.** Session, Copilot, workspace and
  provider deletes go through `confirm()` from `composables/confirm.ts`. The
  agent's own `delete_file` tool is deliberately *not* gated.
- **The app opens on the workspace home, and a card there is the only way into a
  conversation.** There is still no router: `App.vue` renders `WorkspaceHome` *or* the
  `Sidebar + ChatView` pair, chosen by `uiState.workspaceHome` in `composables/ui.ts` —
  a flag, where two views and a boolean do not need a dependency and a URL nobody types.
  The sidebar's old workspace `<select>` went in the same change: with the home page as
  the switcher it was a second, duplicate way to change workspace, and it could name the
  workspaces without saying anything about them. `selectWorkspace` is now reached only
  through a card, and neither the workspace nor the session is persisted — the app landing
  directly in a conversation is the regression, not the feature. Navigation goes through
  `showWorkspaceHome()` / `showChat()`, never a component-local flag. `e2e/workspaces.ts`
  is the same rule for the specs; a spec that skips it fails on a composer that never
  renders.
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
  `[guided-learning] listening on <url>`. Not a fixed port, not a timer, and not
  Fastify's own "Server listening at …" banner, which is logged from inside `listen`
  before the process is necessarily ready. A control panel that claims a server is up
  when it is not is worse than one that says nothing, because the user has no way to tell.
- **The desktop app never writes into its own bundle.** Writable state lives under
  `app.getPath("userData")`, reached through `GL_PROJECT_ROOT`; the bundle is read-only
  and is replaced wholesale on every update. First-run seeding is idempotent and **never
  overwrites** an existing `config.yaml` or overlay — that is what keeps an API key the
  user typed into the Settings UI from vanishing on the next launch.
- **The panel's LAN switch owns the bind address, and `GL_HOST` is always set.** Including
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
- **Extracted document text lives in `parsed/`, never beside the bytes.** An
  attachment's derived data goes to `uploads/<sessionId>/parsed/<attachmentId>.txt`,
  not `uploads/<sessionId>/<attachmentId>.txt`. `findStoredAttachment()` globs
  `<id>.*` in the session directory and `txt` is a valid extension in the MIME table,
  so a flat sibling would let the download endpoint serve extracted text instead of
  the original PDF. Pinned by a test in `apps/server/test/documents/store.test.ts`.
- **`read_document` is scoped to the current turn's attachments.** It is bound to a
  whitelist of attachment ids, not to the uploads root, because ids are guessable and
  a bare-id tool would let a model read another session's uploads. Adding a document
  tool that takes an id without checking it against the whitelist reintroduces that.
- **A document that could not be read must never look like one that was.** An empty
  extraction is reported as `no_text_layer`, not as empty text — a model told it read
  a file it never saw will answer about it anyway. `parseStatus` on the attachment is
  what the UI renders, and the composer blocks sending until extraction has settled.
- **`pdfjs-dist` is pinned to 4.x.** 5.7+ and 6.x require Node ≥ 22.13 while
  `package.json` advertises Node ≥ 20; bumping that floor is a separate,
  user-visible change and must not ride along with an unrelated dependency update.

## Gotchas

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
  + real env vars. Real env vars win over `.env`. `GL_CONFIG_PATH` swaps the
  *overlay* path, and `GL_DATA_DIR` moves the sqlite database + uploads tree —
  both exist for tests and the e2e run, and both must be set before the config
  module is first imported.
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

For the full architecture and configuration reference, see `docs/`.