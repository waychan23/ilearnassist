# Desktop app

`apps/desktop` wraps the product in an Electron shell — the **control panel**. It exists so
that someone who is not a developer can install ilearnassist the way they install any
other Mac application: drag it into Applications, double-click it, and get a window with a
button that opens the app.

The panel does four things and nothing else:

- **starts and stops the server**, and says truthfully which of the two it is;
- **opens the chat UI**, in a window of its own or in the user's browser;
- **opens the app on a phone or tablet** on the same network, by showing a QR code;
- **shows where the data lives**, and offers to reveal it in Finder.

It also keeps running when you close it: the window goes away, the server does not, and a
menu-bar icon brings it back. Only an explicit "stop the server and quit" stops anything —
see [Closing the window, and quitting](#closing-the-window-and-quitting).

The backend is unchanged by this. The desktop app supervises the same Fastify server that
`pnpm dev:server` starts; it does not reimplement or wrap any of it.

## What the user gets

```bash
pnpm install
pnpm desktop:package          # → apps/desktop/release/ilearnassist-0.1.0-arm64.dmg
```

Open the `.dmg`, drag **ilearnassist** onto the Applications shortcut, and launch it. The
control panel appears and, after you choose a data folder and create the first
administrator, starts the server; the **Open app** button then loads the chat UI in a second
window. (On later launches the server starts straight away.)

The build is **ad-hoc signed, not notarised** (see [Signing](#signing) below), so the first
launch shows *"cannot be opened because Apple cannot check it for malicious software"*. That
wording is alarming and the fix is mundane:

- **Right-click the app → Open**, then confirm. One time only, per machine.
- Or, from a terminal: `xattr -dr com.apple.quarantine /Applications/ilearnassist.app`

What you should *not* see is *"ilearnassist is damaged and can't be opened"* — that one
is not a trust prompt and right-click → Open will not clear it. `scripts/after-sign.mjs`
exists to prevent it; see [Signing](#signing).

## How it fits together

```text
┌─ ilearnassist.app ────────────────────────────────────────────────┐
│                                                                      │
│  Contents/MacOS/ilearnassist        ← Electron                    │
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

  app state   ~/Library/Application Support/ilearnassist/
                ├── config/config.yaml         (seeded once)
                ├── config/config.local.yaml   (port: 0)
                └── desktop.json               (this app's preferences)

  your data   wherever you chose on first launch
                ├── db/sqlite/ilearnassist.sqlite
                ├── users/<name>/workspaces/<name>/
                ├── users/<name>/sources/
                └── uploads/
```

**Two directories, and the split is the point.** The app's own tree holds the config and the
panel's preferences and is replaced when the app updates; yours holds the database, your
workspaces and your uploads, and nothing here ever writes to it except the server you told it
to run. Backing up your work means copying the second one; reinstalling the app touches only
the first.

That directory is named after `app.setName()` in `apps/desktop/src/main/main.ts`, which is also
why renaming the app moves it: it used to be `~/Library/Application Support/guided-learning/`,
and nothing is read from there any more. An install that predates the rename has to be carried
across by hand — `config/config.yaml` and `.env`, which hold the API keys. A freshly seeded
`config.yaml` is not a substitute, because its `apiKey` fields are `${ENV_VAR}` references and
the new directory has no `.env` beside them yet.

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
[ilearnassist] listening on http://127.0.0.1:50896
```

The panel keys on that line and nothing else — not on a fixed port, and not on Fastify's own
"Server listening at …" banner, which is logged from inside `listen` before the process is
necessarily ready. Entering `running` has exactly one cause (that line) and exactly one exit
(the process exiting), which is why the panel can be trusted when it says the server is up.
A control panel that reports "Running" for a server that is not running is worse than one
that reports nothing, because the user has no way to tell.

### The app's state lives under `userData`, and yours does not (`src/main/paths.ts`)

A checkout keeps `config/` next to the source. A `.dmg` cannot: the bundle is read-only and is
replaced wholesale on every update. The desktop app therefore sets `ILA_PROJECT_ROOT` to
`~/Library/Application Support/ilearnassist` and seeds a `config.yaml` there on first launch.

Seeding is **idempotent and non-destructive** — an existing `config.yaml` or overlay is never
rewritten, so an API key typed into the Settings UI on a previous launch survives an update.
It also deliberately **does not create a data folder**: the data root is the user's to choose,
and an empty directory made on their behalf looks exactly like the one they were supposed to
pick.

### Choosing where your data goes

The server will not start without a data root — no default, by design, because that path
decides how much of your work survives an uninstall. So the first launch asks: the panel shows
**Choose folder…** and will not start the server until a folder is picked.

Two things make that question honest. The picker starts in
`~/Library/Application Support/ilearnassist/data`, which is *outside* the application bundle —
dragging the `.app` to the Trash does not take it with you. And if the folder you pick holds no
database, the panel says so before accepting it, because an empty folder and a wrong folder are
indistinguishable from the outside and one of them starts a second, empty database that looks
exactly like having lost everything. It warns; it does not refuse, since a new folder is the
normal first-run case.

The choice is remembered in `desktop.json` and passed to the server as `ILA_DATA_DIR` on every
launch — not written into a config file, which is what lets **Choose folder…** take effect on
the restart that follows. Precedence is `ILA_DATA_DIR` from the environment first, then
`desktop.json`, then the picker; the environment wins so that `pnpm desktop:dev` and the e2e
harness can run without a human at a dialog. Changing the folder restarts the server, and the
conversations you had on screen stay where they were.

The app also writes a `config.local.yaml` overlay (via the existing `ILA_CONFIG_PATH`
mechanism, not a fork of the config format) setting `port: 0`, so the OS assigns a free port
on every launch. A fixed port is the wrong default for a desktop app: it turns "another copy
is already running" or "something else likes 3720" into a failed launch whose error a
non-technical user cannot act on. Edit that file to pin one.

### Creating the first administrator

A fresh data folder has no administrator, and the server **refuses to listen until one
exists**. The web app cannot create accounts, so the panel shows a **Create superadmin** card
in place of a Start button that would only fail. That control works with the server stopped:

- the panel spawns the bundled `dist/server/cli.mjs` as a one-shot child (the same
  `ELECTRON_RUN_AS_NODE` trick as the long-lived server, but a process that runs and exits);
- the operator types a username and a password with a confirmation field — their own
  credential, which is why it is typed rather than generated; the password is handed over
  stdin, so it never appears in the process table or a log line;
- the CLI writes the account and its directory tree directly to the chosen data folder, then
  exits, and the panel starts the server.

Doing it here rather than in the web app is the security boundary: the panel only runs on the
operator's machine, while the login screen is reachable over the network the moment LAN
sharing is on. An in-app "create administrator" screen would be a `public` route anyone on
that network could claim during the one window in which the installation has no owner. A data
root carried over from the build where a username *was* the credential adopts the matching
account rather than making a second one beside it.

The same CLI is the headless path on a machine with no panel:

```bash
pnpm --filter @ilearnassist/server cli status                                        # is there an administrator?
pnpm --filter @ilearnassist/server cli create-admin --username <you> --generate     # invent a password, shown once
pnpm --filter @ilearnassist/server cli create-admin --username <you> --password-stdin   # type your own
```

### The panel's language

The panel ships in Simplified Chinese and English, like the app, and the choice is a control in
its header rather than a hidden preference. The stored value is `desktop.json`'s `locale`:
`""` means **follow the system**, and that is the default — the panel is usually the first
screen of the product, and a desktop app should agree with the rest of the machine without being
asked. Unlike the web app, "follow the system" is a real answer it is worth being able to return
to; there is no way back to a detected default once an explicit choice has been stored.

**The main process owns the language, and the page renders what it is told.** That is not a
layering preference: the menu bar, the tray menu, the window title and every native dialog —
including the two that confirm a data folder and a password reset — are strings Electron renders
outside the page, and they have to change with it. So `panel:set-locale` is a round trip that
writes the preference, rebuilds the menu and the tray, retitles the window and broadcasts; the
page adopts the `locale` on the broadcast. A page that switched on its own would leave the menu
above it in the old language.

Two consequences worth knowing:

- The renderer's `navigator.language` is only a *placeholder* for the few milliseconds before
  the first state arrives, so the page never paints in the wrong language for longer than that.
- The three options are labelled in their own language — **简体中文** and **English** do not
  translate — because a picker that renders the option you cannot read in a language you cannot
  read is no use to the person who needs it. `apps/desktop/test/messages.test.ts` allows the CJK
  in the English catalog for that one key.

## Opening the app on a phone or tablet

Press **Open on your phone** in the panel. If the server is loopback-only it restarts bound
to every interface, then the panel shows a QR code; point the phone's camera at it and the
same app opens in the phone's browser.

That button is the consent. Being reachable from the network is not something the app should
do on its own — it makes this machine's workspaces, conversations and, through the chat UI
on that device, the configured provider keys reachable by anything on the network. Reasonable
on a home network; not reasonable to have happen on a café's. So it is off until asked for,
stays on until turned off, and the panel carries a **Stop sharing** control for as long as it
is on.

**It also decides who can reach the sign-in screen.** Every account has a password and every
request carries a token, so an address on the network is no longer an address anyone can walk
into — but it is still the switch that decides whether there is anything to walk into. With
sharing off, only this machine can reach the app at all, which is a second reason to leave it
off unless someone actually wants to read their notes from the sofa.

The bind address follows the switch rather than the config, always — including when the
switch is off and the address is loopback. Leaving the loopback case to `config.yaml` would
mean a user who had hand-edited `server.host` there could have the panel report "not shared"
while the port was open to the network they were sitting on, and a control whose stated state
and actual state can disagree is worse than no control. That is what `ILA_HOST` is for, and
why `buildLaunchSpec` always sets it.

Rebinding needs a restart, because a bind address is chosen once at `listen` and there is no
way to widen a socket that is already accepting. The panel performs one and waits for it, so
the address it shows is one that is answering.

### Which address goes in the code

A machine has several addresses and only one of them is reachable from the phone. Picking the
wrong one produces a QR that scans perfectly and then times out, with nothing on either device
saying which end is wrong — so `lan.ts` ranks rather than finds:

- **Virtual interfaces are excluded**, by name: `utun`, `tun`, `bridge`, `docker`, `vmnet`,
  `awdl` and friends. A VPN address is a private IPv4 on an up interface, indistinguishable
  from Wi-Fi by inspection, and reachable only from inside the tunnel.
- **`169.254.x.x` is excluded** — what an interface gives itself when DHCP failed.
- **A private address is preferred**, but a public one is still offered: a café can hand out
  routable addresses.
- **The result is a total order**, so the panel cannot show a different address on two
  launches of the same machine. A QR that changes for no reason is one a user stops trusting.

If nothing survives that, `findLanAddress` returns null and the sheet says so instead of
drawing a code. Null is a real answer: encoding `127.0.0.1` would make the phone load its
*own* loopback, which is the most confusing possible outcome.

### The QR code does not follow the theme

It is the one surface in the panel that ignores light and dark, and it has to: a scanner needs
dark modules on a light field, and inverting the code to match a dark window is the classic
way to ship a QR that renders beautifully, screenshots well and never reads on the phone it
was made for.

The two colours are `fill` **attributes on the elements**, not CSS. As classes they would live
only as long as the stylesheet does, and a serialised or rasterised copy of the SVG would fall
back to SVG's default black fill — including the quiet zone, which then paints over the whole
code. That is not hypothetical: it is what the first version did, and decoding the rendered
SVG is how it was found. Every colour in `paintQr` is written where it travels with the
markup.

## Resetting a forgotten administrator password

Every route in the app needs somebody already signed in, which is exactly what a forgotten
password prevents — so without a way in that needs nobody signed in, an installation whose only
administrator forgot their password is a directory full of files nobody can open. The panel
carries that way in: **Reset superadmin password** generates a new one, shows it once, and signs
the account out everywhere so the old one really is gone.

**What makes it safe is `ILA_PANEL_TOKEN`.** The panel generates a secret when it launches,
passes it to the server child it spawns, and sends it with the reset request; the server accepts
`POST /api/auth/panel-reset` from nothing else. The secret is never written anywhere — not to
`desktop.json`, not to the config overlay, not to a log line — so it does not exist between
launches, and reaching the server over the network does not get you one. A launch that was not
the panel (a checkout, a `pnpm dev`) has no token, and the route answers 404: it is simply not
there.

What it rests on is that sitting at the machine is the proof of identity. That is a real claim
and not a figure of speech — anyone who can run this panel can also read the database file
directly — so the token is not what makes the feature safe; it is what keeps the feature from
being reachable from somewhere else.

The confirmation in front of it is not ceremony either. This replaces the credential of the one
account that can do everything, and unlike disabling a user there is no second administrator
behind it to put things right.

**It is also the only way a superadmin can replace their own password.** The web console refuses
a superadmin's own reset outright (`PANEL_RESET_REQUIRED`), because that console is reached with
a credential the caller already holds — a self-reset there would be a second and weaker way to
replace the one credential that can undo the installation. An ordinary administrator is not in
that position and resets their own from the web like any other password change.

## Closing the window, and quitting

Closing the panel **hides it**. The server keeps running, so a phone that is mid-conversation
does not lose it, and a menu-bar icon brings the panel back. A second launch — the Dock icon,
or opening the app again — raises the existing panel rather than starting a rival server,
via `requestSingleInstanceLock`.

Only two things stop the server: the menu bar's **Stop server and quit**, and quitting the app
any way at all (`Cmd+Q`, the app menu). Both route through `before-quit`, which awaits
`server.stop()` — that is what drains in-flight requests and closes sqlite rather than killing
the process mid-write. `process.on("exit")` force-kills the child as a backstop for the paths
that cannot await, so nothing is left holding the port.

The tray icon is a **template image**: black with alpha, filename ending in `Template`, so
macOS recolours it for a dark menu bar and dims it when the app is not frontmost. It is drawn
at 16 and 32 pixels rather than scaled down from the 1024-pixel app icon, because the
reduction turns the speech bubble's tail into a smudge.

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
*"ilearnassist is damaged and can't be opened"*, which is the one Gatekeeper message
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
| `lan.test.ts` | which address a phone can reach, and that it does not change between calls |
| `settings.test.ts` | that no state of the preferences file can stop the app from opening |
| `qr.test.ts` | that a decoder reads the URL back out of the code |
| `messages.test.ts` | the panel's two catalogs |

`serverProcess.test.ts` spawns real processes running one-line Node fixtures rather than
mocking `ChildProcess`, because everything worth testing here *is* the process boundary: that
a line split across two `data` chunks is still recognised, that SIGTERM actually reaches the
child, that an exit nobody asked for is reported as a failure. A fake would assert that the
code calls the methods it visibly calls.

`qr.test.ts` deliberately does **not** decode with the library that encoded: it rasterises the
module square, hands the pixels to `jsQR`, and asserts the URL comes back. A code read back by
its own encoder proves only that the encoder is self-consistent, and a QR is not read by its
own encoder — it is read by a phone camera.

`e2e/panel.spec.ts` covers the page itself, in Chromium, against the built bundle — with
`window.panel` stubbed, since that one object is the whole of what the page needs from
Electron. It is a browser test rather than a jsdom one for a specific reason: jsdom has no
cascade, so it cannot tell whether `hidden` actually hides anything, and a `display: flex` in
the stylesheet silently overriding the attribute is a bug that shipped once. The same
limitation is why one of its cases asserts that every control's bounding box is inside the
window: the panel is a fixed-size window over a fixed stack of rows, so adding a row is how a
control ends up below the bottom edge with nothing to indicate it exists.

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
/Applications/ilearnassist.app/Contents/MacOS/ilearnassist --remote-debugging-port=9222 &
curl -s localhost:9222/json        # one page target per open window
```

Evaluating `document.querySelector('[data-role="state"]').textContent` over that protocol is
how "the panel says Running and the URL is the port the server actually bound" was confirmed
for the shipped `.dmg`, and how clicking `[data-action="open"]` was shown to produce a second
page target on the server's URL. Reach for this before trusting a green unit test about a
build you have not run.

The same protocol drives the parts no unit test can reach:

- **The LAN switch** — click `[data-action="share"]`, then `fetch()` the URL the sheet
  encoded. A 200 from the network address is the only proof the bind is real; a server still
  on loopback refuses that address outright.
- **Close-to-tray** — `Runtime.evaluate("window.close()")` and then compare process counts.
  A *hidden* window disappears from `/json` while its renderer and the server child stay
  alive, which is the distinction that matters; the panel is not destroyed.
- **The re-raise** — launch a second instance and check both that a page target is back and
  that there is still exactly **one** server child. Two would mean the single-instance lock is
  not holding, which looks like nothing at all until two servers fight over the database.

Launch the app detached (`spawn(..., { detached: true }).unref()`) and do the whole sequence
inside one script: a process backgrounded from a shell does not reliably outlive the shell.
