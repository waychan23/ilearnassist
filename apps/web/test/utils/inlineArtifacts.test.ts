import { describe, expect, it } from "vitest";
import {
  buildInlineParts,
  parseArtifactMarkers,
  snapToBlockBoundary,
  type ArtifactSlot,
  type TextSegment,
} from "../../src/utils/inlineArtifacts.js";
import { renderMarkdown } from "../../src/utils/markdown.js";
import { stripInlineMarkers, type ToolCall } from "../../src/api/types.js";

/** A tool call with the given args object as JSON input. */
function call(
  name: string,
  args: Record<string, unknown>,
  extra?: Partial<ToolCall> & { id?: string }
): ToolCall {
  return {
    id: extra?.id ?? `call_${Math.random().toString(36).slice(2)}`,
    name,
    input: JSON.stringify(args),
    ...(extra?.output !== undefined ? { output: extra.output } : {}),
    ...(extra?.contentOffset !== undefined ? { contentOffset: extra.contentOffset } : {}),
  };
}

const diagramCall = (
  name: string,
  extra?: Partial<ToolCall> & { id?: string }
): ToolCall =>
  call(
    "ila_diagram",
    { name, source: "flowchart TD\n A-->B", summary: "s" },
    { output: "saved", ...extra }
  );

const LABELS = { copy: "Copy", copied: "Copied" };

describe("buildInlineParts — basic ordering", () => {
  it("returns one text part when there is no marker and no call", () => {
    const result = buildInlineParts("just prose", [], { settled: true });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ kind: "text", text: "just prose" });
    expect(result.legacyCalls).toEqual([]);
  });

  it("places a matched artifact between the two prose paragraphs", () => {
    const content = ["Before the figure.", "", "[[artifact:diagram/auth-flow]]", "", "After the figure."].join(
      "\n"
    );
    const result = buildInlineParts(content, [diagramCall("Auth Flow", { id: "call_1" })], {
      settled: true,
    });

    expect(result.parts.map((p) => p.kind)).toEqual(["text", "slot", "text"]);
    const slot = result.parts[1] as ArtifactSlot;
    expect(slot.toolCall?.id).toBe("call_1");
    expect(slot.status).toBe("done");
    expect((result.parts[0] as TextSegment).text).toContain("Before");
    expect((result.parts[2] as TextSegment).text).toContain("After");
    // The marker line left no text behind.
    expect(JSON.stringify(result.parts)).not.toContain("[[artifact");
  });
});

describe("buildInlineParts — diagram handle normalization", () => {
  it.each([
    ["auth-flow", "Auth Flow"],
    ["Auth Flow", "auth-flow"],
    ["auth-flow.mmd", "Auth Flow"],
    ["AUTH-FLOW.MMD", "auth-flow"],
  ])("resolves marker %s against call name %s", (markerHandle, callName) => {
    const content = `Intro\n\n[[artifact:diagram/${markerHandle}]]\n\nOutro`;
    const result = buildInlineParts(content, [diagramCall(callName)], { settled: true });

    const slot = result.parts.find((p) => p.kind === "slot");
    expect(slot).toBeDefined();
    expect((slot as ArtifactSlot).toolCall).toBeDefined();
  });

  it("keeps a CJK plot name through the slug", () => {
    const content = "Intro\n\n[[artifact:plot/函数曲线]]\n\nOutro";
    const plot = call("ila_plot", { name: "函数曲线", spec: { width: 400 } }, { output: "saved" });
    const result = buildInlineParts(content, [plot], { settled: true });

    const slot = result.parts.find((p) => p.kind === "slot") as ArtifactSlot;
    expect(slot.toolCall).toBeDefined();
  });
});

describe("buildInlineParts — file markers", () => {
  const fileContent = "x".repeat(20);

  it("matches a path-only marker against a backslash path", () => {
    const content = "Intro\n\n[[artifact:file/notes/a.txt]]\n\nOutro";
    const write = call(
      "write_file",
      { path: "notes\\a.txt", content: fileContent },
      { output: "Wrote" }
    );
    const result = buildInlineParts(content, [write], { settled: true });

    const slot = result.parts.find((p) => p.kind === "slot") as ArtifactSlot;
    expect(slot.toolCall).toBeDefined();
  });

  it("requires the location to match when the marker names one", () => {
    const content = "Intro\n\n[[artifact:file/a.txt?location=session]]\n\nOutro";

    const workspace = call(
      "write_file",
      { path: "a.txt", content: fileContent, location: "workspace" },
      { output: "Wrote" }
    );
    const noMatch = buildInlineParts(content, [workspace], { settled: true });
    expect((noMatch.parts.find((p) => p.kind === "slot") as ArtifactSlot).status).toBe(
      "dangling"
    );

    const session = call(
      "write_file",
      { path: "a.txt", content: fileContent, location: "session" },
      { output: "Wrote" }
    );
    const matched = buildInlineParts(content, [session], { settled: true });
    expect((matched.parts.find((p) => p.kind === "slot") as ArtifactSlot).toolCall).toBeDefined();
  });
});

