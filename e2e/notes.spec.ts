import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { annotate, selectText } from "./notes";
import { enterWorkspace } from "./workspaces";

/**
 * The notes widget end to end: a passage is selected, marked in one click or written about
 * through the window, and found again from the panel.
 *
 * The parts of this that only a browser can check are the ones the unit tests cannot reach —
 * that a real selection produces a toolbar at all, that the mark lands on the words that were
 * chosen rather than on the first occurrence of the quote, that the window is not a modal,
 * and that uninstalling the widget takes the markup away with it.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/**
 * A reply with two phrases worth marking, and one repeated on purpose.
 *
 * The repeat is the case that breaks a naive implementation: it highlights the first match of
 * the quote, so "ATP" alone would look right whether or not the occurrence was recorded.
 *
 * Long enough to overflow the pane, which is what makes 定位's *landing* assertable at all —
 * a reply that fits on screen has nothing to scroll, and the mark would sit wherever it
 * happened to be rather than five lines down from the top.
 */
const REPLY =
  "光合作用发生在叶绿体中，其中光反应阶段产生 ATP，暗反应固定二氧化碳。生成的 ATP 用于后续的合成反应。".repeat(
    14
  );

const FIRST_PHRASE = "光反应阶段";
const SECOND_PHRASE = "暗反应";

/** A conversation with the notes widget installed, and the panel open on its empty state. */
async function notesSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-notes").check();
  await page.getByTestId("create-session").click();

  await page.getByTestId("widget-tab-notes").click();
  await expect(page.getByTestId("notes-empty")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await expect(page.getByText(FIRST_PHRASE).last()).toBeVisible({ timeout: 15_000 });
}

/** The assistant's rendered content — where a selection is made. */
function replyContent(page: Page) {
  return page.getByTestId("message-content").last();
}

/**
 * Where the flashed mark sits, in lines below the top of the message pane.
 *
 * Measured in lines rather than pixels because that is what the placement promises — "about
 * five lines of its own text above it" — and because the value is derived from the mark's own
 * computed `line-height`, which is what the implementation measures too.
 */
async function flashOffsetInLines(page: Page): Promise<number> {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="messages"]') as HTMLElement;
    const mark = container.querySelector("mark.note-flash") as HTMLElement;
    const lineHeight = parseFloat(getComputedStyle(mark).lineHeight) || 24;
    return (
      (mark.getBoundingClientRect().top - container.getBoundingClientRect().top) / lineHeight
    );
  });
}

