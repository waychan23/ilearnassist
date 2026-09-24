/**
 * The copy controls inside rendered markdown, click side — a code block's and a table's.
 *
 * `utils/markdown.ts` writes the buttons into the HTML; this is what happens when they are
 * pressed. The two are apart because they have to be: the markup is produced by a pure
 * `string → string` function, and a button inside `v-html` cannot be a component — Vue does not
 * know about the elements it did not create, and the container's HTML is reassigned on every
 * streamed token, so anything mounted inside it would be destroyed continuously.
 *
 * So one delegated listener per rendered surface, on the container, and the state lives in the
 * DOM: `data-copy-state` on the button, which the stylesheet paints. That is also why the buttons
 * carry **no text nodes** — `utils/noteAnchor.ts` counts a note's quote over a message's
 * *visible* text, so a label here would shift every anchor in the message. (The table's *bar* does
 * carry text, and that is what `data-note-skip` on it is for.)
 */

import { copyRich, copyText } from "../utils/clipboard";
import { tableHtmlForClipboard } from "../utils/tableClipboard";

/** How long the control says "copied" before going back. Matches `CopyButton.vue`'s beat. */
const RESET_MS = 2_000;

/**
 * A click handler for a container holding rendered markdown.
 *
 * Returns whether it handled the event, so a caller with its own click behaviour — the message
 * list opens a note when a highlight is pressed — can tell the two apart rather than guessing.
 *
 * The write itself goes through `utils/clipboard.ts`, which is where the non-secure-origin
 * fallback lives — and that is not a detail of this file: the reported failure was a **synchronous
 * throw** out of `navigator.clipboard.writeText` on an `http://192.168.x.x` address, straight
 * through the `.catch` below and into the container's handler. The control says "failed" rather
 * than appearing to have worked, which is `CopyButton.vue`'s reasoning and the one outcome the
 * user cannot act on.
 */
export function codeCopyClick(event: MouseEvent): boolean {
  const button = (event.target as Element | null)?.closest<HTMLElement>("[data-copy-code]");
  if (!button) return false;

  // The container may have its own handler — a message opens a note on a highlight, a file
  // preview has nothing — and pressing Copy is not pressing the thing behind it.
  event.stopPropagation();
  event.preventDefault();

  // `closest("pre")` rather than the parent: the button sits in the block's header strip, so its
  // parent *is* that strip and the code is a sibling of the strip rather than of the button.
  // Reading the parent was right while the control was positioned directly in the `<pre>`, and it
  // silently copied `""` the moment it moved into the header — which is what the test above the
  // markup is for.
  const text = button.closest("pre")?.querySelector("code")?.textContent ?? "";

  void copyText(text)
    .then(() => flash(button, "copied"))
    .catch(() => flash(button, "failed"));

  return true;
}

/**
 * The same, for a table's copy control.
 *
 * Two things differ from the code block's, and both are why this is not a branch inside it. The
 * text is the table's own cells rather than a `<code>` element's content — and it is read off the
 * **wrapper**, because a bar and its table are siblings inside one `data-table-block` while a
 * code control's `<code>` is its parent's child. And the HTML flavour is written alongside the
 * text, with the inline styles `utils/tableClipboard.ts` adds: a table pasted into a document
 * without them arrives as a heap of words in a grid nobody can see.
 *
 * `write` with a `ClipboardItem` needs a secure context and a browser that has `ClipboardItem` at
 * all; where either is missing the text alone is written — `utils/clipboard.ts`'s rule, and
 * `CopyButton.vue`'s before it: a copy that half-worked is worse than one that took the plainer of
 * the two.
 */
export function tableCopyClick(event: MouseEvent): boolean {
  const button = (event.target as Element | null)?.closest<HTMLElement>("[data-copy-table]");
  if (!button) return false;

  event.stopPropagation();
  event.preventDefault();

  const block = button.closest<HTMLElement>("[data-table-block]");
  const text = block?.querySelector("table")?.textContent ?? "";
  const html = block ? tableHtmlForClipboard(block.innerHTML) : null;

  void copyRich(text, html)
    .then(() => flash(button, "copied"))
    .catch(() => flash(button, "failed"));

  return true;
}

/**
 * Paint the button's state, and put it back.
 *
 * The two states are drawn from `data-copy-state`, and the accessible name is swapped with them —
 * an icon that changed colour is not something a screen reader can report, and "copied" is the
 * whole confirmation.
 */
function flash(button: HTMLElement, state: "copied" | "failed"): void {
  const idle = button.dataset.idleLabel ?? "";
  const label = state === "copied" ? button.dataset.copiedLabel || idle : idle;

  button.dataset.copyState = state;
  button.setAttribute("aria-label", label);
  button.title = label;

  window.setTimeout(() => {
    button.dataset.copyState = "idle";
    button.setAttribute("aria-label", idle);
    button.title = idle;
  }, RESET_MS);
}
