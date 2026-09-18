import { describe, expect, it } from "vitest";
import {
  DIAGRAM_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  type ToolCall,
} from "@ilearnassist/shared";
import {
  groupHead,
  groupToolCalls,
  isGroupableToolCall,
  runningToolCall,
  type ToolCallRun,
} from "../../src/utils/toolCallGroups";

/**
 * The folded run's arithmetic. This is why it is not in the component: which calls end up on
 * one line is a rule, and a rule buried in a `.vue` file is covered by Playwright or by
 * nothing.
 */

function call(id: string, name = "web_search", output?: string): ToolCall {
  return { id, name, input: "{}", ...(output === undefined ? {} : { output }) };
}

/** The shape of a run, as a readable string — `"g2"` is a group of two calls. */
const shape = (runs: ToolCallRun[]): string[] =>
  runs.map((run) => (run.kind === "single" ? `1:${run.call.id}` : `g${run.calls.length}`));

/** Every call the runs cover, in order, however it was grouped. */
const ids = (runs: ToolCallRun[]): string[] =>
  runs.flatMap((run) => (run.kind === "single" ? [run.call.id] : run.calls.map((c) => c.id)));

describe("groupToolCalls", () => {
  it("returns nothing for no calls", () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it("leaves a lone call as the card it always was", () => {
    expect(shape(groupToolCalls([call("a")]))).toEqual(["1:a"]);
  });

  it("folds a run of two, which is the threshold", () => {
    expect(shape(groupToolCalls([call("a"), call("b")]))).toEqual(["g2"]);
  });

  it("folds a longer run into one entry", () => {
    expect(shape(groupToolCalls([call("a"), call("b"), call("c"), call("d")]))).toEqual(["g4"]);
  });

  it("keeps a group's calls in their original order", () => {
    const first = groupToolCalls([call("a"), call("b"), call("c")])[0];
    expect(first?.kind === "group" ? first.calls.map((c) => c.id) : []).toEqual(["a", "b", "c"]);
  });

  it("breaks a run around a diagram rather than hiding the drawing in it", () => {
    const runs = groupToolCalls([
      call("a"),
      call("b"),
      call("draw", DIAGRAM_TOOL_NAME),
      call("c"),
      call("d"),
    ]);
    expect(shape(runs)).toEqual(["g2", "1:draw", "g2"]);
  });

  it("breaks a run around an interactive call", () => {
    // Interactive calls are filtered out by `MessageItem` before they reach here, so this is
    // the guard that keeps that true if a call site changes: a question must never end up
    // inside a collapsed line.
    const runs = groupToolCalls([call("a"), call("b"), call("q", "ask_user"), call("c"), call("d")]);
    expect(shape(runs)).toEqual(["g2", "1:q", "g2"]);
  });

  it("never swallows a card: every call appears exactly once", () => {
    const calls = [call("a"), call("b"), call("draw", DIAGRAM_TOOL_NAME), call("c")];
    expect(ids(groupToolCalls(calls))).toEqual(["a", "b", "draw", "c"]);
  });

  it("folds calls that differ only in name, since a run is consecutive regardless", () => {
    expect(shape(groupToolCalls([call("a", "web_search"), call("b", "read_file")]))).toEqual(["g2"]);
  });
});

describe("isGroupableToolCall", () => {
  it("accepts an ordinary action", () => {
    expect(isGroupableToolCall(call("a", "read_file"))).toBe(true);
  });

  it("refuses a diagram, whose card renders the artifact", () => {
    expect(isGroupableToolCall(call("a", DIAGRAM_TOOL_NAME))).toBe(false);
  });

  it("refuses a write, whose card renders the file", () => {
    // The diagram's reason in a second place: a write is not a step on the way to an answer but a
    // thing the conversation now holds, so a turn that writes one and reads two others must not
    // file the file under "3 个工具调用".
    expect(isGroupableToolCall(call("a", WRITE_FILE_TOOL_NAME))).toBe(false);
  });

  it("refuses each interactive tool", () => {
    for (const name of ["ask_user", "ila_quiz", "ila_make_plan"]) {
      expect(isGroupableToolCall(call("a", name))).toBe(false);
    }
  });
});

describe("runningToolCall", () => {
  it("is undefined once every call has an output", () => {
    const calls = [call("a", "read_file", "done"), call("b", "read_file", "done")];
    expect(runningToolCall(calls)).toBeUndefined();
  });

  it("finds the call that has not finished", () => {
    expect(runningToolCall([call("a", "read_file", "done"), call("b", "read_file")])?.id).toBe("b");
  });

  it("takes the last of several in flight, which is where the model is now", () => {
    expect(runningToolCall([call("a"), call("b"), call("c")])?.id).toBe("c");
  });

  it("does not treat an empty output as still running", () => {
    // A call that finished and returned nothing is finished — the test is on the field being
    // present, not on it being truthy.
    expect(runningToolCall([call("a", "read_file", "")])).toBeUndefined();
  });

  it("is undefined for no calls", () => {
    expect(runningToolCall([])).toBeUndefined();
  });
});

describe("groupHead", () => {
  /**
   * The branch the collapsed head takes. Pinned here rather than in the browser because the
   * offline e2e suite has no tool slow enough to be caught mid-flight — every tool it can
   * reach is a local file operation — so a spec could only assert the settled half.
   */
  it("names the call in flight, and nothing else", () => {
    const calls = [call("a", "read_file", "done"), call("b", "web_search")];
    expect(groupHead(calls)).toEqual({ kind: "running", name: "web_search" });
  });

  it("counts the run once every call has finished", () => {
    const calls = [call("a", "read_file", "done"), call("b", "read_file", "done")];
    expect(groupHead(calls)).toEqual({ kind: "count", count: 2 });
  });

  it("counts a run whose calls all returned nothing", () => {
    // `output: ""` is a finished call, so the head reports a count rather than naming a tool
    // that is not actually running.
    expect(groupHead([call("a", "read_file", ""), call("b", "read_file", "")])).toEqual({
      kind: "count",
      count: 2,
    });
  });
});
