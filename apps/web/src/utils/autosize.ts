/**
 * The cap on a self-sizing textarea, in pixels.
 *
 * Past this the box scrolls internally rather than growing further: a long note should not
 * push the rest of a card off the screen, and neither should a pasted wall of text. It is
 * enforced by this module rather than by a CSS `max-height` so the number exists once — the
 * element's height is set explicitly in pixels, so a stylesheet cap would be a second copy
 * of the same decision, free to drift from the first with nothing to notice.
 */
export const AUTOSIZE_MAX_PX = 200;

/**
 * Grow a textarea to fit its content, up to `max`.
 *
 * The height is cleared before it is measured, and that is not incidental. `scrollHeight` is
 * not "what the content needs" — it is what the element needs *at its current height*, so a
 * box that has already grown reports the height it has. Reading it without the reset would
 * give a box that grows but never shrinks, leaving the gap behind when a line is deleted.
 *
 * Callers drive this themselves, because when there is new content to measure is theirs to
 * know: the composer reacts to its draft, and a card that reveals an already-filled box on a
 * tab switch has to size it on mount, where no input event will ever fire.
 */
export function autosizeTextarea(el: HTMLTextAreaElement, max = AUTOSIZE_MAX_PX): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
