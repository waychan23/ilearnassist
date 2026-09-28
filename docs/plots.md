# Plots

The model draws a math figure — a function, a coordinate-geometry shape, a set of points, a
vector — by passing a **JSON spec**, and the app renders it. The figure appears inline in the
conversation and is listed in the 图表 panel beside the diagrams and tables.

This is the working reference, and it is the answer to the question `docs/diagrams.md` used to
close with ("Why there is no coordinate plotting"). The decision then was "not yet"; this is the
decision now, and the shape it took: a ready-made renderer behind a spec we validate.

## The one thing that shapes everything: the model writes data, never code

There is no code execution anywhere in this feature. The model says *what* the figure is; the
**app** decides how to draw it, with a renderer that runs in the browser and reaches nothing.
That is a product requirement as much as a security one — the deployment has no sandbox that
could run a plotting library, and a spec is inspectable, revisable and storable in a way a
script is not.

Three consequences, and each is load-bearing:

- **The spec is a closed vocabulary.** `PLOT_ELEMENT_KINDS` is nine kinds and no way to extend
  one from a call: `function`, `implicit`, `parametric`, `points`, `segment`, `polygon`,
  `vector`, `circle`, `text`. A spec that names anything else is refused before a row is written.
- **An expression is formula data, not a program.** It may name the element's own variable
  (`x`, `x`/`y`, `t`), the constants `pi`/`e`, and a whitelisted function list — and nothing
  else. `isPlotExpression` in `packages/shared` is the rule, enforced **twice**: the tool refuses
  an expression before the write, and the client refuses it before the library sees it. The
  second enforcer is not redundant — a row may have been written by another build — and the two
  are one function so they cannot drift.
- **The renderer is swappable without touching the contract.** The library's options never appear
  in the spec, the row or the tool schema; `utils/plotSpec.ts` is the single translation point.

## The library, and why this one

**`function-plot@1.25.4`** — MIT, TypeScript types, d3-based SVG, ~60 KB gzipped, imported as a
lazy chunk exactly like mermaid. It draws:

| spec kind | how it is drawn | who provides it |
| --- | --- | --- |
| `function` | `fnType: "linear"`, `graphType: "polyline"`; `fill` closes the area to y = 0 | library |
| `implicit` | `fnType: "implicit"`, `graphType: "interval"` — the interval sampler | library |
| `parametric` | `fnType: "parametric"` with `x`/`y` expressions in `t` | library |
| `points` | `fnType: "points"`, scatter or connected polyline | library |
| `segment` | a two-point polyline | library |
| `polygon` | an overlay `<path>` built from the chart's own scales | **our adapter** |
| `vector` | `fnType: "vector"` with an arrow marker | library |
| `circle` | constructed as the implicit equation `(x-a)² + (y-b)² − r²` | **our adapter** |
| `text` | `graphType: "text"` | library |

Two constructs are ours because the library has no equivalent: a circle (the model gives a centre
and a radius, and the equation is built from those numbers, never written by the model) and a
polygon (the library's `closed` fills *down to the x-axis*, which is right for "the area under a
curve" and wrong for a triangle — so the adapter hands the points to `renderPlot`, which maps
them through `chart.meta.xScale/yScale` into a `<path>` in the same clipped group).

Alternatives assessed and rejected: **Plotly** is JSON-native and exports SVG, but it is ~1 MB
gzipped with its own renderer, modebar and layout model; **JSXGraph** has the richest geometry
but an imperative `board.create()` API (a bespoke bridge for every kind), an LGPL-3.0 licence this
repository deliberately avoids, and no first-class SVG export; **ECharts** is canvas-first and
awkward for geometry at data coordinates; **Chart.js** is already a dependency but is a canvas —
no SVG export, so the viewer's download menu and the zoom's honest scaling would both have to
change, and a chart grammar is not a coordinate plane.

## The spec

```jsonc
{
  "title": "抛物线",                          // optional heading
  "x": { "domain": [-5, 5], "label": "x" },   // domain/label/log; omitted = renderer default
  "y": { "domain": [-2, 10], "label": "y" },
  "grid": true,
  "elements": [
    { "kind": "function",   "expr": "x^2 - 2*x", "from": -4, "to": 4, "fill": false, "dashed": false },
    { "kind": "implicit",   "expr": "x^2 + y^2 - 9" },
    { "kind": "parametric", "x": "3*cos(t)", "y": "3*sin(t)", "from": 0, "to": 6.2832 },
    { "kind": "circle",     "center": [1, -2], "radius": 3 },
    { "kind": "points",     "points": [[1, 1], [-1, 2]], "connect": false },
    { "kind": "segment",    "from": [0, 0], "to": [3, 2] },
    { "kind": "polygon",    "points": [[0, 0], [4, 0], [3, 3]], "fill": true },
    { "kind": "vector",     "from": [0, 0], "to": [2, 1] },
    { "kind": "text",       "at": [1.5, 2], "text": "顶点" }
  ]
}
```

