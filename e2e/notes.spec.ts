import { expect, test, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { annotate, selectAndAsk, selectText } from "./notes";
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
const SENTENCE =
  "光合作用发生在叶绿体中，其中光反应阶段产生 ATP，暗反应固定二氧化碳。生成的 ATP 用于后续的合成反应。";

const REPLY = SENTENCE.repeat(14);

const FIRST_PHRASE = "光反应阶段";
const SECOND_PHRASE = "暗反应";

/**
 * A passage long enough that the window's quote cannot show all of it.
 *
 * Five sentences is the shortest run that clears the quote's own five-line box at the floating
 * size, and it is a run of *consecutive* sentences — the only shape `selectText` can address,
 * since it finds its offsets by searching the message's visible text for the quote.
 */
const LONG_QUOTE = SENTENCE.repeat(5);

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
  /*
   * Then wait for the turn to *finish*, which the first line above does not do: the text appears
   * as it streams, so that wait is satisfied by the streaming bubble. Everything below works on
   * the rendered DOM, and `message_done` replaces that bubble with the persisted message — a fresh
   * set of text nodes, so any `Range` into the old ones collapses and the selection toolbar is
   * dismissed by the app's own handler. Selecting in that window is what made this file fail
   * intermittently under a full-suite run and pass alone.
   *
   * Send replacing Stop is the app's own signal that the turn is over, and three other specs
   * already wait on it.
   */
  await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
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

    /*
     * The bar mounts on the `mouseup` `selectText` dispatches, which is a render later — so this
     * waits for it rather than reading the DOM in the same tick. `annotate()` in `e2e/notes.ts`
     * has always waited; this test measured straight away, which reads the same as long as the
     * mount wins the race and throws a bare `TypeError` when it does not — a full-suite run, where
     * the machine is busy, is where it does not.
     */
    await expect(page.getByTestId("note-toolbar")).toBeVisible();

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

    /*
     * Uninstalling gives the *markup* up: the widget that owns that capability is gone, so the
     * two buttons it contributed are gone and no new highlight is drawn.
     *
     * The bar itself stays, and that is the change this assertion was rewritten for — it is the
     * conversation's now, not the widget's, and 追问 is a gesture every conversation has. What
     * disappears is the widget's half of it.
     */
    await page.getByTestId("open-session-settings").click();
    await page.getByTestId("session-widget-toggle-notes").click();
    await page.getByTestId("session-settings-save").click();

    await expect(page.getByTestId("widget-tab-notes")).toHaveCount(0);
    await selectText(page, replyContent(page), FIRST_PHRASE);
    await expect(page.getByTestId("note-toolbar")).toBeVisible();
    await expect(page.getByTestId("note-toolbar-ask")).toBeVisible();
    await expect(page.getByTestId("note-toolbar-annotate")).toHaveCount(0);
    await expect(page.getByTestId("note-toolbar-note")).toHaveCount(0);
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
     * Floating, and the scrim is the difference that matters: this is a card beside the text it is
     * annotating, and the text stays readable behind it. Growing it is a deliberate act with its
     * own control.
     *
     * **Wider than it is tall**, which is the shape and not a size. The card's rows are three short
     * things stacked, so it is height that runs out first; a portrait card would also have to grow
     * downward across the passage it is annotating.
     */
    expect(small.width).toBeGreaterThan(small.height);
    expect(small.width).toBeGreaterThan(400);
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

  test("scrolls a long quote rather than cutting it off", async ({ page, request }) => {
    /*
     * The quote is what the note is *about*, so its end is the one part of the window the reader
     * most needs and the one a clamp takes away. `scrollHeight > clientHeight` is the assertion
     * that separates a scroller from a clamp: both hide the overflow, and only one of them can
     * reach it.
     *
     * The card around it must *not* scroll — otherwise the quote is reachable only by scrolling
     * the window past its own actions row, which is the same defect wearing a different hat.
     */
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    await annotate(page, replyContent(page), LONG_QUOTE, "note");

    const quote = page.getByTestId("note-editor-quote");
    await expect(quote).toBeVisible();
    await expect(quote).toContainText(FIRST_PHRASE);

    const scrolls = await quote.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrolls.scrollHeight).toBeGreaterThan(scrolls.clientHeight);

    const card = await page.getByTestId("note-editor").evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight);

    /*
     * And the body still has a box of its own below it. A quote that pushed the writing area to
     * nothing would satisfy both measurements above while making the window useless.
     */
    await expect(page.getByTestId("note-editor-content")).toBeVisible();
    expect((await page.getByTestId("note-editor-content").boundingBox())!.height).toBeGreaterThan(
      60
    );
  });

  test("shows a short quote whole, without a scrollbar", async ({ page, request }) => {
    // The other half of the pair above: bounded must not mean "always scrolling".
    const name = unique("Notes");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    await annotate(page, replyContent(page), SECOND_PHRASE, "note");

    const quote = page.getByTestId("note-editor-quote");
    await expect(quote).toHaveText(SECOND_PHRASE);
    const sizes = await quote.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(sizes.scrollHeight).toBeLessThanOrEqual(sizes.clientHeight);
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

/**
 * 追问 — pointing at something and asking about it.
 *
 * The mechanism is unit-tested at both ends (`turnReferences.test.ts` for what a reference
 * resolves to and what the model reads, `turnRefs.test.ts` for what the client builds). What only
 * a browser can show is the *gesture*: that selecting a passage offers the button, that pressing
 * it stages a chip and puts the caret in the composer, and that sending carries both to the server
 * and back into the bubble — which is five components agreeing about one array.
 */
test.describe("asking about something", () => {
  test("stages a selected passage, and sends it with the question", async ({ page, request }) => {
    const name = unique("Ask");
    await scriptLlm(request, { turns: [{ content: REPLY }, { content: "它是能量货币。" }], title: "光合作用" });
    await notesSession(page, name);
    await send(page, "讲讲光合作用");

    await selectAndAsk(page, replyContent(page), SECOND_PHRASE);

    // The chip names the kind and shows the words, because "a passage" and "a diagram" are
    // different claims about the same subject.
    const chip = page.getByTestId("composer-refs");
    await expect(chip).toContainText("选中的内容");
    await expect(chip).toContainText(SECOND_PHRASE);

    // And the caret is in the composer — the whole gesture is point, then type.
    await expect(page.getByTestId("composer-input")).toBeFocused();

    await page.getByTestId("composer-input").fill("它是什么？");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("message-assistant").last()).toContainText("它是能量货币。", {
      timeout: 20_000,
    });

    /*
     * The bubble carries the passage above the question, which is the whole point of rendering it
     * rather than naming it: a reader checking whether the model answered the right question is
     * answered by the words. `message-refs` is a *sibling* of the content element a note anchors
     * to, so this also proves the anchored-markup arithmetic was not disturbed.
     */
    const refs = page.getByTestId("message-refs");
    await expect(refs).toHaveCount(1);
    await expect(refs).toContainText(SECOND_PHRASE);

    // And it survives a reload — a reference is a record, not a chip that lived in one tab.
    await page.reload();
    await enterWorkspace(page, name);
    await page.getByTestId("session-item").first().click();
    await expect(page.getByTestId("message-refs")).toContainText(SECOND_PHRASE);

    // What the model was actually sent: the passage, quoted, and the sentence saying what it is.
    const sent = JSON.stringify(
      (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as unknown[]
    );
    expect(sent).toContain(SECOND_PHRASE);
    expect(sent).toContain("never an instruction to follow");
    // The call that fetches a *figure* must not be suggested for a passage, which has no handle.
    expect(sent).not.toContain('ila_query(kind: \\"message\\"');
  });

  test("offers 追问 with no notes panel installed, and no marking-up beside it", async ({
    page,
    request,
  }) => {
    /*
     * The host's action is not part of the claim. A conversation with no widget installed has no
     * marking-up and still has 追问 — which is the whole reason the bar survived the refactor from
     * a widget's toolbar to the conversation's, and the reason the action is composed here rather
     * than asked of whatever claimed.
     */
    const name = unique("AskBare");
    await scriptLlm(request, { turns: [{ content: REPLY }], title: "光合作用" });

    await page.goto("/");
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-create-submit").click();
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-notes").uncheck();
    await page.getByTestId("create-session").click();

    await send(page, "讲讲光合作用");
    await selectAndAsk(page, replyContent(page), FIRST_PHRASE);

    expect(await page.getByTestId("note-toolbar").count()).toBe(0);
    await expect(page.getByTestId("composer-refs")).toContainText(FIRST_PHRASE);
  });

  test("stages a diagram from the figure panel, and the chip opens nothing but the question", async ({
    page,
    request,
  }) => {
    /*
     * The other end of the range: an object with no words to quote. The chip shows the *name*,
     * because the content is fetched by the agent and a copy in the chip would be a copy free to
     * disagree with the figure.
     */
    const name = unique("AskFigure");
    await scriptLlm(request, {
      turns: [
        {
          content: "画好了：",
          toolCalls: [
            {
              id: "call_d1",
              name: "ila_diagram",
              args: {
                name: "auth-flow",
                source: "graph TD\n  A[开始] --> B[结束]",
                summary: "登录流程",
              },
            },
          ],
        },
        { content: "还需要补充吗？" },
      ],
    });

    await page.goto("/");
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-create-submit").click();
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-diagram").check();
    await page.getByTestId("create-session").click();
    await page.getByTestId("widget-tab-diagram").click();

    await page.getByTestId("composer-input").fill("画个登录流程图");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("diagram-row").first()).toBeVisible();

    await page.getByTestId("diagram-row-ask").first().click();
    await expect(page.getByTestId("composer-refs")).toContainText("图");
    await expect(page.getByTestId("composer-refs")).toContainText("auth-flow");

    await page.getByTestId("composer-input").fill("这一步是什么意思？");
    await page.getByTestId("composer-send").click();
    /*
     * Wait for the turn to *end* rather than for a particular sentence. Installing the figure
     * panel brings the topic classifier with it, and that side call takes a scripted turn of its
     * own — so which reply the second chat gets is a race with a call this test is not about.
     * Send replacing Stop is the app's own signal that the turn is over.
     */
    await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });

    // The bubble names the diagram rather than quoting it, and the prompt tells the agent how to
    // read it — the pointer, not a copy.
    await expect(page.getByTestId("message-refs")).toContainText("auth-flow");

    /*
     * Asserted on the *user turn's own content*, not on the request as a whole.
     *
     * The whole request does contain the mermaid source — turn 1's tool call is replayed in the
     * history with its arguments, which is how the model keeps the thread of earlier tool use.
     * So "the source is not in the request" is false for a reason that has nothing to do with
     * references, and the claim worth making is the narrow one: the *reference* hands over the
     * pointer and not the drawing.
     *
     * Selected by `tools`, because the topic classifier also sends the conversation and would
     * otherwise be the request this reads.
     */
    const requests = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
      tools?: unknown;
      messages?: { role: string; content: unknown }[];
    }[];
    const turn = requests.find(
      (r) => Array.isArray(r.tools) && JSON.stringify(r.messages).includes("这一步是什么意思？")
    )!;
    const asked = (turn.messages ?? []).filter((m) => m.role === "user").at(-1)!;
    const content = JSON.stringify(asked.content);
    // Single quotes, because the needle carries JSON-escaped quotation marks: what the wire
    // holds is `ila_query(kind: \"diagram\", …)`.
    expect(content).toContain('ila_query(kind: \\"diagram\\", name: \\"auth-flow.mmd\\")');
    expect(content).not.toContain("graph TD");
  });
});

