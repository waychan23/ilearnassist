import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../src/db.js";
import { NO_SCOPE } from "../src/workspaceScope.js";
import { captureWebPage, type PageCache } from "../src/webCapture.js";
import { listResourceViewsForUser } from "../src/resources.js";
import { resolveFilePath } from "../src/resourcePaths.js";
import { dataLayout, userLayout, workspaceWorkdir, type UserLayout } from "../src/paths.js";
import type { StoredFile } from "@ilearnassist/shared";

/**
 * A page becomes a reference, whoever asked for it.
 *
 * Two callers share this and the difference between them is one field — the summary, which only
 * a model can write. So the cases here are about the half they share: the bytes on disk where the
 * resolver looks, the text in the one `parsed/` tree, and **the references**, which are the part
 * that makes the page usable rather than merely present.
 *
 * Three records per capture, and each case below is about one of them: the `web_pages` row whose
 * identity is the reading, the two `files` rows (the fetched body, unreferenced; and the extracted
 * text, which the reference points at), and the references themselves.
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
  it("carries the URL into the listing a client reads", async () => {
    /*
     * The URL is what a row's "open in browser" control is *gated on* — the client offers it only
     * when there is somewhere to go — so a page whose `url` stopped reaching the view would make
     * the control silently disappear from both surfaces rather than fail. Asserted on the view
     * rather than on the capture's return value for that reason: the row having a URL is not the
     * question, the row *arriving with one* is.
     */
    const url = "https://example.com/kept";
    const row = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "workspace", id: "w1" },
      workspaceId: "w1",
      url,
      cache: cacheWith(url),
    });

    const views = await listResourceViewsForUser(db, user, "u1");
    const listed = views.find((v) => v.id === row.id);
    expect(listed?.resourceType).toBe("web_page");
    expect((listed?.resource as { url: string }).url).toBe(url);
  });

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

    const page = row.resource as { url: string; title: string };
    expect(row.resourceType).toBe("web_page");
    expect(page.url).toBe(url);
    expect(page.title).toBe("递归入门");
    // No summary: nothing has read the page, and an absent one is what that means.
    expect(row.summary).toBeUndefined();

    /*
     * The text is a file the reference points at, and it holds what `read_document` will read.
     * The fetched body is a file too — registered and referenced by nothing, which is the honest
     * case the file/reference split exists for rather than a workaround.
     */
    expect(row.parsedFileId).toBeTruthy();
    expect(row.parseStatus).toBe("ready");
    const text = db.getFileForUser("u1", row.parsedFileId!)!;
    expect(readFileSync(resolveFilePath(user, text)!, "utf8")).toContain("递归就是自己调用自己");

    const body = db
      .listFilesForUser("u1")
      .find((f) => f.path.includes("/web/") && f.mimeType === "text/html")!;
    expect(readFileSync(resolveFilePath(user, body)!, "utf8")).toBe(HTML);
    // ...and no reference names it, which is what "registered but not referenceable" means.
    expect(db.listWorkResourcesForResource("u1", "file", body.id)).toEqual([]);

    // The reference — the half that makes it *readable*. A page with a row and no reference is
    // material the library lists and the model cannot open.
    expect(
      db.listReadableWorkResources("u1", "s1", "w1", NO_SCOPE).some((r) => r.id === row.id)
    ).toBe(true);
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

    expect(row.ownerType).toBe("session");
    expect(row.summary).toBe("递归的入门讲解");
    /*
     * Two references: the conversation it was kept in, and the workspace it belongs to — which is
     * how a page kept in one conversation is readable from another, exactly as an upload is. One
     * text file serves both, because a page arrives already extracted and there is nothing to
     * redo; the *parse* is per reference, which is why each carries its own `parsed_file_id`.
     */
    const refs = db.listWorkResourcesForResource("u1", "web_page", row.resourceId);
    expect(refs.map((r) => r.ownerType).sort()).toEqual(["session", "workspace"]);
    expect(refs.every((r) => r.parsedFileId === row.parsedFileId)).toBe(true);
    // Compared by the *entity*: a sibling conversation in the same workspace reads the page
    // through the workspace's reference, not through this conversation's.
    expect(
      db
        .listReadableWorkResources("u1", "s2-nonexistent", "w1", NO_SCOPE)
        .some((r) => r.resourceId === row.resourceId)
    ).toBe(true);
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
    expect(await listResourceViewsForUser(db, user, "u1")).toHaveLength(0);
  });
});