`color` on any element is a token name (`accent`, `success`, `warning`, `danger`, `muted`),
mapped to the live palette at render time — never a hex, because a hex chosen for the light page
is illegible on the dark one. Omitting it cycles the palette in element order. Labels are plain
SVG `<text>` with any Unicode (`x²`, `π`, `θ`): there is deliberately no LaTeX, because KaTeX
produces HTML, and HTML in an SVG means `foreignObject` — which breaks the self-contained export
that the whole surface (viewer zoom, SVG/PNG/JPG download) rests on.

The axes are **sticky** — drawn through the origin — which is what makes a coordinate-plane
figure a figure rather than a cornered chart.

## The shape

```
packages/shared/src/index.ts     PLOT_TOOL_NAME, Plot, PlotSpec + the nine element kinds,
                                 PLOT_COLORS, PLOT_EXPRESSION_FUNCTIONS/CONSTANTS,
                                 isPlotExpression, QUERY_KINDS += "plot", TURN_REFERENCE_KINDS,
                                 NOTE_TARGET_KINDS, WIDGETS.diagram.tools.names
apps/server/src/schema.ts        session_plots                 the rows
apps/server/src/db.ts            upsert/list/briefs/ForUser/assignPlotToThread
apps/server/src/plots.ts         plotName, validatePlotSpec, registerPlot, listPlotViews
apps/server/src/tools/plot.ts    buildPlotTool, plotGuidance     writes the row
apps/server/src/tools/index.ts   NON_FILE_TOOLS += ila_plot
apps/server/src/routes.ts        /api/sessions/:id/plots         the panel's read
apps/server/src/tools/query.ts   ila_query(kind: "plot")         the model's read of its own work
apps/server/src/threads.ts       places each plot in a thread
apps/web/src/utils/plotSpec.ts   spec → function-plot options, palette, serialisation (pure)
apps/web/src/utils/plot.ts       the lazy chunk, the polygon overlay, the cache release
apps/web/src/components/         PlotFigure / PlotCard
apps/web/src/widgets/            DiagramWidget                   the panel: three kinds
apps/web/src/components/dialogs/DiagramDialog.vue                the viewer, three kinds
```

## The tool

`ila_plot`, with `{ name, summary, spec }`. Like `ila_diagram` and `ila_table` it is
**`auto-install`**: ordinary, allow-listable, pickable in a Copilot, and plotting one installs
the 图表 panel. It *is* in `NON_FILE_TOOLS` — a plot writes a database row and touches no
sandbox, so an operator's `fileTools.enabled: false` must not remove it.

The refusals are the validator's, and they come in a deliberate order:

1. **Size.** The serialised spec over `MAX_PLOT_SPEC_CHARS` (32 KB) is refused first, because it
   is a statement about the call as a whole.
2. **Shape.** `validatePlotSpec` **rebuilds** the spec field by field: an unknown top-level or
   per-element field is refused with a sentence rather than silently dropped by a schema (the
   `ila_query` `checkFields` argument, one level down); every number must be finite; a domain
   must run low to high; a circle's radius must be positive; a polygon needs three points; the
   figure is capped at 24 elements and 1000 explicit points.
3. **Expressions.** Each expression is checked against its own element's variables — `y` in a
   function of `x` is refused, `alert(x)` is refused, an over-long one is refused.

All of them throw before `ctx.save`, which is the half that matters most: the upsert revises by
name, so a refused call that had already reached the save would replace the figure the panel
holds with nothing.

## The row

`session_plots`, and the table's shape applied to a third kind: `id`, `session_id`, `thread_id`,
`name`, `summary`, **`spec`**, `tool_call_id`, timestamps. What it is *not* is a file — no
`file_id`, no `.plot.json` in `sessions/<id>/` — because the spec is data and a second copy on
disk would be the one drift the diagram split exists to prevent. It gets no `work_resources`
reference either, for the table's reason: a plot is not material to browse, and the panel lists
it from its own row.

The row holds the **canonical JSON** `validatePlotSpec` produced, not the model's bytes: a read
that cannot parse it must surface as a rendering failure rather than a 500, and the renderer is
the authority on what it can draw — the division `ila_diagram` documents for mermaid, one kind
over. `name` is `slugify`, no extension, and the same name revises: the upsert keys on
`(session_id, name)` and clears `thread_id` so the new shape is judged again.

Two reads exist because the two consumers need different widths: `listPlotsForUser` (the route
and the panel) carries the spec, and `listPlotBriefsBySession` (the thread classifier) blanks it —
the classifier is shown a name and a one-line summary, and a 32 KB spec read once per turn is the
cost that split avoids.

## The renderer

