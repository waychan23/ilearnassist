# Desktop app

`apps/desktop` wraps the product in an Electron shell — the **control panel**. It exists so
that someone who is not a developer can install guided-learning the way they install any
other Mac application: drag it into Applications, double-click it, and get a window with a
button that opens the app.

The panel does three things and nothing else:

- **starts and stops the server**, and says truthfully which of the two it is;
- **opens the chat UI**, in a window of its own or in the user's browser;
- **shows where the data lives**, and offers to reveal it in Finder.

The backend is unchanged by this. The desktop app supervises the same Fastify server that
`pnpm dev:server` starts; it does not reimplement or wrap any of it.

## What the user gets

```bash
pnpm install
pnpm desktop:package          # → apps/desktop/release/guided-learning-0.1.0-arm64.dmg
```

Open the `.dmg`, drag **guided-learning** onto the Applications shortcut, and launch it. The
control panel appears, starts the server, and the **Open app** button loads the chat UI in a
second window.

The build is **ad-hoc signed, not notarised** (see [Signing](#signing) below), so the first
launch shows *"cannot be opened because Apple cannot check it for malicious software"*. That
wording is alarming and the fix is mundane:

- **Right-click the app → Open**, then confirm. One time only, per machine.
- Or, from a terminal: `xattr -dr com.apple.quarantine /Applications/guided-learning.app`

What you should *not* see is *"guided-learning is damaged and can't be opened"* — that one
is not a trust prompt and right-click → Open will not clear it. `scripts/after-sign.mjs`
exists to prevent it; see [Signing](#signing).

## How it fits together

```text
┌─ guided-learning.app ────────────────────────────────────────────────┐
│                                                                      │
│  Contents/MacOS/guided-learning        ← Electron                    │
│      │                                                               │
│      │ spawns, with ELECTRON_RUN_AS_NODE=1                           │
│      ▼                                                               │
│  Contents/Resources/app/dist/server/index.mjs                        │
│      │   the whole Fastify server, bundled to one ESM file           │
│      │                                                               │
│      ├── requires  app/node_modules/better-sqlite3   (N-API prebuild)│
│      ├── imports   app/node_modules/pdfjs-dist                       │
│      │                                                               │
│      └── serves    Contents/Resources/web/*  at http://127.0.0.1:N   │
│                    and the /api/* it has always served   ▲           │
│                                                          │           │
│  Contents/Resources/app/dist/renderer/index.html ────────┘ loads URL │
│      the control panel page                                          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

        writes to   ~/Library/Application Support/guided-learning/
                      ├── config/config.yaml         (seeded once)
                      ├── config/config.local.yaml   (port: 0)
                      ├── data/guided-learning.sqlite
                      ├── data/uploads/
                      └── workspaces/
```

Four decisions hold this up. Each of them is a comment in the code; together they are why a
packaged build behaves like the checkout.

### The frontend is served by the server (`apps/server/src/webApp.ts`)

Before this, `pnpm build` produced an `apps/web/dist` that **nothing served** — the only way
to use the app was the Vite dev server with its `/api` proxy in front of a separate backend.
The production build was unreachable, and the desktop app would have had to reimplement that
proxy.

So the server serves the built frontend itself, from the same origin as the API, and
registers it **only when an `index.html` exists**. A fresh checkout or a test run that has
never run `pnpm build` therefore gets exactly the API-only server it had before — which is
what keeps the test suite independent of whether someone happened to build the frontend.

### The server runs as a child of the Electron binary (`src/main/launch.ts`)

There is no Node on a user's machine, and shipping one would mean shipping a second
interpreter. `ELECTRON_RUN_AS_NODE=1` makes the binary already running execute the server as
plain Node — same version, same native-module ABI, nothing to install.

A separate process rather than the same one, because a crash or a blocking parse inside a
route must not take the window with it, and because "stop the server" needs a boundary to
stop at. Stopping sends **SIGTERM**, which `index.ts` turns into `app.close()`: in-flight
requests drain, a running document parse settles, and the sqlite connection closes rather
than being killed mid-write.

### The address is read off the server's stdout (`src/main/serverProcess.ts`)

The server prints one line once it is actually accepting connections:

```text
[guided-learning] listening on http://127.0.0.1:50896
```

The panel keys on that line and nothing else — not on a fixed port, and not on Fastify's own
"Server listening at …" banner, which is logged from inside `listen` before the process is
necessarily ready. Entering `running` has exactly one cause (that line) and exactly one exit
(the process exiting), which is why the panel can be trusted when it says the server is up.
A control panel that reports "Running" for a server that is not running is worse than one
that reports nothing, because the user has no way to tell.

### All state lives under the user's data directory (`src/main/paths.ts`)

A checkout keeps `config/`, `data/` and `workspaces/` next to the source. A `.dmg` cannot:
the bundle is read-only and is replaced wholesale on every update. The desktop app therefore
sets `GL_PROJECT_ROOT` to `~/Library/Application Support/guided-learning`, seeds a
`config.yaml` there on first launch, and lets the server resolve everything else against it.

Seeding is **idempotent and non-destructive** — an existing `config.yaml` or overlay is never
rewritten, so an API key typed into the Settings UI on a previous launch survives an update.

The app also writes a `config.local.yaml` overlay (via the existing `GL_CONFIG_PATH`
mechanism, not a fork of the config format) setting `port: 0`, so the OS assigns a free port
on every launch. A fixed port is the wrong default for a desktop app: it turns "another copy
is already running" or "something else likes 3720" into a failed launch whose error a
non-technical user cannot act on. Edit that file to pin one.

## Commands

```bash
pnpm desktop:dev        # bundle, then run the panel against a live Electron
pnpm desktop:build      # bundle everything, including the frontend (no .app)
pnpm desktop:package    # build + electron-builder → apps/desktop/release/*.dmg
```

Individual targets, from `apps/desktop`:

```bash
node scripts/build.mjs --no-web   # the fast loop: skips the frontend build
node scripts/build.mjs            # what packaging runs
node scripts/make-icon.mjs        # redraw assets/icon.icns after editing the mark
electron-builder --mac --arm64 --x64   # both Mac architectures (the `package:mac` script)
```

`pnpm desktop:dev` is not a hot-reload loop: it bundles once and launches. Edit, re-run. The
frontend half of a change still belongs in `pnpm dev`, where Vite's HMR works.

## Packaging

`electron-builder.yml` carries two settings that are not its defaults, and both are load-
bearing.

**`asar: false`.** The server runs as a child process and Node has to resolve two packages
out of the tree: `better-sqlite3`, a native addon that `dlopen`s a `.node` file from its
`prebuilds/` directory, and `pdfjs-dist`, whose legacy build Node imports by ESM path. Both
go through filesystem calls that an asar archive intercepts, from a process that is not the
one Electron patched for it. Leaving the tree unpacked removes the question entirely. The
cost is a directory of loose files instead of one archive, which for a self-hosted
single-user app is not a cost.

**`npmRebuild: false`.** `better-sqlite3` v13 ships **N-API** prebuilds
(`prebuilds/darwin-arm64.node` and friends). N-API binaries are ABI-stable across Node and
Electron versions, so the binary built for this machine's Node is already correct for the
Electron runtime that loads it. Rebuilding would spend a network fetch or a full `node-gyp`
compile producing a byte-different equivalent of a file that is already there. If a future
dependency ships a non-N-API native module, this is the setting that has to change.

### What ends up in the app

The `.dmg` is ~150 MB; the app inside unpacks to ~380 MB, of which Electron is the large
majority. The parts that are ours:

| Path | Size | What |
| --- | --- | --- |
| `Contents/Resources/app/dist/server` | 6.6 MB | the whole backend, bundled to one file |
| `Contents/Resources/web` | 2.1 MB | the built frontend |
| `.../app/node_modules/pdfjs-dist` | 42 MB | PDF text extraction |
| `.../app/node_modules/better-sqlite3` | — | N-API prebuilds for every platform |

`pdfjs-dist` is the one obvious candidate: only its `legacy` build is imported, so
`web/` and the other entry points could be filtered out with a `files` rule. It is left
whole on purpose — a `files` glob that accidentally drops a data file breaks PDF parsing
only for the documents that need it, which is a failure nobody would notice until a user hit
it. Worth doing alongside a real test that parses a PDF through the packaged app.

Loading `pdfjs-dist` is also what makes the frontend bundle 6.6 MB smaller than it looks: it
is external to the server bundle and resolved at runtime, not inlined.

### Cross-platform

macOS only today. The layout is already platform-neutral — `paths.ts` derives everything from
`app.getPath("userData")` and `process.resourcesPath`, and the icon script writes a plain
`.png` on non-Mac hosts — so what remains is a `win`/`linux` block in
`electron-builder.yml` and the icons those targets want. Nothing in `src/main` is
Mac-specific except the `titleBarStyle` branch, which already falls back.

Two things to know before adding them:

- `electron-winstaller` is currently set to `false` in `pnpm-workspace.yaml`'s `allowBuilds`.
  The Windows Squirrel target needs it flipped to `true`.
- The `arch: [arm64]` list under `mac` is deliberately one entry so a bare `pnpm
  desktop:package` is quick on an Apple Silicon machine. Use `pnpm desktop:package:mac` for
  both architectures.

## Signing

**Ad-hoc, and that is the minimum, not a nicety.**

Electron ships its binaries linker-signed. electron-builder then adds our entire application
under `Contents/Resources/` — and the result is a signature that claims to seal no resources
on a bundle that now has some. macOS reads that inconsistency as damage, and reports it as
*"guided-learning is damaged and can't be opened"*, which is the one Gatekeeper message
**right-click → Open cannot dismiss**: it is not a trust decision, so there is nothing for
the user to consent to. The only way out is a terminal, which is the opposite of the point
of this app.

`scripts/after-sign.mjs` runs from electron-builder's `afterSign` hook — after the bundle is
assembled, before the `.dmg` is made from it — and re-signs the finished bundle with
`codesign --sign -`. That produces a seal over what is actually there, which turns the
unopenable state into the ordinary *"unidentified developer"* prompt that right-click → Open
does dismiss.

It **deliberately does nothing when the app already verifies** (`codesign --verify --deep
--strict`), so adding a real certificate later cannot silently downgrade a valid signature
into an unopenable one.

Removing the warning entirely needs a Developer ID certificate *and* notarisation, which
needs an Apple Developer account — a release-process decision, not a code change. When a
certificate is present, electron-builder picks it up from the login keychain automatically;
the only edit is adding `notarize` to the `mac` block. The hook then steps aside on its own.

## Building from a slow network

`electron-builder` fetches its own helper binaries from GitHub on first use, and Electron's
binary comes from the same place. On a network where that is slow or blocked, both downloads
stall before any output appears — the build looks hung rather than failing. Point them at a
mirror:

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
pnpm desktop:package
```

Both downloads are cached (`~/Library/Caches/electron`), so this is a first-build cost. The
`ELECTRON_MIRROR` half is worth setting before `pnpm install` too, since Electron's own
postinstall pulls the same ~130 MB binary.

## Testing

`apps/desktop/test/` covers the parts that have logic in them, and those modules are written
to be testable without a display — everything that does not import `electron` takes its
inputs as arguments:

| File | What it holds |
| --- | --- |
| `paths.test.ts` | the per-user layout, and that seeding never overwrites a user's config |
| `launch.test.ts` | reading the address off stdout, and the child's environment |
| `serverProcess.test.ts` | the whole state machine, against real child processes |
| `messages.test.ts` | the panel's two catalogs |

`serverProcess.test.ts` spawns real processes running one-line Node fixtures rather than
mocking `ChildProcess`, because everything worth testing here *is* the process boundary: that
a line split across two `data` chunks is still recognised, that SIGTERM actually reaches the
child, that an exit nobody asked for is reported as a failure. A fake would assert that the
code calls the methods it visibly calls.

`e2e/panel.spec.ts` covers the page itself, in Chromium, against the built bundle — with
`window.panel` stubbed, since that one object is the whole of what the page needs from
Electron. It is a browser test rather than a jsdom one for a specific reason: jsdom has no
cascade, so it cannot tell whether `hidden` actually hides anything, and a `display: flex` in
the stylesheet silently overriding the attribute is a bug that shipped once.

What is deliberately not tested is the rest of the plumbing — window creation, the menu, the
IPC handlers, and `renderer/panel.ts`'s DOM bindings. Those are kept thin enough to read.

The frontend the server now serves has its own tests in `apps/server/test/web-app.test.ts`,
and the assertion that matters there is not that `/` returns HTML — it is that a concrete API
route still wins over the static wildcard, and that an unknown `/api/...` path still answers
with the error envelope the browser client parses.

### Checking a packaged build by hand

The panel reports its own state in the DOM, so a built app can be inspected without a
screenshot or a click, and without any accessibility permission:

```bash
/Applications/guided-learning.app/Contents/MacOS/guided-learning --remote-debugging-port=9222 &
curl -s localhost:9222/json        # one page target per open window
```

Evaluating `document.querySelector('[data-role="state"]').textContent` over that protocol is
how "the panel says Running and the URL is the port the server actually bound" was confirmed
for the shipped `.dmg`, and how clicking `[data-action="open"]` was shown to produce a second
page target on the server's URL. Reach for this before trusting a green unit test about a
build you have not run.
