import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./fixtures";
import { enterWorkspace } from "./workspaces";

/**
 * Moving a dialog by its header.
 *
 * A browser spec rather than a unit test, and not by preference: what is being asserted is a
 * *gesture* — a pointer pressed on one element, moved, and released, with the box ending up
 * somewhere else — and the arithmetic behind it is already unit-tested in
 * `apps/web/test/utils/windowDrag.test.ts`. What cannot be unit-tested is that the handler is
 * wired to the right element, that the class which takes the box out of the overlay's flex row
 * applies at the right moment, and that the box does not jump the moment it does.
 *
 * The file preview is the window under test because it is the one these dialogs can all be opened
 * from a fixture: a file exists on disk, and opening it is two clicks. The other three (the
 * question panel, the diagram viewer, the library) go through the same composable, the same class
 * and the same three attributes; the behaviour asserted here is theirs too.
 */

async function seedWorkspace(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { workdirPath } = (await res.json()) as { workdirPath: string };
  mkdirSync(join(workdirPath, "src"), { recursive: true });
  writeFileSync(join(workdirPath, "notes.txt"), "纯文本内容\n");
}

/** Open the preview of `notes.txt`, from the sidebar's files panel. */
async function openPreview(page: Page, workspace: string): Promise<Locator> {
  await page.goto("/");
  await enterWorkspace(page, workspace);
  await page.getByTestId("sidebar-tab-files").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await page.getByTestId("file-row").filter({ hasText: "notes.txt" }).first().click();

  const dialog = page.getByTestId("file-preview");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The box that moves. */
function panel(dialog: Locator): Locator {
  return dialog.locator(".modal");
}

/** Its header — the handle. */
function head(dialog: Locator): Locator {
  return dialog.locator(".modal-head");
}

/** Press the header and move the pointer by `dx`, `dy`, in steps so every move is delivered. */
async function dragBy(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  // The position is written on release; one frame for it to land.
  await page.waitForTimeout(50);
}

test("a dialog is moved by its header, and reopens where it was left", async ({ page, request }) => {
  await seedWorkspace(request, "拖动窗口");
  const dialog = await openPreview(page, "拖动窗口");
  const box = panel(dialog);

  const before = (await box.boundingBox())!;
  // Centred by the overlay's flex row until it is moved, which is the state the first press has
  // to leave *unchanged*: adopting the current place is what makes the drag start under the
  // pointer rather than jumping to a corner.
  expect(await box.evaluate((el) => (el as HTMLElement).style.left)).toBe("");

  await dragBy(page, head(dialog), 160, 120);

  const after = (await box.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x + 160, 0);
  expect(after.y).toBeCloseTo(before.y + 120, 0);
  // Moved means positioned: the inline coordinates are the only thing that can put it back.
  expect(await box.evaluate((el) => (el as HTMLElement).style.left)).not.toBe("");
  await expect(box).toHaveClass(/is-moved/);

  /* Closing and reopening is the same window: the position is remembered for the session. */
  await dialog.getByTestId("file-preview-close").click();
  await expect(page.getByTestId("file-preview")).toHaveCount(0);
  await page.getByTestId("file-row").filter({ hasText: "notes.txt" }).first().click();

  const reopened = page.getByTestId("file-preview");
  await expect(reopened).toBeVisible();
  const again = (await panel(reopened).boundingBox())!;
  expect(again.x).toBeCloseTo(after.x, 0);
  expect(again.y).toBeCloseTo(after.y, 0);

  /* Double-clicking the header puts it back where the layout had it. */
  await head(reopened).dblclick();
  await expect(panel(reopened)).not.toHaveClass(/is-moved/);
  const reset = (await panel(reopened).boundingBox())!;
  expect(reset.x).toBeCloseTo(before.x, 0);
  expect(reset.y).toBeCloseTo(before.y, 0);
});

test("a window dragged past an edge keeps its header reachable", async ({ page, request }) => {
  await seedWorkspace(request, "窗口边界");
  const dialog = await openPreview(page, "窗口边界");
  const box = panel(dialog);
  const viewport = page.viewportSize()!;

  const start = (await head(dialog).boundingBox())!;
  const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };

  /*
   * Far off the top-left corner, in both directions at once. The measurements are taken **while
   * the button is still down** and the pointer is brought back inside before it is released, and
   * that is not fussiness: the position is written on every move, so the clamp is already exercised
   * by the move — and a release outside the viewport is a press and a release on different
   * elements, which the browser turns into a click on their common ancestor, i.e. the overlay,
   * i.e. "close this dialog". Which is how this test first failed.
   */
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 4000, from.y - 4000, { steps: 8 });

  const moved = (await box.boundingBox())!;
  expect(moved.x).toBeLessThan(0);
  // Held at the viewport's own top edge rather than allowed above it: what has to stay reachable
  // is the *header*, and above the top edge there is nowhere for it to be.
  expect(moved.y).toBe(0);
  expect(moved.y).toBeLessThanOrEqual(viewport.height);

  /*
   * And the point of the whole rule, measured rather than assumed: the header is on screen in both
   * axes, so the window can still be dragged back. This is the assertion the first version of the
   * clamp would have failed — it kept 64px of the *window* visible, which at the top edge is its
   * bottom, leaving the title bar off screen and the window unreachable.
   */
  const header = (await head(dialog).boundingBox())!;
  expect(header.x + header.width).toBeGreaterThan(0);
  expect(header.y).toBeGreaterThanOrEqual(0);
  expect(header.y + header.height).toBeLessThanOrEqual(viewport.height);

  await page.mouse.move(from.x, from.y, { steps: 8 });
  await page.mouse.up();
});

