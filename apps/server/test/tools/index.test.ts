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

describe("buildTools", () => {
  it("exposes every tool by default", () => {
    expect(names().sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("keeps the web tools but drops the file tools when fileTools is disabled", () => {
    expect(names({ fileToolsEnabled: false }).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("drops web_fetch when it is disabled", () => {
    expect(names({ webFetch: { enabled: false, maxChars: 1000 } })).not.toContain("web_fetch");
  });

  it("restricts to a Copilot's allow-list", () => {
    expect(names({ allowedNames: ["read_file", "web_search"] }).sort()).toEqual(["read_file", "web_search"]);
  });

  it("treats an empty allow-list as 'no restriction'", () => {
    // A Copilot with no tools selected gets everything, not nothing.
    expect(names({ allowedNames: [] })).toHaveLength(ALL_TOOL_NAMES.length);
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
