# File preview

The file browser, the source browser and the diagram widget all open a file and show it. Text is highlighted,
Markdown is rendered, diagrams are drawn, and everything else is handed to
[`open-file-viewer`](https://github.com/xushanpei/open-file-viewer) — an MIT, framework-agnostic
viewer with plugins for images, PDF, Office, media, archives, mail, drawings, 3D and GIS.

This is the working reference. The invariant that governs it is in [CLAUDE.md](../CLAUDE.md)
under "A file's preview `kind` is the extension point".

## The shape

```
packages/shared/src/index.ts     FILE_CONTENT_KINDS, FileContent, MAX_FILE_PREVIEW_BYTES
apps/server/src/files.ts         readPreviewFile          what a file *is* — both roots call it
                                 readFileContent          path-resolved, capped at 256 KB
                                 readRawFile              the bytes, capped at 32 MB
apps/server/src/routes.ts        …/files/content          JSON: metadata + text
                                 …/files/raw              bytes, octet-stream
                                 /api/sources/:id/preview a source, described the same way
apps/web/src/utils/fileViewer.ts      the gate + theme/locale mapping   (DOM-free, eager)
apps/web/src/utils/openFileViewer.ts  the lazy chunk + the vendor sheet (the only importer)
apps/web/src/components/FileViewer.vue        the lifecycle, and `data-render-state`
apps/web/src/components/dialogs/FilePreviewDialog.vue  the exhaustive switch on `kind`
apps/web/src/components/dialogs/SourcesDialog.vue      a row opens an upload here
e2e/file-preview-viewer.spec.ts       real PNGs and PDFs, from a workspace and from an upload
```

## Three sources of a file, one dialog

| | addressed by | guard |
| --- | --- | --- |
| the file tree | a workspace-relative path | `resolveReal` |
| a conversation's files | a path inside `sessions/<id>/` | `resolveReal` |
| an uploaded file | the source's **id** | `resolveInSources` |

All three end in the same `FilePreviewDialog`, which is why `readPreviewFile` exists as a separate
export: the sandbox differs per root — and must — but *what is this file* does not, and two copies
of the extension tables is how a `.mmd` gets drawn in one dialog and shown as code in another. A
`.md` uploaded to a conversation therefore renders exactly like a `.md` in a workspace, and a PDF
behaves like a PDF either way.

`SourcesDialog` is where an upload is reachable at all: a source lives outside every workspace, so
the file tree cannot list it, and until its rows gained an open control the list offered nothing but
a delete button. The row's main area is one `<button>` and delete is its sibling, rather than a
click handler on the `<li>` — a button inside a button is invalid. Both dialogs listen on `window`
for Escape, so `SourcesDialog` returns early while a preview is up, the same guard the sidebar
drawer makes; without it one press closes the file *and* the list underneath.

## Two routes, because they carry different things

`…/files/content` answers *what this is*, in JSON, and stops at `MAX_PREVIEW_BYTES` (256 KB). It
is what makes `Makefile` and `LICENSE` readable, because an unfamiliar extension is decided by a
NUL check and a UTF-8 decode rather than by a table.

`…/files/raw` answers *here are the bytes* and goes to `MAX_FILE_PREVIEW_BYTES` (32 MB). A PDF
cannot ride in the first at all, and a scanned document does not fit in the second. It is fetched
rather than linked because a bearer token cannot ride on a `<video src>`, and it hands back a
`File` rather than an object URL because the viewer takes a `File` — which carries the name, the
type and the bytes together and has nothing to revoke.

Three details of that route are load-bearing:

- **The response type is `application/octet-stream`, never the file's own.** This deliberately
  diverges from `/api/sources/:id/raw`, which serves the real `mimeType` and should keep doing so:
  that route serves the account's own uploads into an `<img>`, where an SVG is inert. These are
  bytes the *agent* may have written into a sandbox, and the viewer re-materialises some of them
  (a `.docx` becomes HTML), so making the type permanently unusable is cheap insurance. The client
  re-labels the blob from the file name — which is also how the viewer matches its plugins.
- **The bearer token is the actual boundary.** A browser attaches no `Authorization` header to an
  `<img src>`, an `<iframe>` or a navigation, so the URL is unreachable except through our own
  `fetch`. The headers above are the second line.
- **Past the cap is a 413**, not a 400. It is the one failure on this route the caller could have
  avoided by asking differently; `FILE_TOO_LARGE` already carried a `limitMb` param and a message
  in both catalogs, so nothing new was needed.

There is no `Range` support and none is wanted: the viewer receives a whole file, so seeking is
local and never re-requests. The limit is the cap, and a 40 MB video past it is refused with a
translated sentence rather than streamed.

## `binary`, and where the server stops

`classify` returns `markdown` / `diagram` / `text` / `binary`. The first three are *text*, which is
the question bytes are needed for, and they stay on the server — that is what keeps an
extensionless `Makefile` readable.

`binary` means only "not text; the bytes are yours to hand to a viewer". Whether anything can
**draw** them is answered by a plugin registry inside a browser chunk, so the server cannot know
it, and it no longer pretends to: the member it replaced (`unsupported`) was a claim about a table
the server could not see, and it would have gone on refusing a format the day the library gained
one.

`BINARY_EXTENSIONS` survives as a **read-avoidance list, not a correctness list**. Anything left
off it still reaches the same answer via the sniff, just after a read, so omitting an entry costs
I/O and never a wrong `kind`. (The docblock used to claim the list was checked *before* the read;
it was not — `readFileContent` read the head first and classified afterwards, so a `.png` cost a
quarter-megabyte of I/O to be refused on its name. The order now matches the claim.)

## The viewer is a lazy chunk, and it has to stay one

`@open-file-viewer/core` is a **single entry point with no `sideEffects` field**, so a bundler
cannot shake the plugins a build does not use. Measured on the real build:

| | |
|---|---|
| initial bundle | **+5.2 kB raw** (1,761,437 → 1,766,623), and *smaller* gzipped — none of it is the library |
| cost to open any viewer file | ~765 kB raw / ~255 kB gzip net new (library core 780 kB + dompurify 27 kB) |
| per format | lazy — `three` 722 kB, `xlsx` 494 kB, `pdf` 330 kB, `hls` 575 kB, `heic2any` 1.35 MB |
| vendor stylesheet | 110 kB, its own lazy chunk |

One cost is worth naming because it looks alarming in `dist/`: the library bundles its **own
mermaid@11** while the app ships mermaid@12. Different majors, so the bundler cannot dedupe them —
662 kB of duplicate mermaid plus a second `elk` layout engine at 1.4 MB, and ~40 `prism-*` chunks
despite `textPlugin` being omitted. All of it is *emitted* but only lazily referenced, and the
duplicated mermaid is reachable only through the library's own text/markdown path, which our
server never routes to. So it is build output and dead files rather than something anyone
downloads — but it is real, and it is the price of `sideEffects` being absent.

Three rules follow, and each is enforced rather than trusted:

- **Only `utils/openFileViewer.ts` imports the library**, and only through `import()`.
  `utils/fileViewer.ts` is the DOM-free half — the extension gate, the theme and locale mapping —
  and is safe to import eagerly, which matters because `FilePreviewDialog` is always mounted.
  `apps/web/test/utils/fileViewer.test.ts` fails if the library is evaluated at import.
- **The plugins are built once**, inside the memoized loader. The Vue adapter remounts whenever
  `plugins` changes *identity*, so a caller building the array in a render would destroy and
  re-create the viewer once per streamed token. (The adapter itself is not used — it statically
  imports the core, which would put the whole library in the initial bundle.)
- **The stylesheet comes in `?inline`** and is injected under `@layer ofv`, for `@layer hljs`'s
  reason in [design-system.md](design-system.md): Vite injects a lazily-imported sheet at a moment
  we do not control, and an unlayered vendor rule landing after `style.css` wins a specificity tie.
  Source order differs between dev and a build; a layer does not.

## The plugin set

Included: `office`, `pdf`, `epub`, `xps`, `ofd`, `image`, `video`, `audio`, `archive`, `email`,
`drawing`, `xmind`, `model3d`, `gis`, `asset`.

Three are deliberately absent, and each for a reason that would otherwise be re-litigated:

- **`textPlugin`** — unreachable. Every format it claims (`txt md json yaml csv js ts vue html css
  py go rs sql sh`) is classified `text` or `markdown` by the server and goes to the existing
  `<pre>`/markdown path. It also renders with prismjs, which would contradict the single-highlighter
  rule. The library bundles prismjs regardless; what this avoids is *routing* to it.
- **`cadPlugin`** — its optional peers are `@mlightcad/libredwg-web` (**GPL-3.0**) and two
  `@mlightcad/*` viewers, plus ~6 MB of WASM. Not installing them is the decision. The plugin
  degrades to a thumbnail path without them; adding them back "to finish the set" would import a
  licence obligation into this repo.
- **`fallbackPlugin()`** — must never be passed. It is terminal by definition, so it matches
  everything: `isPreviewSupported` would answer *yes* for every file and a `.bin` would render an
  empty box instead of the unsupported panel, breaking both the behaviour and the browser suite.

Two gates guard the chunk, in this order, and the order is the point:

1. **`fileViewerSupported(name)`** — ours, from the extension, synchronous. A `.bin` fails here, so
   it costs **no request and no chunk**. `e2e/file-preview-viewer.spec.ts` counts `/files/raw`
   calls to pin that.
2. **`isPreviewSupported(...)`** — the library's, async, and the authority once the chunk is in
   hand. It is a *second opinion*, not a copy of the library's format list, which is what keeps a
   stale entry in ours from rendering wrongly. A file that passes our gate and fails this one gets
   the same unsupported panel.

Our list may be a superset: an under-claim is the failure (a format the library gained that we did
not list is one a user cannot open), while a false yes costs one chunk and gets an honest answer.

## Styling and language

The vendor sheet exposes 33 custom properties and keys off **neither** `data-theme` nor
`prefers-color-scheme` — so it is themed entirely by mapping ~12 `--ofv-*` variables onto our
tokens in `style.css`. Because `--ofv-bg: var(--panel)` resolves at computed-value time, the
chrome follows a light/dark flip through CSS with no re-create; the viewer is only re-created for
the plugins that paint into a canvas, and for a change of `theme` or `locale`.

The overrides live in `apps/web/src/style.css` rather than a file of their own, because
`style.test.ts` globs `../src/*.css` **shallowly** — overrides in a subdirectory would be invisible
to every design-system guard, and `style.css` is the one place they are held to our rules.

The toolbar's words come from the library's own catalog: pass `locale` (`zh-CN` | `en-US`), mapped
from ours. That is why there is no `files.viewer.*` namespace — a second translation of strings we
do not own would be a copy to keep in step with nothing.

## `data-render-state`, and what it does not mean

The component exposes `rendering` / `ready` / `failed` / `unsupported`, the same vocabulary as
`MermaidDiagram`, because an async third-party render is otherwise unassertable — an element that
never arrived, arrived empty and was refused all look identical to a `toBeVisible()` timeout.

**But `ready` means less here than it does for mermaid.** `onLoad` fires when the viewer has taken
the file, not when a plugin drew it: a PNG whose bytes do not decode still reaches `ready`, because
the image plugin handles that itself by replacing its stage with its own failure panel, and there is
no callback for it. A spec must assert on the *content* — a `naturalWidth`, a canvas with pixels —
and treat `ready` as the thing to wait for first. The first version of the image spec passed on
`ready` while the picture on screen was an error panel; that is how this was found.

## Testing

- `apps/server/test/files.test.ts` — `readRawFile`: whole bytes past the text cap, the limit
  inclusive at exactly `MAX_FILE_PREVIEW_BYTES`, `FILE_TOO_LARGE` past it, a directory, a missing
  file, an escaping path and an escaping *symlink*. The last two are re-proved here rather than
  inherited from the read above, because this is the route that hands out whole files.
- `apps/server/test/routes.test.ts` — the route's three headers, the 413, and the 400 for `..`;
  then a source's preview for both a binary and a text upload. Note the fixtures there are
  deliberately unique bodies: sources dedupe by content, so shared bytes come back under whichever
  name was uploaded first.
- `apps/web/test/api/client.test.ts` — that the raw fetch carries `/api` (below), and that a
  source is addressed by id and comes back as the same `File` a workspace file does.
- `apps/web/test/utils/fileViewer.test.ts` — the gate per family, and the assertion that the
  library is **not evaluated** by importing the eager module.
- `apps/web/test/api/client.test.ts` — that the raw fetch carries `/api`. Every path in the `api`
  object is `/api`-relative because `request()` adds the prefix, and this one is a bare `fetch`
  that must carry its own. Getting it wrong is not a 404: the dev server answers an unknown path
  with `index.html` at **200**, so the viewer is handed a few kilobytes of HTML to draw as a PNG
  and the only symptom is a picture that will not decode.
- `e2e/file-preview-viewer.spec.ts` — a real 1×1 PNG and a `buildPdf()` PDF seeded with `node:fs`,
  and the same two uploaded as sources, each asserted on `data-render-state` and then on *measured
  pixels*. The upload case also pins the Escape guard: one press closes the preview and leaves the
  list standing.

## What this does not do

- **Formats the server calls `text` never reach the viewer.** `svg`, `geojson`, `kml`, `gpx` and
  `csv` are valid UTF-8, so they are shown as highlighted source — an SVG as XML, a GeoJSON as JSON.
  This is defensible (the text view is good, and the sniff is what makes `Makefile` work) but it is
  the visible limit on "preview everything". The next step is to reuse the segmented control the
  dialog already has: for a `text` file the viewer supports, `hasTwoViews` becomes true with
  `rendered` = the viewer and `source` = the `<pre>`. It is not in this cut because it makes the
  view state depend on the viewer gate and doubles the states the browser suite must cover.
- **Files past 32 MB** are refused rather than streamed.
- **No preview in the message list** — this is the file browser, the source browser and the
  diagram widget.
