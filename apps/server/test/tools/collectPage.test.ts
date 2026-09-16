import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../../src/db.js";
import { buildCollectPageTool, type PageCache } from "../../src/tools/collectPage.js";
import { listSourceViewsForUser } from "../../src/sources.js";
import { dataLayout, userLayout, type UserLayout } from "../../src/paths.js";

/**
 * The tool, as opposed to the operation behind it.
 *
 * `captureWebPage` is where a page *becomes* a source — the bytes, the text, the row, the links
 * — and `test/webCapture.test.ts` is where that is tested, for both callers at once. What is
 * left for the tool is the contract the model sees: one call, one line back, and the workspace
 * coming from the turn's context rather than from anything the model said.
 */

let root: string;
let db: AppDb;
let user: UserLayout;

/** The body the fake turn already fetched, so the tool reuses it instead of going to the wire. */
function cacheWith(url: string, body: string): PageCache {
  return new Map([[url, { finalUrl: url, body, contentType: "text/html" }]]);
}

const HTML =
  "<html><head><title>递归入门</title></head><body><main><p>自己调用自己。</p></main></body></html>";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-collect-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: "u1", username: "tester", slug: "tester" });
  db.createWorkspace({ id: "w1", userId: "u1", name: "W", slug: "w1", dirPath: join(root, "w1") });
  db.createSession({
    id: "s1",
    workspaceId: "w1",
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: "A conversation",
  });
  user = userLayout(dataLayout(root), "tester");
});

afterEach(() => {
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
});

function tool(cache: PageCache) {
  return buildCollectPageTool({
    db,
    user,
    userId: "u1",
    sessionId: "s1",
    workspaceId: "w1",
    cache,
  });
}

describe("ila_collect_page", () => {
  it("keeps the page in the conversation the turn belongs to, and says so", async () => {
    const url = "https://example.com/recursion";
    const result = (await tool(cacheWith(url, HTML)).invoke({
      url,
      summary: "递归的基础讲解",
    })) as string;

    // The model is told what it kept and, more usefully, what it can now do with it — the id is
    // in the sentence because `read_document` takes one.
    expect(result).toContain("递归入门");
    const row = (await listSourceViewsForUser(db, user, "u1"))[0]!;
    expect(result).toContain(row.id);
    expect(row.summary).toBe("递归的基础讲解");
    expect(row.ownerKind).toBe("session");
    expect(row.ownerId).toBe("s1");
  });

  it("refuses a page with nothing to store, as a tool error the model can act on", async () => {
    // A thrown error rather than a silent no-op: the model can still quote what `web_fetch`
    // returned, and a tool that answered cheerfully having kept nothing is one it keeps calling.
    const url = "https://example.com/empty";
    await expect(
      tool(cacheWith(url, "<html><body><script>1</script></body></html>")).invoke({
        url,
        summary: "x",
      })
    ).rejects.toThrow(/no readable text/);
  });
});