test.describe("the notes widget", () => {
  test("marks a passage in one click, and takes it away again", async ({ page, request }) => {
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    // One click, and no window: the quick action's whole point is that it costs one click.
    await annotate(page, replyContent(page), FIRST_PHRASE);

    await expect(page.getByTestId("note-toolbar")).toBeHidden();
    await expect(page.locator(".modal-overlay")).toHaveCount(0);

    // The row says what was marked, because a bare mark has no words of its own.
    const row = page.getByTestId("notes-list").locator("li");
    await expect(row).toHaveCount(1);
    await expect(row.first()).toContainText(FIRST_PHRASE);

    // And the words themselves are marked, in the message rather than in the panel.
    const mark = replyContent(page).locator("mark.note-highlight");
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText(FIRST_PHRASE);

    // Deleting it takes both away. The confirm is the app's rule for a destructive action, so
    // it is driven here rather than bypassed.
    await row.first().click();
    await expect(page.getByTestId("note-editor")).toBeVisible();
    await page.getByTestId("note-editor-remove").click();
    await page.getByTestId("confirm-accept").click();

    await expect(page.getByTestId("notes-empty")).toBeVisible();
    await expect(replyContent(page).locator("mark.note-highlight")).toHaveCount(0);
  });

  /*
   * Where the bar lands, which the arithmetic's own tests cannot answer: they pin the rule, and
   * this pins *what it is given* — the live selection's rectangle and the message list's edge,
   * measured off the real scroller. The bar is anchored by its top-left corner on the selection's
   * bottom-right vertex and must not cross the list's right edge, so a drag near the column's end
   * does not float it over the panel beside the conversation.
   */
  test("floats off the selection's bottom-right corner, inside the message list", async ({
    page,
    request,
  }) => {
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    // The reply overflows the pane and the follow leaves it scrolled to the end. Back at the top
    // the wanted phrase — the first line of it — is on screen, and there is room beneath it, so
    // the below-the-selection placement is the one under test rather than the flip.
    await page.evaluate(() => {
      (document.querySelector('[data-testid="messages"]') as HTMLElement).scrollTop = 0;
    });

    await selectText(page, replyContent(page), FIRST_PHRASE);

    const box = await page.evaluate(() => {
      const range = document.getSelection()?.getRangeAt(0).getBoundingClientRect();
      const bar = (document.querySelector('[data-testid="note-toolbar"]') as HTMLElement)
        .getBoundingClientRect();
      const list = document.querySelector('[data-testid="messages"]') as HTMLElement;
      return {
        selection: range
          ? { right: range.right, bottom: range.bottom }
          : null,
        bar: { left: bar.left, top: bar.top, right: bar.right },
        listRight: list.getBoundingClientRect().left + list.clientWidth,
      };
    });

    expect(box.selection).not.toBeNull();
    // The corner, not the midpoint of the line: half a bar's width to the left is what the old
    // placement would have produced, and it is a difference this asserts rather than tolerates.
    expect(box.bar.left).toBeCloseTo(box.selection!.right, 1);
    // Below it, by the gap — the bar hangs off the selection rather than standing over it.
    expect(box.bar.top).toBeGreaterThan(box.selection!.bottom);
    // And inside the conversation: the list's edge is the boundary, which with the panel open is
    // well short of the window's.
    expect(box.listRight).toBeLessThan(await page.evaluate(() => window.innerWidth));
    expect(box.bar.right).toBeLessThanOrEqual(box.listRight);
  });

  test("writes a note about a passage, with a kind, in a window that does not block the page", async ({
    page,
    request,
  }) => {
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    await annotate(page, replyContent(page), SECOND_PHRASE, "note");

    const editor = page.getByTestId("note-editor");
    await expect(editor).toBeVisible();
    // Not a modal: no scrim, and the conversation behind it is still there to read — which is
    // the point, since the annotated text is the context for what is being written.
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect(replyContent(page)).toBeVisible();
    // The annotated original, read-only, above the field it is about.
    await expect(page.getByTestId("note-editor-quote")).toHaveText(SECOND_PHRASE);

    // Floating *near* the selection means floating inside the window: the placement measures
    // the card and clamps it, so this is the assertion that it was placed at all rather than
    // left at the page's origin.
    const box = (await editor.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

    await page.getByTestId("note-editor-content").fill("暗反应是不是也需要光？");
    await page.getByTestId("note-type-question").click();
    await page.getByTestId("note-editor-save").click();

    await expect(editor).toBeHidden();
    const row = page.getByTestId("notes-list").locator("li");
    await expect(row).toHaveCount(1);
    // The body is what the row shows once there is one — the quote becomes context you get by
    // opening it.
    await expect(row.first()).toContainText("暗反应是不是也需要光？");
    await expect(row.first()).toContainText("疑问");
  });

  test("adds a note with nothing marked, and goes back to what was marked", async ({
    page,
    request,
  }) => {
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    // A note of one's own, with nothing selected: no quote to show and nothing to locate.
    await page.getByTestId("notes-add").click();
    await expect(page.getByTestId("note-editor-quote")).toHaveCount(0);
    await expect(page.getByTestId("note-editor-locate")).toHaveCount(0);
    // And nothing to delete yet — the note does not exist until it is saved.
    await expect(page.getByTestId("note-editor-remove")).toHaveCount(0);

    await page.getByTestId("note-editor-content").fill("复习这一节");
    await page.getByTestId("note-editor-save").click();
    await expect(page.getByTestId("notes-list").locator("li")).toHaveCount(1);

    // Now one that is anchored, so the window has a place to go back to.
    await annotate(page, replyContent(page), FIRST_PHRASE);
    await expect(page.getByTestId("notes-list").locator("li")).toHaveCount(2);

    const anchored = page.getByTestId("notes-list").locator("li").filter({ hasText: FIRST_PHRASE });
    await anchored.click();
    const locate = page.getByTestId("note-editor-locate");
    await expect(locate).toBeVisible();

    // Opened from the panel, which sits at the right edge: the card has nowhere to go on that
    // side, so the placement flips it to the left of the row it came from rather than off the
    // screen — and does not cover the row either, which is the point of anchoring to it.
    const rowBox = (await anchored.boundingBox())!;
    const card = (await page.getByTestId("note-editor").boundingBox())!;
    expect(card.x + card.width).toBeLessThanOrEqual(rowBox.x);

    // The three actions, in the order the reader meets them: delete furthest from the two that
    // keep what is written, with a button's worth of nothing between it and the one beside it.
    const remove = (await page.getByTestId("note-editor-remove").boundingBox())!;
    const locateBox = (await locate.boundingBox())!;
    const save = (await page.getByTestId("note-editor-save").boundingBox())!;
    expect(remove.x).toBeLessThan(locateBox.x);
    expect(locateBox.x).toBeLessThan(save.x);
    expect(locateBox.x - (remove.x + remove.width)).toBeGreaterThan(save.width);

    await locate.click();

    // Locating flashes the mark rather than opening anything, and leaves the window up so the
    // note can be read against the passage.
    await expect(page.getByTestId("note-editor")).toBeVisible();
    const flashed = replyContent(page).locator("mark.note-flash");
    await expect(flashed).toHaveText(FIRST_PHRASE);

    // The scroll is smooth, so wait for it to stop before measuring where it stopped: two
    // readings in a row that agree. Asserting the offset outright would pass on the first
    // frame of a scroll that has not moved yet.
    let previous = NaN;
    await expect
      .poll(
        async () => {
          const now = await flashOffsetInLines(page);
          const settled = Math.abs(now - previous) < 0.5;
          previous = now;
          return settled;
        },
        { timeout: 10_000 }
      )
      .toBe(true);

    // About five lines down rather than pinned to the top — which is the whole difference
    // between "this note is in this message" and "this note is about these words". Measured at
    // 5.0 against a 1.6 line-height; the band is a line either side, which is what "about"
    // means and gives a device-pixel difference somewhere to land.
    const lines = await flashOffsetInLines(page);
    expect(lines).toBeGreaterThan(4);
    expect(lines).toBeLessThan(6);
  });

  test("keeps the notes across a reload, and gives the markup up on uninstall", async ({
    page,
    request,
  }) => {
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");
    await annotate(page, replyContent(page), FIRST_PHRASE);

    // A reload lands on the workspace home — the app remembers neither the workspace nor the
    // conversation, deliberately — so walk back in and reopen the session from the sidebar.
    await page.reload();
    await enterWorkspace(page, name);
    await page.getByTestId("session-item").first().click();
    await page.getByTestId("widget-tab-notes").click();
    await expect(page.getByTestId("notes-list").locator("li")).toHaveCount(1);
    // The mark is redrawn from the stored anchor, which is the whole reason the anchor is a
    // quote rather than a pair of offsets into the HTML that was on screen when it was made.
    await expect(replyContent(page).locator("mark.note-highlight")).toHaveText(FIRST_PHRASE);

    // Uninstalling gives the markup up: the widget that owns the capability is gone, so
    // selecting text offers nothing.
    await page.getByTestId("open-session-settings").click();
    await page.getByTestId("session-widget-toggle-notes").click();
    await page.getByTestId("session-settings-save").click();

    await expect(page.getByTestId("widget-tab-notes")).toHaveCount(0);
    await selectText(page, replyContent(page), FIRST_PHRASE);
    await expect(page.getByTestId("note-toolbar")).toBeHidden();
    await expect(replyContent(page).locator("mark.note-highlight")).toHaveCount(0);
  });
});
