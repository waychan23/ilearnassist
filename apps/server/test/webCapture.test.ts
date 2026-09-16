import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../src/db.js";
import { NO_SCOPE } from "../src/workspaceScope.js";
import { captureWebPage, type PageCache } from "../src/webCapture.js";
import { listSourceViewsForUser } from "../src/sources.js";
import { resolveSourceBytes, resolveSourceParsed } from "../src/sourcePaths.js";
import { dataLayout, userLayout, workspaceWorkdir, type UserLayout } from "../src/paths.js";

/**
 * A page becomes a source, whoever asked for it.
 *
 * Two callers share this and the difference between them is one field — the summary, which only
 * a model can write. So the cases here are about the half they share: the bytes on disk where
 * the resolver looks, the text in the one `parsed/` tree, and **the links**, which are the part
 * that makes the row usable rather than merely present.
 *
 * The fetch is driven through the **cache** (`web_fetch` records what it fetched, and this is the
 * path a model's "keep that page" takes), because the other branch goes through the SSRF guard
 * and refuses loopback by design — a suite that must stay offline cannot reach it. The guard
 * itself is covered by `web-fetch.test.ts`.
 */

const HTML =
  "<html><head><title>递归入门</title></head><body><main>" +
  "<p>递归就是自己调用自己。</p></main></body></html>";

let root: string;
let db: AppDb;
let user: UserLayout;

function cacheWith(url: string, body = HTML): PageCache {
  return new Map([[url, { finalUrl: url, body, contentType: "text/html" }]]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-capture-"));
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
  mkdirSync(workspaceWorkdir(join(root, "w1")), { recursive: true });
  user = userLayout(dataLayout(root), "tester");
});

afterEach(() => {
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a workspace page — the user pasted a link", () => {
  it("stores the bytes and the text, and links it to the workspace", async () => {
    const url = "https://example.com/recursion";
    const row = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "workspace", id: "w1" },
      workspaceId: "w1",
      url,
      cache: cacheWith(url),
    });

    expect(row.category).toBe("page");
    expect(row.storage).toBe("web");
    expect(row.origin).toBe("web");
    expect(row.url).toBe(url);
    expect(row.name).toBe("递归入门");
    // No summary: nothing has read the page, and an empty one is what that means.
    expect(row.summary).toBeUndefined();

    expect(readFileSync(resolveSourceBytes(user, row, join(root, "w1"))!, "utf8")).toBe(HTML);
    expect(readFileSync(resolveSourceParsed(user, row)!, "utf8")).toContain("递归就是自己调用自己");

    // The link — the half that makes it *readable*. A page with a row and no link is material
    // the browser lists and the model cannot open.
    expect(db.listReadableSources("u1", "s1", "w1", NO_SCOPE).some((s) => s.id === row.id)).toBe(true);
  });

  it("links a page kept in a conversation to the conversation too", async () => {
    const url = "https://example.com/a";
    const row = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "session", id: "s1" },
      workspaceId: "w1",
      url,
      summary: "递归的入门讲解",
      cache: cacheWith(url),
    });

    expect(row.ownerKind).toBe("session");
    expect(row.summary).toBe("递归的入门讲解");
    // Both links: the conversation it was kept in, and the workspace it belongs to — which is
    // how a page kept in one conversation is readable from another, exactly as an upload is.
    expect(db.listSessionSources("u1", "s1").some((s) => s.id === row.id)).toBe(true);
    expect(db.listReadableSources("u1", "s2-nonexistent", "w1", NO_SCOPE).some((s) => s.id === row.id)).toBe(
      true
    );
  });
});

describe("what it refuses", () => {
  it("refuses a page with no readable text", async () => {
    const url = "https://example.com/empty";
    await expect(
      captureWebPage(db, {
        user,
        userId: "u1",
        owner: { kind: "workspace", id: "w1" },
        workspaceId: "w1",
        url,
        cache: cacheWith(url, "<html><body><script>1</script></body></html>"),
      })
    ).rejects.toThrow(/no readable text/);

    // Nothing half-written: no row, and no bytes beside it.
    expect(await listSourceViewsForUser(db, user, "u1")).toHaveLength(0);
  });
});
