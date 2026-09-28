import { describe, expect, it } from "vitest";
import {
  PLOT_FIGURE_HEIGHT,
  PLOT_FIGURE_WIDTH,
  parsePlotSpec,
  plotColors,
  serializePlotFigure,
  toFunctionPlot,
} from "../../src/utils/plotSpec";
import type { PlotSpec } from "../../src/api/types";

/**
 * The model's spec → the renderer's options.
 *
 * This is the module that knows function-plot, and these cases pin the two things a screenshot
 * cannot: the *shape* each kind maps to (so a renamed library option is a test failure rather
 * than a blank figure), and the expression re-check that stands between a stored row and the
 * library's own evaluator.
 */

const COLORS = plotColors((token) => {
  const map: Record<string, string> = {
    "--accent": "#111111",
    "--success": "#222222",
    "--warning": "#333333",
    "--danger": "#444444",
    "--text-2": "#555555",
    "--text-3": "#666666",
    "--text": "#777777",
  };
  return map[token] ?? "";
});

const spec = (elements: PlotSpec["elements"], rest: Partial<PlotSpec> = {}): PlotSpec => ({
  elements,
  ...rest,
});

describe("plotColors", () => {
  it("reads the palette as concrete colours and falls back when a token is empty", () => {
    expect(COLORS.series.accent).toBe("#111111");
    expect(COLORS.axes).toBe("#666666");
    expect(COLORS.text).toBe("#777777");

    const empty = plotColors(() => "");
    // Never `var()`: the value has to survive serialisation into a downloaded file.
    expect(empty.series.accent).toBe("#4c8bf5");
    expect(empty.axes).toBe("#6e7781");
  });
});

describe("toFunctionPlot", () => {
  it("draws a fixed-size, zoom-disabled chart with sticky axes", () => {
    const chart = toFunctionPlot(
      spec([{ kind: "function", expr: "sin(x)" }], {
        title: "正弦",
        x: { domain: [-6, 6], label: "x" },
        y: { domain: [-2, 2], label: "y" },
        grid: true,
      }),
      COLORS
    );

    expect(chart.size).toEqual({ width: PLOT_FIGURE_WIDTH, height: PLOT_FIGURE_HEIGHT });
    expect(chart.options.width).toBe(PLOT_FIGURE_WIDTH);
    expect(chart.options.disableZoom).toBe(true);
    expect(chart.options.grid).toBe(true);
    expect(chart.options.title).toBe("正弦");
    // Axes through the origin — the coordinate-plane convention rather than a cornered chart.
    expect(chart.options.xAxis).toMatchObject({ domain: [-6, 6], label: "x", position: "sticky" });
    expect(chart.options.yAxis).toMatchObject({ domain: [-2, 2], label: "y", position: "sticky" });
  });

  it("maps a function with its range, fill and dash", () => {
    const chart = toFunctionPlot(
      spec([
        {
          kind: "function",
          expr: "x^2",
          from: -3,
          to: 3,
          fill: true,
          dashed: true,
          color: "danger",
        },
      ]),
      COLORS
    );
    expect(chart.options.data?.[0]).toMatchObject({
      fn: "x^2",
      fnType: "linear",
      graphType: "polyline",
      color: "#444444",
      range: [-3, 3],
      closed: true,
      attr: { "stroke-dasharray": "6 4" },
    });
  });

  it("leaves a function's range unset unless the spec bounds it", () => {
    // Unbounded means "sample the visible domain", which is the library's own default and the
    // right one for a function the model did not clip.
    const chart = toFunctionPlot(spec([{ kind: "function", expr: "x" }]), COLORS);
    expect(chart.options.data?.[0]).not.toHaveProperty("range");
  });

  it("draws an implicit relation with the interval sampler", () => {
    const chart = toFunctionPlot(spec([{ kind: "implicit", expr: "x^2 + y^2 - 9" }]), COLORS);
    expect(chart.options.data?.[0]).toMatchObject({
      fn: "x^2 + y^2 - 9",
      fnType: "implicit",
      graphType: "interval",
    });
  });

  it("builds a circle's equation from its own numbers", () => {
    // Never a model-written expression: the model gives a centre and a radius, and the equation
    // is constructed here — which is also what makes a negative coordinate safe.
    const chart = toFunctionPlot(
      spec([{ kind: "circle", center: [1, -2], radius: 3 }]),
      COLORS
    );
    expect(chart.options.data?.[0]).toMatchObject({
      fn: "(x - 1)^2 + (y + 2)^2 - 9",
      fnType: "implicit",
      graphType: "interval",
    });
  });

  it("defaults a parametric pair's range to one turn", () => {
    const chart = toFunctionPlot(
      spec([{ kind: "parametric", x: "cos(t)", y: "sin(t)" }]),
      COLORS
    );
    expect(chart.options.data?.[0]).toMatchObject({
      x: "cos(t)",
      y: "sin(t)",
      fnType: "parametric",
      graphType: "polyline",
      range: [0, 2 * Math.PI],
    });
  });

  it("draws points as dots, or as a polyline when asked to connect them", () => {
    const dots = toFunctionPlot(spec([{ kind: "points", points: [[1, 2]] }]), COLORS);
    expect(dots.options.data?.[0]).toMatchObject({ graphType: "scatter", fnType: "points" });

    const line = toFunctionPlot(
      spec([{ kind: "points", points: [[1, 2]], connect: true }]),
      COLORS
    );
    expect(line.options.data?.[0]).toMatchObject({ graphType: "polyline", fnType: "points" });
  });

  it("draws a segment as a two-point polyline and a vector as an arrow", () => {
    const segment = toFunctionPlot(
      spec([{ kind: "segment", from: [0, 0], to: [3, 2] }]),
      COLORS
    );
    expect(segment.options.data?.[0]).toMatchObject({
      points: [[0, 0], [3, 2]],
      graphType: "polyline",
    });

    const vector = toFunctionPlot(
      spec([{ kind: "vector", from: [1, 1], to: [3, 2] }]),
      COLORS
    );
    expect(vector.options.data?.[0]).toMatchObject({
      vector: [2, 1],
      offset: [1, 1],
      fnType: "vector",
    });
  });

  it("places a text label at its point", () => {
    const chart = toFunctionPlot(spec([{ kind: "text", at: [1, 2], text: "A" }]), COLORS);
    expect(chart.options.data?.[0]).toMatchObject({
      location: [1, 2],
      text: "A",
      graphType: "text",
    });
  });

  it("hands a polygon back as an overlay path, not a datum", () => {
    // The library's `closed` fills down to the x-axis rather than closing the shape, so a
    // polygon is drawn from the chart's own scales instead.
    const chart = toFunctionPlot(
      spec([{ kind: "polygon", points: [[0, 0], [4, 0], [3, 3]] }]),
      COLORS
    );
    expect(chart.options.data).toEqual([]);
    expect(chart.polygons).toEqual([
      { points: [[0, 0], [4, 0], [3, 3]], color: "#111111", fill: true },
    ]);
  });

  it("cycles the palette in element order and honours a named colour", () => {
    const chart = toFunctionPlot(
      spec([
        { kind: "text", at: [0, 0], text: "A" },
        { kind: "text", at: [1, 1], text: "B" },
        { kind: "text", at: [2, 2], text: "C", color: "success" },
      ]),
      COLORS
    );
    expect(chart.options.data?.map((d) => d.color)).toEqual(["#111111", "#222222", "#222222"]);
  });

  it("drops an element whose expression is outside the language", () => {
    // The renderer is the last line rather than the first: the server refuses one before it
    // writes, but a row may have come from a build with a wider vocabulary.
    const chart = toFunctionPlot(
      spec([
        { kind: "function", expr: "alert(x)" },
        { kind: "function", expr: "x^2" },
      ]),
      COLORS
    );
    expect(chart.options.data).toHaveLength(1);
    expect(chart.options.data?.[0]?.fn).toBe("x^2");
  });
});

