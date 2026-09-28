import type functionPlotType from "function-plot";
import { plotColors, serializePlotFigure, toFunctionPlot, type PlotChart } from "./plotSpec";
import type { PlotSpec } from "../api/types";

/**
 * `function-plot`, loaded on demand, drawn into a self-contained SVG.
 *
 * The same shape as `utils/mermaid.ts` and `utils/charts.ts`, for the same reason: the library
 * is a lazy chunk (~60 KB gzipped, imported only when a figure is actually on screen) behind a
 * memoized *promise*, so N figures share one fetch and a failed chunk can be retried.
 *
 * Unlike mermaid, nothing here is asynchronous per render: function-plot draws synchronously
 * into a detached element, which is then serialised and thrown away. That is what makes a plot
 * exportable by construction — the string the card renders is the string the viewer scales and
 * the file is written from.
 */

/** What the lazy chunk gives us: the renderer, and the class whose cache it must be freed from. */
interface FunctionPlotKit {
  functionPlot: typeof functionPlotType;
  chart?: { cache?: Record<string, unknown> };
}

let loading: Promise<FunctionPlotKit> | null = null;

/**
 * The default export, whichever shape the CJS interop hands it in.
 *
 * `function-plot` is CommonJS with `__esModule: true` and `exports.default = functionPlot`, and
 * a dynamic import of it under Vite's dependency pre-bundling can arrive as either
 * `{ default: fn, Chart, … }` or `{ default: { default: fn, Chart, … } }` — the second is what
 * the browser suite caught, as "functionPlot is not a function" in the failure panel. Both
 * shapes mean the same thing, so the loader normalises rather than any caller guessing.
 */
function pickFunctionPlot(module: unknown): typeof functionPlotType {
  const namespace = module as { default?: unknown } | undefined;
  const direct = namespace?.default;
  if (typeof direct === "function") return direct as typeof functionPlotType;
  const nested = (direct as { default?: unknown } | undefined)?.default;
  if (typeof nested === "function") return nested as typeof functionPlotType;
  throw new Error("The figure renderer did not load.");
}

/** The `Chart` class, wherever the interop put it — its static cache is what we release. */
function pickChart(module: unknown): { cache?: Record<string, unknown> } | undefined {
  const namespace = module as { Chart?: unknown; default?: unknown } | undefined;
  const nested = (namespace?.default as { Chart?: unknown } | undefined)?.Chart;
  const candidate = namespace?.Chart ?? nested;
  return typeof candidate === "function"
    ? (candidate as { cache?: Record<string, unknown> })
    : undefined;
}

function loadFunctionPlot(): Promise<FunctionPlotKit> {
  loading ??= import("function-plot")
    .then((module) => ({
      functionPlot: pickFunctionPlot(module),
      chart: pickChart(module),
    }))
    .catch((err: unknown) => {
      // Cleared so a transient chunk failure can be retried by the next figure rather than
      // poisoning every one after it with a rejected promise nobody can re-run.
      loading = null;
      throw err;
    });
  return loading;
}

type Chart = ReturnType<typeof functionPlotType>;

/**
 * A polygon, drawn by hand because the library cannot close a shape.
 *
 * Its `closed` option fills an area down to y = 0 (d3's area generator), which is right for
 * "the area under a curve" and wrong for a triangle. The scales the chart already built are all
 * a polygon needs, so it is one `<path>` appended to the same clipped content group the
 * library's own datums live in — clipped, scrollable and exported like everything else.
 *
 * The group is looked up **in the rendered SVG**, not through `chart.content`: in 1.25 that
 * property is the *update* selection, which is empty on the first render because the enter
 * selection is what got the node — so `chart.content.node()` is null and the overlay silently
 * disappeared. The host is ours, so the DOM is the authority.
 */
function drawPolygons(chart: Chart, root: ParentNode, chartSpec: PlotChart): void {
  const xScale = chart.meta?.xScale;
  const yScale = chart.meta?.yScale;
  const content = root.querySelector("g.content");
  if (!xScale || !yScale || !content || chartSpec.polygons.length === 0) return;

  for (const polygon of chartSpec.polygons) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const [first, ...rest] = polygon.points;
    if (!first) continue;
    const moves = rest.map(([x, y]) => `L ${xScale(x)} ${yScale(y)}`).join(" ");
    path.setAttribute(
      "d",
      `M ${xScale(first[0])} ${yScale(first[1])} ${moves} Z`
    );
    path.setAttribute("fill", polygon.fill ? polygon.color : "none");
    path.setAttribute("fill-opacity", "0.18");
    path.setAttribute("stroke", polygon.color);
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-linejoin", "round");
    content.appendChild(path);
  }
}

/** The palette reader, against the document's own stylesheet — the mermaid seam. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

export interface RenderedPlot {
  svg: string;
  size: { width: number; height: number };
}

/**
 * Draw a figure, as a self-contained SVG string and the size it wants to be.
 *
 * Rejects when the spec is not drawable — a malformed row, an expression outside the language,
 * a domain the library refuses. The caller shows that as a *rendering* outcome beside the spec,
 * never a blank bubble: the same rule `MermaidDiagram` follows, and for the same reason (the
 * spec is model-authored, and "nothing was drawn" must not be indistinguishable from "there was
 * nothing to draw").
 */
export async function renderPlot(spec: PlotSpec): Promise<RenderedPlot> {
  const { functionPlot, chart: chartClass } = await loadFunctionPlot();
  const colors = plotColors(readToken);
  const chartSpec = toFunctionPlot(spec, colors);

  const host = document.createElement("div");
  const chart = functionPlot({ ...chartSpec.options, target: host });
  try {
    drawPolygons(chart, host, chartSpec);
    const svg = host.querySelector("svg");
    if (!svg) throw new Error("The renderer produced no figure.");
    return { svg: serializePlotFigure(svg, colors), size: chartSpec.size };
  } finally {
    /*
     * The 1.25 build has no `destroy()`, and its `Chart.cache` holds every instance ever made —
     * keyed by the id the constructor writes onto the options. Dropping the entry and the
     * listeners is what keeps a conversation full of figures from retaining one detached SVG
     * per render; the host itself is ours and goes out of scope here.
     */
    chart.removeAllListeners();
    const id = chart.options.id;
    if (chartClass?.cache && typeof id === "string") delete chartClass.cache[id];
  }
}
