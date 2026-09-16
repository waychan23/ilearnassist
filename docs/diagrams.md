# Diagrams

The agent draws diagrams — flowcharts, sequence diagrams, class/UML, state machines, ER models —
instead of describing them in ASCII art, and the conversation shows the drawing. The source is
written as a file into the conversation's own folder.

This is the working reference. The rationale for the on-disk layout is in
[architecture.md](architecture.md); the widget half of it is in [widgets.md](widgets.md).

## The shape

```
packages/shared/src/index.ts     DIAGRAM_TOOL_NAME, DIAGRAM_FILE_EXTENSIONS, isDiagramFile,
                                 FILE_CONTENT_KINDS += "diagram", Diagram / GetSessionDiagramsResponse
apps/server/src/diagrams.ts      diagramFileName, registerDiagram, listDiagramViews
apps/server/src/tools/diagram.ts buildDiagramTool            writes the file and the row
apps/server/src/files.ts         classify()                  says a .mmd is a diagram
apps/server/src/threads.ts       places each diagram in a thread
apps/server/src/db.ts            session_diagrams             the rows
apps/server/src/routes.ts        /api/sessions/:id/diagrams   reads them; .../files the folder
apps/web/src/utils/mermaid.ts    renderMermaid               lazily loads mermaid
apps/web/src/components/         MermaidDiagram / DiagramCard / DiagramDialog
apps/web/src/widgets/            DiagramWidget               the panel: a list of the rows
```

