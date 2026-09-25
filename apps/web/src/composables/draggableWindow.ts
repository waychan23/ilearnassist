import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from "vue";
import {
  clampWindowPosition,
  nudgeWindowPosition,
  WINDOW_NUDGE_PX,
  type WindowBox,
  type WindowSize,
} from "../utils/windowDrag";
import { isNarrow } from "./breakpoints";

/**
 * Moving a window by its header.
 *
 * The reader's problem is a window that covers the thing they are reading — a question panel over
 * the passage it is about, a file preview over the reply that cited it — and the answer is to let
 * them shove it aside rather than to close it and lose their place. So this is deliberately not a
 * full window manager: no resize, no snapping, no z-order. One behaviour, on the header, and the
 * header is chosen because it is the strip every one of these dialogs already has and because a
 * title bar is where the gesture is expected.
 *
 * **The position is remembered for the session, and only there.** A map keyed by window id that
 * lives as long as the page: closing a dialog and reopening it puts it back where it was, which is
 * what makes the gesture worth doing twice. Not `localStorage`, and that is a decision rather than
 * an omission — a position is a fact about *this* arrangement of this screen, and one persisted
 * across a monitor change reopens as a window hanging off an edge. `clampWindowPosition` guards
 * that anyway for the remembered case, but the honest answer is that a reader who has not asked
 * for their window to move should find it centred tomorrow, not where it happened to be today.
 *
 * **It is off below the narrow breakpoint and while a dialog is maximised.** Both are surfaces
 * that are not floating: a bottom sheet is pinned to the bottom edge and a maximised dialog fills
 * the viewport, so a position would either be ignored (the sheet's CSS wins) or drag the window
 * clean out of the layout it belongs to.
 */

/** Where each window was left, for the life of the page. */
const remembered = new Map<string, WindowBox>();

/** For the tests: forget every remembered position. */
export function forgetWindowPositions(): void {
  remembered.clear();
}

export interface DraggableWindowOptions {
  /** The window's name in that map. Two windows sharing one are one window. */
  id: string;
  /** The box that moves — and the thing measured, so the clamp knows how much is off screen. */
  panel: Ref<HTMLElement | null>;
  /**
   * Off where the surface is not a floating window: a maximised dialog, or a modal that is a
   * bottom sheet at this width. Absent means always movable.
   */
  enabled?: Ref<boolean>;
  /**
   * Where the window sits when nobody has moved it, for a window that places *itself*.
   *
   * A centred dialog needs none: the overlay's layout puts it somewhere good, and an absent
   * fallback means exactly that. The note window does need one — it floats beside the passage it is
   * about, measured against a selection that moves — so its own placement is handed in here. A
   * dragged position still wins over it, which is what the name is for.
   */
  fallback?: Ref<WindowBox | null>;
}

export interface DraggableWindow {
  /** The inline `left`/`top` to apply, or null for "wherever the layout puts it". */
  placed: ComputedRef<WindowBox | null>;
  dragging: Ref<boolean>;
  /** Whether this window may be moved at all — which is also the class and the `tabindex`. */
  movable: ComputedRef<boolean>;
  /**
   * Whether the reader has moved it.
   *
   * A window that places itself has to stop doing that once somebody has: a card that snapped back
   * to its anchor on the next resize would undo the gesture. Its owner asks this rather than
   * inferring it, because the fallback makes "has a position" true either way.
   */
  moved: ComputedRef<boolean>;
  onDragStart(event: PointerEvent): void;
  onDragKeydown(event: KeyboardEvent): void;
  onDragReset(): void;
  resetDrag(): void;
}

