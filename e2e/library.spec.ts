import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The source browser: one account's material, from two front doors.
 *
 * The dialog it replaced listed *uploads*. A source is now every file and page the account
 * holds — an upload, a file the agent wrote into a workspace, a file it wrote into a
 * conversation — and the browser is where all of them are listable and filterable together.
 *
 * Seeded over the API and the filesystem rather than through the model, so nothing here depends
 * on the fake LLM: what is under test is the listing, the filters and the two entry points.
 */

/** A workspace with one seeded file in its sandbox. */
async function seedWorkspace(
  request: APIRequestContext,
  name: string,
  file: string
): Promise<string> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { id, workdirPath } = (await res.json()) as { id: string; workdirPath: string };
  const target = join(workdirPath, file);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `contents of ${file}`);
  return id;
}

/** Upload silently into a workspace, which is also how the browser's own "add" works. */
async function seedUpload(request: APIRequestContext, workspaceId: string, name: string) {
  const res = await request.post(`/api/workspaces/${workspaceId}/files/upload`, {
    data: {
      dir: "",
      name,
      mimeType: "text/plain",
      data: Buffer.from(`uploaded ${name}`).toString("base64"),
    },
  });
  expect(res.status()).toBe(201);
}

/**
 * Wait for a filter's fetch to land before asserting on the list.
 *
 * Asserting that a row is *gone* is the case that needs this: the assertion is true of the
 * unfiltered list too, so it passes or fails on whether the refetch happened to have arrived —
 * which the full suite, running four browsers against one server, does not always give it.
 * Waiting for the dialog's own "loading" marker to clear makes the next assertion a statement
 * about the filtered list rather than about the clock.
 */
async function settle(page: Page): Promise<void> {
  await expect(page.getByTestId("library-loading")).toHaveCount(0);
}

async function openBrowser(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library-dialog")).toBeVisible();
}

test("lists files from every workspace, not only uploads", async ({ page, request }) => {
  // The claim the whole change is about: a workspace file is material the account holds, and a
  // browser that could not see one would be the uploads list with a different title.
  const suffix = Date.now();
  await seedWorkspace(request, `Browse-${suffix}`, "from-the-agent.md");

  await openBrowser(page);

  const row = page.getByTestId("resource-row").filter({ hasText: "from-the-agent.md" });
  await expect(row).toBeVisible();
  /*
   * And the byline says where it came from — which the flat list answers in words, since it has
   * no tree to nest in.
   *
   * The origin here reads `已有文件` ("found in a folder") rather than one of the two `agent_*`
   * values, and that is the honest answer: this file was written straight to disk by the test,
   * so no tool of ours claimed it. A browser that labelled it "written by the assistant" would
   * be lying about provenance in the one place the user looks to check it.
   */
  await expect(row.getByTestId("resource-origin")).toContainText(`Browse-${suffix}`);
  await expect(row.getByTestId("resource-origin")).toContainText("已有文件");
});

test("a file two conversations refer to is one row, not three", async ({ page, request }) => {
  /*
   * **The reported bug.** `@`-ing a workspace file used to write a *holding* row for the
   * conversation, and this dialog lists holdings — so the same file appeared once per
   * conversation that had mentioned it. It is one file throughout: a reference points at an
   * entity, and nothing was ever copied.
   *
   * A browser is the right place for it because the claim is about what the *list* draws, and
   * because the two conversations have to be made the way a reader makes them.
   */
  const suffix = Date.now();
  const workspace = `Shared-${suffix}`;
  // Named per test: the library lists the whole account, so a fixed name would collide with the
  // file the other case in this file seeds.
  const fileName = `shared-${suffix}.md`;
  const workspaceId = await seedWorkspace(request, workspace, fileName);

  /** A conversation in that workspace, with the file `@`-ed into it. */
  async function refer(): Promise<void> {
    const sessionId = await request
      .post(`/api/workspaces/${workspaceId}/sessions`, { data: {} })
      .then((r) => r.json<{ id: string }>())
      .then((session) => session.id);
    const file = await (await request.get("/api/resources"))
      .json<{ id: string; resource: { path: string } }[]>()
      .then((rows) => rows.find((r) => r.resource.path.endsWith(`/${fileName}`))!);

    await scriptLlm(request, { turns: [{ content: "看过了。" }] });
    await request.post(`/api/sessions/${sessionId}/chat`, {
      data: {
        message: "看一下这个文件",
        refs: [{ kind: "resource", ref: file.id, label: fileName }],
      },
    });
  }

  await refer();
  await refer();

  await openBrowser(page);
  await expect(
    page.getByTestId("resource-row").filter({ hasText: fileName })
  ).toHaveCount(1);

  // And each conversation's own panel still shows it — the half a cross-conversation dedupe
  // could have taken away. The panel's filter is `?sessionId=`, so this is asked directly.
  for (const sessionId of await (
    await request.get(`/api/workspaces/${workspaceId}/sessions`)
  )
    .json<{ id: string }[]>()
    .then((rows) => rows.map((r) => r.id))) {
    const panel = await (
      await request.get(`/api/resources?sessionId=${sessionId}`)
    ).json<{ resource: { path: string } }[]>();
    expect(panel.some((r) => r.resource.path.endsWith(`/${fileName}`))).toBe(true);
  }
});

