import { describe, expect, it } from "vitest";
import { diagramFileName } from "@ilearnassist/shared";

/**
 * The naming rule, tested from the server because this is where the diagram feature lives.
 * The function itself is in `packages/shared`: the client works out the same name when it
 * matches a tool call to the file it wrote.
 */
describe("diagramFileName", () => {
  it("kebab-cases a name and gives it the diagram extension", () => {
    expect(diagramFileName("Auth Flow")).toBe("auth-flow.mmd");
  });

  it("keeps CJK, because a slug is meant to stay readable", () => {
    // `slugify` filters on `\p{Letter}`, which Han is — deliberately, and the file browser's
    // `?path=` query parameter exists for the same reason (names legitimately hold CJK). A
    // transliteration scheme here would be a name nobody recognises in their own folder.
    expect(diagramFileName("架构图")).toBe("架构图.mmd");
    expect(diagramFileName("登录流程 图")).toBe("登录流程-图.mmd");
  });

  it("falls back when nothing survives the filter", () => {
    // Not "workspace": that is `slugify`'s default and would be a quiet lie about the file.
    expect(diagramFileName("!!!")).toBe("diagram.mmd");
    expect(diagramFileName("")).toBe("diagram.mmd");
    expect(diagramFileName("   ")).toBe("diagram.mmd");
  });

  it("does not double an extension the model already wrote", () => {
    // A model that passes "auth-flow.mmd" means the same diagram as one that passes
    // "auth-flow"; slugify alone would make `auth-flow-mmd.mmd` of it.
    expect(diagramFileName("auth-flow.mmd")).toBe("auth-flow.mmd");
    expect(diagramFileName("auth-flow.mermaid")).toBe("auth-flow.mmd");
    expect(diagramFileName("AUTH-FLOW.MMD")).toBe("auth-flow.mmd");
  });

  it("turns a traversal attempt into an ordinary name", () => {
    // The tool still resolves through the sandbox; this is what makes that a formality.
    expect(diagramFileName("../../etc/passwd")).toBe("etc-passwd.mmd");
    expect(diagramFileName("..")).toBe("diagram.mmd");
    expect(diagramFileName("/etc/passwd")).toBe("etc-passwd.mmd");
  });

  it("never returns a path separator or a leading dot", () => {
    for (const name of ["a/b", "..", ".hidden", "a\\b", "a:b", "/abs"]) {
      const file = diagramFileName(name);
      expect(file).not.toContain("/");
      expect(file).not.toContain("\\");
      expect(file.startsWith(".")).toBe(false);
    }
  });

  it("caps the name and keeps the extension", () => {
    const file = diagramFileName("x".repeat(200));
    expect(file.endsWith(".mmd")).toBe(true);
    expect(file.length).toBe(48 + ".mmd".length);
  });

  it("is stable, so a revise call names the same file", () => {
    // The whole revise mechanism: same name in, same file out, so the second call overwrites
    // rather than leaving two diagrams of one thing on screen.
    expect(diagramFileName("Auth Flow")).toBe(diagramFileName("auth flow"));
    expect(diagramFileName("  auth-flow  ")).toBe(diagramFileName("auth-flow"));
  });
});
