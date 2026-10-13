import { describe, expect, it } from "vitest";
import {
  collectRepairTargets,
} from "../src/artifactVerify.js";
import {
  isToolErrorOutput,
  type ToolCall,
} from "@ilearnassist/shared";

/**
 * Pure programmatic detection — the convention that replaced LLM/marker-only detection.
 *
 * `isToolErrorOutput` reads the agent loop's failure convention; `collectRepairTargets`
 * builds the repair worklist from markers and calls with no I/O of its own (the presence
 * check is injected).
 */
describe("isToolErrorOutput", () => {
  it("recognises the loop's failure strings", () => {
    expect(isToolErrorOutput("Tool error: bad path")).toBe(true);
    expect(isToolErrorOutput(`Unknown tool "x".`)).toBe(true);
  });

  it("treats ordinary results and absent output as not failures", () => {
    expect(isToolErrorOutput("Wrote 12 characters to x in the session folder")).toBe(false);
    expect(isToolErrorOutput("")).toBe(false);
    expect(isToolErrorOutput(undefined)).toBe(false);
  });
});

function call(partial: Partial<ToolCall> & { id: string; name: string }): ToolCall {
  return { input: "{}", ...partial };
}

describe("collectRepairTargets", () => {
  it("reports a marker with no call as a marker target", () => {
    const targets = collectRepairTargets(
      "see [[artifact:diagram/ghost]]",
      [],
      () => true
    );
    expect(targets).toEqual([
      { kind: "diagram", handle: "ghost", markerStart: 4 },
    ]);
  });

  it("reports a marker whose call failed, keeping both addresses", () => {
    const calls = [
      call({
        id: "c1",
        name: "ila_diagram",
        input: JSON.stringify({ name: "ghost" }),
        output: "Tool error: empty source",
      }),
    ];
    const targets = collectRepairTargets(
      "[[artifact:diagram/ghost]]",
      calls,
      () => false
    );
    expect(targets).toEqual([
      { kind: "diagram", handle: "ghost", markerStart: 0, callId: "c1" },
    ]);
  });

  it("reports a successful call whose entity is missing", () => {
    const calls = [
      call({
        id: "c1",
        name: "ila_diagram",
        input: JSON.stringify({ name: "ghost", source: "x" }),
        output: "saved",
      }),
    ];
    const targets = collectRepairTargets(
      "[[artifact:diagram/ghost]]",
      calls,
      () => false
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.callId).toBe("c1");
  });

  it("leaves a successful, present artifact alone", () => {
    const calls = [
      call({
        id: "c1",
        name: "ila_diagram",
        input: JSON.stringify({ name: "ghost", source: "x" }),
        output: "saved",
      }),
    ];
    expect(
      collectRepairTargets("[[artifact:diagram/ghost]]", calls, () => true)
    ).toEqual([]);
  });

  it("retries a failed call that has no marker", () => {
    const calls = [
      call({
        id: "c1",
        name: "write_file",
        input: JSON.stringify({ path: "a.md", content: "x" }),
        output: "Tool error: escape refused",
      }),
    ];
    const targets = collectRepairTargets("writing", calls, () => false);
    expect(targets).toEqual([
      { kind: "file", handle: "a.md", callId: "c1" },
    ]);
  });

  it("deduplicates one identity across a marker and a call", () => {
    const calls = [
      call({
        id: "c1",
        name: "ila_diagram",
        input: JSON.stringify({ name: "ghost" }),
        output: "Tool error: x",
      }),
    ];
    const targets = collectRepairTargets(
      "[[artifact:diagram/ghost]]",
      calls,
      () => false
    );
    expect(targets).toHaveLength(1);
    // Marker address wins — its card renders in place.
    expect(targets[0]!.markerStart).toBe(0);
  });
});
