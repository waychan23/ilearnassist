import { describe, expect, it } from "vitest";
import { svgSize } from "../../src/utils/mermaid";

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
