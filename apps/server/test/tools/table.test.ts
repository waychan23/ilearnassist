import { describe, expect, it, vi } from "vitest";
import { buildTableTool, type TableSaveInput } from "../../src/tools/table.js";
import { MAX_TABLE_CHARS, TABLE_SUMMARY_MAX } from "../../src/tables.js";

/**
 * `ila_table`, which writes one row and no file.
 *
 * The tool's whole job is a translation: a model-authored table and summary become a row under a
 * canonical name, or a refusal the model can act on. Everything here is one of those two, because
 * there is nothing else it can do — and the refusals are the half worth testing hardest, since
 * each of them is the only thing standing between a bad call and a row the panel would show.
 */

const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";
const SUMMARY = "三项指标的对比。";

function build(save: (input: TableSaveInput) => void = () => undefined) {
  return { saved: save, tool: buildTableTool({ save }) };
}

describe("ila_table", () => {
  it("saves the row with the canonical name, the summary and the content", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);

    const result = (await tool.invoke({
      name: "Quarterly Comparison",
      table: TABLE,
      summary: SUMMARY,
    })) as string;

    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith({
      name: "quarterly-comparison",
      summary: SUMMARY,
      content: TABLE,
      toolCallId: null,
    });
    // Names the row, echoes the summary, and asks for the part this tool cannot do — the inline
    // copy in the reply. See the tool's docblock for why that ask is not decoration.
    expect(result).toContain("quarterly-comparison");
    expect(result).toContain(SUMMARY);
    expect(result).toContain("reply");
  });

  it("records the call id when the invoke config carries one", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    await tool.invoke({ name: "t", table: TABLE, summary: SUMMARY }, {
      configurable: { toolCallId: "call_7" },
    });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "call_7" }));
  });

  it("refuses an empty table without saving", async () => {
    // `without saving` is the load-bearing half of every refusal in this file: the upsert is a
    // revise when the name repeats, so a refused call that had already reached `save` would wipe
    // the copy the panel holds and replace it with nothing.
    const saved = vi.fn();
    const { tool } = build(saved);
    await expect(tool.invoke({ name: "t", table: "   ", summary: SUMMARY })).rejects.toThrow(
      /empty/
    );
    expect(saved).not.toHaveBeenCalled();
  });

  it("refuses a table past the cap without saving", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    const huge = `| a |\n| --- |\n| ${"x".repeat(MAX_TABLE_CHARS)} |`;
    await expect(tool.invoke({ name: "t", table: huge, summary: SUMMARY })).rejects.toThrow(
      new RegExp(String(MAX_TABLE_CHARS))
    );
    expect(saved).not.toHaveBeenCalled();
  });

  it("refuses something that is not a markdown table without saving", async () => {
    /*
     * The one content check this repository takes on, and the asymmetry with `ila_diagram` is
     * deliberate rather than an inconsistency: mermaid syntax is not validated there because the
     * *renderer* is the authority on what it can draw, while a table's claim is that markdown-it
     * renders it as a table — and markdown-it needs exactly this row to do so.
     */
    const saved = vi.fn();
    const { tool } = build(saved);
    for (const notATable of ["这是一段说明。", "- 一\n- 二", "| 项目 | 数值 |"]) {
      await expect(
        tool.invoke({ name: "t", table: notATable, summary: SUMMARY })
      ).rejects.toThrow(/separator/);
    }
    expect(saved).not.toHaveBeenCalled();
  });

  it("accepts the spellings markdown itself does", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    for (const table of ["a | b\n--- | ---\n1 | 2", "| a |\n| :--- |\n| 1 |"]) {
      await expect(tool.invoke({ name: "t", table, summary: SUMMARY })).resolves.toBeTruthy();
    }
    expect(saved).toHaveBeenCalledTimes(2);
  });

  it("caps the summary in its schema, so an over-long one never reaches the handler", async () => {
    // The schema is where this belongs: a zod refusal is a model-visible error it can correct,
    // and it costs no code in the handler.
    const { tool } = build();
    await expect(
      tool.invoke({ name: "t", table: TABLE, summary: "x".repeat(TABLE_SUMMARY_MAX + 1) })
    ).rejects.toThrow();
  });

  it("names the tool and describes the inline copy, since that is the one thing it cannot do", () => {
    // The description is read when the model is deciding whether to call; the guidance in the
    // system prompt is read when it decides what to do with the turn. Both have to say it.
    const { tool } = build();
    expect(tool.name).toBe("ila_table");
    expect(tool.description).toContain("reply");
  });
});
