/**
 * The code block's copy control, click side.
 *
 * `utils/markdown.ts` writes the button into the HTML; this is what happens when it is pressed.
 * The two are apart because they have to be: the markup is produced by a pure `string → string`
 * function, and a button inside `v-html` cannot be a component — Vue does not know about the
 * elements it did not create, and the container's HTML is reassigned on every streamed token, so
 * anything mounted inside it would be destroyed continuously.
 *
 * So one delegated listener per rendered surface, on the container, and the state lives in the
 * DOM: `data-copy-state` on the button, which the stylesheet paints. That is also why the button
 * carries **no text nodes** — `utils/noteAnchor.ts` counts a note's quote over a message's
 * *visible* text, so a label here would shift every anchor in the message.
 */

/** How long the control says "copied" before going back. Matches `CopyButton.vue`'s beat. */
const RESET_MS = 2_000;

/**
 * A click handler for a container holding rendered markdown.
 *
 * Returns whether it handled the event, so a caller with its own click behaviour — the message
 * list opens a note when a highlight is pressed — can tell the two apart rather than guessing.
 *
 * `navigator.clipboard` is absent outside a secure context and in jsdom, so the failure branch is
 * reachable in ordinary use rather than theoretical; the control says so rather than appearing to
 * have worked, which is `CopyButton.vue`'s reasoning and the one outcome the user cannot act on.
 */
export function codeCopyClick(event: MouseEvent): boolean {
  const button = (event.target as Element | null)?.closest<HTMLElement>("[data-copy-code]");
  if (!button) return false;

  // The container may have its own handler — a message opens a note on a highlight, a file
  // preview has nothing — and pressing Copy is not pressing the thing behind it.
  event.stopPropagation();
  event.preventDefault();

  const code = button.parentElement?.querySelector("code");
  const text = code?.textContent ?? "";

  void navigator.clipboard
    .writeText(text)
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
