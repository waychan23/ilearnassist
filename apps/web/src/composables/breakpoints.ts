import { ref, type Ref } from "vue";

/**
 * The viewport and pointer state the layout switches on.
 *
 * A module-level singleton, like `theme.ts` and `locale.ts`: one `matchMedia` per query for
 * the lifetime of the page, no teardown. That is deliberate rather than lazy — the queries
 * answer a question about the window, not about a component, so a per-component copy would
 * mean N listeners answering the same thing and N chances for them to disagree. The minimap
 * is why this exists: its "hidden below 900px" rule lived in `ChatView.vue` as a local ref,
 * and the drawer needs the same value. Two copies of one breakpoint is how a drawer ends up
 * opening on a screen whose toggle is hidden.
 *
 * `breakpoints.test.ts` asserts the query strings, and `style.test.ts` asserts the sheet uses
 * the same pixel values. Media queries cannot read custom properties, so the number is spelt
 * out in both languages and nothing can make that one value shared — guarding it is the
 * compensation.
 */

/** Below this the sidebar becomes a drawer and the minimap rail is hidden. */
export const COMPACT = "(max-width: 900px)";

/** Below this the composer toolbar stops fitting on one line. */
export const NARROW = "(max-width: 560px)";

/**
 * A touch device, at *any* width.
 *
 * Separate from the width queries on purpose. Anything revealed on `:hover` is unreachable
 * on a 1024px tablet, which has no narrow-layout problem at all — so a fix keyed to a
 * breakpoint would leave the tablet broken and would hide inside a width-keyed test.
 */
export const COARSE_POINTER = "(hover: none), (pointer: coarse)";

/**
 * jsdom has no `matchMedia`. Reading a query it cannot answer must mean "no", not a crash —
 * the same guard `ChatView.vue` carried before this module existed.
 */
function query(mq: string): Ref<boolean> {
  const matches = ref(false);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return matches;

  const list = window.matchMedia(mq);
  matches.value = list.matches;
  const sync = (event: MediaQueryListEvent) => {
    matches.value = event.matches;
  };
  // `addEventListener` is the modern form; the legacy `addListener` is only reached by
  // browsers older than the ones this app targets, so it is not worth a second code path.
  list.addEventListener("change", sync);
  return matches;
}

/** The viewport is narrow enough that the sidebar has to become a drawer. */
export const isCompact = query(COMPACT);

/** The viewport is narrow enough that the composer toolbar has to reflow. */
export const isNarrow = query(NARROW);

/** The primary pointer has no hover — a phone or a tablet. */
export const isCoarsePointer = query(COARSE_POINTER);