The `.mmd` file holds the bytes; the `session_diagrams` row holds what the file cannot answer.
See [What is a file and what is a row](#what-is-a-file-and-what-is-a-row).

## The tool

`ila_diagram`, with `{ name, source, summary }`. It is an **ordinary, allow-listable tool** — not
widget-bound, unlike the plan and quiz tools. A bound tool is assembled only when its widget is
installed, and nothing installs a widget by default (`DEFAULT_WIDGET_IDS` is empty), so binding
this one would mean the model has no way to draw a diagram in most conversations, which is the
complaint the tool exists to answer. It is also *not* in `NON_FILE_TOOLS`, so
`fileTools.enabled: false` means no diagrams — an operator saying "this agent does not write
files" should not get a diagram whose file was never written.

`name` is a short label in any language; the server slugifies it (`diagramFileName`) and writes
`<slug>.mmd`. **Re-using a name overwrites that file**, which is the revise mechanism: a model
correcting its own diagram calls again with the same name, and the conversation ends up showing
one diagram rather than two. There is no uniqueness suffix, deliberately — `uniqueSlug` would
turn a correction into `auth-flow-1.mmd`.

`source` is passed through untouched. The tool does **not** validate mermaid syntax: the viewer
has to survive a malformed diagram anyway (a model can be wrong in ways no schema describes), and
a second validator would be a second opinion about what mermaid accepts, free to disagree with
the mermaid that actually draws it. An empty source and one past `MAX_DIAGRAM_CHARS` are refused,
because those are things the model can fix.

`summary` is a required one- or two-sentence description of what the diagram is *about* (not its
shape), in the conversation's language, capped at `DIAGRAM_SUMMARY_MAX`. It is the line the panel
shows under each diagram and the enlarged view shows above the drawing; it is also the material
the thread classifier is given to place the diagram. The size cap is server-local rather than
shared: `MAX_DIAGRAM_CHARS` is enforced on both sides, but only the tool bounds the summary. The
file is written first and the row second, so a refused call — or a failed write — leaves the
previous revision entirely alone, including its thread placement.

There is no `ila_read_diagram`. Within the conversation the model already has its own earlier
call in context (a non-suspending tool's arguments are persisted verbatim and replayed), and past
the history window the fallback is "call it again and rewrite" — which is cheap for something
that winds up in a file. A read tool would be a decision to widen the agent's read surface into
the session directory, not a bug fix. If that decision is ever made, it belongs beside
`read_document` in the "a tool takes a whitelist" family, not here.

## The file

```
<dataRoot>/users/<userSlug>/workspaces/<wsSlug>/sessions/<sessionId>/<slug>.mmd
```

Flat, one level, `.mmd` (`.mermaid` is accepted by `isDiagramFile` and previews identically, since
people arrive with it). The directory is a **sibling of `workdir/`**, not a corner of it: the
workdir is the tree every conversation in the workspace shares, and a conversation's own files
are not the same kind of thing. A workspace-relative path cannot climb into `sessions/` —
`resolveInWorkspace(workdir, "../sessions/x")` is refused — so nothing written *through the
workspace sandbox* lands here.

The session directory has **two writers** and two readers:

| | path | sandbox |
| --- | --- | --- |
| write | `ila_diagram` | `resolveInWorkspace` — lexical only, like every agent tool |
| write | the file tools, with `location: "session"` | the same, against this root |
| read | the session-files routes, via `files.ts` | lexical **and** `realpath`, like every browser read |

It used to be one writer, and the reason it no longer is is the write-location setting: a
conversation's default folder is its own, so `write_file` has to be able to reach it. What
protected the directory was never really the count — it was that every file in it is a row, and
now that is true of both writers: each leaves a **source** row (see `docs/sources.md`), so a
file here is addressable by id whatever wrote it.

That asymmetry is inherited rather than invented: it is the same one the workspace browser and the
file tools already have, and for the same reason. See the invariant in `CLAUDE.md`.

A missing directory is not an error at either end. The session route makes one best-effort, the
tool makes one before it writes, and the listing makes one before it reads — the last of those
because the plan widget's snapshot fork writes a session straight to the database and never goes
near the session route, so "this conversation has no files yet" must be an empty list rather than
a 404.

## What is a file and what are the rows

A diagram is a **file plus two rows**, and each record holds only what the others cannot answer.
The argument that used to sit here — "a table would be a second copy of bytes" — is the reason for
the split rather than against it: neither row holds any of the source.

| the `session_diagrams` row holds | because the file cannot |
| --- | --- |
| `name`, canonical (`auth-flow.mmd`) | it *is* the file's name — the join key to `FileEntry.name`, so the client derives nothing of its own |
| `summary` | the model's one-line description of the drawing; nothing else records it |
| `tool_call_id` | "which reply drew this" without scanning the message list |
| `thread_id` | which 脉络 node the classifier put it in — not derivable from the bytes at all |

| the `sources` row holds | because the diagram table cannot |
| --- | --- |
| `storage: "session"` + `rel_path` | where the file is, in the one shape every other file answers with |
| `category: "diagram"` | what kind of thing it is, for the browser's filters |
| `origin: "agent_session"` | that the assistant wrote it, which is what the browser prints |
| an **id** shared with every other source | so a diagram can be referenced, listed and opened by the same machinery as an upload |

Both rows and the file are written **in one transaction** (`registerDiagram` + `registerFileSource`
in the tool's `save` callback): a diagram whose file exists but whose rows half-landed is a file
the conversation draws and the registry cannot name. Without the source row a diagram would be the
one file in the app the source browser and `@`-reference could not see — the exact split the
registry exists to close. See `docs/sources.md`.

What is **not** in the row is as deliberate. No `source` (the file is the source; a second copy
is free to disagree), no `source_path` (a pure function of the session and the name), no
`message_id` (the assistant message does not exist when the tool runs), and no `deleted_at` — the
row is derived data like `session_threads`, nothing in the product deletes a diagram, and a
soft-deleted session keeps its bytes anyway.

Two things can drift between the halves, and both are *reported* rather than prevented:

- a `.mmd` nobody drew has a file but no row. The conversation-files dialog shows it; the diagram
  panel (which lists rows) does not.
- a row whose file is gone reads `fileMissing` in `GET /diagrams`, the same way a note's read
  reports `messageMissing`.

The one drift still unrepresentable is two copies of the bytes disagreeing with each other.

`diagramFileName` and `slugify` are server-side (`apps/server/src/diagrams.ts` /
`workspace.ts`). They used to be shared so the client could derive a file name to join a call to
it; the row now carries the canonical name, so the client does no deriving and there is nothing
to keep in step.

### The row follows the thread classification

`thread_id` is not set when the tool writes the row — a thread is assigned to a *turn* only
after the turn ends, by the best-effort classifier in `apps/server/src/threads.ts`. The
classifier is given the turn's diagrams (name + summary, never the raw source) under the message
that drew them, answers one placement per diagram, and writes it inside the same transaction as
the turn's own thread. Its answer is an **override**: `"continue"` or an existing `eN`, never
`"new"` (a diagram has no messages of its own, so a thread it started would hold nothing). A
missing or unusable answer drops just that diagram, which then inherits its turn's thread — so a
diagram's `thread_id` is null **iff** the turn owning its latest call has no thread yet. A revise
clears it (the new shape may be a new topic) and the next sync judges it again.

## The renderer

`utils/mermaid.ts`, and the one structural fact about it: **it is not part of `renderMarkdown`.**
`renderMarkdown` is a synchronous `string → string` on purpose — that is why KaTeX was chosen over
MathJax — and mermaid's API is async. So a diagram cannot arrive through the markdown path, and
making the whole render pipeline async for the one case that needs it would be a large change for
a small feature. `MermaidDiagram.vue` is the component that owns the async half; the util module
holds the part with no DOM.

`initialize` options, each with a reason:

| option | value | why |
| --- | --- | --- |
| `startOnLoad` | `false` | otherwise mermaid scans the document on import and renders any `.mermaid` node it finds, including ones this app never made |
| `securityLevel` | `strict` | the source is **model-authored**. Same decision as `html: false` in markdown-it and `trust: false` in KaTeX. Do not relax it |
| `htmlLabels` | `false` | SVG `<text>` instead of a `foreignObject` of HTML: no injection surface at all, and the labels are searchable text in the output, which is what lets a spec assert on a label rather than on coordinates |
| `suppressErrorRendering` | `true` | mermaid reports failure by rejecting; it must not *also* inject its own error graphic where this app has a panel |
| `theme` | `base` | the theme designed to accept `themeVariables`; `default`/`dark` override them |
| `themeVariables` | from the palette | see below |

The chunk is behind a memoized promise inside a function, so importing the module costs nothing
and N diagrams on screen share one fetch. `apps/web/vite.config.ts` lists `mermaid` in
`optimizeDeps.include` so the first diagram does not pay a cold transform of ~200 modules.

### Colours

`diagramThemeVariables(read)` takes a *reader* rather than reaching for `getComputedStyle`, and
that seam is what makes it testable — jsdom does not apply `style.css`, so a real read returns
`""` there. It maps a short list of palette tokens onto mermaid's variables and lets everything
else fall back to mermaid's own `base` theme.

Two things are load-bearing:

- **Values are concrete colours, never `var(--token)`.** Mermaid computes with them in
  JavaScript — derived borders, the pie and git-graph palettes — and a `var()` is not a colour to
  a colour function, it is a string.
- **`edgeLabelBackground` is set.** Mermaid's default is hard white, which on a dark theme is a
  white box sitting on top of every edge label.

The theme follows `composables/theme.ts`; a flip re-initializes and redraws, because mermaid's
configuration is module-global and a diagram drawn for the light palette is wrong the moment it
changes. `theme.ts` writes `data-theme` synchronously, so by the time the watcher runs the
computed styles it reads are the new ones.

Note that `apps/web/test/style.test.ts` cannot check any of this: it scans the stylesheet, and
mermaid's output carries its colours as inline SVG attributes and a scoped `<style>` block. The
runtime derivation *is* the mechanism — which is why `e2e/diagram.spec.ts` has a theme case.

### Failure

A diagram that cannot be drawn is shown, never swallowed and never blank. The panel says so,
names mermaid's own message (dynamic English, untranslated — the same treatment a provider's raw
failure gets), and keeps the source underneath, because without it "this cannot be drawn" leaves
the reader with nothing. Past `MAX_DIAGRAM_CHARS` the source is shown and not drawn: layout is not
linear in the input, and there is no diagram worth a frozen tab.

This is the same decision as KaTeX's `throwOnError: false`, one renderer over: a message that
half-renders is worse than one that renders with a visible complaint in it.

## The three viewer surfaces

- **The card**, inline under the tool call: the drawing in a bounded window, a click to open the
  viewer, and a disclosure for the source. `DiagramCard.vue` — and note it is dispatched in
  `ToolCallCard.vue` by its own predicate, **not** through `INTERACTIVE_TOOL_NAMES`, which means
  "suspends the turn": the server routes submitted answers by that list and `MessageItem` groups
  calls by it to put questions below the reply. Its summary comes straight from the persisted
  call arguments, so a reload needs no request.
- **The widget**, in the right panel: the conversation's **rows** — name, the model's summary,
  the thread each diagram belongs to, and a jump to the reply that drew it. `DiagramWidget.vue`,
  a viewer with no tools — see [widgets.md](widgets.md#a-viewer-widget-with-no-tools-the-diagram-widget).
- **The source browser** lists the whole folder as sources — a conversation's own file is a
  `storage='session'` row like any other, and one of the browser's filters is the conversation. It
  is where a `.mmd` nobody drew stays reachable, because the folder carries the file and the
  diagram row does not.

One viewer serves all three, and the file preview as well: `DiagramDialog.vue` owns the zoom and
shows the summary above the drawing. Zoom is the CSS `zoom` property rather than
`transform: scale`, because a transform does not change layout and a scroll container would not
grow with the picture. The file preview's diagram branch gets its summary from the server: the
session-root `…/files/content` read attaches the row's summary by canonical file name — a
workspace-root `.mmd` has none.

## The session file routes

`GET /api/sessions/:id/files`, `…/files/content` and `…/files/raw` mirror the workspace trio, and
are the same functions in `files.ts` with a different root — a second *caller*, never a second
browser. Every row opens the ordinary file preview, which renders a diagram because
`kind: "diagram"` is a member of `FILE_CONTENT_KINDS`.

**They no longer have a browser of their own.** The dialog that listed the whole folder is gone:
every entry to it was a second way to see a folder the source browser already lists by scope, and
two surfaces for one folder are two places to keep in step. The folder view that remains is that
browser with the conversation as its filter. The *routes* stay, and are not vestigial — the
diagram widget opens one of its rows through `…/files/content` + `…/files/raw` (a `.mmd` is
previewed where it is written rather than copied into a preview), and `e2e/diagram.spec.ts` reads
the listing to assert the tool wrote a file, which is a different claim from a widget having drawn
something.

There is no write endpoint. Both writers are tools, and a browser for it is a read.

## Adding another format

The extension point is `FileContentKind`. A new member needs a `classify` branch in `files.ts`,
an entry in `FILE_CONTENT_KINDS`, and a branch in `FilePreviewDialog`'s `view` switch — which is
exhaustive *because of this feature*: it used to be a `v-else-if` chain whose last branch was
`<pre v-else-if="content">`, so a new kind compiled cleanly and rendered as highlighted source.

A format that needs a server-side renderer (Graphviz, PlantUML) is a different shape: it needs a
process, so it is a driver under `documents/drivers/` and not a `FileContentKind`.

## Watching it work

```
pnpm dev:restart
```

Ask for a diagram ("画一个登录流程的流程图"), and check: the card draws it, the head names it, the
expand button opens the viewer, zoom works, and the source browser (the header's library button,
with this conversation as the scope) lists the `.mmd` under it. Then flip the theme —
the diagram redraws. A malformed request ("画一张坏掉的图") should leave the reply standing with the
complaint in place of the drawing.