test("deleting a file inside a workspace says what it will destroy", async ({ page, request }) => {
  /*
   * The false promise this closes. A file inside a workspace is deleted through the **file
   * manager's** route — the bytes move to that workspace's trash and the shared `files` row goes
   * — so every conversation referencing it loses it. The dialog used to describe the other delete
   * (this account's reference, and nothing else), which promised other conversations were
   * unaffected, in front of an irreversible action.
   *
   * Two branches, and a browser is the only place either is visible: the *wording* is rendered,
   * and the second branch needs a real second holder. The count that decides is the server's —
   * one grouped statement on the listing, not a query per row.
   */
  const suffix = Date.now();
  const workspace = `Shared-${suffix}`;
  // Named per test: the library lists the whole account, so a fixed name would collide with the
  // file the other case in this file seeds.
  const fileName = `shared-${suffix}.md`;
  const workspaceId = await seedWorkspace(request, workspace, fileName);

  /*
   * The **workspace's** row, not the conversation's. Both are on the list — they are two
   * references to one file — and only the workspace's offers a delete from here, because a
   * conversation's own file belongs to that conversation. Filtering on the control rather than on
   * position is what keeps this test about the count rather than about ordering.
   */
  const listed = () =>
    page
      .getByTestId("resource-row")
      .filter({ hasText: fileName })
      .filter({ has: page.getByTestId("source-delete") });

  await openBrowser(page);
  await expect(listed()).toHaveCount(1);
  await listed().getByTestId("source-delete").click();

  // Nobody else holds it: the file wording, and no number to speak about.
  const dialog = page.locator(".confirm-overlay");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("删除这个文件");
  await expect(dialog).not.toContainText("另外还有");
  await dialog.getByTestId("confirm-cancel").click();

  /*
   * A second holder, made the way a reader makes one: a conversation referencing the file, which
   * is the reference `@`-pointing writes. The link happens before the turn runs, so a scripted
   * reply is enough for the request to finish cleanly.
   */
  const sessionId = await request
    .post(`/api/workspaces/${workspaceId}/sessions`, { data: {} })
    .then((r) => r.json<{ id: string }>())
    .then((session) => session.id);
  const file = await (
    await request.get("/api/resources")
  )
    .json<{ id: string; resource: { path: string } }[]>()
    .then((rows) => rows.find((r) => r.resource.path.endsWith(`/${fileName}`))!);

  await scriptLlm(request, { turns: [{ content: "看过了。" }] });
  await request.post(`/api/sessions/${sessionId}/chat`, {
    data: {
      message: "看一下这个文件",
      refs: [{ kind: "resource", ref: file.id, label: fileName }],
    },
  });

  // Re-read the listing, and the number is there — which is what the dialog branches on.
  await page.getByTestId("sources-close").click();
  await openBrowser(page);
  await expect(listed()).toHaveCount(1);
  await listed().getByTestId("source-delete").click();
  await expect(dialog).toContainText("另外还有");
  await expect(dialog).toContainText("一并删除文件与所有引用");
});

test("filters by workspace", async ({ page, request }) => {
  const suffix = Date.now();
  const first = await seedWorkspace(request, `Filter-A-${suffix}`, "alpha.md");
  const second = await seedWorkspace(request, `Filter-B-${suffix}`, "beta.md");
  void second;

  await openBrowser(page);
  await expect(page.getByTestId("resource-row").filter({ hasText: "alpha.md" })).toBeVisible();
  await expect(page.getByTestId("resource-row").filter({ hasText: "beta.md" })).toBeVisible();

  await page.getByTestId("resources-filter-workspace").selectOption({ label: `Filter-A-${suffix}` });
  await settle(page);

  await expect(page.getByTestId("resource-row").filter({ hasText: "alpha.md" })).toBeVisible();
  await expect(page.getByTestId("resource-row").filter({ hasText: "beta.md" })).toHaveCount(0);
  void first;
});

