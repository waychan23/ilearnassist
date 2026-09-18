import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { buildPdf } from "../apps/server/src/documents/sample.js";
import { enterWorkspace } from "./workspaces";

/**
 * The file viewer, in a real browser against the real server.
 *
 * Only a browser can check this: the viewer is a lazily fetched chunk that builds real DOM with
 * real layout, and the question worth asking is whether a *seeded file on disk* reaches a
 * *drawn* result through the route, the byte fetch and the plugin registry in between. That
 * whole path is invisible to jsdom, which is why `utils/fileViewer.ts` is unit-tested for what
 * it *decides* and the drawing happens here.
 *
 * Every wait goes through `data-render-state` rather than an element appearing, which is
 * `MermaidDiagram`'s rule and `e2e/diagram.spec.ts`'s opening argument: a picture that never
 * arrived, one that arrived empty, and one that was refused all look identical to a
 * `toBeVisible()` timeout. The attribute tells them apart, and it turns a race into an
 * assertion. Assertions are on text and on measured pixels, never on coordinates — geometry is
 * font-dependent and a PDF page box is not.
 */

/** A real 1×1 PNG. Small enough to keep as a base64 literal rather than a binary fixture. */
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** A workspace with the three files this spec needs. */
async function seedWorkspace(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { workdirPath } = (await res.json()) as { workdirPath: string };

  mkdirSync(workdirPath, { recursive: true });
  writeFileSync(join(workdirPath, "photo.png"), ONE_PX_PNG);
  // Built rather than committed: the server's own tests use the same generator, so these bytes
  // are already known to be a PDF that pdfjs will parse.
  writeFileSync(join(workdirPath, "doc.pdf"), buildPdf(["Viewer fixture"]));
  writeFileSync(join(workdirPath, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50]));
  // The richest header: a Markdown file is the only kind that carries the view switch *and* a
  // copy button, so it is the one the layout case below wants.
  writeFileSync(join(workdirPath, "notes.md"), "# 标题\n\n正文\n");
}

async function openFilesTab(page: Page): Promise<void> {
  await page.getByTestId("sidebar-tab-files").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
}

/**
 * Upload `bytes` as an account-owned file, through the real routes.
 *
 * A workspace and a conversation are needed to upload at all — a source is created *from* a
 * conversation even though it does not belong to one.
 */
async function seedSource(
  request: APIRequestContext,
  name: string,
  mimeType: string,
  bytes: Buffer
): Promise<void> {
  const workspace = await request
    .post("/api/workspaces", { data: { name: `Viewer-${Date.now()}-${name}` } })
    .then((r) => r.json());
  const session = await request
    .post(`/api/workspaces/${workspace.id}/sessions`, { data: {} })
    .then((r) => r.json());

  const res = await request.post(`/api/sessions/${session.id}/resources`, {
    data: { name, mimeType, data: bytes.toString("base64") },
  });
  expect(res.status()).toBe(201);
}

/** The uploaded-files dialog, which lives on the workspace home. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library-dialog")).toBeVisible();
}

/**
 * The sources dialog, narrowed to *uploads*.
 *
 * It used to be the uploads list and nothing else, so a name was enough to find a row. It is a
 * browser over every source the account holds now, and this file seeds the same names as
 * workspace files (that is how the tree cases above work) — so a lookup by name alone is
 * ambiguous, and the filter that tells them apart is the one the dialog was given for it.
 *
 * v4 has no `origin` filter, so the scope is what separates them: an upload is owned by the
 * conversation it arrived in, and a workspace file by the workspace.
 */
async function openUploads(page: Page, name: string): Promise<void> {
  await openLibrary(page);
  await page.getByTestId("resources-filter-owner-type").selectOption("session");
  /*
   * Wait for the filtered list to *arrive* before anything is clicked.
   *
   * `selectOption` returns as soon as the change is dispatched; the list is re-fetched, so for
   * a moment the dialog still shows the unfiltered rows — and a click aimed at "the row called
   * doc.pdf" then resolves to several. Counting first is what makes the click unambiguous
   * rather than lucky.
   */
  await expect(
    page.getByTestId("resource-row").filter({ hasText: name })
  ).toHaveCount(1);
}

