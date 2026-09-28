import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, DEFAULT_SESSION_TITLE, type AppDb } from "../src/db.js";
import {
  MAX_PLOT_ELEMENTS,
  MAX_PLOT_POINTS,
  MAX_PLOT_SPEC_CHARS,
  PLOT_SUMMARY_MAX,
  plotName,
  registerPlot,
  validatePlotSpec,
} from "../src/plots.js";

/**
 * The plot row's domain rules, in two halves that fail differently.
 *
 * The naming rule is `tableName`'s (nothing here touches a filesystem, so there is no extension),
 * and `validatePlotSpec` is the part with no sibling: a table's `looksLikeMarkdownTable` asks
 * whether a renderer will draw it, while this one *is* the drawing language — every expression,
 * number and field the renderer will ever see has been through it.
 */

describe("plotName", () => {
  it("kebab-cases a name, with no extension", () => {
    expect(plotName("Parabola Vertex")).toBe("parabola-vertex");
    expect(plotName("x^2")).toBe("x-2");
    expect(plotName("季度 对比")).toBe("季度-对比");
  });

  it("falls back when nothing survives the filter", () => {
    // "plot", not "workspace": `slugify`'s default would be a quiet lie about what this is.
    expect(plotName("!!!")).toBe("plot");
    expect(plotName("")).toBe("plot");
  });

  it("never returns a separator or a leading dot", () => {
    for (const name of ["a/b", "..", ".hidden", "/abs"]) {
      const canonical = plotName(name);
      expect(canonical).not.toContain("/");
      expect(canonical.startsWith(".")).toBe(false);
    }
  });
});

