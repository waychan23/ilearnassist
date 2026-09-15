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

  const res = await request.post(`/api/sessions/${session.id}/sources`, {
    data: { name, mimeType, data: bytes.toString("base64") },
  });
  expect(res.status()).toBe(201);
}

/** The uploaded-files dialog, which lives on the workspace home. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("open-sources").click();
  await expect(page.getByTestId("sources-dialog")).toBeVisible();
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
  await openLibrary(page);

  await page.getByTestId("source-open").filter({ hasText: "shot.png" }).click();

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
  await expect(page.getByTestId("sources-dialog")).toBeVisible();
});

test("an uploaded PDF opens in the viewer", async ({ page, request }) => {
  // The same route with a format that has no text fallback at all: a PDF's bytes are the only
  // thing that can show it, which is the shape the sources list could not reach before.
  await seedSource(request, "doc.pdf", "application/pdf", buildPdf(["Viewer fixture"]));
  await openLibrary(page);

  await page.getByTestId("source-open").filter({ hasText: "doc.pdf" }).click();

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
