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
    /*
     * …and here 标注 *is* offered, which is the other half of the rule the case above asserts the
     * absence of: a passage is marked, so the kind that means "this marks a passage" is a true
     * thing to say about the note. It is also the default, because the reader who chose 笔记 over
     * the one-click mark has usually not changed their mind about what they are doing.
     */
    await expect(page.getByTestId("note-type-annotation")).toBeVisible();
    await expect(page.getByTestId("note-type-annotation")).toHaveAttribute("aria-pressed", "true");

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

    /*
     * 标注 is not offered, because there is nothing marked: the kind means "this marks a passage",
     * and the note being written has none. Asserted as absence *and* as the four that remain,
     * since a strip that had lost its whole list would satisfy the first half.
     */
    await expect(page.getByTestId("note-type-annotation")).toHaveCount(0);
    for (const kind of ["idea", "question", "opinion", "other"]) {
      await expect(page.getByTestId(`note-type-${kind}`)).toBeVisible();
    }
    // The one that is chosen is one of those, so nothing is pressed-but-hidden.
    await expect(page.getByTestId("note-type-other")).toHaveAttribute("aria-pressed", "true");

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

  test("grows the window to write in, and puts it back where it was", async ({
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

    const small = (await editor.boundingBox())!;
    const bodyHeight = (await page.getByTestId("note-editor-content").boundingBox())!.height;
    const viewport = page.viewportSize()!;
    /*
     * Small on purpose, and the scrim is the difference that matters: this is a floating card
     * beside the text it is annotating, and the text stays readable behind it. Growing it is a
     * deliberate act with its own control.
     */
    expect(small.width).toBeLessThan(400);
    await expect(page.getByTestId("note-editor-scrim")).toHaveCount(0);
    await expect(page.getByTestId("note-editor-maximize")).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("note-editor-maximize").click();

    /*
     * Grown: the source browser's own box, centred, over a scrim. Asserted as a *relationship* to
     * the viewport rather than as a pixel width, so the two stay matched if that box moves.
     */
    await expect(page.getByTestId("note-editor-scrim")).toBeVisible();
    await expect(page.getByTestId("note-editor-maximize")).toHaveAttribute("aria-pressed", "true");

    const big = (await editor.boundingBox())!;
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
    // Centred: equal room on both sides, within a pixel of rounding.
    expect(Math.abs(big.x - (viewport.width - big.x - big.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(big.y - (viewport.height - big.y - big.height))).toBeLessThanOrEqual(1);
    /*
     * And it is not the whole viewport. The file preview's maximise fills the screen; this one is
     * a *window* of a fixed, comfortable width — which is the difference between the two controls
     * even though they share a mark.
     */
    expect(big.width).toBeLessThan(viewport.width);

    /*
     * And the room goes *into the writing box*, which is the point of the taller window. A card
     * that grew with a five-line textarea still in it — the space collecting under the actions —
     * satisfies every measurement above and is not what was asked for.
     */
    const box = page.getByTestId("note-editor-content");
    expect((await box.boundingBox())!.height).toBeGreaterThan(bodyHeight);

    // The note is still being written: growing the window does not disturb the draft.
    await page.getByTestId("note-editor-content").fill("这是一段很长的笔记。");

    // Back, and back *exactly*: the same size, and the same place.
    await page.getByTestId("note-editor-maximize").click();
    await expect(page.getByTestId("note-editor-scrim")).toHaveCount(0);
    const restored = (await editor.boundingBox())!;
    expect(Math.round(restored.width)).toBe(Math.round(small.width));
    expect(Math.round(restored.x)).toBe(Math.round(small.x));
    expect(Math.round(restored.y)).toBe(Math.round(small.y));
    await expect(page.getByTestId("note-editor-content")).toHaveValue("这是一段很长的笔记。");
  });

  test("backs out of the grown window with Escape before it closes", async ({ page, request }) => {
    /*
     * Escape means "out of the full-screen state" to everything that has one, and a note being
     * written is the last thing that should be discarded because the reader wanted their screen
     * back. A second press — now that it is small again — closes.
     */
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    await annotate(page, replyContent(page), SECOND_PHRASE, "note");
    await expect(page.getByTestId("note-editor")).toBeVisible();

    // Maximise, then type — so the second Escape has something to ask about.
    await page.getByTestId("note-editor-maximize").click();
    await expect(page.getByTestId("note-editor-scrim")).toBeVisible();
    await page.getByTestId("note-editor-content").fill("写了一半。");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("note-editor-scrim")).toHaveCount(0);
    await expect(page.getByTestId("note-editor")).toBeVisible();

    await page.keyboard.press("Escape");
    // The discard prompt, because the body is dirty — the confirm that protects a stray close.
    await expect(page.getByTestId("confirm-accept")).toBeVisible();
  });
});