describe("validatePlotSpec", () => {
  it("accepts and rebuilds a figure that uses every kind", () => {
    const result = validatePlotSpec({
      title: "圆与弦",
      x: { domain: [-5, 5], label: "x" },
      y: { domain: [-5, 5], label: "y" },
      grid: true,
      elements: [
        { kind: "function", expr: "sin(x)", from: -3, to: 3, dashed: true, color: "accent" },
        { kind: "implicit", expr: "x^2 + y^2 - 9" },
        { kind: "parametric", x: "2*cos(t)", y: "2*sin(t)" },
        { kind: "points", points: [[1, 2]], connect: true },
        { kind: "segment", from: [0, 0], to: [1, 1] },
        { kind: "polygon", points: [[0, 0], [2, 0], [1, 2]] },
        { kind: "vector", from: [0, 0], to: [2, 1] },
        { kind: "circle", center: [1, -2], radius: 3 },
        { kind: "text", at: [1, 2], text: "A" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe("圆与弦");
    expect(result.spec.grid).toBe(true);
    expect(result.spec.elements).toHaveLength(9);
    // The expression is kept, the optional markers are normalised to their presence.
    expect(result.spec.elements[0]).toMatchObject({ kind: "function", expr: "sin(x)", dashed: true });
  });

  it("refuses a spec that is not an object, or has no elements", () => {
    expect(validatePlotSpec(null).ok).toBe(false);
    expect(validatePlotSpec("x^2").ok).toBe(false);
    expect(validatePlotSpec({}).ok).toBe(false);
    expect(validatePlotSpec({ elements: [] }).ok).toBe(false);
  });

  it("refuses an unknown field rather than dropping it silently", () => {
    // The `ila_query` checkFields argument one level down: a misspelled field is a model that
    // believes it asked for something, and a schema that strips it returns a figure and never
    // says the field went nowhere.
    const top = validatePlotSpec({ elements: [{ kind: "text", at: [0, 0], text: "A" }], gridlines: true });
    expect(top.ok).toBe(false);

    const element = validatePlotSpec({
      elements: [{ kind: "function", expr: "x", radius: 3 }],
    });
    expect(element.ok).toBe(false);
    if (!element.ok) expect(element.error).toContain('no field "radius"');
  });

  it("refuses an expression outside the drawing language", () => {
    // A character the alphabet does not have.
    const inject = validatePlotSpec({
      elements: [{ kind: "function", expr: "x; fetch('/x')" }],
    });
    expect(inject.ok).toBe(false);

    // An identifier that is not a variable, a constant or a whitelisted function. `random` is
    // deliberately not one: a figure that draws differently on every render is not a figure.
    for (const expr of ["foo(x)", "random()", "y", "window.x"]) {
      const result = validatePlotSpec({ elements: [{ kind: "function", expr }] });
      expect(result.ok, expr).toBe(false);
    }
  });

  it("checks each kind's own variables", () => {
    // `y` belongs to an implicit relation, not to a function of x.
    expect(validatePlotSpec({ elements: [{ kind: "function", expr: "x + y" }] }).ok).toBe(false);
    expect(validatePlotSpec({ elements: [{ kind: "implicit", expr: "x^2 + y^2 - 1" }] }).ok).toBe(true);
    expect(validatePlotSpec({ elements: [{ kind: "function", expr: "t" }] }).ok).toBe(false);
    expect(validatePlotSpec({ elements: [{ kind: "parametric", x: "cos(t)", y: "sin(t)" }] }).ok).toBe(true);
    // The constants are always available.
    expect(validatePlotSpec({ elements: [{ kind: "function", expr: "pi*x + e" }] }).ok).toBe(true);
  });

  it("refuses the structural mistakes each kind can make", () => {
    const cases: Array<Record<string, unknown>> = [
      { kind: "circle", center: [0, 0], radius: 0 },
      { kind: "circle", center: [0, 0], radius: -2 },
      { kind: "polygon", points: [[0, 0], [1, 1]] },
      { kind: "segment", from: [0, 0], to: [0] },
      { kind: "text", at: [0, 0], text: "  " },
      { kind: "points", points: [] },
      { kind: "function", expr: "x", from: 5, to: 1 },
      { kind: "function", expr: "x", color: "chartreuse" },
      { kind: "text", at: [0, Number.NaN], text: "A" },
    ];
    for (const element of cases) {
      const result = validatePlotSpec({ elements: [element] });
      expect(result.ok, JSON.stringify(element)).toBe(false);
    }
  });

  it("caps elements, explicit points and text length", () => {
    const many = Array.from({ length: MAX_PLOT_ELEMENTS + 1 }, () => ({
      kind: "text",
      at: [0, 0],
      text: "A",
    }));
    expect(validatePlotSpec({ elements: many }).ok).toBe(false);

    const points = Array.from({ length: MAX_PLOT_POINTS + 1 }, (_, i) => [i, i]);
    expect(validatePlotSpec({ elements: [{ kind: "points", points }] }).ok).toBe(false);

    expect(
      validatePlotSpec({ elements: [{ kind: "text", at: [0, 0], text: "x".repeat(201) }] }).ok
    ).toBe(false);
  });

  it("refuses a reversed or non-finite domain", () => {
    expect(validatePlotSpec({ x: { domain: [5, -5] }, elements: [] }).ok).toBe(false);
    expect(
      validatePlotSpec({
        x: { domain: [0, Number.POSITIVE_INFINITY] },
        elements: [{ kind: "function", expr: "x" }],
      }).ok
    ).toBe(false);
  });

  it("keeps the cap shared with the client and the summary server-local", () => {
    // `MAX_PLOT_SPEC_CHARS` is server-local the way `MAX_TABLE_CHARS` is — a spec is bounded by
    // what is worth storing, while the *expression* cap is shared because the renderer refuses
    // one too. Both numbers are asserted so a change to either is a visible one.
    expect(MAX_PLOT_SPEC_CHARS).toBe(32 * 1024);
    expect(PLOT_SUMMARY_MAX).toBe(300);
  });
});

describe("registerPlot", () => {
  let root: string;
  let db: AppDb;
  const SESSION = "s1";
  const SPEC = JSON.stringify({ elements: [{ kind: "function", expr: "x^2" }] });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gl-plots-"));
    db = createDb(join(root, "test.sqlite"));
    db.createUser({ id: "u1", username: "tester", slug: "tester" });
    db.createWorkspace({ userId: "u1", id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
    db.createSession({
      id: SESSION,
      workspaceId: "w1",
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: DEFAULT_SESSION_TITLE,
    });
  });

  afterEach(() => {
    try {
      db.raw.close();
    } catch {
      /* already closed */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("creates one row with the canonical name and the spec, unjudged", () => {
    const row = registerPlot(db, SESSION, {
      name: plotName("Parabola"),
      summary: "抛物线",
      spec: SPEC,
      toolCallId: "c1",
    });

    expect(row).toMatchObject({
      sessionId: SESSION,
      name: "parabola",
      summary: "抛物线",
      // The row *is* the artifact, unlike a diagram's: the spec is drawn from here.
      spec: SPEC,
      toolCallId: "c1",
      threadId: null,
      threadTitle: null,
    });
    expect(db.listPlotsBySession(SESSION)).toHaveLength(1);
  });

  it("revises one row in place: new summary, spec and anchor; id and birth kept", () => {
    const first = registerPlot(db, SESSION, {
      name: "parabola",
      summary: "一版",
      spec: SPEC,
      toolCallId: "c1",
    });
    const second = registerPlot(db, SESSION, {
      name: "parabola",
      summary: "二版",
      spec: JSON.stringify({ elements: [{ kind: "circle", center: [0, 0], radius: 2 }] }),
      toolCallId: "c2",
    });

    const rows = db.listPlotsBySession(SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
    expect(rows[0]?.summary).toBe("二版");
    // The spec moves as well as the summary, exactly as a table's content does: a revise that
    // moved the label and not the figure would leave the panel showing the old drawing.
    expect(rows[0]?.spec).toContain("circle");
    expect(rows[0]?.toolCallId).toBe("c2");
    expect(rows[0]?.createdAt).toBe(first.createdAt);
    expect(second.id).toBe(first.id);
  });

  it("clears a thread judgement when the plot is revised", () => {
    registerPlot(db, SESSION, { name: "p", summary: "一版", spec: SPEC, toolCallId: "c1" });
    db.raw.prepare("UPDATE session_plots SET thread_id = ? WHERE session_id = ?").run("t-old", SESSION);
    expect(db.listPlotsBySession(SESSION)[0]?.threadId).toBe("t-old");

    registerPlot(db, SESSION, { name: "p", summary: "二版", spec: SPEC, toolCallId: "c2" });
    expect(db.listPlotsBySession(SESSION)[0]?.threadId).toBeNull();
  });

  it("blanks the spec in the classifier's read, and keeps it in the panel's", () => {
    registerPlot(db, SESSION, { name: "p", summary: "s", spec: SPEC, toolCallId: "c1" });

    const [brief] = db.listPlotBriefsBySession(SESSION);
    expect(brief?.spec).toBe("");
    expect(brief?.name).toBe("p");
    expect(brief?.summary).toBe("s");
    expect(db.listPlotsBySession(SESSION)[0]?.spec).toBe(SPEC);
  });

  it("has no ownerless way in: the ForUser list is the API's read", () => {
    registerPlot(db, SESSION, { name: "p", summary: "s", spec: SPEC, toolCallId: "c1" });
    expect(db.listPlotsForUser("u1", SESSION)).toHaveLength(1);
    expect(db.listPlotsForUser("someone-else", SESSION)).toEqual([]);
  });
});
