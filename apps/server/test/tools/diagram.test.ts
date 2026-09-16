import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DIAGRAM_CHARS } from "@ilearnassist/shared";
import { buildDiagramTool, type DiagramSaveInput } from "../../src/tools/diagram.js";

/**
 * A conversation's own directory — made by the session route in production, and made here
 * only when a case is *about* its absence.
 */
let sessionDir: string;
let workspace: string;

const FLOW = "flowchart TD\n  A[开始] --> B[结束]";
const SUMMARY = "登录流程：提交凭证、校验、签发会话。";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gl-diagram-"));
  sessionDir = join(workspace, "sessions", "s1");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A tool bound to the conversation's directory, recording every row it asks to save. */
function build(save: (input: DiagramSaveInput) => void = () => undefined) {
  return {
    saved: save,
    tool: buildDiagramTool({ sessionDir, save }),
  };
}

describe("ila_diagram", () => {
  it("writes the diagram into the session directory, verbatim", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    const result = (await tool.invoke({ name: "auth flow", source: FLOW, summary: SUMMARY })) as string;

    expect(readFileSync(join(sessionDir, "auth-flow.mmd"), "utf8")).toBe(FLOW);
    // The result names the file, says where it went, and echoes the summary back — model
    // input, so it is not translated and not a JSON blob.
    expect(result).toContain("auth-flow.mmd");
    expect(result).toContain("conversation's folder");
    expect(result).toContain(SUMMARY);
    expect(saved).toHaveBeenCalledOnce();
  });

  it("saves a row with the canonical file name and the model's summary", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    await tool.invoke({ name: "Auth Flow", source: FLOW, summary: SUMMARY });

    // The canonical name is what the row joins to the file: "Auth Flow" and "auth flow" are
    // one file, so they have to be one row.
    expect(saved).toHaveBeenCalledWith({
      name: "auth-flow.mmd",
      size: expect.any(Number),
      summary: SUMMARY,
      toolCallId: null,
    });
  });

  it("records the tool-call id the invoke config carries", async () => {
    const saved = vi.fn();
    const { tool } = build(saved);
    await tool.invoke(
      { name: "flow", source: FLOW, summary: SUMMARY },
      { configurable: { toolCallId: "call_42" } }
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "call_42" })
    );
  });

  it("creates the directory when nothing has made it yet", async () => {
    // The session-time mkdir is best-effort on purpose, and the plan widget's "make a new
    // plan" fork never goes near that route at all — so the writer guarantees its directory.
    expect(existsSync(sessionDir)).toBe(false);
    await build().tool.invoke({ name: "flow", source: FLOW, summary: SUMMARY });
    expect(existsSync(join(sessionDir, "flow.mmd"))).toBe(true);
  });

  it("overwrites on a second call with the same name, leaving no sibling", async () => {
    /*
     * This is the revise mechanism, not an accident of `writeFile`. A model correcting its
     * own diagram re-calls with the same name; a uniqueness suffix would turn that into
     * `flow-1.mmd` and leave the wrong diagram on screen next to the right one.
     */
    const saved = vi.fn();
    const tool = build(saved).tool;
    await tool.invoke({ name: "flow", source: "flowchart TD\n  A --> B", summary: "一版" });
    await tool.invoke({ name: "flow", source: "flowchart LR\n  A --> B", summary: "二版" });

    expect(readdirSync(sessionDir)).toEqual(["flow.mmd"]);
    expect(readFileSync(join(sessionDir, "flow.mmd"), "utf8")).toBe("flowchart LR\n  A --> B");
    // Both calls save to the same file name, so the upsert (in db.ts) has one row to revise.
    expect(saved.mock.calls.map((c) => c[0].name)).toEqual(["flow.mmd", "flow.mmd"]);
    expect(saved.mock.calls[1]?.[0].summary).toBe("二版");
  });

  it("treats a name spelled with the extension as the same diagram", async () => {
    const saved = vi.fn();
    const tool = build(saved).tool;
    await tool.invoke({ name: "flow", source: "flowchart TD\n  A --> B", summary: "一版" });
    await tool.invoke({ name: "flow.mmd", source: "flowchart LR\n  A --> B", summary: "二版" });

    expect(readdirSync(sessionDir)).toEqual(["flow.mmd"]);
    expect(saved.mock.calls.map((c) => c[0].name)).toEqual(["flow.mmd", "flow.mmd"]);
  });

  it("writes a `../` name inside the session directory", async () => {
    await build().tool.invoke({ name: "../../escape", source: FLOW, summary: SUMMARY });

    expect(readdirSync(sessionDir)).toEqual(["escape.mmd"]);
    // The one thing that must not happen: a file beside the session's own directory.
    expect(readdirSync(join(workspace, "sessions"))).toEqual(["s1"]);
  });

  it("refuses an empty source and writes neither a file nor a row", async () => {
    // A model that calls this with nothing has made a mistake it can fix, so the refusal is a
    // `Tool error: …` it reads, not a silently empty file.
    const saved = vi.fn();
    await expect(
      build(saved).tool.invoke({ name: "flow", source: "   \n  ", summary: SUMMARY })
    ).rejects.toThrow(/empty/);
    expect(existsSync(sessionDir)).toBe(false);
    expect(saved).not.toHaveBeenCalled();
  });

  it("refuses a source past the cap and writes neither a file nor a row", async () => {
    const saved = vi.fn();
    await expect(
      build(saved).tool.invoke({
        name: "flow",
        source: "x".repeat(MAX_DIAGRAM_CHARS + 1),
        summary: SUMMARY,
      })
    ).rejects.toThrow(new RegExp(String(MAX_DIAGRAM_CHARS)));
    expect(existsSync(sessionDir)).toBe(false);
    expect(saved).not.toHaveBeenCalled();
  });

  it("does not save a row when the file write fails", async () => {
    /*
     * This pins the file-then-row ordering itself, rather than a validation refusal: point
     * the session directory under a path where a *file* stands in for a parent, so the
     * recursive mkdir throws before the file can be written. A row written first would be
     * the worse half to leave behind — a diagram that errors when opened — and this guards
     * the reverse order the tool relies on.
     */
    writeFileSync(join(workspace, "blocker"), "i am a file");
    const saved = vi.fn();
    const tool = buildDiagramTool({
      sessionDir: join(workspace, "blocker", "s1"),
      save: saved,
    });
    await expect(
      tool.invoke({ name: "flow", source: FLOW, summary: SUMMARY })
    ).rejects.toThrow();
    expect(saved).not.toHaveBeenCalled();
  });

  it("accepts a source exactly at the cap", async () => {
    const saved = vi.fn();
    await expect(
      build(saved).tool.invoke({
        name: "flow",
        source: "x".repeat(MAX_DIAGRAM_CHARS),
        summary: SUMMARY,
      })
    ).resolves.toBeTypeOf("string");
    expect(saved).toHaveBeenCalledOnce();
  });

  it("accepts source it cannot parse, and says nothing about it", async () => {
    /*
     * Deliberately not validated. The viewer has to survive a diagram mermaid rejects anyway
     * — a model can be wrong in ways no schema describes — and a second validator here would
     * be a second opinion about what mermaid accepts, free to disagree with the mermaid that
     * draws it. The file is written; the render is where the failure is shown.
     */
    const saved = vi.fn();
    await expect(
      build(saved).tool.invoke({
        name: "broken",
        source: "flowchart TD\n  A --> ",
        summary: SUMMARY,
      })
    ).resolves.toBeTypeOf("string");
    expect(readFileSync(join(sessionDir, "broken.mmd"), "utf8")).toBe("flowchart TD\n  A --> ");
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: "broken.mmd" }));
  });

  it("binds to the directory it was built for", async () => {
    // The closure is the sandbox: a tool built for one conversation writes into that
    // conversation's directory, whatever it is handed.
    const other = mkdtempSync(join(tmpdir(), "gl-diagram-other-"));
    try {
      await buildDiagramTool({ sessionDir: other, save: () => undefined }).invoke({
        name: "flow",
        source: FLOW,
        summary: SUMMARY,
      });
      expect(readFileSync(join(other, "flow.mmd"), "utf8")).toBe(FLOW);
      expect(existsSync(sessionDir)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
