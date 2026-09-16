import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { enterWorkspace } from "./workspaces";

/**
 * The workspace file manager, in a browser.
 *
 * The panel used to be a viewer: the agent wrote files and the user looked at them. It is a
 * *web* app, so there is no Finder behind it — which is why create, upload, move and delete are
 * here rather than in a file dialog nobody would write.
 *
 * Every case ends on the same two things, and both matter. The **tree** shows the result — a
 * write that leaves no visible change is indistinguishable from one that failed — and the
 * **filesystem** agrees, which is the half a mocked test would not have. The rows are seeded on
 * disk rather than driven through the model, so nothing here depends on the fake LLM.
 */

/** A workspace with a known tree, created over the API so no dialog is involved. */
async function seedWorkspace(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { workdirPath } = (await res.json()) as { workdirPath: string };
  return workdirPath;
}

async function openFilesTab(page: Page): Promise<void> {
  await page.getByTestId("sidebar-tab-files").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
}

function row(page: Page, name: string) {
  return page.getByTestId("file-row").filter({ hasText: name }).first();
}

/** Type into the shared one-field dialog and submit. */
async function fillDialog(page: Page, value: string): Promise<void> {
  await expect(page.getByTestId("file-path-dialog")).toBeVisible();
  await page.getByTestId("file-path-input").fill(value);
  await page.getByTestId("file-path-submit").click();
  await expect(page.getByTestId("file-path-dialog")).toHaveCount(0);
}

test("creates a folder, uploads into it, and renames what is inside", async ({ page, request }) => {
  const workdir = await seedWorkspace(request, "文件管理");
  await page.goto("/");
  await enterWorkspace(page, "文件管理");
  await openFilesTab(page);

  // New folder at the root — the selection is the root, so nothing is typed as a path.
  await page.getByTestId("file-new-folder").click();
  await fillDialog(page, "notes");
  await expect(row(page, "notes")).toBeVisible();
  expect(existsSync(join(workdir, "notes"))).toBe(true);

  // Select it, then upload into it: the toolbar acts on the row in front of the user, so
  // clicking the folder is what points the next action at it.
  await row(page, "notes").click();
  await page.getByTestId("file-upload-input").setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("first draft"),
  });

  await expect(row(page, "draft.txt")).toBeVisible();
  expect(readFileSync(join(workdir, "notes", "draft.txt"), "utf8")).toBe("first draft");

  // Rename it, and move it out to the root in the same edit — the field holds a path.
  await row(page, "draft.txt").getByTestId("file-rename").click();
  await fillDialog(page, "final.txt");

  await expect(row(page, "final.txt")).toBeVisible();
  expect(readFileSync(join(workdir, "final.txt"), "utf8")).toBe("first draft");
  expect(existsSync(join(workdir, "notes", "draft.txt"))).toBe(false);
});