test("filters by category", async ({ page, request }) => {
  /*
   * v4's filter axis for this, where v3 filtered by `origin`.
   *
   * A reference is *what it points at*, so the library filters by the entity's kind and its
   * coarse category — and "how did this come to exist" is the row's byline rather than a filter,
   * because a person reads it to check provenance and rarely wants to narrow by it. What the
   * case pins is unchanged: one control narrows the list, and the row it excludes is really gone.
   */
  const suffix = Date.now();
  const workspaceId = await seedWorkspace(request, `Category-${suffix}`, "written-by-agent.md");
  await seedUpload(request, workspaceId, "uploaded-by-hand.pdf");

  await openBrowser(page);
  await page.getByTestId("resources-filter-workspace").selectOption({ label: `Category-${suffix}` });
  await expect(page.getByTestId("resource-row").filter({ hasText: "uploaded-by-hand.pdf" })).toBeVisible();

  await page.getByTestId("resources-filter-category").selectOption("markdown");
  await settle(page);
  await expect(page.getByTestId("resource-row").filter({ hasText: "written-by-agent.md" })).toBeVisible();
  await expect(page.getByTestId("resource-row").filter({ hasText: "uploaded-by-hand.pdf" })).toHaveCount(0);
});

test("the tree view groups by where a file came from", async ({ page, request }) => {
  const suffix = Date.now();
  const workspaceId = await seedWorkspace(request, `Tree-${suffix}`, "notes/deep.md");

  await openBrowser(page);
  await page.getByTestId("resources-filter-workspace").selectOption({ label: `Tree-${suffix}` });
  await page.getByTestId("sources-view-tree").click();

  // Workspace → the directory the path names → the file. The grouping is the point: a flat
  // list cannot say that `deep.md` is a workspace file and not a conversation's.
  const tree = page.getByTestId("sources-tree");
  await expect(tree).toBeVisible();
  await tree.getByTestId("source-group").filter({ hasText: `Tree-${suffix}` }).click();
  await expect(tree.getByTestId("source-group").filter({ hasText: "notes" })).toBeVisible();
  await tree.getByTestId("source-group").filter({ hasText: "notes" }).click();
  await expect(tree.getByTestId("resource-row").filter({ hasText: "deep.md" })).toBeVisible();
  void workspaceId;
});

test("adds a file to a workspace from the browser", async ({ page, request }) => {
  const suffix = Date.now();
  const name = `Added-${suffix}`;
  const workspaceId = await seedWorkspace(request, name, "seed.md");

  await openBrowser(page);
  await page.getByTestId("library-add").click();

  // One door, a tab per kind: the file tab is the one showing, and everything is collected
  // before anything is sent.
  const dialog = page.getByTestId("add-source-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("add-source-workspace").selectOption({ label: name });
  await dialog.getByTestId("add-source-dir").fill("reading");
  await dialog.getByTestId("add-source-input").setInputFiles({
    name: "added.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("added"),
  });
  await expect(dialog.getByTestId("add-source-picked")).toContainText("added.txt");
  await dialog.getByTestId("add-source-submit").click();
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("resources-filter-workspace").selectOption({ label: name });
  await expect(page.getByTestId("resource-row").filter({ hasText: "added.txt" })).toBeVisible();

  // And it is really in the folder that was typed, not only in the list.
  const listed = await request
    .get(`/api/workspaces/${workspaceId}/files?path=reading`)
    .then((r) => r.json());
  expect(listed.entries.map((e: { name: string }) => e.name)).toContain("added.txt");
});

test("a conversation opens it on its own workspace, and the picker moves it", async ({
  page,
  request,
}) => {
  /*
   * The second front door. It differs from the first by one prop — the scope the list opens
   * *on* — and not by which controls exist, which is the claim this case exists for: the
   * workspace picker used to be hidden here, so the only way to see another workspace's
   * material (or an upload, which no workspace holds) was to leave the conversation.
   */
  const suffix = Date.now();
  const mine = `Scoped-${suffix}`;
  const other = `Elsewhere-${suffix}`;
  const mineId = await seedWorkspace(request, mine, "mine.md");
  await seedWorkspace(request, other, "theirs.md");

  await page.goto("/");
  await enterWorkspace(page, mine);
  await page.getByTestId("open-library").click();

  const dialog = page.getByTestId("library-dialog");
  await expect(dialog).toBeVisible();
  await settle(page);

  // Opened on this conversation's workspace: its own files are here, the other one's are not.
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "mine.md" })).toBeVisible();
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "theirs.md" })).toHaveCount(0);

  const picker = dialog.getByTestId("resources-filter-workspace");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue(mineId);

  // …and it is a default rather than a lock: the other workspace is one selection away.
  await picker.selectOption({ label: other });
  await settle(page);
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "theirs.md" })).toBeVisible();
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "mine.md" })).toHaveCount(0);

  // All the way out — the whole account, which is what the other front door opens on.
  await picker.selectOption("");
  await settle(page);
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "mine.md" })).toBeVisible();
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "theirs.md" })).toBeVisible();

  /*
   * And what is added goes where the list is *looking*, not where the dialog was opened. With
   * nothing filtered the destination is a question again, so the picker is drawn — it was
   * answered from the door's own scope, which here would have silently aimed an upload at the
   * workspace the reader had just navigated away from.
   */
  await dialog.getByTestId("library-add").click();
  await expect(page.getByTestId("add-source-workspace")).toBeVisible();
});

