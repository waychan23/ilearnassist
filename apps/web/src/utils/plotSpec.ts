import type { FunctionPlotDatum, FunctionPlotOptions } from "function-plot";
import {
  PLOT_COLORS,
  isPlotExpression,
  type PlotColor,
  type PlotElement,
  type PlotPoint,
  type PlotSpec,
} from "../api/types";

/**
 * The model's plot spec → the renderer's options, as data.
 *
 * This is the one module that knows the drawing library, and it is deliberately **pure**: the
 * spec in, an options object out, no DOM and no chart. That seam is what makes the arithmetic
 * unit-testable (the `diagramThemeVariables` argument one renderer over), and it is also where
 * the drawing language is enforced a second time — every expression is re-checked against the
 * shared whitelist before it reaches the evaluator, so an expression that slipped past the
 * server (or a row written by another build) still cannot name anything the language lacks.
 *
 * Two constructs the library does not have are filled in here rather than by the model: a
 * `circle` becomes the implicit equation `(x-a)² + (y-b)² − r² = 0`, and a `polygon` is handed
 * back as a custom path (`PlotChart.polygons`) because the library's own `closed` fills to the
 * x-axis rather than closing the shape.
 */

/** The figure's own size in CSS pixels. Fixed, and scaled down by CSS in the message card. */
export const PLOT_FIGURE_WIDTH = 760;
export const PLOT_FIGURE_HEIGHT = 420;

/** The concrete colours a figure is drawn with, read from the palette at render time. */
export interface PlotColors {
  /** The series palette, by the spec's colour name. */
  series: Record<PlotColor, string>;
  /** The axes, ticks and grid — a quieter tone than the series. */
  axes: string;
  /** Titles and labels. */
  text: string;
}

/** Which design token each colour name reads. The one place the vocabulary meets the palette. */
const COLOR_TOKENS: Record<PlotColor, string> = {
  accent: "--accent",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  muted: "--text-2",
};

/**
 * Read the palette into concrete colours.
 *
 * A *reader* rather than a reach for `getComputedStyle`, for `diagramThemeVariables`' reason:
 * jsdom does not apply `style.css`, so a real read returns `""` in a unit test and the mapping
 * would only ever be exercised in a browser. The values are concrete because a canvas-free SVG
 * still cannot resolve `var()` after it is serialised for download.
 */
export function plotColors(read: (token: string) => string): PlotColors {
  const value = (token: string, fallback: string): string => read(token).trim() || fallback;
  const series = {} as Record<PlotColor, string>;
  for (const name of PLOT_COLORS) {
    series[name] = value(COLOR_TOKENS[name], "#4c8bf5");
  }
  return { series, axes: value("--text-3", "#6e7781"), text: value("--text", "#1f2328") };
}

/** One filled or outlined polygon, drawn after the chart exists because it needs the scales. */
export interface PlotPolygon {
  points: PlotPoint[];
  color: string;
  fill: boolean;
}

/** What the renderer consumes: the library's options, our overlay paths, and the size. */
export interface PlotChart {
  options: FunctionPlotOptions;
  polygons: PlotPolygon[];
  size: { width: number; height: number };
}

/** The datum fields this module builds; the library's type, narrowed for our tests. */
export type PlotDatum = FunctionPlotDatum;

/** Wrap a coordinate in `(x - n)` / `(x + n)` so a negative number stays valid arithmetic. */
function shift(variable: string, n: number): string {
  return n >= 0 ? `(${variable} - ${n})` : `(${variable} + ${-n})`;
}

/** A circle's implicit equation, from its own numbers — never a model-written expression. */
function circleExpression([cx, cy]: PlotPoint, radius: number): string {
  return `${shift("x", cx)}^2 + ${shift("y", cy)}^2 - ${radius * radius}`;
}

/**
 * The dashed attribute the library's per-datum `attr` accepts. `6 4` reads as a dash on both
 * line widths the figures use.
 */
const DASHED = { "stroke-dasharray": "6 4" } as const;

/**
 * One element → its datum, or null for a polygon (which is drawn as an overlay path).
 *
 * Throws when an expression is not inside the language: the server refuses one before writing,
 * but a row may have been written by a build with a wider vocabulary, and the renderer is the
 * last line rather than the first.
 */
function elementDatum(element: PlotElement, color: string): FunctionPlotDatum | null {
  switch (element.kind) {
    case "function": {
      if (!isPlotExpression(element.expr, ["x"])) return null;
      const range: [number, number] | undefined =
        element.from !== undefined || element.to !== undefined
          ? [element.from ?? -Infinity, element.to ?? Infinity]
          : undefined;
      return {
        fn: element.expr,
        fnType: "linear",
        graphType: "polyline",
        color,
        ...(range ? { range } : {}),
        ...(element.fill ? { closed: true } : {}),
        ...(element.dashed ? { attr: DASHED } : {}),
      };
    }
    case "implicit": {
      if (!isPlotExpression(element.expr, ["x", "y"])) return null;
      return {
        fn: element.expr,
        fnType: "implicit",
        graphType: "interval",
        color,
        nSamples: 80,
        ...(element.dashed ? { attr: DASHED } : {}),
      };
    }
    case "parametric": {
      if (!isPlotExpression(element.x, ["t"]) || !isPlotExpression(element.y, ["t"])) return null;
      return {
        x: element.x,
        y: element.y,
        fnType: "parametric",
        graphType: "polyline",
        color,
        range: [element.from ?? 0, element.to ?? 2 * Math.PI],
        ...(element.dashed ? { attr: DASHED } : {}),
      };
    }
    case "points":
      return {
        points: element.points.map((p) => [...p]),
        fnType: "points",
        graphType: element.connect ? "polyline" : "scatter",
        color,
      };
    case "segment":
      return {
        points: [[...element.from], [...element.to]],
        fnType: "points",
        graphType: "polyline",
        color,
        ...(element.dashed ? { attr: DASHED } : {}),
      };
    case "polygon":
      return null;
    case "vector":
      return {
        vector: [element.to[0] - element.from[0], element.to[1] - element.from[1]],
        offset: [...element.from],
        fnType: "vector",
        graphType: "polyline",
        color,
      };
    case "circle":
      if (!Number.isFinite(element.radius) || element.radius <= 0) return null;
      return {
        fn: circleExpression(element.center, element.radius),
        fnType: "implicit",
        graphType: "interval",
        color,
        nSamples: 80,
        ...(element.dashed ? { attr: DASHED } : {}),
      };
    case "text":
      return { location: [...element.at], text: element.text, graphType: "text", color };
  }
}

