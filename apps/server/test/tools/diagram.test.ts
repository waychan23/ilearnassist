import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DIAGRAM_CHARS } from "@ilearnassist/shared";
import { buildDiagramTool } from "../../src/tools/diagram.js";

/**
 * A conversation's own directory — made by the session route in production, and made here
 * only when a case is *about* its absence.
 */
let sessionDir: string;
let workspace: string;

const FLOW = "flowchart TD\n  A[开始] --> B[结束]";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gl-diagram-"));
  sessionDir = join(workspace, "sessions", "s1");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A tool bound to the conversation's directory, made *after* any fixture setup. */
function build(): ReturnType<typeof buildDiagramTool> {
  return buildDiagramTool({ sessionDir });
}

describe("ila_diagram", () => {
  it("writes the diagram into the session directory, verbatim", async () => {
    const result = (await build().invoke({ name: "auth flow", source: FLOW })) as string;

    expect(readFileSync(join(sessionDir, "auth-flow.mmd"), "utf8")).toBe(FLOW);
    // The result names the file and says where it went — content the model reads, so it is
    // not translated and it is not a JSON blob.
    expect(result).toContain("auth-flow.mmd");
    expect(result).toContain("conversation's folder");
  });

  it("creates the directory when nothing has made it yet", async () => {
    // The session-time mkdir is best-effort on purpose, and the plan widget's "make a new
    // plan" fork never goes near that route at all — so the writer guarantees its directory.
    expect(existsSync(sessionDir)).toBe(false);
    await build().invoke({ name: "flow", source: FLOW });
    expect(existsSync(join(sessionDir, "flow.mmd"))).toBe(true);
  });

  it("overwrites on a second call with the same name, leaving no sibling", async () => {
    /*
     * This is the revise mechanism, not an accident of `writeFile`. A model correcting its own
     * diagram re-calls with the same name; a uniqueness suffix would turn that into
     * `flow-1.mmd` and leave the wrong diagram on screen next to the right one.
     */
    const tool = build();
    await tool.invoke({ name: "flow", source: "flowchart TD\n  A --> B" });
    await tool.invoke({ name: "flow", source: "flowchart LR\n  A --> B" });

    expect(readdirSync(sessionDir)).toEqual(["flow.mmd"]);
    expect(readFileSync(join(sessionDir, "flow.mmd"), "utf8")).toBe("flowchart LR\n  A --> B");
  });

  it("treats a name spelled with the extension as the same diagram", async () => {
    const tool = build();
    await tool.invoke({ name: "flow", source: "flowchart TD\n  A --> B" });
    await tool.invoke({ name: "flow.mmd", source: "flowchart LR\n  A --> B" });

    expect(readdirSync(sessionDir)).toEqual(["flow.mmd"]);
  });

  it("writes a `../` name inside the session directory", async () => {
    await build().invoke({ name: "../../escape", source: FLOW });

    expect(readdirSync(sessionDir)).toEqual(["escape.mmd"]);
    // The one thing that must not happen: a file beside the session's own directory.
    expect(readdirSync(join(workspace, "sessions"))).toEqual(["s1"]);
  });

  it("refuses an empty source rather than writing an empty diagram", async () => {
    // A model that calls this with nothing has made a mistake it can fix, so the refusal is a
    // `Tool error: …` it reads, not a silently empty file the user then has to look at.
    await expect(build().invoke({ name: "flow", source: "   \n  " })).rejects.toThrow(/empty/);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("refuses a source past the cap and writes nothing", async () => {
    await expect(
      build().invoke({ name: "flow", source: "x".repeat(MAX_DIAGRAM_CHARS + 1) })
    ).rejects.toThrow(new RegExp(String(MAX_DIAGRAM_CHARS)));
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("accepts a source exactly at the cap", async () => {
    await expect(
      build().invoke({ name: "flow", source: "x".repeat(MAX_DIAGRAM_CHARS) })
    ).resolves.toBeTypeOf("string");
  });

  it("accepts source it cannot parse, and says nothing about it", async () => {
    /*
     * Deliberately not validated. The viewer has to survive a diagram mermaid rejects anyway
     * — a model can be wrong in ways no schema describes — and a second validator here would
     * be a second opinion about what mermaid accepts, free to disagree with the mermaid that
     * draws it. The file is written; the render is where the failure is shown.
     */
    await expect(
      build().invoke({ name: "broken", source: "flowchart TD\n  A --> " })
    ).resolves.toBeTypeOf("string");
    expect(readFileSync(join(sessionDir, "broken.mmd"), "utf8")).toBe("flowchart TD\n  A --> ");
  });

  it("binds to the directory it was built for", async () => {
    // The closure is the sandbox: a tool built for one conversation writes into that
    // conversation's directory, whatever it is handed.
    const other = mkdtempSync(join(tmpdir(), "gl-diagram-other-"));
    try {
      await buildDiagramTool({ sessionDir: other }).invoke({ name: "flow", source: FLOW });
      expect(readFileSync(join(other, "flow.mmd"), "utf8")).toBe(FLOW);
      expect(existsSync(sessionDir)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
