import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Selecting part of a message, the way a reader does.
 *
 * `locator.selectText()` cannot stand in for this. It selects the element's **entire**
 * contents — which is not what this feature is about, since the unit of the feature is a
 * *sub-range* — and it dispatches no `mouseup`, so a listener waiting for the end of a drag
 * never runs. Both of those would make a spec pass against a build that only ever annotates
 * whole messages.
 *
 * So the range is built explicitly and the `mouseup` is dispatched, which is the same pair of
 * events a real drag produces. The document-order walk that turns the quote into offsets is
 * the one in `apps/web/src/utils/noteAnchor.ts` re-expressed here — deliberately not shared
 * with it, because a helper that imported the implementation would agree with it about where
 * the text is even when both were wrong.
 */
export async function selectText(
  page: Page,
  root: Locator,
  quote: string,
  occurrence = 0
): Promise<void> {
  const handle = await root.elementHandle();
  expect(handle, "the message content should be in the DOM").not.toBeNull();

  await handle!.evaluate(
    (element, options) => {
      // Formulas are skipped on both sides: KaTeX renders each one twice, once as glyphs and
      // once as hidden MathML, so a raw walk would find a quote in the copy nobody can see.
      const skipped = (node: Node) =>
        node.parentElement?.closest("[data-note-skip], .katex-mathml, .katex-html") != null;

      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          (node as Text).data && !skipped(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });

      const points: Array<{ node: Text; start: number }> = [];
      let full = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        points.push({ node: node as Text, start: full.length });
        full += (node as Text).data;
      }

      let at = -1;
      for (let seen = 0; seen <= options.occurrence; seen += 1) {
        at = full.indexOf(options.quote, at + 1);
        if (at === -1) throw new Error(`the message does not contain "${options.quote}"`);
      }

      const locate = (offset: number): [Text, number] => {
        for (const point of points) {
          if (offset < point.start + point.node.data.length) {
            return [point.node, offset - point.start];
          }
        }
        const last = points[points.length - 1];
        if (!last) throw new Error("the message has no selectable text");
        return [last.node, last.node.data.length];
      };

      const range = element.ownerDocument.createRange();
      range.setStart(...locate(at));
      range.setEnd(...locate(at + options.quote.length));

      const selection = element.ownerDocument.defaultView?.getSelection();
      if (!selection) throw new Error("no selection object");
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { quote, occurrence }
  );

  // What a drag ends with, and the event the message list listens for. `selectText()` never
  // fires one, which is exactly why it cannot be used here.
  await root.dispatchEvent("mouseup");
}

/** Select a quote and take one of the two actions the floating bar offers. */
export async function annotate(
  page: Page,
  root: Locator,
  quote: string,
  action: "annotate" | "note" = "annotate"
): Promise<void> {
  await selectText(page, root, quote);
  await expect(page.getByTestId("note-toolbar")).toBeVisible();
  await page.getByTestId(action === "annotate" ? "note-toolbar-annotate" : "note-toolbar-note").click();
}

/**
 * Select a passage and ask about it — the 追问 button on the bar.
 *
 * Its own helper rather than a third `annotate` action, because what it leaves behind is a
 * different thing: the two above end with a *note*, and this one ends with a staged reference and
 * the composer holding the caret. A spec that wants to type a question next reads better saying so.
 */
export async function selectAndAsk(page: Page, root: Locator, quote: string): Promise<void> {
  await selectText(page, root, quote);
  await expect(page.getByTestId("note-toolbar")).toBeVisible();
  await page.getByTestId("note-toolbar-ask").click();
  // The bar goes with the selection it was floating over, and the chip row is what replaces it.
  await expect(page.getByTestId("note-toolbar")).toBeHidden();
  await expect(page.getByTestId("composer-refs")).toBeVisible();
}
