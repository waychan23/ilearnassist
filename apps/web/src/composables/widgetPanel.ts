import { computed, ref } from "vue";

/**
 * The widget panel's own preferences: how wide it is, which edge its tab strip is on, and which
 * widget is open.
 *
 * A sibling of `theme.ts` and `locale.ts` rather than part of `ui.ts`, and the split is the one
 * `ui.ts`'s own docblock draws: that module holds flags more than one place needs and persists
 * none of them, because a remembered drawer is a bug rather than a preference. These three *are*
 * preferences — they survive a reload because being asked again would be the annoyance.
 *
 * `theme.ts` says "revisit if a third persisted preference appears", and this is a third and a
 * fourth and a fifth. It is still not the moment for a shared `persistedPreference<T>()`: those
 * three all belong to one subsystem, are read and written by one module, and none of them needs
 * a side-effect hook — a generic helper would be given one caller. The note is about a third
 * *kind* of preference; three fields of one panel are one kind.
 *
 * ### Why localStorage and not the account
 *
 * 1. The app has no per-account preference store. `app_settings` is installation-wide, and the
 *    only two preferences that exist (`gl-locale`, `gl-theme`) are local.
 * 2. A panel width is a property of *this window*, not of the account: a 1440px laptop wants a
 *    wide panel, a 1024px window wants a narrow one, and a phone wants none at all. One
 *    server-side value would impose the wrong sharing model on a CSS length.
 * 3. It is read synchronously at first paint, so the panel does not jump on every reload.
 *
 * The honest counter is that server-side would follow the account across browsers. The width
 * argument decides it.
 *
 * Collapse is deliberately **not** persisted, matching `uiState.sidebarCollapsed`: a rail is what
 * you narrow the window for, and coming back to a sidebar you had hidden is the kind of
 * remembered state that reads as a bug.
 */

export const WIDGET_WIDTH_KEY = "gl-widget-width";
export const WIDGET_ORIENTATION_KEY = "gl-widget-orientation";
export const WIDGET_ACTIVE_KEY = "gl-widget-active";

/**
 * The narrowest the panel may be dragged.
 *
 * Two constraints, and they pull in opposite directions — which is what fixes the number:
 *
 * - **At least one tab must stay visible.** A strip showing nothing but its "more" button is a
 *   panel that cannot say which widget it is showing. The widest label comes to ~143px and the
 *   header's own controls take ~74px, so anything below ~217 breaks that.
 * - **The narrow end must still be narrow enough to overflow.** Both tabs need ~270px of strip, so
 *   the tail has to move into the menu somewhere below that — which is what keeps the overflow
 *   path a state a user can actually reach instead of machinery nobody ever triggers.
 *
 * 230 sits between the two with a little slack on the first, so a slightly longer label does not
 * quietly push both tabs into the menu.
 */
export const WIDGET_MIN_WIDTH = 230;
export const WIDGET_MAX_WIDTH = 720;

/**
 * Where the panel starts, and it is sized to fit the tabs rather than chosen for looks.
 *
 * Measured: both built-in widgets' labels come to about 270px of strip once their "（Demo）"
 * suffixes are counted, and the header's own controls (the layout toggle, the collapse button and
 * the padding) take another ~74px — so a default of 320 put the second tab in the "more" menu on
 * a fresh install, which reads as a widget that failed to appear rather than as a strip that ran
 * out of room. A default that cannot show the default install is the wrong default; the width is
 * still the user's to drag, and the clamp still refuses to take the conversation's room.
 */
export const WIDGET_DEFAULT_WIDTH = 360;
/** The collapsed width: enough for the expand control and nothing else. */
export const WIDGET_RAIL_WIDTH = 36;

/** Which edge the tab strip is on. Horizontal is the top, vertical is a rail inside the panel. */
export type WidgetOrientation = "horizontal" | "vertical";

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
    /* Ignored: the panel still works for this session. */
  }
}

/**
 * The left sidebar's own track, from `style.css`. Duplicated as a number because this arithmetic
 * cannot read a custom property — and it is `grid-template-columns: 272px …` there, a literal by
 * the same argument the sheet gives.
 */
const SIDEBAR_WIDTH = 272;