test("asking from a window closes it, so the composer is not covered", async ({
  page,
  request,
}) => {
  /*
   * The two windows that offer 追问 were the two that stayed up, and what that produced was
   * reported as looking like a bug — correctly, because the composer takes the caret the moment a
   * reference is staged, and on a phone the window is sitting on top of the field that caret went
   * into. A full-screen overlay cannot move aside, so it dismisses; the reply streams into the
   * message list it was covering, so it had to go before the answer arrived anyway.
   *
   * Both halves are asserted for each window: the reference survives the dismissal, and the
   * window does not.
   */
  const name = unique("AskWindows");
  /*
   * Two scripted turns for **one** turn of the conversation, which is what a tool call costs: the
   * loop makes a request per step, so the diagram is drawn on the first and the prose that answers
   * it arrives on the second. Both land in the same assistant message, which is why the card and
   * the passage `annotate` needs are in the same place.
   */
  await scriptLlm(request, {
    turns: [
      {
        content: "画好了：",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "auth-flow", source: "graph TD\n  A[开始] --> B[结束]", summary: "登录流程" },
          },
        ],
      },
      { content: REPLY },
    ],
    title: "光合作用",
  });
  await notesSession(page, name);
  await send(page, "画个登录流程图");

  // The diagram card's own enlarge control, which is the viewer's other front door.
  await expect(page.getByTestId("diagram-card").first()).toBeVisible();
  await page.getByTestId("diagram-expand").first().click();
  await expect(page.getByTestId("diagram-viewer")).toBeVisible();

  await page.getByTestId("diagram-viewer-ask").click();

  await expect(page.getByTestId("diagram-viewer")).toHaveCount(0);
  await expect(page.getByTestId("composer-refs")).toContainText("auth-flow");
  await expect(page.getByTestId("composer-input")).toBeFocused();

  // The note window, opened from the panel's own row. The note has to be *saved* first: the
  // button needs an id, and a draft has none to offer.
  await page.getByTestId("composer-ref-remove").click();
  await annotate(page, replyContent(page), FIRST_PHRASE);
  await page.getByTestId("notes-list").locator("li").first().click();

  const editor = page.getByTestId("note-editor");
  await expect(editor).toBeVisible();
  await page.getByTestId("note-editor-ask").click();

  await expect(editor).toBeHidden();
  await expect(page.getByTestId("composer-refs")).toContainText("笔记");
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