/*
 * The dialog is a browser, so the controls are a strip and the list is what it is sized for.
 *
 * Asserted as a ratio rather than a pixel count: the toolbar's exact height is a styling
 * decision that will change, and what must not change is that it is a small fraction of the
 * dialog — the version before this one put a lead sentence, a disclosure row and a two-column
 * grid of labelled fields above the rows, and left the list a couple of rows high.
 */
test("keeps the controls to a strip and gives the rest to the list", async ({ page }) => {
  await openBrowser(page);

  const toolbar = page.getByTestId("sources-toolbar");
  const list = page.getByTestId("library-dialog").locator(".browser-scroll");
  await expect(toolbar).toBeVisible();

  const toolbarBox = (await toolbar.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(toolbarBox.height).toBeLessThan(listBox.height / 2);
  // And one row of controls, not three: six fields at ~40px plus wrapping.
  expect(toolbarBox.height).toBeLessThan(90);
});

/*
 * One open, one read of each list.
 *
 * A regression guard rather than a nicety. Opening the dialog writes `filters` from the props, and
 * for two rounds that write was itself a *change* to the fields the filter watchers watch — so
 * every open read the rows and the facets twice, seven requests where two belong, and each listing
 * makes the server reconcile a filesystem before it answers. Nothing about the *result* was wrong
 * at any point, which is exactly why only a count can hold this in place.
 */
test("reads each list once per open, and only the rows when a filter changes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  // Attached between the app starting and the dialog opening, so the count is the open's alone.
  const seen: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/resources") seen.push(r.url());
  });

  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library-dialog")).toBeVisible();
  await settle(page);

  /*
   * Two, and one of them is the *scope* read the option lists are drawn from. They are two
   * questions that happen to share a URL here — with nothing filtered, "everything in scope" and
   * "everything matching the filters" are the same list — and a third would be the session list,
   * which no workspace is in scope to ask for.
   */
  expect(seen).toHaveLength(2);

  /*
   * A filter change is not a scope change, so it re-reads the rows *only*: the option lists are
   * drawn from the scope, and re-reading them would both waste a listing and delete the option
   * the reader narrowed by.
   */
  seen.length = 0;
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/resources");
  await page.getByTestId("resources-filter-search").fill("no-such-source-anywhere");
  await answered;
  expect(seen).toHaveLength(1);
});

test("adds a web link, and says why one that cannot be reached was not kept", async ({
  page,
  request,
}) => {
  /*
   * The success case fetches a real page, and the fetch goes through `web_fetch`'s SSRF guard —
   * which refuses loopback by design, so a suite that must stay offline cannot reach it. The
   * *route's* happy path is unit-tested over `captureWebPage` in the server suite; what this
   * case is for is the half a unit test cannot see: the dialog, the prompt, and where the
   * refusal is reported.
   */
  const suffix = Date.now();
  const name = `Link-${suffix}`;
  await seedWorkspace(request, name, "seed.md");

  await openBrowser(page);
  await page.getByTestId("library-add").click();

  const dialog = page.getByTestId("add-source-dialog");
  await dialog.getByTestId("add-source-workspace").selectOption({ label: name });
  await dialog.getByTestId("add-source-tab-link").click();
  await dialog.getByTestId("add-source-url").fill("http://127.0.0.1:9/nope");
  await dialog.getByTestId("add-source-submit").click();

  // Refused, in the dialog the action was taken in, and the sentence names the reason.
  await expect(dialog.getByTestId("add-source-error")).toBeVisible();
  await expect(dialog.getByTestId("add-source-error")).toContainText("127.0.0.1");
});
