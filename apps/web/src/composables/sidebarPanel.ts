import { computed, ref } from "vue";

/**
 * The left sidebar's width preference: how wide the conversation list is dragged.
 *
 * A sibling of `widgetPanel.ts` and for its reasons: a width is a property of *this window*
 * rather than of the account — a 1440px laptop wants a wide list, a 1024px window wants a
 * narrow one, and one server-side value would impose the wrong sharing model on a CSS length —
 * and it is read synchronously at first paint, so the sidebar does not jump on every reload.
 * The split from `ui.ts` is the one that module's own docblock draws: `ui.ts` holds flags more
 * than one place needs and persists none of them, because a remembered drawer is a bug rather
 * than a preference. This *is* a preference, and being asked again would be the annoyance.
 *
 * Collapse is deliberately **not** here. It stays `uiState.sidebarCollapsed`, unpersisted, for
 * the reason that flag gives: a rail is what you narrow the window for. This module owns the
 * width alone.
 *
 * The width is a grid *track*, not a width on the `<aside>`. `App.vue` binds it on `.app` as
 * `--sidebar-w` from `widthCss`, and `style.css` reads it in `grid-template-columns` — the
 * widget panel's arrangement, and for its reason: a width on the item would fight the track.
 */

export const SIDEBAR_WIDTH_KEY = "gl-sidebar-width";

/**
 * The narrowest the sidebar may be dragged.
 *
 * Measured against what the open sidebar must keep on one line: the header's two icon buttons
 * and their gaps (~72px of the row's own chrome), the tab strip's two labels and its action
 * (~168px), and a session row's three controls plus the title slice in front of them (~126px).
 * 200 leaves a session title a readable run of characters rather than an ellipsis with nothing
 * before it, which is the state the floor exists to prevent.
 */
export const SIDEBAR_MIN_WIDTH = 200;

/**
 * The widest the sidebar may be dragged.
 *
 * A fact about the compact breakpoint rather than a taste: below 901px the sidebar leaves the
 * grid for a drawer, and 901 - 480 leaves the conversation 421px — more than the 380px
 * `widgetPanel.ts` holds as the point below which the message column stops being readable. So
 * on every viewport where this width is painted, the conversation keeps its minimum, and the
 * ceiling needs no arithmetic of its own. The widget panel, which *can* be open beside a wide
 * sidebar, reads this width into its own ceiling instead — see `usableMaxWidth` there.
 */
export const SIDEBAR_MAX_WIDTH = 480;

/**
 * Where the sidebar starts: the track `style.css` used to spell out.
 *
 * The default the app shipped with, kept so an untouched install looks exactly as it did. The
 * compact drawer keeps this width as a literal of its own — a fixed overlay has no width to
 * drag and must not inherit a 480px preference onto a phone.
 */
export const SIDEBAR_DEFAULT_WIDTH = 272;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be unavailable — private browsing, disabled cookies. A preference is not
    // worth an exception, and every caller has a default.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Ignored: the sidebar still works for this session. */
  }
}

/** Clamp into the range the sidebar can actually be, for both the stored and the painted value. */
export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function readWidth(): number {
  const stored = Number(read(SIDEBAR_WIDTH_KEY));
  // `Number(null)` is 0 and `Number("junk")` is NaN, so both a missing key and garbage fall back
  // the same way — and the fallback is the default rather than the minimum, because a first run
  // should not look like a sidebar somebody had dragged to its smallest.
  return stored > 0 ? clampWidth(stored) : SIDEBAR_DEFAULT_WIDTH;
}

/*
 * Module-level so the sidebar, the drag handle, the grid track and the tests all agree on one
 * set of values — the same reason `uiState` and `widgetPanel` are singletons.
 */
const width = ref(readWidth());

/** The width to paint, which is the set width through the same clamp. */
const effectiveWidth = computed(() => clampWidth(width.value));

/** The value `App.vue` puts on `.app` as `--sidebar-w`. */
const widthCss = computed(() => `${effectiveWidth.value}px`);

export const sidebarPanel = {
  /** The width the user set, before the clamp. */
  width,
  effectiveWidth,
  widthCss,

  /** Set the width, clamped. Persisted, so it survives a reload. */
  setWidth(value: number): void {
    width.value = clampWidth(value);
    write(SIDEBAR_WIDTH_KEY, String(width.value));
  },

  /** Nudge the width — the keyboard's way of doing what the drag handle does. */
  stepWidth(delta: number): void {
    sidebarPanel.setWidth(width.value + delta);
  },

  /** Re-read storage. For tests, which share one module instance across a file. */
  reload(): void {
    width.value = readWidth();
  },
};