/** Open one file from the tree by name, and wait for its dialog. */
async function openFile(page: Page, name: string): Promise<void> {
  await page.getByTestId("file-row").filter({ hasText: name }).first().click();
  await expect(page.getByTestId("file-preview-body")).toBeVisible();
}

test("an image is drawn by the viewer", async ({ page, request }) => {
  await seedWorkspace(request, "图片预览");
  await page.goto("/");
  await enterWorkspace(page, "图片预览");
  await openFilesTab(page);
  await openFile(page, "photo.png");

  const viewer = page.getByTestId("file-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "ready");

  // Measured rather than merely present: an `<img>` that failed to decode still exists in the
  // DOM with zero intrinsic width, so `toBeVisible` would pass on a broken render.
  const image = viewer.locator("img").first();
  await expect(image).toBeVisible();
  expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test("a PDF is drawn by the viewer", async ({ page, request }) => {
  await seedWorkspace(request, "PDF 预览");
  await page.goto("/");
  await enterWorkspace(page, "PDF 预览");
  await openFilesTab(page);
  await openFile(page, "doc.pdf");

  const viewer = page.getByTestId("file-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "ready");
  // pdf.js paints into a canvas, so a canvas with real pixels is what "it drew" means. The
  // same distinction as the image above: the element existing is not the assertion.
  const canvas = viewer.locator("canvas").first();
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).width)).toBeGreaterThan(0);
});

test("an uploaded image opens in the viewer, over the list it came from", async ({
  page,
  request,
}) => {
  /*
   * The one path a file's *contents* were unreachable by. A source lives outside every
   * workspace — `sources/raw/<id>.<ext>` — so the file tree cannot list it, and the uploaded
   * files dialog offered nothing but a delete button.
   */
  await seedSource(request, "shot.png", "image/png", ONE_PX_PNG);
  await openUploads(page, "shot.png");

  await page.getByTestId("resource-open").filter({ hasText: "shot.png" }).click();

  const viewer = page.getByTestId("file-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "ready", { timeout: 15000 });
  const image = viewer.locator("img").first();
  await expect(image).toBeVisible();
  expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  /*
   * One Escape closes the preview and leaves the list. Both dialogs listen on `window` for the
   * same key, so without the guard in `SourcesDialog` a single press takes the file away *and*
   * slides the list out from under it — the drawer's problem, one layer over.
   */
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("file-viewer")).toHaveCount(0);
  await expect(page.getByTestId("library-dialog")).toBeVisible();
});

test("an uploaded PDF opens in the viewer", async ({ page, request }) => {
  // The same route with a format that has no text fallback at all: a PDF's bytes are the only
  // thing that can show it, which is the shape the sources list could not reach before.
  await seedSource(request, "doc.pdf", "application/pdf", buildPdf(["Viewer fixture"]));
  await openUploads(page, "doc.pdf");

  await page.getByTestId("resource-open").filter({ hasText: "doc.pdf" }).click();

  const viewer = page.getByTestId("file-viewer");
  await expect(viewer).toHaveAttribute("data-render-state", "ready", { timeout: 15000 });
  const canvas = viewer.locator("canvas").first();
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).width)).toBeGreaterThan(0);
});

test("an unpreviewable binary reaches the panel without fetching a byte", async ({
  page,
  request,
}) => {
  await seedWorkspace(request, "二进制预览");
  await page.goto("/");
  await enterWorkspace(page, "二进制预览");
  await openFilesTab(page);

  /*
   * Counting the raw requests is what makes this one assertion stand for two claims: that the
   * gate declines the file, and that declining it costs nothing. `.bin` matches no plugin, so
   * asking for its bytes would be a request whose only possible outcome is being thrown away —
   * and the chunk that would do the asking is ~250 kB gzip nobody should download for a file
   * that cannot be drawn.
   */
  let rawCalls = 0;
  await page.route("**/files/raw*", async (route) => {
    rawCalls += 1;
    await route.continue();
  });

  await openFile(page, "data.bin");
  await expect(page.getByTestId("file-preview-unsupported")).toBeVisible();
  // `unsupported` rather than the viewer being absent, and the distinction is the design: the
  // panel is the *viewer's* answer, reached without loading the viewer. The dialog has no
  // opinion to offer — it cannot know what the library can draw.
  await expect(page.getByTestId("file-viewer")).toHaveAttribute("data-render-state", "unsupported");
  expect(rawCalls).toBe(0);

  // And the counter is not simply broken — closing and opening something viewable moves it.
  await page.getByTestId("file-preview-close").click();
  await openFile(page, "photo.png");
  await expect(page.getByTestId("file-viewer")).toHaveAttribute("data-render-state", "ready");
  expect(rawCalls).toBeGreaterThan(0);
});