/** The colour for an element: its own if it named one, otherwise the palette in order. */
function colorFor(element: PlotElement, index: number, colors: PlotColors): string {
  const named = element.color;
  if (named) return colors.series[named];
  const fallback = PLOT_COLORS[index % PLOT_COLORS.length]!;
  return colors.series[fallback];
}

/**
 * The whole figure, as the library's options.
 *
 * `xAxis`/`yAxis` are the library's own names for the axes (not `x`/`y`), and both are drawn
 * **sticky** — through the origin — because that is what a coordinate-plane figure is: a graph
 * whose axes sit at the corner is a chart, and a circle at negative coordinates is the case
 * that makes the difference obvious.
 */
export function toFunctionPlot(spec: PlotSpec, colors: PlotColors): PlotChart {
  const data: FunctionPlotDatum[] = [];
  const polygons: PlotPolygon[] = [];

  spec.elements.forEach((element, index) => {
    const color = colorFor(element, index, colors);
    if (element.kind === "polygon") {
      // Closed by repeating the first vertex only for the stroke; the fill is our own path.
      polygons.push({
        points: element.points,
        color,
        fill: element.fill !== false,
      });
      return;
    }
    const datum = elementDatum(element, color);
    if (datum) data.push(datum);
  });

  const options: FunctionPlotOptions = {
    target: undefined as unknown as HTMLElement,
    width: PLOT_FIGURE_WIDTH,
    height: PLOT_FIGURE_HEIGHT,
    grid: spec.grid === true,
    disableZoom: true,
    data,
    ...(spec.title ? { title: spec.title } : {}),
    xAxis: {
      type: spec.x?.log ? "log" : "linear",
      position: "sticky",
      ...(spec.x?.domain ? { domain: [...spec.x.domain] } : {}),
      ...(spec.x?.label ? { label: spec.x.label } : {}),
    },
    yAxis: {
      type: spec.y?.log ? "log" : "linear",
      position: "sticky",
      ...(spec.y?.domain ? { domain: [...spec.y.domain] } : {}),
      ...(spec.y?.label ? { label: spec.y.label } : {}),
    },
  };

  return { options, polygons, size: { width: PLOT_FIGURE_WIDTH, height: PLOT_FIGURE_HEIGHT } };
}

/**
 * A stored spec, parsed.
 *
 * Deep validation is the server's job and `toFunctionPlot` is tolerant of anything extra, so
 * this checks only what the mapper would crash on — the shape it iterates. A row written by a
 * later build, or one that JSON cannot parse at all, lands in the failure panel with the raw
 * text visible, which is the same outcome a malformed mermaid source gets.
 */
export function parsePlotSpec(raw: string): PlotSpec {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { elements?: unknown }).elements)
  ) {
    throw new Error("The figure's spec is not a JSON object with an elements array.");
  }
  return parsed as PlotSpec;
}

/**
 * A rendered figure, as a self-contained SVG string.
 *
 * Why post-process at all, when the library already produced an SVG: three things have to be
 * true of the string before it is **serialised for download** as much as rendered inline.
 * The library's axes are `currentColor`, which resolves to nothing outside our stylesheet, so
 * the root gets a concrete `color`; text nodes the library leaves unfilled would come out
 * black on a dark page; and a `viewBox` is what lets the same string scale to the bubble and to
 * the viewer's zoom. Stripping `script`/`foreignObject`/`on*` is defence in depth on a string
 * that will be handed to `v-html`: every label in it is model-authored, and this is the point
 * where the app stops trusting the renderer to have escaped all of them.
 */
export function serializePlotFigure(svg: SVGElement, colors: PlotColors): string {
  const clone = svg.cloneNode(true) as SVGElement;

  const width = Number(clone.getAttribute("width"));
  const height = Number(clone.getAttribute("height"));
  if (width > 0 && height > 0 && !clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  clone.setAttribute("color", colors.axes);

  for (const text of Array.from(clone.querySelectorAll("text"))) {
    if (!text.getAttribute("fill")) {
      const isTitle = (text.getAttribute("class") ?? "").includes("title");
      text.setAttribute("fill", isTitle ? colors.text : "currentColor");
    }
  }

  for (const bad of Array.from(clone.querySelectorAll("script, foreignObject"))) {
    bad.remove();
  }
  for (const element of Array.from(clone.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  }

  return new XMLSerializer().serializeToString(clone);
}
