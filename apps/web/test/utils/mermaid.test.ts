import { describe, expect, it } from "vitest";
import { darkenDiagramStyles, diagramThemeVariables, svgSize } from "../../src/utils/mermaid";

/**
 * Reading a drawing's own size off the SVG text.
 *
 * This is the whole of what makes the figure viewer's zoom work, and it is here rather than in the
 * browser suite because the arithmetic is the part that can be wrong in ways a screenshot would
 * not show: a size read as `0` scales to nothing, and a size read from the wrong place scales to
 * something plausible and wrong.
 *
 * The svg strings are mermaid's own shape, and reproducing that shape is the point — this reads
 * the `viewBox` precisely *because* the `width` and `height` attributes are percentages that mean
 * nothing without a container.
 */

/** What mermaid emits under `useMaxWidth: true`, which is the setting this app keeps. */
const MERMAID_SVG =
  '<svg id="mmd-1" width="100%" xmlns="http://www.w3.org/2000/svg" ' +
  'style="max-width: 312.5px;" viewBox="0 0 312.5 154" role="graphics-document document">' +
  "<g></g></svg>";

describe("svgSize", () => {
  it("reads the drawing's own size from the viewBox", () => {
    expect(svgSize(MERMAID_SVG)).toEqual({ width: 312.5, height: 154 });
  });

  it("is not fooled by the percentage width mermaid writes beside it", () => {
    // The failure this exists to prevent: `100%` is not a size, and a viewer that believed it
    // would scale every drawing by a number that means "whatever the box is".
    const size = svgSize(MERMAID_SVG);
    expect(size?.width).not.toBe(100);
    expect(size?.width).toBe(312.5);
  });

  it("accepts a comma-separated viewBox, which is equally valid SVG", () => {
    expect(svgSize('<svg viewBox="0,0,120,60"></svg>')).toEqual({ width: 120, height: 60 });
  });

  it("accepts a viewBox whose origin is not the corner", () => {
    // Only the last two numbers are the size; an origin read as a dimension would give a drawing
    // twice its width.
    expect(svgSize('<svg viewBox="-10 -20 80 40"></svg>')).toEqual({ width: 80, height: 40 });
  });

  it("answers null rather than a number for anything it cannot read", () => {
    // Null is the caller's "fall back to mermaid's own behaviour" — the honest answer, and the
    // reason the viewer's zoom controls are disabled rather than misleading in this case.
    expect(svgSize("<svg></svg>")).toBeNull();
    expect(svgSize('<svg viewBox="0 0 100"></svg>')).toBeNull();
    expect(svgSize('<svg viewBox="0 0 abc 100"></svg>')).toBeNull();
    expect(svgSize("")).toBeNull();
  });

  it("treats an empty drawing as no size at all", () => {
    // Mermaid emits `0 0 0 0` for a graph with nothing in it. Zero is not a scale factor, and a
    // canvas of zero pixels is a failure rather than a blank picture.
    expect(svgSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
    expect(svgSize('<svg viewBox="0 0 100 -5"></svg>')).toBeNull();
  });
});

/**
 * The palette → mermaid `themeVariables` mapping.
 *
 * This is where the dark-theme fix is decided: the base theme is built for a light page, and the
 * variables it fixes or derives for one — ER rows, done gantt bars, the xychart palette — have
 * to be restated under dark. Asserting the *mapping* rather than a drawing keeps this in jsdom:
 * the browser spec renders the result.
 */

/** Every token the mapping reads, keyed by name — concrete values so no `var()` reaches mermaid. */
const TOKENS: Record<string, string> = {
  "--panel": "#202327",
  "--panel-2": "#262a2f",
  "--text": "#e6e8eb",
  "--border": "#2b2f35",
  "--text-2": "#9aa0a6",
  "--text-3": "#6b7280",
  "--accent": "#4c8bf5",
  "--success": "#4cc38a",
  "--warning": "#e6b33c",
  "--lock-held": "#f0883e",
  "--danger": "#e5534b",
  "--danger-bg": "rgba(229, 83, 75, 0.12)",
  "--danger-text": "#f2a19c",
};
const reader = (name: string): string => TOKENS[name] ?? "";

describe("diagramThemeVariables under the light theme", () => {
  const vars = diagramThemeVariables("light", reader);

  it("maps the shared palette onto the base-theme fields", () => {
    expect(vars.background).toBe("#202327");
    expect(vars.primaryTextColor).toBe("#e6e8eb");
    expect(vars.edgeLabelBackground).toBe("#202327");
  });

  it("does not touch the base theme's light-page derivations", () => {
    // Those fields only need restating under dark; naming them in light would pin light rows to
    // values mermaid already derives correctly.
    expect(vars.rowOdd).toBeUndefined();
    expect(vars.doneTaskBkgColor).toBeUndefined();
    expect(vars.xyChart).toBeUndefined();
  });
});

describe("diagramThemeVariables under the dark theme", () => {
  const vars = diagramThemeVariables("dark", reader);

  it("restates ER attribute rows with dark fills", () => {
    // The base derivation lightens them to near white while the labels stay light.
    expect(vars.rowOdd).toBe("#202327");
    expect(vars.rowEven).toBe("#262a2f");
  });

  it("restates completed gantt tasks with a muted fill and lighter border", () => {
    expect(vars.doneTaskBkgColor).toBe("#6b7280");
    expect(vars.doneTaskBorderColor).toBe("#9aa0a6");
  });

  it("supplies the nested xyChart object whole, with no light-page cream", () => {
    expect(vars.xyChart).toEqual(expect.any(Object));
    const xy = vars.xyChart as Record<string, string>;
    expect(xy.plotColorPalette).not.toMatch(/FFF4DD/i);
    expect(xy.plotColorPalette).toContain("#4c8bf5");
    // The nested override replaces rather than merges, so every text field must be named.
    for (const field of [
      "titleColor",
      "dataLabelColor",
      "legendTextColor",
      "xAxisLabelColor",
      "yAxisTickColor",
    ]) {
      expect(xy[field]).toBe("#e6e8eb");
    }
  });

  it("falls back when a token cannot be read", () => {
    const vars = diagramThemeVariables("dark", () => "");
    expect(vars.rowOdd).toBe("#202327");
    const xy = vars.xyChart as Record<string, string>;
    expect(xy.backgroundColor).toBe("#202327");
  });
});

describe("darkenDiagramStyles", () => {
  it("moves hardcoded light fills to dark fills of the same hue", () => {
    // The exact dark hexes are deterministic; pinning them keeps the hue/saturation mapping
    // honest, and the labels still carry the model's green/blue/amber/purple distinction.
    const source =
      "flowchart TD\n" +
      "  style DA fill:#e8f5e9\n" +
      "  style LC fill:#e3f2fd\n" +
      "  style LG fill:#fff3e0\n" +
      "  style LS fill:#f3e5f5";
    expect(darkenDiagramStyles(source)).toBe(
      "flowchart TD\n" +
        "  style DA fill:#28612d\n" +
        "  style LC fill:#064f84\n" +
        "  style LG fill:#8a5500\n" +
        "  style LS fill:#5c2464"
    );
  });

  it("leaves fills that are already dark untouched", () => {
    expect(darkenDiagramStyles("  style A fill:#202327")).toBe("  style A fill:#202327");
  });

  it("handles classDef statements, and expands 3-digit hexes", () => {
    expect(darkenDiagramStyles("  classDef cls fill:#fff")).toBe("  classDef cls fill:#4a4a4a");
  });

  it("keeps an 8-digit hex's alpha suffix", () => {
    expect(darkenDiagramStyles("  style A fill:#e8f5e980")).toBe("  style A fill:#28612d80");
  });

  it("lightens a hardcoded dark text color", () => {
    expect(darkenDiagramStyles("  style A color:#222")).toBe("  style A color:#b6b6b6");
  });

  it("does not touch linkStyle, named colours, or fills outside style lines", () => {
    const source =
      "flowchart TD\n  linkStyle default stroke:#fff\n  style A fill:red\n" +
      '  B["a fill:#e8f5e9 label"]';
    expect(darkenDiagramStyles(source)).toBe(source);
  });
});
