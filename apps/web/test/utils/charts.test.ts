import { afterEach, describe, expect, it, vi } from "vitest";
import { chartTheme, resetChartKit, shortDayLabel } from "../../src/utils/charts";

/**
 * The chart palette, and the axis labels.
 *
 * `chartTheme` takes a *reader* rather than reaching for `getComputedStyle`, and this is what that
 * seam is for: jsdom applies no stylesheet, so a real computed-style read returns `""` for every
 * token and the mapping would only ever be exercised in a browser. With a reader that answers, the
 * three things that can actually go wrong here are all visible:
 *
 *  - a token that does not exist, which must fall back rather than hand a canvas an empty string;
 *  - a `var(--x)` string, which is the one mistake that looks right in the source and paints
 *    nothing on a canvas;
 *  - a series colour equal to the axis colour, which draws a line the reader cannot separate from
 *    the ticks beside it.
 */

const reader = (values: Record<string, string>) => (name: string) => values[name] ?? "";

/** What `style.css` holds, as the reader would answer it. */
const TOKENS: Record<string, string> = {
  "--text": "#e6e8eb",
  "--text-2": "#9aa0a6",
  "--text-3": "#6b7280",
  "--border": "#2b2f35",
  "--accent": "#4c8bf5",
  "--success": "#4cc38a",
  "--warning": "#e6b33c",
  "--panel-2": "#262a2f",
};

describe("chartTheme", () => {
  it("reads the app's own tokens rather than carrying a palette of its own", () => {
    const theme = chartTheme(reader(TOKENS));
    expect(theme.text).toBe("#e6e8eb");
    expect(theme.muted).toBe("#6b7280");
    expect(theme.grid).toBe("#2b2f35");
    expect(theme.series).toEqual(["#4c8bf5", "#4cc38a", "#e6b33c", "#9aa0a6"]);
    expect(theme.tooltipBg).toBe("#262a2f");
  });

  it("hands over concrete colours, never a var() reference", () => {
    /*
     * The failure this exists for. Chart.js paints to a canvas, which has no cascading context:
     * `ctx.fillStyle = "var(--accent)"` is not a colour, it is a string the canvas ignores — and
     * the chart keeps whatever fill was set before it, which reads as every series being the same
     * colour. It is mermaid's `themeVariables` problem verbatim.
     */
    const theme = chartTheme(reader(TOKENS));
    for (const colour of [theme.text, theme.muted, theme.grid, theme.tooltipBg, ...theme.series]) {
      expect(colour).not.toContain("var(");
      expect(colour).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it("falls back rather than handing over an empty string", () => {
    // An unresolved token answers `""`. A blank fill is invisible, which is worse than a colour
    // that is merely wrong for the theme.
    const theme = chartTheme(reader({}));
    expect(theme.series.every((colour) => colour.length > 0)).toBe(true);
    expect(theme.text.length).toBeGreaterThan(0);
    expect(theme.grid.length).toBeGreaterThan(0);
  });

  it("never draws a series in the colour of the ticks beside it", () => {
    // A line the same colour as the axis labels is one the reader has to work out from position.
    const theme = chartTheme(reader(TOKENS));
    expect(theme.series).not.toContain(theme.muted);
    expect(new Set(theme.series).size).toBe(theme.series.length);
  });
});

describe("shortDayLabel", () => {
  it("keeps the month and the day, and drops the year the tooltip carries", () => {
    expect(shortDayLabel("2026-09-17")).toBe("09-17");
  });

  it("passes anything else through rather than mangling it", () => {
    // A key the server did not write is not something to slice at arbitrary offsets.
    expect(shortDayLabel("2026-09")).toBe("2026-09");
    expect(shortDayLabel("nonsense")).toBe("nonsense");
  });
});

describe("the lazy chunk", () => {
  afterEach(() => {
    resetChartKit();
    vi.doUnmock("chart.js");
  });

  it("does not load Chart.js until a chart is drawn", async () => {
    /*
     * The claim that keeps the initial bundle from carrying it. A static import anywhere on the
     * eager path would put the library in `index.js` for every session, most of which never open a
     * statistics page — the argument `utils/openFileViewer.ts` makes for the same move, and the
     * one `test/fileViewer.test.ts` asserts there.
     */
    vi.resetModules();
    const loaded = { count: 0 };
    vi.doMock("chart.js", () => {
      loaded.count += 1;
      // Only the surface `chartKit` touches: a real `Chart` needs a canvas context jsdom does not
      // provide, and the claim under test is *when* the module loads, not what it then draws.
      return {
        Chart: class {
          static register(): void {}
        },
        registerables: [],
      };
    });

    const mod = await import("../../src/utils/charts");
    expect(loaded.count).toBe(0);

    await mod.chartKit();
    expect(loaded.count).toBe(1);

    // …and once more shares the same promise rather than importing again.
    await mod.chartKit();
    expect(loaded.count).toBe(1);

    mod.resetChartKit();
  });
});
