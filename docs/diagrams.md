# Diagrams

The agent draws diagrams — flowcharts, sequence diagrams, class/UML, state machines, ER models —
instead of describing them in ASCII art, and the conversation shows the drawing. The source is
written as a file into the conversation's own folder.

This is the working reference. The rationale for the on-disk layout is in
[architecture.md](architecture.md); the widget half of it is in [widgets.md](widgets.md).

## The shape

```
packages/shared/src/index.ts     DIAGRAM_TOOL_NAME, DIAGRAM_FILE_EXTENSIONS, isDiagramFile,
                                 diagramFileName, slugify, FILE_CONTENT_KINDS += "diagram"
apps/server/src/tools/diagram.ts buildDiagramTool            writes the file
apps/server/src/files.ts         classify()                  says a .mmd is a diagram
apps/server/src/routes.ts        /api/sessions/:id/files     reads the folder back
apps/web/src/utils/mermaid.ts    renderMermaid               lazily loads mermaid
apps/web/src/components/         MermaidDiagram / DiagramCard / DiagramDialog
apps/web/src/widgets/            DiagramWidget               the panel: a list of the folder
```

There is **no diagram table**. The `.mmd` file in `sessions/<sessionId>/` is the record; see
[Why there is no table](#why-there-is-no-table).

## The tool

`ila_diagram`, with `{ name, source }`. It is an **ordinary, allow-listable tool** — not
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
workdir is the sandbox `write_file` and the file tree share, and a conversation's own files are
not the same kind of thing. `write_file` cannot reach `sessions/` — `resolveInWorkspace(workdir,
"../../sessions/x")` is refused — so this directory contains nothing a typed tool did not write.

The session directory has **one writer** and two readers:

| | path | sandbox |
| --- | --- | --- |
| write | `ila_diagram` | `resolveInWorkspace` — lexical only, like every agent tool |
| read | the session-files routes, via `files.ts` | lexical **and** `realpath`, like every browser read |

That asymmetry is inherited rather than invented: it is the same one the workspace browser and the
file tools already have, and for the same reason. See the invariant in `CLAUDE.md`.

A missing directory is not an error at either end. The session route makes one best-effort, the
tool makes one before it writes, and the listing makes one before it reads — the last of those
because the plan widget's snapshot fork writes a session straight to the database and never goes
near the session route, so "this conversation has no files yet" must be an empty list rather than
a 404.

## Why there is no table

A `session_diagrams` table would be a second copy of bytes that already have a home, free to
disagree with the file about its own content. Everything a table would have provided comes from
somewhere else:

| A table would give | Where it comes from instead |
| --- | --- |
| the diagram's content | the file |
| a title | mermaid YAML front-matter, which mermaid draws itself; else the file's name |
| ordering | `FileEntry.modifiedAt`, already on the wire |
| a stable id | the file's path |
| "which reply drew this" | `toolCall.id`, found by scanning the message list (`utils/diagramAnchors.ts`) |
| delete semantics | the session's own soft delete — the bytes stay, like every other file |

The join between a call and its file is the one piece that needs care: the call records the name
the *model* chose (`"Auth Flow"`), the folder holds what the server made of it (`auth-flow.mmd`).
`diagramFileName` lives in `packages/shared` for exactly that reason — a second slug rule on the
web side would put the "go to the reply" button on the wrong row, or on none, and nothing would
report it.

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

## The two viewer surfaces

- **The card**, inline under the tool call: the drawing in a bounded window, a click to open the
  viewer, and a disclosure for the source. `DiagramCard.vue` — and note it is dispatched in
  `ToolCallCard.vue` by its own predicate, **not** through `INTERACTIVE_TOOL_NAMES`, which means
  "suspends the turn": the server routes submitted answers by that list and `MessageItem` groups
  calls by it to put questions below the reply.
- **The widget**, in the right panel: a list of the conversation's diagrams with a jump to the
  reply that drew each one. `DiagramWidget.vue`, a viewer with no tools — see
  [widgets.md](widgets.md#a-viewer-widget-with-no-tools-the-diagram-widget).

One viewer serves both, and the file preview as well: `DiagramDialog.vue` owns the zoom. Zoom is
the CSS `zoom` property rather than `transform: scale`, because a transform does not change layout
and a scroll container would not grow with the picture.

## The session file browser

`GET /api/sessions/:id/files` and `…/files/content` mirror the workspace pair, and are the same
two functions in `files.ts` with a different root — a second *caller*, never a second browser.
`SessionFilesDialog.vue` lists the whole folder (not only diagrams; the widget is the filtered
view) and is opened from the chat header. Every row opens the ordinary file preview, which renders
a diagram because `kind: "diagram"` is a member of `FILE_CONTENT_KINDS`.

There is no write endpoint. The folder's one writer is the tool, and a browser for it is a read.

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
expand button opens the viewer, zoom works, and the file appears in 会话文件. Then flip the theme —
the diagram redraws. A malformed request ("画一张坏掉的图") should leave the reply standing with the
complaint in place of the drawing.