describe("buildInlineParts — contentOffset backstop", () => {
  it("places the unmarked call at its snapped offset", () => {
    const content = "Intro paragraph.\n\nMore text.";
    const offset = "Intro paragraph.".length + "\n\n".length;
    const write = call(
      "write_file",
      { path: "a.txt", content: "x" },
      { output: "Wrote", contentOffset: offset }
    );
    const result = buildInlineParts(content, [write], { settled: true });

    expect(result.parts.map((p) => p.kind)).toEqual(["text", "slot", "text"]);
    const slot = result.parts[1] as ArtifactSlot;
    expect(slot.toolCall?.id).toBe(write.id);
  });

  it("sends a call with an out-of-range offset to legacy placement", () => {
    const write = call(
      "write_file",
      { path: "a.txt", content: "x" },
      { output: "Wrote", contentOffset: 999 }
    );
    const result = buildInlineParts("prose", [write], { settled: true });

    expect(result.legacyCalls).toEqual([write]);
    expect(result.parts.some((p) => p.kind === "slot")).toBe(false);
  });

  it("uses legacy placement when there is neither marker nor offset", () => {
    const write = diagramCall("x");
    const result = buildInlineParts("prose", [write], { settled: true });

    expect(result.legacyCalls).toEqual([write]);
  });
});

describe("buildInlineParts — streaming states", () => {
  const content = "Intro\n\n[[artifact:diagram/auth-flow]]\n\nOutro";

  it("is pending while unsettled and the call has not arrived", () => {
    const result = buildInlineParts(content, [], { settled: false });
    expect((result.parts.find((p) => p.kind === "slot") as ArtifactSlot).status).toBe("pending");
  });

  it("is dangling once settled and the call never arrived", () => {
    const result = buildInlineParts(content, [], { settled: true });
    expect((result.parts.find((p) => p.kind === "slot") as ArtifactSlot).status).toBe(
      "dangling"
    );
  });

  it("is running when the call has started, and done with a Tool error output", () => {
    const running = diagramCall("Auth Flow", { output: undefined });
    const runningResult = buildInlineParts(content, [running], { settled: false });
    expect(
      (runningResult.parts.find((p) => p.kind === "slot") as ArtifactSlot).status
    ).toBe("running");

    const failed = diagramCall("Auth Flow", { output: "Tool error: bad" });
    const failedResult = buildInlineParts(content, [failed], { settled: true });
    const slot = failedResult.parts.find((p) => p.kind === "slot") as ArtifactSlot;
    expect(slot.status).toBe("done");
    expect(slot.toolCall?.output).toContain("Tool error");
  });
});

describe("parseArtifactMarkers", () => {
  it("does not return marker-like text inside a code fence", () => {
    const content = "```\n[[artifact:diagram/x]]\n```\nprose";
    expect(parseArtifactMarkers(content)).toEqual([]);

    const result = buildInlineParts(content, [diagramCall("x")], { settled: true });
    expect(result.parts.some((p) => p.kind === "slot")).toBe(false);
  });

  it("handles duplicate markers: one matches, the second stays dangling", () => {
    const content =
      "[[artifact:diagram/x]]\n[[artifact:diagram/x]]";
    const result = buildInlineParts(content, [diagramCall("x")], { settled: true });

    const slots = result.parts.filter((p) => p.kind === "slot") as ArtifactSlot[];
    expect(slots).toHaveLength(2);
    expect(slots[0]!.toolCall).toBeDefined();
    expect(slots[1]!.status).toBe("dangling");
  });
});

describe("snapToBlockBoundary", () => {
  it("snaps forward past a fence", () => {
    const content = "```py\ncode\n```\npara";
    const snapped = snapToBlockBoundary(content, "```py\nco".length);
    expect(snapped).toBe(content.indexOf("para"));
  });

  it("snaps forward from a paragraph to its end", () => {
    const content = "before\n\nafter";
    const snapped = snapToBlockBoundary(content, 2);
    expect(content.slice(snapped)).toBe("\nafter");
  });

  it("snaps a list item to the next item start", () => {
    const content = "- one\n- two";
    const snapped = snapToBlockBoundary(content, 3);
    expect(snapped).toBe(content.indexOf("- two"));
  });

  it("snaps forward past a table", () => {
    const content = "| a | b |\n| - | - |\n| 1 | 2 |";
    const snapped = snapToBlockBoundary(content, 5);
    expect(snapped).toBe(content.length);
  });

  it("returns an offset on a blank line unchanged", () => {
    const content = "one\n\ntwo";
    const offset = content.indexOf("\n\ntwo") + 1; // the blank line
    expect(snapToBlockBoundary(content, offset)).toBe(offset);
  });
});

describe("segment markdown", () => {
  it("keeps an ordered list split across segments continuous via start attribute", () => {
    const html = renderMarkdown("2. two\n3. three", LABELS);
    expect(html).toContain('<ol start="2">');
  });
});

describe("stripInlineMarkers", () => {
  it("drops a marker-only line and keeps surrounding prose", () => {
    const text = stripInlineMarkers("before\n\n[[artifact:diagram/x]]\n\nafter");
    expect(text).toBe("before\n\nafter");
  });

  it("removes an inline marker and keeps the rest of the line", () => {
    const text = stripInlineMarkers("see [[artifact:diagram/x]] now");
    expect(text).toBe("see  now");
  });

  it("preserves marker-like text inside a fence", () => {
    const text = stripInlineMarkers("```\n[[artifact:diagram/x]]\n```");
    expect(text).toContain("[[artifact:diagram/x]]");
  });
});
