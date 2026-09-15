/**
 * The application's icons, as path data on a 16x16 grid.
 *
 * Before this existed the UI drew its icons with Unicode characters, and the set had
 * drifted into two incompatible rendering families: colour emoji (`trash`, `brain`,
 * `image`, the theme trio) handed to the platform's emoji font, and monochrome symbols
 * (`x`, `check`, the carets) taken from whatever text font is in force. The two do not
 * merely look different. An emoji is painted by a colour font, so it **ignores `color`**
 * — which made `.icon-btn.danger:hover { color: var(--danger) }` a rule that worked on
 * the dialog close buttons and silently did nothing on the delete buttons beside them.
 * It also put the same action behind two glyphs: `trash` and the `x` it fell back to
 * when a row had no room for it, and a second, visually identical `x` (U+00D7) that a
 * settings chip had picked up along the way.
 *
 * Every icon here is described the same way, and that description is the style:
 *
 * - a 16x16 viewBox, with geometry staying inside roughly 2..14 so a 1.5 stroke is
 *   never clipped at the edge
 * - stroked, never filled — a filled glyph is what reintroduced the weight mismatch
 * - `currentColor`, so a hover, a `.danger` state or an inherited `--text-3` reaches
 *   the icon without the icon knowing anything about colour
 * - one shape language: open outlines, round caps and joins, no decorative detail that
 *   would disappear below 14px
 *
 * Paths are an array because an icon is usually several strokes rather than one, and
 * keeping them separate means a later tweak to one does not have to re-parse a combined
 * `d`. `Icon.vue` renders them; `test/icons.test.ts` holds the set to the rules above.
 */