test("the header moves the window from the keyboard too", async ({ page, request }) => {
  await seedWorkspace(request, "键盘拖动");
  const dialog = await openPreview(page, "键盘拖动");
  const box = panel(dialog);
  const before = (await box.boundingBox())!;

  // The handle is focusable *because* it is movable — a window with no pointer is still a window
  // that can be in the way, and the arrow keys are the whole of that affordance.
  const handle = head(dialog);
  await expect(handle).toHaveAttribute("tabindex", "0");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(50);

  const after = (await box.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x + 16, 0);
  expect(after.y).toBeCloseTo(before.y + 16, 0);
});

test.describe("on a narrow viewport", () => {
  // Below this width the modal is a bottom sheet pinned to the bottom edge, and a sheet that
  // could be dragged away from it is a dialog with no home. The composable answers the same
  // question for a maximised dialog, which is why the switch is a prop rather than a code path.
  test.use({ viewport: { width: 500, height: 800 } });

  test("the dialog is not draggable", async ({ page, request }) => {
    await seedWorkspace(request, "窄屏不拖动");
    await page.goto("/");
    await enterWorkspace(page, "窄屏不拖动");
    // The file tree lives in the sidebar, which at this width is a drawer behind the toggle.
    await page.getByTestId("nav-toggle").click();
    await page.getByTestId("sidebar-tab-files").click();
    await expect(page.getByTestId("file-tree")).toBeVisible();
    await page.getByTestId("file-row").filter({ hasText: "notes.txt" }).first().click();
    const dialog = page.getByTestId("file-preview");
    await expect(dialog).toBeVisible();
    const box = panel(dialog);
    const before = (await box.boundingBox())!;

    await expect(head(dialog)).not.toHaveAttribute("tabindex", "0");
    // Downward and small, so the whole gesture happens inside a viewport whose sheet reaches the
    // top of the screen: what is being asserted is that nothing moves, and a drag that ended off
    // screen would be asserting it about the wrong thing.
    await dragBy(page, head(dialog), 40, 40);

    const after = (await box.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    await expect(box).not.toHaveClass(/is-moved/);
  });
});