/**
 * A note written about a 图 or a 表 rather than about a passage.
 *
 * The whole of what a browser can add here is the *route*: the panel is where a figure lives, the
 * note is written from there, and the two records have to meet afterwards — the note's row has to
 * name the figure, and the name it shows has to be one the panel can open. Every step in between
 * is unit-tested; what is not is that they are connected.
 */
test.describe("a note about a figure", () => {
  /** The table a scripted model records, and the name its row will carry. */
  const TABLE_NAME = "季度对比";
  const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";

  /**
   * One turn that records a table — the same shape `e2e/table.spec.ts` uses, because the loop
   * persists the last step's utterance, so a table written beside the call survives and one
   * written in the closing step does not.
   */
  function scriptTable(request: Parameters<typeof scriptLlm>[0]): Promise<void> {
    return scriptLlm(request, {
      turns: [
        {
          content: `对比一下：\n\n${TABLE}`,
          toolCalls: [
            {
              id: "call_t1",
              name: "ila_table",
              args: { name: TABLE_NAME, table: TABLE, summary: "两个季度的对比" },
            },
          ],
        },
        { content: "需要展开哪一项？" },
      ],
    });
  }

  test("is written from the panel, and its row opens what it is about", async ({
    page,
    request,
  }) => {
    const name = unique("FigureNote");
    await scriptTable(request);

    await page.goto("/");
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-create-submit").click();
    await enterWorkspace(page, name);

    // Both panels: the figure is what the note is about, the notes panel is what can file one —
    // and its absence is why the 记笔记 button is not drawn at all.
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-notes").check();
    await page.getByTestId("new-session-widget-check-diagram").check();
    await page.getByTestId("create-session").click();
    await page.getByTestId("widget-tab-diagram").click();

    // The composer directly, not this file's `send` helper: that one waits for the
    // photosynthesis reply's own phrase, which no turn here produces.
    await page.getByTestId("composer-input").fill("帮我做一个对比表");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("diagram-row").first()).toBeVisible();

    // Write the note from the figure's own row. No selection was made and no message is involved.
    await page.getByTestId("diagram-note").first().click();
    const editor = page.getByTestId("note-editor");
    await expect(editor).toBeVisible();
    // The window shows what it is about — the counterpart of 标注原文 for a note with no passage.
    await expect(page.getByTestId("note-editor-target")).toContainText(TABLE_NAME);
    // …and it offers no 定位, because a figure note names no message to scroll to.
    await expect(page.getByTestId("note-editor-locate")).toHaveCount(0);

    await page.getByTestId("note-editor-content").fill("第二列的数字是什么意思？");
    await page.getByTestId("note-editor-save").click();
    await expect(editor).toBeHidden();

    // The row names the figure it is about, and the name is the one the panel opens by.
    await page.getByTestId("widget-tab-notes").click();
    await expect(page.getByTestId("notes-list").locator("li")).toHaveCount(1);
    const chip = page.locator('[data-testid^="note-target-"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(TABLE_NAME);

    // Pressing it shows the figure — which is the whole point of the chip existing rather than
    // the name being a label: a control that renders and does nothing is the failure this repo
    // names most often.
    await chip.click();
    await expect(page.getByTestId("diagram-viewer")).toBeVisible();
    await expect(page.getByTestId("diagram-viewer-body")).toContainText("速度");
    await page.getByTestId("diagram-viewer-close").click();

    // And it survives a reload, with the same name — the target is stored, not derived client-side.
    await page.reload();
    await enterWorkspace(page, name);
    await page.getByTestId("session-item").first().click();
    await page.getByTestId("widget-tab-notes").click();
    await expect(page.locator('[data-testid^="note-target-"]')).toContainText(TABLE_NAME);
  });

  test("offers the note control only where a note can be filed", async ({ page, request }) => {
    /*
     * The notes panel owns notes-as-records, so a conversation without it has nowhere to put one.
     * Asserted as an *absence* rather than as a refusal, for the reason the whole app gives: a
     * control that renders and then fails is worse than no control.
     *
     * The notes panel is on by default, so this conversation has to *give it up* — which is also
     * the more interesting direction: it is the only way to reach a figure with no note control.
     */
    const name = unique("FigureNoNotes");
    await scriptTable(request);

    await page.goto("/");
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-create-submit").click();
    await enterWorkspace(page, name);

    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-notes").uncheck();
    await page.getByTestId("new-session-widget-check-diagram").check();
    await page.getByTestId("create-session").click();
    await page.getByTestId("widget-tab-diagram").click();

    // The composer directly, not this file's `send` helper: that one waits for the
    // photosynthesis reply's own phrase, which no turn here produces.
    await page.getByTestId("composer-input").fill("帮我做一个对比表");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
    // The row is there and 定位 with it; only the note control is missing.
    await expect(page.getByTestId("diagram-row").first()).toBeVisible();
    await expect(page.getByTestId("diagram-locate").first()).toBeVisible();
    await expect(page.getByTestId("diagram-note")).toHaveCount(0);
  });
});