test("the preview can be maximised, and a new file opens at its normal size", async ({
  page,
  request,
}) => {
  /*
   * The control exists because a preview is often the thing you came for — a PDF, a large image —
   * and the default width is 720px of a 1600px screen. Measured rather than asserted on a class:
   * "is it bigger" is the whole claim, and a class that nothing paints would satisfy the cheaper
   * check.
   */
  await seedWorkspace(request, "预览最大化");
  await page.goto("/");
  await enterWorkspace(page, "预览最大化");
  await openFilesTab(page);

  await openFile(page, "doc.pdf");
  await expect(page.getByTestId("file-viewer")).toHaveAttribute("data-render-state", "ready");

  const dialog = page.locator(".modal");
  const viewport = page.viewportSize()!;
  const before = (await dialog.boundingBox())!;
  expect(before.width).toBeLessThan(viewport.width);

  const maximize = page.getByTestId("file-preview-maximize");
  await expect(maximize).toHaveAttribute("aria-pressed", "false");
  await maximize.click();

  await expect(maximize).toHaveAttribute("aria-pressed", "true");
  const after = (await dialog.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width);
  expect(after.height).toBeGreaterThan(before.height);
  // Filling the viewport, less nothing: a maximised window with a margin is a bigger window.
  expect(Math.round(after.width)).toBe(viewport.width);
  expect(Math.round(after.height)).toBe(viewport.height);

  // The viewer still draws at the new size — the library measures its container, so a body that
  // failed to grow would leave the file half-rendered rather than obviously broken.
  await expect(page.getByTestId("file-viewer")).toHaveAttribute("data-render-state", "ready");

  // Pressing it again gives the window back.
  await maximize.click();
  await expect(maximize).toHaveAttribute("aria-pressed", "false");
  expect(Math.round((await dialog.boundingBox())!.width)).toBe(Math.round(before.width));

  /*
   * And a *different* file opens at the normal size. The dialog is always mounted — `App.vue` has
   * no `v-if` on it — so a state left behind here would open the next file full-screen, in a
   * dialog that only looks like it was reopened.
   */
  await maximize.click();
  await page.getByTestId("file-preview-close").click();
  await openFile(page, "photo.png");
  await expect(page.getByTestId("file-preview-maximize")).toHaveAttribute("aria-pressed", "false");
  expect(Math.round((await page.locator(".modal").boundingBox())!.width)).toBe(
    Math.round(before.width)
  );
});

