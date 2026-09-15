import { describe, expect, it, vi } from "vitest";
import { MAX_DIAGRAM_CHARS } from "@ilearnassist/shared";
import { diagramThemeVariables, diagramTooLarge, renderMermaid } from "../../src/utils/mermaid.js";

/**
 * Did anything import mermaid?
 *
 * Set by the mocked factory, which vitest runs the first time `"mermaid"` is imported by
 * anything under test. Since `vi.mock` is hoisted above the imports of this file, the answer at
 * the end of it is a statement about `utils/mermaid.ts` and not about this test.
 */
const mermaidLoaded = vi.hoisted(() => ({ value: false }));

vi.mock("mermaid", () => {
  mermaidLoaded.value = true;
  // Never called: the point is that the module is not *evaluated*, and the shape only has to
  // be good enough that a caller inside `renderMermaid` would not throw on import.
  return { default: { initialize: () => {}, parse: async () => ({}), render: async () => ({ svg: "" }) } };
});

/**
 * What can be pinned without a browser.
 *
 * The render itself cannot be: mermaid needs real layout, `getBBox` and SVG measurement, none
 * of which jsdom has. That half is the browser suite's, which is the same division the app
 * already accepts for `.vue` components. What is left is the part that decides *whether* to
 * render and *what colours* it renders with — and that second one is here rather than in the
 * browser because the mapping takes an injected reader, precisely so it can be.
 */

describe("diagramTooLarge", () => {
  it("accepts a source at the cap and refuses one past it", () => {
    // The boundary is shared with the server, which refuses to *write* one this size — a
    // diagram the tool accepted and the viewer declined would read as a broken viewer.
    expect(diagramTooLarge("x".repeat(MAX_DIAGRAM_CHARS))).toBe(false);
    expect(diagramTooLarge("x".repeat(MAX_DIAGRAM_CHARS + 1))).toBe(true);
  });
});

describe("diagramThemeVariables", () => {
  it("draws its colours from the palette tokens", () => {
    const read = vi.fn((_name: string) => "#123456");
    const vars = diagramThemeVariables(read);
    const asked = new Set(read.mock.calls.map((call) => call[0]));

    // The surface, the two greys, the border and the text tones: everything a node, an edge
    // and a cluster is painted from.
    for (const token of ["--panel", "--panel-2", "--text", "--border", "--text-3"]) {
      expect(asked).toContain(token);
    }
    // The error pair, because a mermaid parse error is drawn *by mermaid*, not by us.
    expect(asked).toContain("--danger-bg");
    expect(asked).toContain("--danger-text");
    expect(vars.background).toBe("#123456");
  });

  it("trims what the reader gives it", () => {
    /*
     * `getComputedStyle(...).getPropertyValue("--panel")` returns the declared value *with*
     * its surrounding whitespace, and mermaid hands these straight to its colour functions. A
     * value of `" #1f2328 "` is not the same string as `"#1f2328"`, and whether it survives
     * that trip is mermaid's business rather than something to find out per diagram.
     */
    const vars = diagramThemeVariables(() => "  #1f2328  ");
    expect(vars.primaryTextColor).toBe("#1f2328");
  });

  it("falls back rather than producing an empty colour", () => {
    // jsdom does not apply `style.css`, so a computed-style read returns "" there — and an
    // empty string handed to mermaid is a broken palette rather than a missing one. It is also
    // the shape a *browser* gives for a token nobody declared yet.
    const vars = diagramThemeVariables(() => "");

    expect(Object.values(vars).every((v) => v.length > 0)).toBe(true);
    expect(vars.background).toBe("#ffffff");
  });

  it("gives edge labels the surface colour rather than mermaid's white", () => {
    // Mermaid's default is hard white, which on a dark theme is a white box sitting on top of
    // every edge label. This is the one variable whose absence is visible in every diagram.
    const vars = diagramThemeVariables((name) => (name === "--panel" ? "#101418" : ""));
    expect(vars.edgeLabelBackground).toBe("#101418");
  });
});

describe("loading", () => {
  it("does not load mermaid until something asks for a render", () => {
    /*
     * The dynamic import lives *inside* a function on purpose: mermaid is a ~1 MB package of
     * some two hundred modules, and importing this one should cost nothing until a diagram is
     * actually on screen. Lift `import mermaid from "mermaid"` to the top of `utils/mermaid.ts`
     * and every user pays for it on first paint, diagram or no diagram — while `renderMermaid`
     * would still be a function and every other test here would still pass. This is the test
     * that would not.
     */
    expect(mermaidLoaded.value).toBe(false);
    expect(typeof renderMermaid).toBe("function");
  });
});