test("moves a file into a folder by typing its path", async ({ page, request }) => {
  const workdir = await seedWorkspace(request, "移动文件");
  await page.goto("/");
  await enterWorkspace(page, "移动文件");
  await openFilesTab(page);

  await page.getByTestId("file-new-folder").click();
  await fillDialog(page, "archive");

  await page.getByTestId("file-upload-input").setInputFiles({
    name: "loose.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  await expect(row(page, "loose.txt")).toBeVisible();

  await row(page, "loose.txt").getByTestId("file-rename").click();
  await fillDialog(page, "archive/loose.txt");

  expect(existsSync(join(workdir, "archive", "loose.txt"))).toBe(true);
  expect(existsSync(join(workdir, "loose.txt"))).toBe(false);
});

test("deletes a file after confirming, and keeps its bytes", async ({ page, request }) => {
  const workdir = await seedWorkspace(request, "删除文件");
  await page.goto("/");
  await enterWorkspace(page, "删除文件");
  await openFilesTab(page);

  await page.getByTestId("file-upload-input").setInputFiles({
    name: "unwanted.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("kept"),
  });
  await expect(row(page, "unwanted.txt")).toBeVisible();

  await row(page, "unwanted.txt").getByTestId("file-delete").click();
  await page.getByTestId("confirm-accept").click();

  await expect(row(page, "unwanted.txt")).toHaveCount(0);
  expect(existsSync(join(workdir, "unwanted.txt"))).toBe(false);

  // Moved to the trash rather than destroyed — the invariant, seen from outside. The id
  // directory is what keeps two deletions of the same name apart.
  const trash = join(workdir, "..", "trash");
  const found = existsSync(trash)
    ? readFileSync(join(trash, readdirSync(trash)[0]!, "unwanted.txt"), "utf8")
    : null;
  expect(found).toBe("kept");
});

test("refuses to delete a folder with anything in it", async ({ page, request }) => {
  const workdir = await seedWorkspace(request, "删除目录");
  await page.goto("/");
  await enterWorkspace(page, "删除目录");
  await openFilesTab(page);

  await page.getByTestId("file-new-folder").click();
  await fillDialog(page, "full");
  await row(page, "full").click();
  await page.getByTestId("file-upload-input").setInputFiles({
    name: "inside.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  await expect(row(page, "inside.txt")).toBeVisible();

  await row(page, "full").getByTestId("file-delete").click();
  await page.getByTestId("confirm-accept").click();

  // Refused, and the refusal is *shown* — in the tree panel, where the action was taken.
  await expect(page.getByTestId("file-tree-error")).toBeVisible();
  expect(existsSync(join(workdir, "full", "inside.txt"))).toBe(true);
});

test("says so when a name is already taken", async ({ page, request }) => {
  // The refusal a file manager most needs to get right: overwriting on a collision loses work
  // without asking, so the move is refused and both files stay where they were.
  const workdir = await seedWorkspace(request, "重名");
  await page.goto("/");
  await enterWorkspace(page, "重名");
  await openFilesTab(page);

  for (const name of ["one.txt", "two.txt"]) {
    await page.getByTestId("file-upload-input").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(name),
    });
    await expect(row(page, name)).toBeVisible();
  }

  await row(page, "two.txt").getByTestId("file-rename").click();
  await fillDialog(page, "one.txt");

  await expect(page.getByTestId("file-tree-error")).toBeVisible();
  expect(readFileSync(join(workdir, "one.txt"), "utf8")).toBe("one.txt");
  expect(readFileSync(join(workdir, "two.txt"), "utf8")).toBe("two.txt");
});

test("moves a file by dragging it onto a folder", async ({ page, request }) => {
  /*
   * The pointer's way of moving something, beside the dialog's. Both stay: a drop target can
   * only be a row you can see, and the dialog is the only way to put a file *into* a folder that
   * is not on screen.
   */
  const workdir = await seedWorkspace(request, "拖拽移动");
  await page.goto("/");
  await enterWorkspace(page, "拖拽移动");
  await openFilesTab(page);

  await page.getByTestId("file-new-folder").click();
  await fillDialog(page, "target");
  await page.getByTestId("file-upload-input").setInputFiles({
    name: "dragged.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("moved by pointer"),
  });
  await expect(row(page, "dragged.txt")).toBeVisible();

  await row(page, "dragged.txt").dragTo(row(page, "target"));

  await expect
    .poll(() => existsSync(join(workdir, "target", "dragged.txt")))
    .toBe(true);
  expect(existsSync(join(workdir, "dragged.txt"))).toBe(false);

  // The tree followed: the file is no longer a root entry, and it is inside the folder it was
  // dropped on. Asserted by *looking* rather than by counting rows — a moved row that the tree
  // never re-read is the half of this a filesystem check cannot see.
  await expect(row(page, "dragged.txt")).toHaveCount(0);
  await row(page, "target").click();
  await expect(row(page, "dragged.txt")).toBeVisible();
});

test("refuses to drop a folder into itself", async ({ page, request }) => {
  // The one move that cannot work. Caught before the drop rather than reported after it: the
  // folder never highlights as a target, so there is nothing to drop onto.
  const workdir = await seedWorkspace(request, "拖拽拒绝");
  await page.goto("/");
  await enterWorkspace(page, "拖拽拒绝");
  await openFilesTab(page);

  await page.getByTestId("file-new-folder").click();
  await fillDialog(page, "outer");
  await row(page, "outer").click();
  await page.getByTestId("file-new-folder").click();
  await fillDialog(page, "inner");
  await expect(row(page, "inner")).toBeVisible();

  await row(page, "outer").dragTo(row(page, "inner"));

  // Both still where they were, and the workspace's error line says nothing — a refusal the
  // user never sees because the target never lit up.
  expect(existsSync(join(workdir, "outer", "inner"))).toBe(true);
  await expect(page.getByTestId("file-tree-error")).toHaveCount(0);
});
