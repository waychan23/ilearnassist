import { describe, expect, it, vi } from "vitest";
import { PLOT_TOOL_NAME } from "@ilearnassist/shared";
import { buildPlotTool, type PlotSaveInput } from "../../src/tools/plot.js";
import { MAX_PLOT_SPEC_CHARS, PLOT_SUMMARY_MAX } from "../../src/plots.js";

/**
 * `ila_plot`, which writes one row from data.
 *
 * The table test's shape, one artifact over: a model-authored spec and summary become a row under
 * a canonical name, or a refusal the model can act on. The refusals are the half worth testing
 * hardest, because each is the only thing between a bad call and a row the panel would list and
 * the renderer could not draw — and because a refused *revise* must leave the previous row whole.
 */

const SPEC = { elements: [{ kind: "function", expr: "x^2", from: -3, to: 3 }] };
const SUMMARY = "抛物线 y=x²。";

function build(save: (input: PlotSaveInput) => void = () => undefined) {
  return { saved: save, tool: buildPlotTool({ save }) };
}

describe("ila_plot", () => {
  it("saves the row with the canonical name, the summary and the canonical spec", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);

    const result = (await tool.invoke({
      name: "Parabola Vertex",
      summary: SUMMARY,
      spec: SPEC,
    })) as string;

    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith({
      name: "parabola-vertex",
      summary: SUMMARY,
      spec: JSON.stringify({ elements: [{ kind: "function", expr: "x^2", from: -3, to: 3 }] }),
      toolCallId: null,
    });
    expect(result).toContain("parabola-vertex");
    expect(result).toContain(SUMMARY);
    // It says the figure is drawn in the conversation, and that the same name revises it.
    expect(result).toContain("revise");
  });

  it("records the call id when the invoke config carries one", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    await tool.invoke({ name: "p", summary: SUMMARY, spec: SPEC }, {
      configurable: { toolCallId: "call_7" },
    });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "call_7" }));
  });

  it("refuses an invalid spec without saving", async () => {
    /*
     * `without saving` is the load-bearing half of every refusal here: the upsert is a revise
     * when the name repeats, so a refused call that had already reached `save` would replace the
     * figure the panel holds with nothing — the same argument the table tool makes, with the
     * difference that this validator can refuse a great many more shapes.
     *
     * The first case is refused by the *schema* (an empty elements array) and the rest by
     * `validatePlotSpec`; both are refusals the model can act on, and the assertion that matters
     * here is only that neither reached the store.
     */
    const saved = vi.fn();
    const { tool } = build(saved);

    await expect(tool.invoke({ name: "p", summary: SUMMARY, spec: { elements: [] } })).rejects.toThrow();

    const bad = [
      { elements: [{ kind: "function", expr: "x; alert(1)" }] },
      { elements: [{ kind: "circle", center: [0, 0], radius: 0 }] },
      { elements: [{ kind: "text", at: [0, 0], text: "A" }], legend: true },
    ];
    for (const spec of bad) {
      await expect(tool.invoke({ name: "p", summary: SUMMARY, spec })).rejects.toThrow(
        /refused/
      );
    }
    expect(saved).not.toHaveBeenCalled();
  });

  it("refuses a spec past the size cap without saving", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    const huge = {
      elements: [
        {
          kind: "text",
          at: [0, 0],
          // Many short labels, so the cap is the JSON's — the point-limit printer is not what is
          // under test here.
          text: "x",
        },
      ],
      // A field the validator refuses anyway — but the size refusal comes first, so the message
      // is the one about size.
      padding: "x".repeat(MAX_PLOT_SPEC_CHARS),
    };
    await expect(tool.invoke({ name: "p", summary: SUMMARY, spec: huge })).rejects.toThrow(
      new RegExp(String(MAX_PLOT_SPEC_CHARS))
    );
    expect(saved).not.toHaveBeenCalled();
  });

  it("caps the summary in its schema, so an over-long one never reaches the handler", async () => {
    const { tool } = build();
    await expect(
      tool.invoke({ name: "p", summary: "x".repeat(PLOT_SUMMARY_MAX + 1), spec: SPEC })
    ).rejects.toThrow();
  });

  it("names the tool and describes what it draws — and what it is not for", () => {
    // The description is read when the model is deciding whether to call: it has to say "graphs
    // and geometry" and to push a flowchart to the diagram tool instead.
    const { tool } = build();
    expect(tool.name).toBe(PLOT_TOOL_NAME);
    expect(tool.description).toContain("coordinate plane");
    expect(tool.description).toContain("mermaid");
  });
});
