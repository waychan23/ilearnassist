import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebFetchConfig, WebSearchConfig } from "../../src/config.js";
import { ALL_TOOL_NAMES, buildTools } from "../../src/tools/index.js";

let workspace: string;

const webSearch: WebSearchConfig = { provider: "bing", maxResults: 5 };
const webFetch: WebFetchConfig = { enabled: true, maxChars: 20_000 };

function names(input: Partial<Parameters<typeof buildTools>[0]> = {}): string[] {
  return buildTools({ workspaceDir: workspace, webSearch, webFetch, fileToolsEnabled: true, ...input }).map(
    (t) => t.name
  );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gl-tools-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const documents = {
  uploadRoot: "/tmp/uploads",
  sessionId: "s1",
  attachments: [{ id: "att-1", name: "lecture.pdf", mimeType: "application/pdf" }],
};

describe("buildTools", () => {
  it("exposes every tool by default, minus read_document", () => {
    // `read_document` is absent because this turn has no document attachments — the tool
    // is registered per turn, so a model is never offered one with nothing to read.
    expect(names().sort()).toEqual(
      [...ALL_TOOL_NAMES].filter((n) => n !== "read_document").sort()
    );
  });

  it("adds read_document when the turn has a document attachment", () => {
    expect(names({ documents })).toContain("read_document");
  });

  it("omits read_document when the attachment list is empty", () => {
    expect(names({ documents: { ...documents, attachments: [] } })).not.toContain("read_document");
  });

  it("keeps the web tools but drops the file tools when fileTools is disabled", () => {
    expect(names({ fileToolsEnabled: false }).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("keeps read_document when the file tools are disabled", () => {
    // It reads attachments from the uploads tree, not the workspace, so the workspace
    // sandbox switch has no bearing on it.
    expect(names({ fileToolsEnabled: false, documents })).toContain("read_document");
  });

  it("drops web_fetch when it is disabled", () => {
    expect(names({ webFetch: { enabled: false, maxChars: 1000 } })).not.toContain("web_fetch");
  });

  it("restricts to a Copilot's allow-list", () => {
    expect(names({ allowedNames: ["read_file", "web_search"] }).sort()).toEqual(["read_file", "web_search"]);
  });

  it("treats an empty allow-list as 'no restriction'", () => {
    // A Copilot with no tools selected gets everything, not nothing.
    expect(names({ allowedNames: [], documents })).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it("lets a Copilot allow-list exclude read_document", () => {
    expect(names({ allowedNames: ["read_file"], documents })).toEqual(["read_file"]);
  });

  it("applies the allow-list on top of the config gates", () => {
    expect(names({ allowedNames: ["web_fetch", "write_file"], fileToolsEnabled: false })).toEqual([
      "web_fetch",
    ]);
  });

  it("binds the file tools to the workspace they were built for", async () => {
    const [writeFile] = buildTools({
      workspaceDir: workspace,
      webSearch,
      webFetch,
      fileToolsEnabled: true,
      allowedNames: ["write_file"],
    });
    await writeFile!.invoke({ path: "a.txt", content: "x" });
    // Written under the given workspace, proving the closure captured it.
    expect(names()).toContain("read_file");
    await expect(writeFile!.invoke({ path: "/tmp/escape.txt", content: "x" })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });
});
