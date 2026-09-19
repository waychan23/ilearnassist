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
pick. The one place this app *does* create one is `ensureDataDir`, and it runs because somebody
pressed a button — see below.

### Choosing where your data goes

The server will not start without a data root — it has no default, by design, because that path
decides how much of your work survives an uninstall. So the first launch asks, and the panel
will not start the server until the question is answered.

It asks in two places, because a question this consequential is worth being able to answer either
way round.

**In the panel, before anything is pressed**: the hint under the data-folder row names
`~/ilearnassist`, and a **Use the default folder** button beside the existing **Choose folder…**
takes it. The offer is one click because the alternative was making somebody work out where their
data should live before they had used the app once.

**On Start, when nothing has been chosen**: a native prompt says so, names the folder it would
create, and offers the same two answers — *use the default* or *choose a folder…*. Taking the
second opens the picker (and its own warning about a folder that holds no data); dismissing it is a
cancel of the whole thing rather than a fall back to the default, because somebody who declined
the picker has not agreed to the folder they just declined. Either answer then continues into the
start that was pressed — the question is a detour to get the missing input, not a substitute for
the press.

That prompt is main's, and it is worth saying why the *page* does not raise it. An earlier version
had Start return the unchanged state and point the reader at the panel's own default button; a
programmatic focus draws no ring and moves nothing, so Start read as a button that did nothing at
all. The question belongs on the side that can ask it out loud.

That is **not** the same as defaulting, and the distinction is the design rather than a detail.
Nothing is created and nothing is recorded until that button is pressed, and the button is the
only thing that ever calls `ensureDataDir`. So the server still receives a path a human agreed
to, and `seedFirstRun` still creates no data folder — an empty directory made at launch looks
exactly like the one somebody was supposed to pick, and picking it by mistake starts a second,
empty database that is indistinguishable from having lost everything. `~/ilearnassist` is also
*outside* the application bundle, for the same reason the old suggestion lived outside it:
dragging the `.app` to the Trash does not take it with you.

The picker starts in that same folder, which is the only "suggested" location there is — two of
them is how the picker ends up somewhere the confirm button would not have gone. And if the
folder you pick holds no database, the panel says so before accepting it, because an empty folder
and a wrong folder are indistinguishable from the outside. It warns; it does not refuse, since a
new folder is the normal first-run case. The offered folder is not warned about, on the other
hand: it is this app's own suggestion in your home, and a folder that already holds data is
somebody coming back to it rather than a mistake.

The choice is remembered in `desktop.json` and passed to the server as `ILA_DATA_DIR` on every
launch — not written into a config file, which is what lets either control take effect on the
restart that follows. Precedence is `ILA_DATA_DIR` from the environment first, then
`desktop.json`, then the question above; the environment wins so that `pnpm desktop:dev` and the
e2e harness can run without a human at a dialog. Changing the folder restarts the server, and the
conversations you had on screen stay where they were.

#### Changing the folder leaves stale state behind, and both ends drop it

Stopping the server is not enough, and the failure it leaves is confusing rather than obvious. An
open **app window** is a browser window on the server's own address: after a switch it holds a
bearer token the new database has never issued, and a `/w/<id>/s/<id>` naming a workspace that
does not exist there. The server usually comes back on the **same port**, so nothing about the
origin changes and the tab has no way to tell it is talking to somebody else. Reported from use as
a 会话不存在 toast on a page the reader did nothing to reach.

So the two ends each drop what they can, and neither is a second implementation of the other:

- **The panel closes the app window** (`resetAppWindow`), and clears that origin's storage on the
  way. The window cannot fix itself here: the server it was pointed at has just been stopped and
  may come back on another port, and `openAppWindow` now compares the window's URL against the
  current one rather than showing a page from a server that is gone.
- **The web app settles it for itself, on every load.** `GET /api/health` carries an
  **installation id** — a value in `app_settings`, not a hash of the path, so a *moved* folder is
  the same installation while a different folder is a different one. The client compares it before
  it uses the token and, on a difference, drops the pair and replaces the address with the front
  door. See `apps/web/src/composables/instance.ts`.

The second is what covers a plain browser, and it is why the check runs **before the router is
installed**: afterwards the answer would arrive as a 401, indistinguishable from an expired
session. It is two things rather than one because the address outlives the token — the guard that
sends a signed-out reader to the sign-in screen remembers where they were going and hands it back,
so the stale path is suppressed on that one navigation rather than merely erased from the bar
(the router captured the location at import time, which is before the reset can have finished its
request). A request that cannot be made concludes nothing: a dropped connection is not an
installation change, and signing somebody out of one that is fine would be the worse mistake.