export const ICON_PATHS = {
  /* Two names for one shape, deliberately: a dialog dismisses with `close`, a key that
   * is not configured reports `cross`. Same geometry, different intent at the call site. */
  close: ["M3.5 3.5L12.5 12.5", "M12.5 3.5L3.5 12.5"],
  cross: ["M3.5 3.5L12.5 12.5", "M12.5 3.5L3.5 12.5"],

  check: ["M3 8.5L6.5 12L13 4"],

  /* Leaving through the door: a doorway open on the right, and an arrow going through it.
   * Not a `cross`, which is what a dialog dismisses with — signing out is not a dismissal. */
  logout: ["M9.5 2.5H3.5V13.5H9.5", "M7 8H13.5", "M11 5.5L13.5 8L11 10.5"],

  trash: ["M2.5 4.5H13.5", "M6.25 4.5V3.25H9.75V4.5", "M4.5 4.5L5.15 12.75H10.85L11.5 4.5"],

  copy: ["M11.5 4.5H4.5V11.5", "M5.5 5.5H12.5V12.5H5.5Z"],

  retry: ["M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33", "M14 2v3.33h-3.33"],

  edit: ["M11.25 2.75L13.25 4.75L5.75 12.25L2.75 13.25L3.75 10.25Z", "M10.25 3.75L12.25 5.75"],

  "caret-down": ["M4 6.5L8 10.5L12 6.5"],
  "caret-right": ["M6.5 4L10.5 8L6.5 12"],
  "caret-left": ["M9.5 4L5.5 8L9.5 12"],

  /* The head of an `ask_user` card — a question the agent is putting to the user. */
  help: [
    "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0",
    "M6.4 6.3a1.65 1.65 0 1 1 1.85 1.75V9.1",
    "M8 11.4V11.41",
  ],

  /* Leaving a workspace, which is the opposite of what `caret-right` means at its call
   * sites (`ModelSelector`'s disclosure). A chevron with a shaft, so it reads as a
   * direction rather than a collapsed section. */
  "arrow-left": ["M13 8H3", "M7 4L3 8L7 12"],

  send: ["M8 13.5V2.75", "M3.75 7L8 2.75L12.25 7"],

  /* The way back down a list that is still being written into: `send`'s shaft and head,
   * turned around. Built on the same measurements as `arrow-left` so the two read as one
   * family, and named for the direction rather than for the button it sits on — the button
   * is "回到最新", which is not a direction. */
  "arrow-down": ["M8 3V13", "M4 9L8 13L12 9"],

  /* Ends something that is running, so it sits beside `send` at the call site and reads as
   * its opposite. Deliberately an *outline* and not the filled square the character `■` was:
   * the set is stroked by contract, and `Icon.vue` paints `fill="none"` — a filled square
   * would render as an empty box. Same rectangle idiom as `image` and `file`. */
  stop: ["M4.5 4.5H11.5V11.5H4.5Z"],

  menu: ["M2.75 4.5H13.25", "M2.75 8H13.25", "M2.75 11.5H13.25"],

  /* The sidebar, as a frame with the panel in its left third — the only mark in the set that
   * says "this control is about the layout" rather than about the thing it acts on. Same
   * rectangle idiom as `image` and `monitor`, with the divider the sidebar's own edge.
   *
   * Deliberately one icon for both states rather than a pair that swaps: the direction is
   * not a fact about the sidebar (a rail is not "leftwards"), and two glyphs a pixel apart
   * are the kind of difference nobody sees — the label on the button says which way it
   * goes, and it is the label that changes. */
  "panel-left": ["M2.5 3.5H13.5V12.5H2.5Z", "M6.5 3.5V12.5"],

  gear: [
    "M6.7 2L9.3 2L8.9 3.7L10.4 4.4L11.3 2.9L13.1 4.7L11.6 5.6L12.3 7.1L14 6.7L14 9.3L12.3 8.9L11.6 10.4L13.1 11.3L11.3 13.1L10.4 11.6L8.9 12.3L9.3 14L6.7 14L7.1 12.3L5.6 11.6L4.7 13.1L2.9 11.3L4.4 10.4L3.7 8.9L2 9.3L2 6.7L3.7 7.1L4.4 5.6L2.9 4.7L4.7 2.9L5.6 4.4L7.1 3.7Z",
    "M10.3 8a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 1 1 4.6 0",
  ],

  plus: ["M8 3V13", "M3 8H13"],

  warning: ["M8 2.6L14.4 13.4H1.6Z", "M8 6.6V9.7", "M8 11.6V11.61"],

  attach: [
    "M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.66-5.65",
  ],

  file: ["M3.5 2.5H8.75L12.5 6.25V13.5H3.5Z", "M8.75 2.5V6.25H12.5"],

  /* The file tree's two directory marks. One shape with the front folded down for the open
   * state, so an expanded directory is legible without reading the caret beside it — the
   * caret says which rows belong to it, the folder says whether it is open. */
  folder: ["M2.5 12.5V4.5H6.5L8 6.5H13.5V12.5Z"],
  "folder-open": ["M2.5 12.5V4.5H6.5L8 6.5H12V8.5", "M2.5 12.5L4.6 8.5H14L12 12.5Z"],

  image: [
    "M2.5 3.5H13.5V12.5H2.5Z",
    "M2.5 9.75L5.5 6.75L8.5 9.75L10.25 8L13.5 11.25",
    "M5.9 6.1V6.11",
  ],

  /* The two actions a text selection offers: mark it, or write about it. A marker and a page
   * with lines — the same "document with something written on it" idea in two states, which
   * is what keeps them readable at 14px beside one another. */
  marker: ["M9.75 2.75L13.25 6.25L7.25 12.25L3.75 8.75Z", "M3.75 8.75L2.75 13.25L7.25 12.25"],
  note: [
    "M3.5 2.5H9.5L12.5 5.5V13.5H3.5Z",
    "M9.5 2.5V5.5H12.5",
    "M5.75 8H10.25",
    "M5.75 10.5H10.25",
  ],

  bulb: [
    "M11.5 6.75a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0",
    "M6.4 10.4V11.9H9.6V10.4",
    "M6.9 13.4H9.1",
  ],

  sliders: [
    "M2.75 4.5H13.25",
    "M2.75 8H13.25",
    "M2.75 11.5H13.25",
    "M5.5 3.25V5.75",
    "M10 6.75V9.25",
    "M6.5 10.25V12.75",
  ],

  diamond: ["M8 2.5L13.5 8L8 13.5L2.5 8Z"],

  robot: [
    "M3.75 5.5H12.25V12.25H3.75Z",
    "M8 5.5V3.75",
    "M8 2.75V2.76",
    "M6.5 8.5V9",
    "M9.5 8.5V9",
  ],

  sun: [
    "M11.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0",
    "M8 1.75V3.25",
    "M8 12.75V14.25",
    "M1.75 8H3.25",
    "M12.75 8H14.25",
    "M3.6 3.6L4.66 4.66",
    "M11.34 11.34L12.4 12.4",
    "M12.4 3.6L11.34 4.66",
    "M4.66 11.34L3.6 12.4",
  ],

  moon: ["M12.75 9.75A5.25 5.25 0 1 1 6.25 3.25a4.2 4.2 0 1 0 6.5 6.5Z"],

  monitor: ["M2.5 3.5H13.5V10.5H2.5Z", "M8 10.5V12.75", "M5.75 13H10.25"],

  /** The widget panel, mirroring `panel-left`: the divider is the panel's own left edge. */
  "panel-right": ["M2.5 3.5H13.5V12.5H2.5Z", "M9.5 3.5V12.5"],

  /*
   * The layout toggle, which is the one place a *pair* is right where `panel-left` argued for a
   * single glyph. That argument was that the direction is not a fact about the sidebar — a rail is
   * not "leftwards". Here the direction is not just a fact but the whole of what the control
   * changes, and the two positions are 90° apart rather than a pixel apart, so they read as two
   * states at a glance rather than as a glyph that moved.
   */
  "tabs-top": ["M2.5 2.5H13.5V13.5H2.5Z", "M2.5 6.5H13.5"],
  "tabs-left": ["M2.5 2.5H13.5V13.5H2.5Z", "M6.5 2.5V13.5"],

  /* The plan widget's tree states. Empty ring = not started; ring with a hand = in
     progress; `skip` is a fast-forward step (moved past, may return); `history` is the
     version dropdown; `list-tree` is the collapse-level control. */
  circle: ["M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0"],
  progress: [
    "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0",
    "M8 5.5V8l2.2 1.4",
  ],
  skip: ["M4.5 4.5L9 8L4.5 11.5", "M10 4.5L14 8L10 11.5", "M12 4.5V11.5"],
  history: [
    "M3 8a5.5 5.5 0 1 1 1.6 3.9",
    "M3 4.5V8h3.5",
  ],
  /* The current-leaf path control: the leaf being tracked, ring and dot. */
  target: [
    "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0",
    "M10.3 8a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 1 1 4.6 0",
  ],
  "list-tree": [
    "M8 4h5.5",
    "M8 8h5.5",
    "M8 12h5.5",
    "M2.5 4V6.5A1.5 1.5 0 0 0 4 8h4",
    "M2.5 8v2.5A1.5 1.5 0 0 0 4 12h4",
  ],
  /* The plan tree's "jump to this chapter" action on not-started/skipped nodes. */
  play: ["M5.5 3.5L12.5 8L5.5 12.5Z"],

  /* The signed-in account, and the door to its own page. */
  user: [
    "M10.5 5.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0",
    "M3.25 13.5c0-2.35 2.13-4.25 4.75-4.25s4.75 1.9 4.75 4.25",
  ],
  /* The platform console: other people's accounts rather than one's own. */
  shield: ["M8 2.25L13.25 4.1V8.5C13.25 11.25 11.1 13.1 8 13.9C4.9 13.1 2.75 11.25 2.75 8.5V4.1Z"],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;

/** Every icon name, for the guard in `test/icons.test.ts` to iterate. */
export const ICON_NAMES = Object.keys(ICON_PATHS) as readonly IconName[];
