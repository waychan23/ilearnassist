import { describe, expect, it } from "vitest";
import {
  addAll,
  addWorkspace,
  isAll,
  isGranted,
  removeWorkspace,
  scopeChipIds,
} from "../../src/utils/workspaceScope";

/**
 * The `@` grant's client-side arithmetic.
 *
 * Every case here is about not leaving a grant behind: the value this produces is written to
 * `session.settings` and read back on later turns, so a leftover `{all: false, workspaceIds: []}`
 * or a `workspaceIds` hidden under `all` is a conversation that reads more — or looks like it
 * reads more — than the chips on screen say.
 */

describe("addWorkspace", () => {
  it("names one workspace in an empty grant", () => {
    expect(addWorkspace(null, "w1")).toEqual({ all: false, workspaceIds: ["w1"] });
  });

  it("appends, keeping the order they were picked in", () => {
    const first = addWorkspace(null, "w1");
    expect(addWorkspace(first, "w2")).toEqual({ all: false, workspaceIds: ["w1", "w2"] });
  });

  it("is idempotent, so a stale row cannot double an id", () => {
    const once = addWorkspace(null, "w1");
    expect(addWorkspace(once, "w1")).toEqual({ all: false, workspaceIds: ["w1"] });
  });

  it("replaces an `all` grant rather than adding beneath it", () => {
    // `all` already covers every workspace, so a named one under it is a list nobody can see.
    // Picking a workspace is a narrower decision than the one on the screen, so it wins.
    expect(addWorkspace(addAll(), "w1")).toEqual({ all: false, workspaceIds: ["w1"] });
  });
});

describe("addAll", () => {
  it("grants every workspace and drops the list", () => {
    const named = addWorkspace(addWorkspace(null, "w1"), "w2");
    expect(addAll()).toEqual({ all: true });
    expect(scopeChipIds(addAll())).toEqual([]);
    // The named one is not carried underneath: `all` is a superset, and a hidden list under a
    // flag that already covers it is state nobody can remove.
    expect(addAll()).not.toHaveProperty("workspaceIds");
    expect(scopeChipIds(named)).toEqual(["w1", "w2"]);
  });
});

describe("removeWorkspace", () => {
  it("takes one out and keeps the rest", () => {
    const scope = addWorkspace(addWorkspace(null, "w1"), "w2");
    expect(removeWorkspace(scope, "w1")).toEqual({ all: false, workspaceIds: ["w2"] });
  });

  it("returns null when the last one goes, never an empty object", () => {
    /*
     * The rule the whole module exists for. An empty `{all: false, workspaceIds: []}` is `!= null`,
     * so `createSession` would send it and the conversation would be stored carrying a grant that
     * grants nothing — which reads, to anyone looking at the settings blob, exactly like one that
     * grants something. `null` is the single representation of "no grant" on both sides.
     */
    expect(removeWorkspace(addWorkspace(null, "w1"), "w1")).toBeNull();
    expect(removeWorkspace(null, "w1")).toBeNull();
  });

  it("leaves an `all` grant alone, because removing one name is not removing everything", () => {
    // There is no workspace to remove from `all`; the chip row for it is a single toggle, and
    // `removeWorkspace` is not the control that turns it off.
    expect(removeWorkspace(addAll(), "w1")).toBeNull();
  });
});

describe("isGranted / isAll", () => {
  it("is true for a named workspace and false otherwise", () => {
    const scope = addWorkspace(null, "w1");
    expect(isGranted(scope, "w1")).toBe(true);
    expect(isGranted(scope, "w2")).toBe(false);
    expect(isGranted(null, "w1")).toBe(false);
  });

  it("is true for every workspace under `all`", () => {
    expect(isGranted(addAll(), "anything")).toBe(true);
    expect(isAll(addAll())).toBe(true);
    expect(isAll(null)).toBe(false);
    expect(isAll(addWorkspace(null, "w1"))).toBe(false);
  });
});