The app also writes a `config.local.yaml` overlay (via the existing `ILA_CONFIG_PATH`
mechanism, not a fork of the config format) setting `port: 0`, so the OS assigns a free port
on every launch. A fixed port is the wrong default for a desktop app: it turns "another copy
is already running" or "something else likes 3720" into a failed launch whose error a
non-technical user cannot act on. Edit that file to pin one.

### Creating the first administrator

A fresh data folder has no administrator, and the server **refuses to listen until one
exists**. The web app cannot create accounts, so the panel shows a **Create superadmin** card.
That control works with the server stopped:

- the panel spawns the bundled `dist/server/cli.mjs` as a one-shot child (the same
  `ELECTRON_RUN_AS_NODE` trick as the long-lived server, but a process that runs and exits);
- the operator types a username and a password with a confirmation field — their own
  credential, which is why it is typed rather than generated; the password is handed over
  stdin, so it never appears in the process table or a log line;
- the CLI writes the account and its directory tree directly to the chosen data folder, then
  exits.

**Start walks both preconditions and ends by starting.** The server needs a data root *and* an
administrator, so pressing **Start server** on a new install asks for the folder natively (see
above) and then opens the create-administrator sheet itself; when the account exists, it starts.
The reader is never left to work out what else is missing — which is what happened when Start was
merely *disabled* in this state, with the card's own button as the only way through.

**The two doors into that sheet end differently, on purpose.** Creating an administrator is not a
request to run the server, so the card's own **Create superadmin** button creates and stops there —
and leaves the sheet open on its success line as the acknowledgement. The form opened *by Start* is
closed again the moment it succeeds, because the reader's attention belongs back on the panel where
the start is happening. The door they came through is what tells the two apart.

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
pnpm --filter @ilearnassist/server cli reset-admin --password-stdin [--username <name>]   # type a new password
pnpm --filter @ilearnassist/server cli reset-admin --generate [--username <name>]        # invent one, shown once
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
carries that way in: **Reset superadmin password** opens a sheet where the operator types a new
password twice, and signs the account out everywhere so the old one really is gone.

The operator is assumed to **be** the superadmin — the person at this machine — which is the
same assumption creating the first administrator makes, so the password is chosen here rather
than generated and shown once. There is no "confirm" dialog: the two-password form is the
deliberate act. Nothing chosen is echoed back; the reply names the account and nothing else.

**It does not need the server to be running**, and that is the whole shape of it. The panel
spawns the same `cli.mjs` it uses to create the first administrator — a one-shot child that
writes the row itself — so the button means the same thing whether the server is up, stopped, or
refusing to start. The last of those is exactly when somebody reaches for it.

It used to be an HTTP route, guarded by a per-launch secret the panel shared with the server it
spawned. The secret bought nothing the process boundary did not already buy: the panel could
always write the database directly, because it runs on the operator's machine and holds the
CLI — and anything that can run this panel can read the database file anyway. What the route
did buy was a dependency on a healthy server, in the one control that exists for the moment
something is wrong. So there is no `ILA_PANEL_TOKEN` any more, and no route; a checkout gets
the same recovery through the terminal:

```bash
pnpm --filter @ilearnassist/server cli reset-admin --password-stdin   # type a new password
pnpm --filter @ilearnassist/server cli reset-admin --generate         # invent one, shown once
# either accepts --username <name>; without it the first enabled superadmin is used
```

It is also the **only** way a superadmin's own password is replaced — the web console refuses
that outright (`PANEL_RESET_REQUIRED`), because a console reached with a credential the caller
already holds is a weaker second way to the one credential that can undo the installation. An
ordinary administrator is not in that position and changes their own password normally.

This replaces the credential of the one account that can do everything, and unlike disabling a
user there is no second administrator behind it to put things right.


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
pnpm desktop:package    # build + electron-builder → apps/desktop/release/*.dmg (arm64)
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

All three, built on a runner of their own. `electron-builder.yml` carries a `win` (NSIS) and a
`linux` (AppImage + deb) block beside `mac`, and `.github/workflows/release.yml` builds each on
its own platform — a manual run leaves the installers as workflow artefacts, a `v*` tag also
attaches them to a GitHub Release. Nothing here is macOS-specific any more except the
`titleBarStyle` branch in `main.ts`, which already falls back.

