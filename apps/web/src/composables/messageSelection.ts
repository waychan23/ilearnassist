import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { NoteAnchor } from "@ilearnassist/shared";
import { anchorFromRange, NOTE_ROOT_ATTR } from "../utils/noteAnchor";

/**
 * Noticing that the reader has selected part of a message.
 *
 * Only the message list can answer this — it needs the rendered DOM — so it lives beside the
 * list rather than in the notes widget, and it hands over a *quote and an occurrence* rather
 * than a `Range`. A `Range` is a pair of live nodes, and the render that produced them is one
 * `v-html` assignment away from being replaced.
 *
 * Two refusals are the feature rather than the edge cases:
 *
 * - **Both ends must be in one message.** A drag across two messages has no single place to
 *   hang a note on, which is the product's "no cross-message selection" rule. Nothing is
 *   offered, rather than something that would guess which message was meant.
 * - **The message must be persisted.** The streaming bubble carries no id, so it has nothing
 *   to anchor to. A note is filed against a message row, and there is no row yet.
 */

export interface MessageSelection {
  messageId: string;
  anchor: NoteAnchor;
  /** Where to float the toolbar: the selection's midpoint, and the top of its first line. */
  x: number;
  top: number;
}

/** The message's content element, or null when the node is not inside one. */
function noteRootOf(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
  return element?.closest<HTMLElement>(`[${NOTE_ROOT_ATTR}]`) ?? null;
}

/**
 * Track selections inside `container`, while `enabled`.
 *
 * The trigger is `mouseup` rather than `selectionchange` alone: `selectionchange` fires
 * continuously through a drag, so a toolbar driven by it would appear on the first character
 * and then chase the pointer. `selectionchange` is still listened to, for the one thing
 * `mouseup` cannot see — a selection that has *gone*, which is also how the toolbar is
 * dismissed by clicking away.
 */
export function useMessageSelection(
  container: Ref<HTMLElement | null>,
  enabled: Ref<boolean>
): { selection: Ref<MessageSelection | null>; clear: () => void } {
  const selection = ref<MessageSelection | null>(null);

  function clear(): void {
    selection.value = null;
  }

  /** Read the current selection, or clear the toolbar when it is not one we can use. */
  function measure(): void {
    if (!enabled.value) {
      clear();
      return;
    }
    const dom = document.getSelection();
    if (!dom || dom.rangeCount === 0 || dom.isCollapsed) {
      clear();
      return;
    }
    const range = dom.getRangeAt(0);
    const start = noteRootOf(range.startContainer);
    const end = noteRootOf(range.endContainer);
    if (!start || start !== end) {
      clear();
      return;
    }
    const messageId = start.closest("[data-message-id]")?.getAttribute("data-message-id");
    const anchor = messageId ? anchorFromRange(start, range) : null;
    if (!messageId || !anchor) {
      clear();
      return;
    }

    const rect = range.getBoundingClientRect();
    selection.value = {
      messageId,
      anchor,
      x: rect.left + rect.width / 2,
      top: rect.top,
    };
  }

  function onMouseUp(event: MouseEvent): void {
    // A press that lands on the toolbar itself is the toolbar being used, not a new
    // selection: reading the (collapsed) selection then would dismiss it before the click.
    if (event.target instanceof Element && event.target.closest("[data-testid='note-toolbar']")) {
      return;
    }
    measure();
  }

  function onSelectionChange(): void {
    if (selection.value) measure();
  }

  /** A scroll moves the text out from under the toolbar, which is anchored in the viewport. */
  function onScroll(): void {
    if (selection.value) clear();
  }

  function attach(): void {
    const element = container.value;
    if (!element) return;
    element.addEventListener("mouseup", onMouseUp);
    element.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
  }

  function detach(): void {
    container.value?.removeEventListener("mouseup", onMouseUp);
    container.value?.removeEventListener("scroll", onScroll);
    document.removeEventListener("selectionchange", onSelectionChange);
  }

  watch(
    [container, enabled],
    ([element], previous) => {
      // The container is a `ref` on a `v-if` element, so it arrives after mount and can be
      // replaced. Re-attaching is the only way the listener follows it.
      if (previous) detach();
      if (element) attach();
      if (!enabled.value) clear();
    },
    { immediate: true }
  );

  onBeforeUnmount(detach);

  return { selection, clear };
}