describe("parsePlotSpec", () => {
  it("parses a spec with an elements array", () => {
    const parsed = parsePlotSpec('{"elements":[{"kind":"function","expr":"x"}]}');
    expect(parsed.elements).toHaveLength(1);
  });

  it("throws for anything the mapper would crash on", () => {
    // A malformed row lands in the failure panel with the raw text visible, which is the same
    // outcome a malformed mermaid source gets.
    expect(() => parsePlotSpec("{not json}")).toThrow();
    expect(() => parsePlotSpec('{"elements":{}}')).toThrow();
    expect(() => parsePlotSpec('"x^2"')).toThrow();
  });
});

describe("serializePlotFigure", () => {
  /** An SVG shaped like the library's: width/height, an unfilled text, a title, a script. */
  function source(): SVGElement {
    const host = document.createElement("div");
    host.innerHTML =
      '<svg width="200" height="100" class="function-plot">' +
      '<text class="title">T</text>' +
      '<text class="axis-label">x</text>' +
      "<path onload=\"alert('x')\" d=\"M0 0\"/>" +
      "<script>alert('x')</script>" +
      "</svg>";
    return host.querySelector("svg")!;
  }

  it("makes the string self-contained and safe to hand to v-html", () => {
    const svg = serializePlotFigure(source(), COLORS);
    expect(svg).toContain('viewBox="0 0 200 100"');
    // The library's axes are `currentColor`, which resolves to nothing outside the app's
    // stylesheet after serialisation — so the root carries the concrete tone.
    expect(svg).toContain(`color="${COLORS.axes}"`);
    // An unfilled text would come out black on a dark page: the axis label inherits the root's
    // tone, and the title gets the stronger one.
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('fill="#777777"');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("onload");
  });

  it("does not overwrite a fill the library already set", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<svg width="10" height="10"><text fill="#abcdef" class="fn-text">A</text></svg>';
    const svg = serializePlotFigure(host.querySelector("svg")!, COLORS);
    expect(svg).toContain("#abcdef");
  });
});
