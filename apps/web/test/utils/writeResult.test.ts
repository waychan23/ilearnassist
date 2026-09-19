import { describe, expect, it } from "vitest";
import { resolvedRoot, writtenFile } from "../../src/utils/writeResult";

/**
 * Reading a `write_file` result back.
 *
 * The sentence is the only place two facts exist — which sandbox the write resolved to, and which
 * reference it became — so this is a parser, and a parser's cases are its refusals. The server's
 * own test pins the sentence (`tools/fileTools.test.ts`); what is here is what the card does with
 * a result that is missing, malformed, or shaped like something it is not.
 */

const ID = "3f1c0b3e-9a44-4c1e-8f77-2b6d5a1e0c99";

describe("the root a write landed in", () => {
  it("reads the folder the tool named", () => {
    expect(writtenFile(`Wrote 5 characters to a.txt in the session folder (id ${ID}).`).root).toBe(
      "session"
    );
    expect(
      writtenFile(`Wrote 5 characters to a.txt in the workspace folder (id ${ID}).`).root
    ).toBe("workspace");
  });

  it("reports no root for a result that names none", () => {
    // A call still running, or one that failed. The card is not the place to guess — see
    // `resolvedRoot`, which is where the fallback chain lives.
    expect(writtenFile("").root).toBeNull();
    expect(writtenFile("Tool error: that path is outside the folder.").root).toBeNull();
  });

  it("falls back to the call's own argument, and then to the product default", () => {
    const unknown = writtenFile("");
    expect(resolvedRoot(unknown, "workspace")).toBe("workspace");
    // `session` is what the write itself would have resolved to when the argument was omitted.
    expect(resolvedRoot(unknown, undefined)).toBe("session");
    // ...and the argument never overrides what the result actually said.
    expect(resolvedRoot(writtenFile("in the session folder"), "workspace")).toBe("session");
  });
});

describe("the reference the write became", () => {
  it("reads the id out of the sentence", () => {
    expect(writtenFile(`Wrote 5 characters to a.txt in the session folder (id ${ID}).`).referenceId)
      .toBe(ID);
  });

  it("reports no id when the write made no reference", () => {
    // A caller whose registry wrote no row: the sentence is there and simply carries no id.
    expect(writtenFile("Wrote 5 characters to a.txt in the session folder.").referenceId).toBe("");
  });

  it("is not fooled by a file whose name looks like an id", () => {
    /*
     * The loose pattern — anything in parentheses — binds `"42"` here, and the card's 标注/笔记
     * control then renders live against a reference nothing answers. A button that renders and
     * cannot work is the failure this repository names most often, and a filename is enough to
     * cause it.
     */
    const file = writtenFile("Wrote 5 characters to notes (id 42).md in the session folder.");
    expect(file.referenceId).toBe("");
  });

  it("reads the trailing id even when the path itself has parentheses", () => {
    // The path cannot be mistaken for the id, and the id is still found — the two are told apart
    // by shape rather than by position alone.
    const file = writtenFile(`Wrote 5 characters to notes (id 42).md in the session folder (id ${ID}).`);
    expect(file.referenceId).toBe(ID);
  });
});
