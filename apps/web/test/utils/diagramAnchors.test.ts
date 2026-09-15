import { describe, expect, it } from "vitest";
import type { Message } from "@ilearnassist/shared";
import { diagramAnchors } from "../../src/utils/diagramAnchors.js";

/**
 * The join between a tool call and the file it wrote.
 *
 * Worth a test of its own because the two sides spell the name differently by construction —
 * the call carries what the model chose, the directory carries what the server made of it —
 * and a mismatch is invisible: the list still renders, the diagram still opens, and only the
 * "go to the reply that drew it" button is quietly absent or on the wrong row.
 */

/** A message carrying one tool call, which is all this derivation reads. */
function withCall(name: string, input: unknown, id = "call_1"): Message {
  return {
    id: `m-${id}`,
    sessionId: "s1",
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCalls: [{ id, name, input: typeof input === "string" ? input : JSON.stringify(input) }],
  };
}

describe("diagramAnchors", () => {
  it("keys a call by the file name the server would have written", () => {
    const anchors = diagramAnchors([withCall("ila_diagram", { name: "Auth Flow" }, "c1")]);

    // Not "Auth Flow": the directory holds `auth-flow.mmd`, and that is what the listing gives
    // a row to look itself up by.
    expect(anchors.get("auth-flow.mmd")).toBe("c1");
    expect(anchors.has("Auth Flow")).toBe(false);
  });

  it("keeps CJK names, which is what the server's slug does", () => {
    const anchors = diagramAnchors([withCall("ila_diagram", { name: "登录流程图" }, "c1")]);
    expect(anchors.get("登录流程图.mmd")).toBe("c1");
  });

  it("ignores every other tool's calls", () => {
    const anchors = diagramAnchors([
      withCall("write_file", { path: "a.txt", content: "x" }, "w1"),
      withCall("ask_user", { questions: [] }, "a1"),
    ]);
    expect(anchors.size).toBe(0);
  });

  it("ignores arguments that are not JSON, or carry no name", () => {
    const anchors = diagramAnchors([
      withCall("ila_diagram", "{ not json", "c1"),
      withCall("ila_diagram", { source: "flowchart TD" }, "c2"),
      withCall("ila_diagram", { name: 42 }, "c3"),
    ]);
    expect(anchors.size).toBe(0);
  });

  it("points a revised diagram at the latest call", () => {
    // A revision is the same name called again with corrected source. One file, one row, and
    // the reply worth scrolling to is the one that drew what is on screen now.
    const anchors = diagramAnchors([
      withCall("ila_diagram", { name: "flow" }, "first"),
      withCall("ila_diagram", { name: "flow" }, "second"),
    ]);
    expect(anchors.get("flow.mmd")).toBe("second");
  });

  it("finds calls across several messages", () => {
    const anchors = diagramAnchors([
      withCall("ila_diagram", { name: "one" }, "a"),
      withCall("ila_diagram", { name: "two" }, "b"),
    ]);
    expect([...anchors.keys()].sort()).toEqual(["one.mmd", "two.mmd"]);
  });

  it("treats a name spelled with the extension as the same diagram", () => {
    const anchors = diagramAnchors([withCall("ila_diagram", { name: "flow.mmd" }, "c1")]);
    expect(anchors.get("flow.mmd")).toBe("c1");
  });
});