/** An arrow key's direction, in units of `WINDOW_NUDGE_PX`. */
const KEY_STEPS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function useDraggableWindow(options: DraggableWindowOptions): DraggableWindow {
  const position = ref<WindowBox | null>(null);
  const dragging = ref(false);

  const movable = computed(() => !isNarrow.value && (options.enabled?.value ?? true));
  const moved = computed(() => position.value !== null);
  // The inline position is withheld rather than merely ignored where the window may not move: a
  // stale `left`/`top` on a maximised dialog positions it against the viewport and puts it off
  // the screen, which is the one way this feature can lose a window.
  const placed = computed(() => {
    if (!movable.value) return null;
    // Where the reader put it, else where its own layout puts it — and for a dialog that is neither,
    // the overlay's centring, which needs no inline style at all.
    return position.value ?? options.fallback?.value ?? null;
  });

  function viewport(): WindowSize {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  function sizeOf(el: HTMLElement): WindowSize {
    // `offsetWidth`/`offsetHeight` rather than the rect: they are the box's own size, untransformed
    // and unscrolled, which is what the clamp's arithmetic is about.
    return { width: el.offsetWidth, height: el.offsetHeight };
  }

  /**
   * Put the window back where it was left, clamped to *this* viewport.
   *
   * Runs when the dialog opens and when it stops being maximised, which is the same question
   * asked twice: the box is on screen, where does it go. A window that has never been moved keeps
   * a null position and stays the layout's business.
   */
  function restore(): void {
    const el = options.panel.value;
    const box = remembered.get(options.id);
    if (!el || !box || !movable.value) {
      position.value = null;
      return;
    }
    position.value = clampWindowPosition(box, sizeOf(el), viewport());
  }

  watch([options.panel, movable], restore, { immediate: true, flush: "post" });

  let start: {
    pointerX: number;
    pointerY: number;
    box: WindowBox;
    size: WindowSize;
  } | null = null;

  function onPointerMove(event: PointerEvent): void {
    if (!start) return;
    position.value = clampWindowPosition(
      {
        left: start.box.left + (event.clientX - start.pointerX),
        top: start.box.top + (event.clientY - start.pointerY),
      },
      start.size,
      viewport()
    );
  }

  /** End the gesture, whatever ended it — the pointer, a cancel, or the component going away. */
  function stop(): void {
    start = null;
    dragging.value = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", stop);
  }

  function onPointerUp(): void {
    const had = start !== null;
    stop();
    // Remembered on release rather than on every move: this map is read when a window opens, and
    // writing it sixty times a second during a drag buys nothing.
    if (had && position.value) remembered.set(options.id, position.value);
  }

  function onDragStart(event: PointerEvent): void {
    if (!movable.value || dragging.value || event.button !== 0) return;
    const el = options.panel.value;
    if (!el) return;
    // A press on one of the header's own controls is a press on that control: the close, maximise
    // and copy buttons live in the same strip as the handle.
    if ((event.target as Element | null)?.closest("button, a, input, select, textarea")) return;

    const rect = el.getBoundingClientRect();
    /*
     * The first press adopts the box's *current* place before anything moves it. Until now the
     * window has been positioned by the overlay's flex centring; switching it to `position: fixed`
     * with these coordinates is the same pixels, so the drag starts under the pointer rather than
     * jumping to a corner.
     */
    const box = position.value ?? { left: rect.left, top: rect.top };
    position.value = box;
    start = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      box: { ...box },
      size: { width: rect.width, height: rect.height },
    };
    dragging.value = true;
    // The pointer is captured on the header so a fast drag that outruns the element (or leaves the
    // window) keeps delivering moves here rather than to whatever is underneath.
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", onPointerMove);
    // The two ends of a gesture are not the same event: a release is the one that remembers where
    // the window ended up, a cancel is the same teardown with nothing worth remembering.
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  }

  /** The keyboard's half: a window with no pointer is still a window that may be in the way. */
  function onDragKeydown(event: KeyboardEvent): void {
    if (!movable.value) return;
    const step = KEY_STEPS[event.key];
    if (!step) return;
    const el = options.panel.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const box = position.value ?? { left: rect.left, top: rect.top };
    position.value = nudgeWindowPosition(
      box,
      { width: rect.width, height: rect.height },
      viewport(),
      step[0] * WINDOW_NUDGE_PX,
      step[1] * WINDOW_NUDGE_PX
    );
    remembered.set(options.id, position.value);
    // An arrow key inside a dialog would otherwise scroll its body out from under the reader.
    event.preventDefault();
  }

  function resetDrag(): void {
    position.value = null;
    remembered.delete(options.id);
  }

  function onDragReset(): void {
    if (!movable.value) return;
    resetDrag();
  }

  /**
   * A viewport change can leave a window past an edge — the reader rotated a screen, or resized
   * the browser to half of it — and the clamp is the same answer it gets on every other move.
   */
  function onResize(): void {
    const el = options.panel.value;
    if (!el || !position.value) return;
    position.value = clampWindowPosition(position.value, sizeOf(el), viewport());
  }

  onMounted(() => window.addEventListener("resize", onResize));
  onBeforeUnmount(() => {
    window.removeEventListener("resize", onResize);
    // An unmount mid-drag is a dialog closed by a hotkey with the button still down; the window
    // listeners would otherwise outlive the element they move.
    stop();
  });

  return {
    placed,
    dragging,
    movable,
    moved,
    onDragStart,
    onDragKeydown,
    onDragReset,
    resetDrag,
  };
}
