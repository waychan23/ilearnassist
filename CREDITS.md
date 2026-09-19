# Third-party credits

ilearnassist is MIT-licensed (see [LICENSE](LICENSE)). It is built on the open-source work
listed below. Thank you to everyone who maintains it.

This file is in English on purpose: package names and the licence terms themselves are
English, and a translation of a licence term is not the licence.

Versions are the ones resolved by `pnpm-lock.yaml` at the time of writing. Licence strings are
read from each package's own `package.json` rather than transcribed by hand — see
[Keeping this file honest](#keeping-this-file-honest).

## Direct dependencies

### `apps/server` — the backend

| Package | Licence | What it does |
| --- | --- | --- |
| [@fastify/cors](https://github.com/fastify/fastify-cors) | MIT | CORS for the API |
| [@fastify/static](https://github.com/fastify/fastify-static) | MIT | serves the built frontend |
| [@langchain/core](https://github.com/langchain-ai/langchainjs) | MIT | model interface, messages, tool binding |
| [@langchain/langgraph](https://github.com/langchain-ai/langgraphjs) | MIT | the interruption primitive behind `ask_user` and friends |
| [@langchain/openai](https://github.com/langchain-ai/langchainjs) | MIT | `ChatOpenAI`, the one wire protocol every provider speaks |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | the database |
| [cheerio](https://github.com/cheeriojs/cheerio) | MIT | turns a fetched page into text |
| [fastify](https://github.com/fastify/fastify) | MIT | the HTTP server |
| [fflate](https://github.com/101arrowz/fflate) | MIT | unzips OOXML/ODF uploads for local parsing |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF text extraction (pinned to 4.x) |
| [yaml](https://github.com/eemeli/yaml) | ISC | reads `config.yaml` |
| [zod](https://github.com/colinhacks/zod) | MIT | tool parameter schemas |

### `apps/web` — the frontend

| Package | Licence | What it does |
| --- | --- | --- |
| [@open-file-viewer/core](https://github.com/open-file-viewer/core) | MIT | the file preview viewer (lazy chunk) |
| [@vscode/markdown-it-katex](https://github.com/microsoft/vscode-markdown-it-katex) | MIT | `$…$` and `$$…$$` maths |
| [chart.js](https://github.com/chartjs/Chart.js) | MIT | the statistics charts (lazy chunk) |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause | the one code highlighter |
| [katex](https://github.com/KaTeX/KaTeX) | MIT | maths rendering |
| [markdown-it](https://github.com/markdown-it/markdown-it) | MIT | the one markdown renderer |
| [mermaid](https://github.com/mermaid-js/mermaid) | MIT | diagrams (lazy chunk) |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF preview in the browser |
| [pinia](https://github.com/vuejs/pinia) | MIT | state |
| [vue](https://github.com/vuejs/core) | MIT | the UI framework |
| [vue-i18n](https://github.com/intlify/vue-i18n) | MIT | the two language catalogs |
| [vue-router](https://github.com/vuejs/router) | MIT | pages are URLs |

### `apps/desktop` — the control panel

| Package | Licence | What it does |
| --- | --- | --- |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | N-API prebuilds, resolved by the server child process |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache-2.0 | same, for the bundled server |
| [electron](https://github.com/electron/electron) | MIT | the desktop shell |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT | packaging |
| [esbuild](https://github.com/evanw/esbuild) | MIT | bundles the server, main, preload and renderer |
| [jsqr](https://github.com/cozmo/jsQR) | Apache-2.0 | reads the LAN QR code |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | MIT | draws the LAN QR code |

### Repository tooling

| Package | Licence |
| --- | --- |
| [@playwright/test](https://github.com/microsoft/playwright) | Apache-2.0 |
| [vitest](https://github.com/vitest-dev/vitest) | MIT |
| [@vitest/coverage-v8](https://github.com/vitest-dev/vitest) | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | Apache-2.0 |

`packages/shared` has no dependencies at all — that is deliberate, and it is why the types can
be imported from either side of the API boundary.

## Notable transitive dependencies

These are not declared by this repo, but they ship inside it — mostly inside the file-preview
chunk, which is why that chunk is lazily fetched.

| Package | Licence | Where it comes from |
| --- | --- | --- |
| [three](https://github.com/mrdoob/three.js) | MIT | 3D previews, via `@open-file-viewer/core` |
| [leaflet](https://github.com/Leaflet/Leaflet) | BSD-2-Clause | GeoJSON/map previews |
| [mermaid](https://github.com/mermaid-js/mermaid) | MIT | a second copy, 11.x, via `@open-file-viewer/core` |
| [elkjs](https://github.com/kieler/elkjs) | EPL-2.0 | mermaid's layout engine |
| [@stackline/xlsx](https://github.com/stackline/xlsx) | Apache-2.0 | spreadsheet previews (a SheetJS community-edition fork) |
| [@aiden0z/pptx-renderer](https://github.com/aiden0z/pptx-renderer) | Apache-2.0 | PowerPoint previews |
| [dompurify](https://github.com/cure53/DOMPurify) | (MPL-2.0 OR Apache-2.0) | sanitises re-materialised HTML; this project relies on the Apache-2.0 arm |
| [docx-preview](https://github.com/VolodymyrBaydalka/docx-preview) | (MIT OR GPL-3.0-or-later) | Word previews; MIT arm |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | (MIT OR GPL-3.0-or-later) | Word → HTML; MIT arm |
| [jszip](https://github.com/Stuk/jszip) | (MIT OR GPL-3.0-or-later) | reads zipped office formats; MIT arm |
| [lru-cache](https://github.com/isaacs/node-lru-cache) | BlueOak-1.0.0 | build tooling |
| [tslib](https://github.com/Microsoft/tslib) | 0BSD | TypeScript helpers |

## Deliberately **not** installed

**[@mlightcad/libredwg-web](https://github.com/mlightcad/libredwg-web) is GPL-3.0**, along with
its siblings `@mlightcad/cad-simple-viewer` and `@mlightcad/data-model`. They are *optional*
peer dependencies of `@open-file-viewer/core` — CAD previews — and this project does not
install them. That is a licence decision, not an oversight: pulling them in would put a
copyleft obligation on the whole application, which is why DWG/DXF/STL previews are absent.
See [`docs/file-preview.md`](docs/file-preview.md).

## Licence summary

Of the 642 packages resolved by the lockfile:

| Licence | Count |
| --- | --- |
| MIT | 482 |
| ISC | 64 |
| Apache-2.0 | 30 |
| BSD-2-Clause | 21 |
| BSD-3-Clause | 20 |
| BlueOak-1.0.0 | 6 |
| MPL-2.0 | 3 |
| MIT-0 | 3 |
| everything else (0BSD, CC0-1.0, EPL-2.0, Unlicense, WTFPL, and dual-licence combinations) | 13 |

**There is no GPL, AGPL, LGPL or SSPL package installed.** The only licence strings that
mention GPL at all are the dual `(MIT OR GPL-3.0-or-later)` ones listed above; in each case
this project takes the MIT arm. `EPL-2.0` (elkjs) and `MPL-2.0` (dompurify, lightningcss,
mtx-decompressor) are weak, file-level copyleft and impose no obligation on the rest of the
application as used here.

## Keeping this file honest

The tables above were generated from the installed tree rather than written from memory — every
`version` and `licence` string is read out of the corresponding `node_modules/**/package.json`.
If you add a dependency, re-read its licence and add a row here; if you remove one, delete the
row. A stale credits file is worse than none, because it makes a claim nobody checked.

Two licence-sensitive places to look at before changing dependencies:

- **`@open-file-viewer/core`'s optional peers.** Installing one of the `@mlightcad/*` packages
  makes this project no longer MIT-only. See `docs/file-preview.md`.
- **Mermaid is installed twice** (12.x directly, 11.x through `@open-file-viewer/core`). Both
  are MIT, but the duplication is the reason the preview chunk is as large as it is.