/**
 * How much room the conversation keeps, whatever else is on screen.
 *
 * Not a token and not a preference: it is the point below which the message column stops being
 * readable, and a panel is never worth that. Roughly a comfortable measure of prose at the app's
 * own type scale.
 */
const MIN_CHAT_WIDTH = 380;

/**
 * The widest the panel may be on this viewport.
 *
 * A stored width travels between windows, and a panel sized for a 1440px screen would eat most of
 * a 1024px one — the failure being a conversation squeezed to a column nobody can read, on a
 * setting the user never changed. So the ceiling is derived from the window as well: whatever is
 * left after the sidebar and the conversation's minimum, and never more than `WIDGET_MAX_WIDTH`
 * even when there is room.
 *
 * The *stored* value is left alone, so widening the window again restores what they chose.
 */
export function usableMaxWidth(): number {
  if (typeof window === "undefined") return WIDGET_MAX_WIDTH;
  const spare = window.innerWidth - SIDEBAR_WIDTH - MIN_CHAT_WIDTH;
  return Math.min(WIDGET_MAX_WIDTH, Math.max(WIDGET_MIN_WIDTH, Math.floor(spare)));
}

/** Clamp into the range the panel can actually be, for both the stored and the painted value. */
export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return WIDGET_DEFAULT_WIDTH;
  return Math.min(usableMaxWidth(), Math.max(WIDGET_MIN_WIDTH, Math.round(value)));
}

function readWidth(): number {
  const stored = Number(read(WIDGET_WIDTH_KEY));
  // `Number(null)` is 0 and `Number("junk")` is NaN, so both a missing key and garbage fall back
  // the same way — and the fallback is the default rather than the minimum, because a first run
  // should not look like a panel somebody had dragged to its smallest.
  return stored > 0 ? clampWidth(stored) : WIDGET_DEFAULT_WIDTH;
}

function readOrientation(): WidgetOrientation {
  return read(WIDGET_ORIENTATION_KEY) === "vertical" ? "vertical" : "horizontal";
}

/*
 * Module-level so the panel, the layout toggle and the tests all agree on one set of values —
 * the same reason `uiState` is a singleton.
 */
const width = ref(readWidth());
const orientation = ref<WidgetOrientation>(readOrientation());
const activeId = ref<string | null>(read(WIDGET_ACTIVE_KEY));
const collapsed = ref(false);

/**
 * The width to paint, which is the set width clamped to what this viewport can hold.
 *
 * Clamped here rather than only on write, because a width that was fine when it was set is not
 * necessarily fine now — a window that got narrower is exactly the case this exists for.
 */
const effectiveWidth = computed(() => clampWidth(width.value));

/** The value `App.vue` puts on `.app` as `--widget-w`. */
const widthCss = computed(() =>
  collapsed.value ? `${WIDGET_RAIL_WIDTH}px` : `${effectiveWidth.value}px`
);

export const widgetPanel = {
  /** The width the user set, before the viewport's ceiling is applied. */
  width,
  effectiveWidth,
  orientation,
  /** The open widget's id, remembered across reloads. An id this build does not know is ignored
   *  where it is used rather than here, so a downgrade does not erase the preference. */
  activeId,
  collapsed,
  widthCss,

  /** Set the width, clamped. Persisted, so it survives a reload. */
  setWidth(value: number): void {
    width.value = clampWidth(value);
    write(WIDGET_WIDTH_KEY, String(width.value));
  },

  /** Nudge the width — the keyboard's way of doing what the drag handle does. */
  stepWidth(delta: number): void {
    widgetPanel.setWidth(width.value + delta);
  },

  toggleOrientation(): void {
    orientation.value = orientation.value === "vertical" ? "horizontal" : "vertical";
    write(WIDGET_ORIENTATION_KEY, orientation.value);
  },

  setActive(id: string): void {
    activeId.value = id;
    write(WIDGET_ACTIVE_KEY, id);
  },

  toggleCollapsed(): void {
    collapsed.value = !collapsed.value;
  },

  /** Not persisted — see the note at the top. Tests use this to start from a known state. */
  setCollapsed(value: boolean): void {
    collapsed.value = value;
  },

  /** Re-read storage. For tests, which share one module instance across a file. */
  reload(): void {
    width.value = readWidth();
    orientation.value = readOrientation();
    activeId.value = read(WIDGET_ACTIVE_KEY);
  },
};