test("the preview header is a title, the file's controls, and the window's", async ({
  page,
  request,
}) => {
  /*
   * The header is a plain `space-between` row, so its shape is a property of how many children it
   * has: with one control per child they spread themselves evenly across it and nothing reads as
   * belonging together. The requirement is the convention — the file's name on the left, then two
   * groups at the right: the controls that act on the **file**, and the two that act on the
   * **box** holding it, with close last.
   *
   * Asserted on measured boxes rather than on the markup, because "grouped" is a distance: three
   * elements in three `div`s that the stylesheet has not spaced are separate in the DOM and one
   * even row on screen. The measurement that carries it is that the separation *between* the
   * groups is larger than any gap within either.
   */
  await seedWorkspace(request, "预览头部");
  await page.goto("/");
  await enterWorkspace(page, "预览头部");
  await openFilesTab(page);
  await openFile(page, "notes.md");
  // Waits for the content, not just the dialog: the view switch and the copy button are both
  // conditional on the file having been read.
  await expect(page.getByTestId("file-preview-rendered")).toBeVisible();

  const boxes = await page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    };
    const fileControls = [".segmented", '[data-testid="file-preview-copy"]'];
    const windowControls = [
      '[data-testid="file-preview-maximize"]',
      '[data-testid="file-preview-close"]',
    ];
    return {
      title: rect(".file-title"),
      fileGroup: rect(".file-actions"),
      windowGroup: rect(".window-actions"),
      fileControls: fileControls.map(rect),
      windowControls: windowControls.map(rect),
      headChildren: (document.querySelector(".modal-head") as HTMLElement).children.length,
    };
  });

  const title = boxes.title!;
  const fileGroup = boxes.fileGroup!;
  const windowGroup = boxes.windowGroup!;
  const fileControls = boxes.fileControls.map((c) => c!);
  const windowControls = boxes.windowControls.map((c) => c!);

  // Three children — the title, and the two groups — is the structure the rest follows from.
  expect(boxes.headChildren).toBe(3);

  // Both groups are right of the title, the file's group holds the file's controls, and the
  // window's holds the window's.
  expect(fileGroup.left).toBeGreaterThan(title.right);
  expect(fileGroup.left).toBe(fileControls[0]!.left);
  expect(fileGroup.right).toBe(fileControls[fileControls.length - 1]!.right);
  expect(windowGroup.left).toBe(windowControls[0]!.left);
  expect(windowGroup.right).toBe(windowControls[windowControls.length - 1]!.right);

  // Maximise is left of close, and close is the right-most control of all — the corner a window's
  // dismiss control belongs in.
  expect(windowControls[0]!.right).toBeLessThanOrEqual(windowControls[1]!.left);
  expect(Math.max(fileGroup.right, windowGroup.right)).toBe(windowGroup.right);

  /*
   * And the separation that makes two groups rather than one row: the gap between them is wider
   * than every gap inside either. `>` rather than a factor, so the exact tokens are the
   * stylesheet's business and this only holds it to the *ordering* of distances.
   */
  const betweenGroups = windowGroup.left - fileGroup.right;
  const withinFile = fileControls[1]!.left - fileControls[0]!.right;
  const withinWindow = windowControls[1]!.left - windowControls[0]!.right;
  expect(betweenGroups).toBeGreaterThan(withinFile);
  expect(betweenGroups).toBeGreaterThan(withinWindow);

  // The title is nowhere near any of it, which is what keeps the row reading as two things.
  expect(fileGroup.left - title.right).toBeGreaterThan(betweenGroups);
});

test("writing a note about the file puts the note window on top of the preview", async ({
  page,
  request,
}) => {
  /*
   * A layering bug, and only a browser can see it. The preview is deliberately at `--z-preview`
   * — above every dialog, because it is the layer opened *from* things — while the note window
   * is a floating card at `--z-window`, below it. So the window appeared **underneath** the
   * dialog that had just asked for it, with its own controls unreachable: the same failure
   * `--z-confirm` was added for, one layer down.
   *
   * The fix is `DiagramDialog`'s: the opener closes, and the file is one press away again
   * because the note window draws its 标注对象 as a control. The second half is asserted below.
   */
  const name = `Viewer-note-${Date.now()}`;
  await seedWorkspace(request, name);
  await page.goto("/");
  await enterWorkspace(page, name);
  // A conversation, and one with the notes panel installed — the button is drawn only where a
  // window would render *and* the conversation accepts writes.
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await openFilesTab(page);
  await openFile(page, "notes.md");

  // The preview has to have found a reference for the control to be drawn at all — the file tree
  // registers one as it lists, and the route resolves the path back to it.
  await page.getByTestId("file-preview-note").click();

  const editor = page.getByTestId("note-editor");
  await expect(editor).toBeVisible();
  // The preview is gone rather than merely behind it: a `toBeVisible` on the editor would pass
  // for an element the dialog is covering, which is exactly the bug.
  await expect(page.getByTestId("file-preview-body")).toHaveCount(0);

  // ...and the object it names is one press away, which is what makes closing cost nothing.
  await expect(editor.getByTestId("note-editor-target")).toBeVisible();
  await editor.getByTestId("note-editor-target").click();
  await expect(page.getByTestId("file-preview-body")).toContainText("标题");
});