```bash
pnpm desktop:package:mac     # arm64 + x64 .dmg
pnpm desktop:package:win     # NSIS .exe          — Windows only
pnpm desktop:package:linux   # .AppImage + .deb
```

**Windows has to be built on Windows.** NSIS needs Windows tooling; electron-builder will try
wine when cross-building and that is a dependency to install and keep working rather than a
thing to document. macOS and Linux build fine from a Mac.

Four things about the platform blocks are decisions rather than defaults:

- **NSIS, not Squirrel**, which is why `electron-winstaller` stays `false` in
  `pnpm-workspace.yaml`'s `allowBuilds`. It is Squirrel's Windows-only toolchain and NSIS does
  not use it. `oneClick: false` because this app's audience installs things by clicking through
  a wizard: a one-click installer offers no choice of location and no visible uninstaller.
- **The icons are three files, and each is drawn at the size it is used at.**
  `assets/icon.icns` (macOS), `assets/icon.ico` (Windows: 16, 32, 48 and 256, because shipping
  one size is what makes an app look blurry in Explorer and fine everywhere else), and
  `assets/icon-512.png` (Linux). `make-icon.mjs` writes all of them from the same geometry —
  see the note there on why nothing is ever scaled down from the 1024px master.
- **The tray icon is two files, chosen by platform.** macOS gets `trayTemplate.png`, a
  *template* image it recolours for a dark menu bar. Windows and Linux have no such convention,
  so that file there is a black glyph on a dark taskbar — drawn, present, and invisible. They
  get `tray.png`, in the accent colour. `trayIconFile()` in `paths.ts` is the choice, and
  `paths.test.ts` asserts both names exist in `assets/` — the failure mode is a packaged app
  with no tray item on Windows only.
- **`artifactName` is spelled out**, so a release's files are
  `ilearnassist-<version>-<os>-<arch>.<ext>` rather than four artefacts told apart by their
  extension alone.

**Neither the Windows nor the Linux artefacts are signed**, and macOS is ad-hoc signed only.
Windows SmartScreen therefore shows its "unrecognised app" warning and Linux packages are
unsigned; both are documented for the user in the README, because for a non-technical audience
that warning is the first thing they meet. Signing them is a release-process decision, not a
code change — see [Signing](#signing) for the macOS half.

## Version and upgrade

The panel shows the version it is running, and says so when a newer release exists. Both are new:
before this, the only place a packaged user could read their version was the operating system's
About box, and nothing ever told them a release had happened.

**The check belongs to the panel rather than to the server**, because the thing being upgraded is
the *application*. It also keeps the server free of a new outbound call — this codebase is
deliberate about those (see `web_fetch`'s SSRF guard) — so there is one place to reason about
instead of two. `update.ts` asks GitHub for the latest release, compares it against
`app.getVersion()` as **numbers rather than strings** (`0.10.0` is newer than `0.9.0`, and a string
comparison gets that exactly backwards), and **never throws**: every failure is "we do not know",
which the panel treats as "nothing to report". The answer is cached in `desktop.json`, so an
offline launch shows what the last successful check found rather than looking broken; a *failed*
check leaves the cache alone rather than overwriting it with "you are up to date".

**There is deliberately no self-update, and it is a signing decision rather than a feature that
was not written.** On macOS an update can only be *installed* by a code-signed app, and this one is
ad-hoc signed (see [Signing](#signing)) — `electron-updater` would download the release and then
have Squirrel.Mac refuse it at the install step. So the notice opens the download page and the user
replaces the app the way they installed it. That works identically on all three platforms, which is
worth more than a button that works on two of them.

**The database upgrade is the part that needs nothing from the user.** Any open of the database
walks it forward and takes a snapshot first (see [migrations.md](migrations.md)), so somebody who
installs a new version and launches it has already been upgraded by the time the window appears.
The server prints one line when that happens:

```text
[ilearnassist] migrated schema v5 -> v6 (backup: <dataRoot>/backups/ilearnassist-v5-….sqlite)
```

The panel parses it — beside `parseListeningLine`, with `parseMigratedLine` — and shows the note
with the path of the copy. A printed line rather than a new IPC path, for the same reason the
listening line is one: the server is the only side that knows, and a launcher already reads its
stdout. The migration does **not** touch the state machine: `running` still has exactly one cause.

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
| `admin.test.ts` | the CLI boundary (argv, stdin, both streams, exits) and the Start gate |
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
