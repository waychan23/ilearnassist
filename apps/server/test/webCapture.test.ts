import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../src/db.js";
import { NO_SCOPE } from "../src/workspaceScope.js";
import { captureWebPage, type PageCache } from "../src/webCapture.js";
import {
  adoptPageParse,
  ensureWorkResource,
  listResourceViewsForUser,
  registerFile,
} from "../src/resources.js";
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
      url,
      cache: cacheWith(url),
    });

    const views = await listResourceViewsForUser(db, user, "u1");
    const listed = views.find((v) => v.id === row.id);
    expect(listed?.resourceType).toBe("web_page");
    expect((listed?.resource as { url: string }).url).toBe(url);
  });

  it("takes the caller's title, and defaults it to the page's own", async () => {
    /*
     * The library's optional field, and the default the dialog's placeholder promises: the page's
     * own title is the *entity's* — what the fetched document says it is called — while `title`
     * here is the **reference's**, which is what one owner calls it. Absent means that default,
     * and a page whose document has no title at all has already fallen back to its URL
     * (`extracted.title || finalUrl`), which is what makes "降级：网址" true without the route
     * doing anything.
     */
    const url = "https://example.com/recursion";
    const named = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "workspace", id: "w1" },
      url,
      title: "递归这一章",
      cache: cacheWith(url),
    });
    expect(named.title).toBe("递归这一章");
    // The page keeps its own title: the entity is what the document says, the reference is what
    // the person decided to call it.
    expect((named.resource as { title: string }).title).toBe("递归入门");

    const plain = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "workspace", id: "w1" },
      url: "https://example.com/plain",
      cache: cacheWith("https://example.com/plain", "<html><body><p>没有标题的页面。</p></body></html>"),
    });
    // No `<title>`: the URL is the title, which is the degradation the requirement names.
    expect(plain.title).toBe("https://example.com/plain");
  });

  it("stores the bytes and the text, and links it to the workspace", async () => {
    const url = "https://example.com/recursion";
    const row = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "workspace", id: "w1" },
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

  it("links a page kept in a conversation to that conversation alone", async () => {
    const url = "https://example.com/a";
    const row = await captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "session", id: "s1" },
      url,
      summary: "递归的入门讲解",
      cache: cacheWith(url),
    });

    expect(row.ownerType).toBe("session");
    expect(row.summary).toBe("递归的入门讲解");
    /*
     * One reference, and there used to be two. The workspace's row was written on the reading
     * that a page is like an upload — readable from every conversation in the workspace — and
     * that reading was already served by the *sibling* arm of the readable set below. So the
     * second row changed nothing about what could be read and only put a duplicate entry in the
     * library under a different owner, which is what the report was about.
     */
    const refs = db.listWorkResourcesForResource("u1", "web_page", row.resourceId);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.ownerType).toBe("session");
    expect(refs[0]!.ownerId).toBe("s1");

    // And a sibling conversation still reads it, which is the half that makes the removal a
    // subtraction rather than a regression: it is `listReadableWorkResources` that widens this,
    // not the row that was deleted.
    expect(
      db
        .listReadableWorkResources("u1", "s2-other", "w1", NO_SCOPE)
        .some((r) => r.resourceId === row.resourceId)
    ).toBe(true);
  });
});

/**
 * A **second** owner pointing at the same page — which is what `@`-picking it into a conversation
 * does, and the one path the document pipeline cannot cover.
 *
 * A page's text is reachable only through a reference: `web_pages` names neither the stored body
 * nor the extracted text. So the reference `/chat` links is born `none` with no pointer, and
 * `documents.schedule` skips it — `text/html` is not a document MIME, and the service
 * early-returns before writing anything. Left alone, `read_document` answers "no readable text"
 * for the rest of the conversation, which is the failure the schedule exists to prevent.
 */
describe("adopting a page's text for a second owner", () => {
  /** A page kept by the workspace, which is the shape the library's "add a link" makes. */
  async function keptPage(url = "https://example.com/kept") {
    return captureWebPage(db, {
      user,
      userId: "u1",
      owner: { kind: "workspace", id: "w1" },
      url,
      cache: cacheWith(url),
    });
  }

  /** The reference `/chat` links: same entity, owned by the conversation. */
  function linked(page: { resourceId: string; title: string }) {
    return ensureWorkResource(db, {
      userId: "u1",
      owner: { kind: "session", id: "s1" },
      resourceType: "web_page",
      resourceId: page.resourceId,
      title: page.title,
    })!;
  }

  it("takes the text file the first owner's reference already points at", async () => {
    const page = await keptPage();
    expect(page.parseStatus).toBe("ready");

    const mine = linked(page);
    // The state the bug left it in: no pointer, and nothing that would ever write one.
    expect(mine.parseStatus).toBe("none");
    expect(mine.parsedFileId).toBeUndefined();

    expect(adoptPageParse(db, "u1", mine)).toBe(true);

    const after = db.getWorkResourceForUser("u1", mine.id)!;
    expect(after.parseStatus).toBe("ready");
    // The *same* text file, not a second copy: a page arrives already extracted, so there is
    // nothing to redo — the rule `webCapture` states when it reuses a prior text file.
    expect(after.parsedFileId).toBe(page.parsedFileId);
  });

  it("says no when there is no text to adopt, rather than claiming ready", async () => {
    /*
     * A page no reference has ever extracted — reachable from a build older than this function,
     * or from a capture whose text write failed. `ready` with no file behind it would make
     * `read_document` promise text it cannot produce; `none` is the honest answer, and it is the
     * same one the reader got before.
     */
    const page = db.createWebPage({
      id: "p-orphan",
      userId: "u1",
      sourceType: "agent_fetch",
      url: "https://example.com/orphan",
      title: "孤儿页",
      sha256: "0".repeat(64),
    });
    const mine = linked({ resourceId: page.id, title: page.title });

    expect(adoptPageParse(db, "u1", mine)).toBe(false);
    expect(db.getWorkResourceForUser("u1", mine.id)!.parseStatus).toBe("none");
  });

  it("says no for a file, which is what the parse pipeline is for", async () => {
    // The caller's rule in one case: a false answer hands the reference to `documents.schedule`,
    // so a file must reach it — an adoption that claimed files too would leave every uploaded
    // document unparsed while looking handled.
    const file = registerFile(db, {
      userId: "u1",
      path: "sources/raw/f-1.txt",
      sourceType: "upload",
      size: 1,
      mimeType: "text/plain",
      title: "notes.txt",
    });
    const mine = ensureWorkResource(db, {
      userId: "u1",
      owner: { kind: "session", id: "s1" },
      resourceType: "file",
      resourceId: file.id,
      title: file.title,
    })!;

    expect(adoptPageParse(db, "u1", mine)).toBe(false);
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
        url,
        cache: cacheWith(url, "<html><body><script>1</script></body></html>"),
      })
    ).rejects.toThrow(/no readable text/);

    // Nothing half-written: no row, and no bytes beside it.
    expect(await listResourceViewsForUser(db, user, "u1")).toHaveLength(0);
  });
});
