import { describe, expect, it } from "vitest";
import { parseOrdinal, uniqueSessionTitle } from "../src/sessionTitles.js";

/** `isTaken` over a fixed list, which is all the module ever sees. */
const takenIn =
  (titles: readonly string[]) =>
  (t: string): boolean =>
    titles.includes(t);

describe("parseOrdinal", () => {
  it("splits a trailing number off a title", () => {
    expect(parseOrdinal("学习计划 (2)")).toEqual({ base: "学习计划", n: 2 });
  });

  it("reads only the last group, so copies of copies do not stack", () => {
    expect(parseOrdinal("报告 (2) (3)")).toEqual({ base: "报告 (2)", n: 3 });
  });

  it("returns null for a title with no number", () => {
    expect(parseOrdinal("学习计划")).toBeNull();
  });

  it("needs a space before the bracket, so a name that merely ends in one is left alone", () => {
    // `版本(2)` is a name somebody typed, not something this module wrote — it always writes
    // the space, and reading it back has to be the same rule.
    expect(parseOrdinal("版本(2)")).toBeNull();
  });

  it("treats a title that is nothing but a number as its own name", () => {
    // The base would be empty, and "the second copy of nothing" is not a name.
    expect(parseOrdinal(" (2)")).toBeNull();
  });
});

describe("uniqueSessionTitle", () => {
  it("leaves a free title alone", () => {
    expect(uniqueSessionTitle("学习计划", takenIn([]))).toBe("学习计划");
  });

  it("numbers the first duplicate (2), the file-manager convention", () => {
    expect(uniqueSessionTitle("学习计划", takenIn(["学习计划"]))).toBe("学习计划 (2)");
  });

  it("takes the lowest free number rather than one past the highest", () => {
    const taken = ["学习计划", "学习计划 (3)"];
    // (2) is empty because (2) was deleted — the number comes back rather than climbing.
    expect(uniqueSessionTitle("学习计划", takenIn(taken))).toBe("学习计划 (2)");
  });

  it("continues from the number a name already carries", () => {
    // Somebody renamed to `报告 (5)`; being moved *down* to `报告 (2)` because that slot
    // happened to be free would be a rename they did not ask for.
    expect(uniqueSessionTitle("报告 (5)", takenIn(["报告 (5)"]))).toBe("报告 (6)");
  });

  it("does not collide with the copy a numbered name came from", () => {
    const taken = ["学习计划", "学习计划 (2)"];
    expect(uniqueSessionTitle("学习计划 (2)", takenIn(taken))).toBe("学习计划 (3)");
  });

  it("terminates on a title that is only an ordinal", () => {
    // `(2)` alone is not parsed, so it grows a suffix of its own rather than looping.
    expect(uniqueSessionTitle("(2)", takenIn(["(2)"]))).toBe("(2) (2)");
  });
});
