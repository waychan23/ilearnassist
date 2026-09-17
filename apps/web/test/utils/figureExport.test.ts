import { describe, expect, it } from "vitest";
import {
  FIGURE_FORMATS,
  FIGURE_RASTER_SCALE,
  downloadName,
  rasterSize,
  svgBlob,
} from "../../src/utils/figureExport";
import { tableHtmlForClipboard } from "../../src/utils/tableClipboard";

/**
 * The parts of the export path a unit test can hold.
 *
 * The raster half needs an `<img>`, a canvas and the browser's own SVG renderer, so it is not here
 * — `e2e/diagram.spec.ts` downloads a real file and opens it. What *is* here is the arithmetic and
 * the names, which is where the mistakes that a browser run would report as "the file is wrong"
 * actually live.
 */

describe("downloadName", () => {
  it("replaces the drawing's extension rather than appending to it", () => {
    // A diagram is `auth-flow.mmd` on disk, and `auth-flow.mmd.png` is a name nobody typed.
    expect(downloadName("auth-flow.mmd", "png")).toBe("auth-flow.png");
    expect(downloadName("auth-flow.mermaid", "jpg")).toBe("auth-flow.jpg");
  });

  it("keeps a name that has no extension, and one with dots inside it", () => {
    expect(downloadName("登录流程", "svg")).toBe("登录流程.svg");
    expect(downloadName("v1.2 flow.mmd", "png")).toBe("v1.2 flow.png");
  });

  it("never produces a bare extension", () => {
    // The download attribute has to carry something; a browser given nothing invents `download`
    // with no extension at all, and the file arrives unopenable.
    expect(downloadName(undefined, "png")).toBe("figure.png");
    expect(downloadName("   ", "svg")).toBe("figure.svg");
  });

  it("does not sanitise, because a `download` value is not a path", () => {
    /*
     * The value goes into an anchor's `download` attribute, which names a file rather than
     * resolving one — a slash in it cannot climb anywhere, and the browser replaces it with `_`
     * itself. A name that had characters removed would be a file the user does not recognise,
     * which is the failure this avoids by doing nothing.
     */
    expect(downloadName("nested/flow.mmd", "png")).toBe("nested/flow.png");
  });
});

describe("rasterSize", () => {
  it("is the drawing's own size times the scale", () => {
    expect(rasterSize({ width: 300, height: 200 }, 2)).toEqual({ width: 600, height: 400 });
  });

  it("rounds up, so a fractional viewBox does not clip its last pixel", () => {
    expect(rasterSize({ width: 300.4, height: 200.2 }, 2)).toEqual({ width: 601, height: 401 });
  });

  it("never asks a canvas for zero pixels", () => {
    // A zero-sized canvas is a `SecurityError` on some browsers and a blank image on others, and
    // neither is a failure anyone could read.
    expect(rasterSize({ width: 0, height: 0 }, 2)).toEqual({ width: 1, height: 1 });
  });

  it("defaults to 2x, which is what the menu promises", () => {
    expect(FIGURE_RASTER_SCALE).toBe(2);
    expect(rasterSize({ width: 100, height: 50 })).toEqual({ width: 200, height: 100 });
  });
});

describe("svgBlob", () => {
  it("carries the drawing through untouched, as an SVG", () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const blob = svgBlob(svg);
    expect(blob.type).toBe("image/svg+xml");
    expect(blob.size).toBe(svg.length);
  });
});

describe("FIGURE_FORMATS", () => {
  it("offers PNG first, because it is the common case", () => {
    expect(FIGURE_FORMATS[0]).toBe("png");
    expect([...FIGURE_FORMATS].sort()).toEqual(["jpg", "png", "svg"]);
  });
});

describe("tableHtmlForClipboard", () => {
  const rendered = '<p>before</p><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';

  it("writes the styles onto the table and its cells", () => {
    // Without them the fragment arrives as words in an invisible grid: the app's own borders live
    // in a stylesheet, and a stylesheet does not travel with a clipboard.
    const html = tableHtmlForClipboard(rendered)!;
    expect(html).toContain('<table style="border-collapse:collapse;width:auto"');
    expect(html).toContain('<th style="border:1px solid');
    expect(html).toContain('<td style="border:1px solid');
  });

  it("returns only the table, not the prose around it", () => {
    const html = tableHtmlForClipboard(rendered)!;
    expect(html).not.toContain("before");
    expect(html.startsWith("<table")).toBe(true);
    expect(html.endsWith("</table>")).toBe(true);
  });

  it("answers null for a fragment with no table in it", () => {
    // The caller's fallback is the markdown, which is still the table. Copying a paragraph here
    // would be copying the wrong thing while looking like it worked.
    expect(tableHtmlForClipboard("<p>no table</p>")).toBeNull();
  });
});