`utils/plotSpec.ts` is the whole drawing language as a pure function: spec in, `function-plot`
options out, no DOM and no chart. That seam is what makes the mapping unit-testable, and it is
where the expression whitelist is enforced a second time. `utils/plot.ts` is the browser half:
a memoized dynamic import (one chunk for N figures, mermaid's pattern), a detached host element,
the polygon overlay drawn from the chart's own scales, and the release.

Three details have reasons rather than habits:

- **The string is self-contained.** After the library draws, `serializePlotFigure` clones the SVG
  and makes it stand alone: a `viewBox` so it scales, a concrete `color` on the root for the
  library's `currentColor` axes, and an explicit `fill` on every text node the library left
  unfilled (which would otherwise be black on a dark page). It also strips `script`,
  `foreignObject` and `on*` attributes — every label in it is model-authored, and the string is
  handed to `v-html`.
- **The palette is read at render time and is concrete.** `plotColors(read)` takes a reader
  rather than reaching for `getComputedStyle` — the `diagramThemeVariables` seam — and returns
  hex values, because the same string is written to a downloaded file where `var()` means
  nothing. A theme flip re-renders, the mermaid rule.
- **The chunk's interop is normalised.** The package is CommonJS with `__esModule`, and under
  Vite's dependency pre-bundling its default export arrives either direct or one level nested.
  `pickFunctionPlot` accepts both — the browser suite found this the first time, as
  "functionPlot is not a function" in the failure panel.

`1.25.4` has no `destroy()`, and its `Chart.cache` keeps every instance ever made. `renderPlot`
removes its listeners and deletes its cache entry in a `finally`, so a conversation full of
figures does not retain one detached SVG per render.

Failure is shown, never swallowed and never blank: `PlotFigure` has the `data-render-state`
lifecycle (so an async-looking render is assertable), keeps the spec under the complaint, and
prints the renderer's own sentence. That is mermaid's rule, and it is the same reason —
a malformed figure is an ordinary outcome for model-authored data, and "nothing was drawn" must
not look like "there was nothing to draw".

## The viewer, the card and the panel

- **`PlotCard`** is `DiagramCard`'s twin: the drawing is the result, so the call renders as a
  picture with a bounded window, an expand control, 追问, 标注, and a JSON-source disclosure. It
  is *not* in `INTERACTIVE_TOOL_NAMES` (that list means "suspends the turn") and it must not be:
  it has its own dispatch in `ToolCallCard`, beside the diagram's, and
  `isGroupableToolCall` refuses it so a run of calls cannot fold a drawing into a count.
- **`DiagramDialog` gained a third content kind.** `FigureContent` is
  `{ kind: "diagram"; source } | { kind: "table"; markdown } | { kind: "plot"; spec }`, and the
  zoom, fit, maximise and download machinery is shared because `PlotFigure` exposes the same
  `{ svg, size }` pair `MermaidDiagram` does. Download writes the serialised SVG in the three
  formats the diagram menu already offers; no second export path exists.
- **The panel shows three kinds**, merged and sorted in `utils/figures.ts` (unit-tested), with a
  filter whose options are derived from the rows. A diagram opens the file preview; a table and a
  plot open the viewer directly, because neither has a file.
- **追问 and notes work unchanged.** `kind: "plot"` joined `TURN_REFERENCE_KINDS` and
  `NOTE_TARGET_KINDS`; the server canonicalises the name with `plotName` in
  `turnReferences.ts`/`notes.ts`, `ila_query(kind: "plot")` is the model's read, and
  `figureViewer.ts` gained the arm that fetches the row and opens the viewer.

## The turn classifier and the insight pass

A plot rides the classifier exactly as a diagram and a table do: a `<plot ref="p1">` block under
the message whose call drew it, its own `"plots"` array in the answer, its own ref prefix and
`MAX_PLOTS_PER_PROMPT` cap, and the same collapse rule — an unanswered plot lands in its turn's
thread, and a forced plan turn's plot is never sent to the model at all because the ref
allocation is one loop over the same `modelTurns`. Three separate loops would have broken that
for plots while leaving the other two intact, which is why `threads.test.ts` writes the forced
case out for each kind.

The insight pass gathers a `<plots>` section with names and summaries only — a spec is
structural JSON, and what a figure is *about* is its summary — and the log line counts them
beside 图 and 表.

## Adding an element kind

The extension point is `PLOT_ELEMENT_KINDS` plus three edits: a `switch` branch in
`validatePlotSpec` (with its `ELEMENT_FIELDS` row), a case in `toFunctionPlot`'s `elementDatum`,
and — if the library cannot draw it — a construct in the adapter or the overlay. A new kind with
no branch is a `tsc` error at both switches, because both are exhaustive over the closed union.
Nothing else in the feature branches per kind.

## Watching it work

```
pnpm dev:restart
```

Ask for a figure ("画一个 y=x² 和圆 x²+y²=9 的位置关系"), and check: the card draws it inline,
the head names it, 放大 opens the viewer, zoom works, the download menu writes SVG/PNG/JPG, and
the 图表 panel lists it — with the filter offering 全部 / 图 / 表 / 坐标图 once more than one kind
is there. Ask for a revision by the same name ("把顶点标出来") and confirm the panel still shows
one figure. Ask for something the language cannot express ("用代码画") and confirm the reply
stands with the tool's own refusal in place of the drawing.
