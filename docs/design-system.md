# Design system

The styling conventions for `apps/web`, and the reasoning behind them. The token tables here
are the source of truth for *what to use*; [`apps/web/src/style.css`](../apps/web/src/style.css)
is the source of truth for *what exists*, and [`apps/web/test/style.test.ts`](../apps/web/test/style.test.ts)
is what keeps the two from drifting.

Read this before adding a colour, a size, a class or a breakpoint.

> **Status.** Everything in this document is implemented and guarded. The token tables
> describe what is in `style.css` today; `apps/web/test/style.test.ts`, `test/composables/`
> and `e2e/mobile.spec.ts` are what hold the code to it.

## How this document is organised

| Section | Answers |
| --- | --- |
| [Tokens](#tokens) | Which value do I use for this spacing / size / radius? |
| [Shared classes](#shared-classes) | Is there already a class for this control? |
| [Icons](#icons) | How do I draw a mark, and how do I add one? |
| [Responsive](#responsive) | Which breakpoint, and what has to move with it? |
| [Accessibility](#accessibility) | What do I owe keyboard and touch users? |
| [Adding to the system](#adding-to-the-system) | What has to change together, and what breaks |
| [Deliberately not tokenised](#deliberately-not-tokenised) | Why is this number still a literal? |
| [Rejected alternatives](#rejected-alternatives) | Why is it not done the obvious other way? |

## Tokens

Every token is a custom property declared in the `:root` block at the top of `style.css`.

There is exactly **one palette block**, and a guard enforces that. `:root` itself may appear
more than once — a media query overrides the motion tokens on it, which is how
`prefers-reduced-motion` is honoured without auditing every `transition` in the app — so
`style.test.ts` picks the palette by *which `:root` declares colours* and fails if more than
one does. The reason is not tidiness: a second palette block would escape the light-palette
completeness check entirely, and the omission would look like a passing test. Extend the
palette block; do not add another.

### Naming

**Arithmetic ramps get a numeric index; roles and layers get names.**

- Numeric — `--space-N`, `--fs-N`. The index *is* the meaning: `--space-6` is understood as
  two steps above `--space-4` without a lookup, which is the entire reason to number it.
- Named — `--radius*`, `--dur-*`, `--z-*`, `--shadow-*`, `--ease-*`, `--lh-*`. An index
  would not help: `--radius-3` still needs a lookup to say whether it means a card or a
  chip, while `--radius-lg` says so.

The file already mixed the two conventions (`--text-2` is a ramp; `--radius` is a role).
This rule makes that legible instead of accidental.

### Colour

Dark values are the `:root` declarations; light values are restated in two more blocks (see
[the light palette](#the-light-palette)). Only *colours* are restated — lengths, durations,
layer indices and shadows are identical in both themes, and a shadow exempts itself by not
being a colour.

| Token | Use |
| --- | --- |
| `--bg`, `--sidebar`, `--panel`, `--panel-2` | Page, sidebar, raised surface, nested surface. In the light theme `--bg` and `--panel` are both white and `--panel-2` carries the separation. |
| `--border` | Every 1px divider and control outline |
| `--text`, `--text-2`, `--text-3` | Primary, secondary, tertiary. `--text-3` is for metadata that should recede (timestamps, counts, hints) |
| `--accent`, `--accent-hover` | Interactive emphasis |
| `--accent-bg` | A tinted *surface* derived from the accent — not text. Light and dark need different alphas so the tint is visible against each theme's panel |
| `--focus-ring` | The keyboard focus indicator. Deliberately not `--accent`: the dark accent is only ~2.9:1 on `--panel`, too faint for a 2px ring, so this is a lightened accent |
| `--danger`, `--danger-hover`, `--danger-text`, `--danger-bg`, `--danger-border` | Destructive actions. `--danger-text` is the readable-on-a-tinted-surface variant, `--danger-bg`/`--danger-border` are the tinted surface and its edge |
| `--warning`, `--warning-bg`, `--warning-border` | Caution states. Darkened in the light theme rather than reused — the dark tone is 1.7:1 on a light panel |
| `--success` | Confirmation and healthy status |
| `--bubble-bg`, `--bubble-fg` | The user's message bubble. A **pair**: a rule that paints the background must state the foreground, because an inherited `--text` flips independently of the surface it lands on |
| `--note-bg` | Behind a passage a note is about: the highlighter's own amber, and a **surface** laid under the text rather than a colour the text is — so it has no foreground of its own and the words on it keep `--text`. Not `--accent-bg`, because a mark and a selection are two different claims about the same words. It shares a hue with `--warning` and is separated from it by *place* (a message versus a banner or dialog) and by alpha (0.3 against 0.12) |
| `--code-bg`, `--code-fg`, `--code-fg-2` | Code surfaces, also a paired triple. Each theme's `--code-fg` matches the colour its highlight.js sheet uses for untokenised code, so the two agree instead of differing by a shade |
| `--scrollbar`, `--scrollbar-hover` | Webkit scrollbar thumb |

### Spacing

A 2px base, ten steps. **`padding`, `margin` and `gap` only** — never `width`, `height` or
`min-height`, where a pixel value is the honest unit (`.msg .avatar { width: 30px }`, the
28px minimap gutter).

| Token | Value | Typical use |
| --- | --- | --- |
| `--space-1` | 2px | Hairline nudges inside a badge |
| `--space-2` | 4px | Gap between an icon and its label |
| `--space-3` | 6px | Tight control padding |
| `--space-4` | 8px | Default gap between related controls |
| `--space-5` | 10px | Input and row padding |
| `--space-6` | 12px | Between rows in a list |
| `--space-7` | 16px | Dialog body padding, section padding |
| `--space-8` | 20px | Between sections |
| `--space-9` | 24px | Dialog padding on a wide screen |
| `--space-10` | 32px | Rare; the largest gap in the app |

### Typography

| Token | Value | Typical use |
| --- | --- | --- |
| `--fs-1` | 11px | Badges, counts, the smallest metadata |
| `--fs-2` | 12px | Hints, secondary metadata |
| `--fs-3` | 13px | Control labels, table-ish content |
| `--fs-4` | 14px | Body — matches `body` itself, so it is the default |
| `--fs-5` | 15px | Emphasis inside the message list |
| `--fs-6` | 16px | Section headings |
| `--fs-7` | 18px | The empty-state heading |
| `--fs-8` | 20px | Markdown `h1` |

Line heights: `--lh-tight` (1.3) for headings, `--lh-base` (1.6) for body.

The scale covers every size the app used. Two were consolidated — `10px` into `--fs-1` and
`17px` into `--fs-7` — because a one-off pixel value is how a scale rots.

### Radius

`--radius` keeps its bare name because it is the default and is used roughly twenty times,
and because a mistyped custom property fails *silently*: a `var(--radius-3)` that resolves to
nothing leaves `border-radius` at 0, which neither `typecheck` nor `test` can see.

| Token | Value | Typical use |
| --- | --- | --- |
| `--radius-2xs` | 2px | The bubble's tail corner |
| `--radius-xs` | 4px | Inline code, small badges |
| `--radius-sm` | 6px | Chips, icon buttons |
| `--radius` | 8px | The default: buttons, inputs, cards, tool cards |
| `--radius-md` | 10px | Popovers and menus |
| `--radius-lg` | 12px | Bubbles, dialogs, the composer surface |
| `--radius-full` | 999px | Pills and the minimap anchor |

`border-radius: 50%` stays a literal: a circle on a square box is idiomatic, never
theme-dependent, and a token there is noise.

### Elevation

| Token | Use |
| --- | --- |
| `--shadow-popover` | Menus and popovers that float above the composer |
| `--shadow-toast` | The error toast |
| `--shadow-sheet` | A bottom sheet, whose shadow points up |
| `--scrim` | The dim behind a modal or the mobile drawer. Shared so the two agree, and **theme-dependent**: 0.55 in dark, 0.32 in light. The dark value over a white page composites everything to `#737373` and reads as a theme flip rather than as a dialog |

### Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 0.12s | Background and colour hovers — the default |
| `--dur-base` | 0.2s | Larger state changes |
| `--dur-slow` | 0.28s | The drawer slide |
| `--ease-drawer` | `cubic-bezier(0.2, 0, 0, 1)` | The drawer only; it decelerates into place |

Durations are tokens specifically so
[reduced motion](#prefers-reduced-motion-must-be-honoured) is one override block rather than
an audit of every `transition` in the app.

### Layers

| Token | Value | Occupant |
| --- | --- | --- |
| `--z-rail` | 10 | The message minimap rail |
| `--z-rail-card` | 20 | Its hover preview |
| `--z-popover` | 60 | Menus and popovers above the composer |
| `--z-backdrop` | 70 | The drawer's scrim |
| `--z-drawer` | 80 | The drawer itself |
| `--z-overlay` | 100 | Modal overlays |
| `--z-toast` | 200 | The error toast |

The ordering is load-bearing, not arbitrary. The drawer sits **above popovers** (its own
content can host one) and **below the modal** — Settings is reachable from the sidebar
footer, so a dialog opened from the open drawer has to cover the drawer rather than race it.
The toast stays topmost because it reports the failure of the action that just happened,
including one inside a dialog.

### The light palette

`auto` is an *attribute value* (`data-theme="auto"`), not something resolved in JavaScript,
so the light palette has to be written twice:

- `:root[data-theme="light"]` — the user forced light
- `@media (prefers-color-scheme: light) { :root[data-theme="auto"] }` — following the system

Custom-property values cannot be shared between an attribute selector and a media query, so
the duplication is unavoidable in this arrangement. It is **guarded** rather than trusted:
`style.test.ts` demands that every colour in `:root` is restated in both blocks.

**The one escape** is resolving `auto` to a concrete `light`/`dark` in the pre-paint script,
which would collapse the two blocks into one and remove ~26 duplicated lines. It is rejected:
it changes the meaning of the stored value, and the [`gl-theme` key, the `data-theme`
attribute and the pre-paint script must stay in lock-step](../CLAUDE.md) — the one invariant
this project names explicitly. Do not re-litigate it without reading that contract.

## Shared classes

### Placement

`style.css` is ordered: reset → layout → sidebar → messages → tool cards → composer →
shared controls → modal → trailing odds and ends. A new class goes in the region that
matches its role, **not** at the end of the file — the file already has two small sections
after the modal block, so "the end" scatters unrelated rules together.

### Tiers

**Primitives** are single-property helpers with no theme dependency. **Tier-1 controls** are
the shared control vocabulary. **Tier-2 composites** are a row, a strip, a popover — a
structure several components need.

Tier 1, in `style.css`:

| Class | Modifiers | Use |
| --- | --- | --- |
| `.btn` | `.primary`, `.danger`, `.small`, `:disabled` | Every text button |
| `.icon-btn` | `.danger` | Square button holding one glyph |
| `.segmented` → `.segment` | `[aria-pressed="true"]` | One choice among a few, as a single control. The shared track is the point — two `.btn`s side by side read as two actions, not two states of one thing |
| `.input`, `.textarea`, `.select` | | Form controls |
| `.field` | child `label`, child `.hint` | A labelled form row |
| `.modal-overlay` → `.modal` → `.modal-head` / `.modal-body` / `.modal-foot` | | Every dialog |

Tier 1 is the vocabulary to reach for first. A component that defines `.model-btn`,
`.token-btn` or `.tab` from scratch instead of using `.btn` or `.icon-btn` is the
duplication this tier exists to prevent.

**`.segment` is keyed on `aria-pressed`, not on a class.** The state a screen reader announces
and the state the sheet paints are then the same fact, so they cannot drift — and the drift is
invisible to whoever is not in the affected audience. A `.active` class would be a second copy
of it.

Tier 2, in `style.css`, for structures several components need:

| Class | Modifiers | Use |
| --- | --- | --- |
| `.form-grid` | | Two columns, no row gap — rows carry their own margin. Sites that need a different gap override it and still inherit the narrow-screen collapse |
| `.overlay-popover` | | The surface for anything anchored above a control: background, border, radius, shadow, `--z-popover` and the upward anchor. Callers set their own size |
| `.modal.sm` / `.modal.lg` | | Dialog widths, from `--modal-sm` / `--modal-lg`. `.modal` alone is `--modal-md` |
| `.tool-checks` | with `.form-grid` | The Copilot tool checkbox grid — the shared grid at a tighter gap |
| `.defaults` | | A collapsed section of a form: the box, plus the summary's spacing when it is open. A `<details>`, so open and closed is the browser's state rather than a flag |
| `.widget-panel` / `.widget-column` / `.widget-body` | `.vertical`, `.collapsed`, `.open` | The right sidebar: the column, the scroller under the strip, and the two states. `open` is the drawer form below 900px |
| `.widget-tabs` / `.widget-tab` | `[aria-selected]`, `.vertical` | The widget strip. A **variant** of `.tabs`/`.tab` rather than the same class, and the reason is the vertical rail: `.tab`'s only state signal is a `border-bottom` underline, which does not survive a column |
| `.widget-resize` | | The panel's drag handle. A `role="separator"` on the panel's left edge |
| `.widget-checks` | | A widget checkbox group inside a `.field`, in the two create dialogs |
| `.list-row` | | A row in a settings list: the box, and the flex row inside it. Variants keep their own gap, padding and alignment |
| `.row-actions` | | The icon-button cluster at the end of a row |
| `.tabs` / `.tab` / `.tab-count` | `.active` | The tab strip on a tabbed dialog |
| `.check-row` | `.sm` | A labelled checkbox — one line, whole line clickable |
| `.badge` | `.muted` | A small outlined label. `muted` drops the accent, for the variant that reports absence rather than presence |
| `.status-dot` | `.ok`, `.off` | A status dot. `ok` is the smaller health dot; `off` is the same dot with nothing in force |
| `.menu-item` | `.foot` | A full-width action row in a popover, plus the footer that sits under a divider |
| `.btn.ghost` | | A text button with no chrome until hovered |
| `.pill` | | The rounded outline shared by the Copilot tag and the token counter — shape only |
| `.truncate` | | The single truncation rule. Includes `min-width: 0`, which is what makes the other three declarations do anything on a flex item |
| `.clamp-2`, `.clamp-4` | | The same idea for a paragraph: keep N lines and ellipsis the rest. By **line** and not by character count, because the same words are one line in a narrow pane and three in a wide one |
| `.note-highlight`, `.note-flash` | | The mark under an annotated passage, and the flash 定位 gives it. Global rather than scoped, because they wrap nodes `v-html` wrote — and `.note-highlight` carries no padding or radius, since one highlight can span elements and either would show as a gap at every boundary |

### Naming a scoped class

Scoped styles are scoped, so two components can both define `.dot` without colliding — but
they will still *read* as the same thing and drift apart. Before adding a scoped class, check
whether the name is already in use elsewhere in `apps/web/src`; if it is, either promote the
shared part to a tier-1 or tier-2 class, or choose a name that says what this one is
(`.reasoning-badge` rather than `.dot`).

The trap to avoid: identical *names* for different things. `ModelSelector`'s `.dot` is a 6px
status dot, `ReasoningBlock`'s was an 18px icon chip, and `SettingsDialog`'s is an 8px
copilot dot. Merging all three would have been a regression; only the two small dots are the
same idea.

### When to promote

Promote to `style.css` when the third copy appears, or when a rule needs to change at a
breakpoint. The second condition matters more than it looks: a mobile override can only be
written once if the rule exists once. Two popovers that both need to become sheets on a
phone are two places to forget.

## Icons

Every mark in the UI is `<Icon name="…" />`, drawn from `ICON_PATHS` in
[`apps/web/src/utils/icons.ts`](../apps/web/src/utils/icons.ts). There is no second way in:
no character, no emoji, no inline `<svg>` at a call site.

The reason is not that the characters looked inconsistent, though they did — half of them
were colour emoji and half were monochrome text glyphs, so 🗑 sitting next to ✕ in one
toolbar was drawn by two different fonts, at two different weights and baselines. Two
concrete bugs came out of the mixing, and neither is visible in a screenshot review:

- **An emoji ignores `color`.** It is painted by a colour font, so
  `.icon-btn.danger:hover { color: var(--danger) }` recoloured the dialog close buttons and
  did *nothing* to the delete buttons beside them. Every state carried by colour — hover,
  `.danger`, disabled — is silently dead on a colour-emoji icon.
- **A glyph inside a sentence cannot be styled.** Ten characters lived in the two catalogs
  rather than in a template, where nothing could size, colour or align them. The drift that
  followed is the honest argument: `settings.providers.keySet` rendered `✓ Key 已配置` while
  `modelSelector.keyMissing` — the same idea — rendered with no mark at all.

### The style

One description, and it is the whole convention:

| Property | Value |
| --- | --- |
| Grid | 16×16 viewBox, geometry inside roughly 2–14 so a 1.5 stroke is not clipped |
| Paint | `fill="none"`, `stroke="currentColor"` — stroked, never filled |
| Stroke | `1.5`, round caps and joins |
| Detail | Nothing that disappears below 14px |

`currentColor` is what makes this better than what it replaced: an icon inherits hover,
`.danger` and `--text-3` without knowing anything about colour, so the state rules already
in `style.css` simply work. A filled glyph is the one thing ruled out — fill is exactly the
weight mismatch the emoji brought.

Sizing defaults to `1em`, deliberately. Every glyph this replaced was sized by `font-size`,
so `.icon-btn { font-size: var(--fs-4) }` and `.tool-card .tool-head .icon { font-size:
var(--fs-2) }` keep working untouched and an icon in running text tracks that text.
`Icon.vue`'s `size` prop exists for the few fixed-size boxes — the 30px avatar, the 36px
file chip — where `1em` would inherit something arbitrary.

### Not an icon

Three characters are punctuation the copy is built from and stay as characters: the `→` in
`Settings → Providers`, the `·` in a `1.2 MB · 3 pages` list, and the `▍` streaming cursor
in `style.css`. `icons.test.ts` strips the first two before it scans, and does not scan the
sheet at all.

The server's `⚠️ ` is out of scope for the same reason it is untranslated: it is persisted
into the conversation and replayed to the model, so it is content rather than chrome.

## Responsive

Two breakpoints, and both are minimums rather than preferences:

| Name | Query | What changes |
| --- | --- | --- |
| compact | `(max-width: 900px)` | The sidebar becomes a drawer; the widget panel becomes a drawer at the right; the minimap rail is hidden |
| narrow | `(max-width: 560px)` | The composer toolbar reflows; forms go single-column; dialogs become bottom sheets |

The minimap's rule predates the drawer and set the value: below 900px its preview card has
nowhere to go. Aligning the drawer to the same number means one mental model and one
guarded constant rather than two numbers that look alike.

`compact` is the breakpoint that matters structurally. It takes the sidebar out of the grid
entirely — `position: fixed`, translated off-canvas — rather than re-columning it. Leaving it
as a grid item would make it an implicit second **row**, collapsing `.main`'s height and
silently stopping the message list from scrolling. The `minmax(0, 1fr)` comment in
`style.css` documents that exact failure; do not undo either half of it.

**A closed drawer must be unreachable, twice over.** `visibility: hidden` keeps its controls
out of the tab order, and `inert` takes the pane behind it out of the tab order and the
accessibility tree while it is open. That pair is the whole focus story — `inert` is a focus
trap with no state machine, and a hand-rolled one is not needed.

**There are two drawers, one at each edge, and they are separate flags.** The widget panel is a
third grid *track* on a wide screen and a fixed overlay here, which is why `App.vue` withholds
`.app.with-widgets` at this width — the class would add a track the drawer does not occupy, and
the panel would be laid out in it while also being `position: fixed`. Its width is capped against
the viewport (`min(320px, 88vw)`) rather than fixed, since 320px on a 412px screen is most of the
screen, and its drag handle is not rendered at all: a fixed overlay has no width to drag.

**Each drawer's toggle sits at the edge its panel appears at.** The sidebar's is on the left beside
the way out; the widget panel's is the topbar's **last** control, past `TopbarControls`, so it is
against the right edge. That is not decoration — a toggle at the wrong end points away from what it
opens — so a reordering of the topbar has to keep it last. It also joins
`@media (pointer: coarse)`'s 44px list with the other topbar buttons: being compact-only, it is a
touch target on essentially every screen it appears on.

**Overlays are teleported to `body`, and this is not optional.** A `position: fixed` element
whose ancestor is transformed is positioned against *that ancestor*. The drawer is a
transformed ancestor, so a dialog left inside the sidebar would be laid out in the off-canvas
panel and render off-screen. Adding a dialog means adding the `Teleport`, and giving `.app`
a `transform`, `filter` or `contain` would break every overlay at once.

**A popover anchored inside an `overflow: hidden` ancestor must anchor to something that keeps it
inside.** The widget strip's overflow menu is the cautionary tale: anchored to its *button*, a
`min-width` menu grew leftward from a button sitting mid-strip, crossed the panel's left edge and
was clipped away — while remaining in the DOM, focusable, and reported as visible by every check
Playwright makes. Only the click revealed it, landing on the chat pane underneath. Anchoring the
same menu to the *strip* (whose right edge is at most ~66px inside the panel) puts it back in
bounds. When a popover is clipped rather than misplaced, the fix is the anchor, not the position.

**Breakpoints are literals in two languages.** A media query cannot read a custom property
and JavaScript cannot evaluate CSS, so `900` and `560` are written in both. Nothing can make
that one value, so it is guarded: `breakpoints.test.ts` pins the strings that reach
`matchMedia`, and `style.test.ts` pins the sheet's media query values. Change both together —
a mismatch produces a drawer that opens on a screen with no toggle, or a toggle that does
nothing.

## Accessibility

### Every control needs an accessible name

An icon is not a copy string. It comes from [`<Icon>`](#icons), which is `aria-hidden` and
carries no name of its own, and the accessible name comes from the catalog via `t()`. An
icon-only button carries both a `title` (for mouse users) and an `aria-label` (for everyone
else) — a `title` never renders on touch, so a button whose only label is a `title` is
unlabelled on a phone.

Keeping the name off the SVG is the point: a name written there would be a second, English
one, outside the catalog. It belongs on the control, where the two languages already agree.

`no-hardcoded-text.test.ts` only detects CJK, so an English `aria-label="Open sidebar"`
literal would pass it silently. There is no machine guard for this; it is a review rule.

### The focus ring is global

```css
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
```

`:where()` keeps the specificity at zero, so this loses to any class rule by design — it is
a floor, not an override. Because it is that weak, a component that says `outline: none`
kills it outright; the fix is to delete the `outline: none`, never to out-specify it.

### Hit targets

| Size | For |
| --- | --- |
| 44px | Primary actions: send, the nav toggle, drawer rows |
| 32px | Secondary per-item actions, such as the copy button on a message |

WCAG 2.5.8 asks for 24px and iOS for 44px. A 44px copy button on every message is visually
heavy, so the secondary tier sits deliberately between the two.

### Touch is a pointer question, not a width question

Anything revealed on `:hover` is invisible on a touch device at **any** width — a 1024px
tablet has no narrow-layout problem and still cannot hover. Key these on
`@media (hover: none)` / `@media (pointer: coarse)`, never on a width breakpoint.

### `prefers-reduced-motion` must be honoured

`--dur-*` are overridden inside `@media (prefers-reduced-motion: reduce)` rather than
auditing every `transition`. Adding an animation means adding its duration token to that
block, not writing a new media query.

## Adding to the system

> Which of these are enforced today: the token rules, the colour/surface rules and the
> spacing rule are, by `style.test.ts`. The breakpoint guard and the overlay rule land with
> the phases that introduce what they guard — they are stated here because they are the
> convention either way, and a class added now should already follow them.

**A token.** Add it to the `:root` block. If its value is a colour (hex or `rgb`/`rgba`),
restate it in **both** light blocks — the guard will fail until you do, and the failure is
the point: a colour that is not restated keeps its dark value, which is invisible for a
background and unreadable for a foreground. Add it to a family already in the
[guard list](../apps/web/test/style.test.ts) or the family check will not cover it. Run
`pnpm test`.

**A component class.** Check for an existing tier-1 class first. If you add a scoped rule
that merely restates a token value, expect the spacing guard to fail once it is in scope —
that guard exists to stop the token layer eroding, and its `MIGRATION_PENDING` list is the
only sanctioned exemption.

**A third copy of a scoped class is the promotion trigger, and it has now fired twice.**
`.tool-checks` came from the tool checkbox grid, and `.defaults` from the Copilot editor's
collapsed "other parameters" section when the new-session dialog needed the same disclosure —
so the disclosure moved to `style.css` and `CopilotDialog` lost its scoped block. The second
condition in [When to promote](#when-to-promote) is the one to watch: a rule that has to change
at a breakpoint can only be overridden once if it exists once.

**The widget panel added no colour and no tier-1 control.** It is built from `--sidebar`,
`--panel`, `--panel-2`, `--border`, `--text-*` and `--accent`, so nothing had to be restated in
the two light blocks; the install/uninstall control is `.btn.small` with the label naming the
*action* and `aria-pressed` carrying the state, which is the same split `.segment` makes with
`aria-pressed` and `sidebar.collapse`/`expand` makes with its two labels. Its three widths — the
36px rail, the 8px handle and the panel's own default — are px literals, which is the documented
exception below: width is not a spacing relationship.

**A breakpoint.** Breakpoints are literals in CSS *and* strings in JavaScript, because a
media query cannot read a custom property. Nothing can make that one value shared, so it is
guarded instead: `style.test.ts` asserts every `@media (max-width: …)` in the sheet is one of
the documented values, and the breakpoints composable's unit test asserts the same strings
reach `matchMedia`. **Change both together** — a CSS/JS breakpoint mismatch produces a
drawer that opens on a screen with no toggle, or a toggle that does nothing.

**An icon.** Add the name and its paths to `ICON_PATHS` in `src/utils/icons.ts`, following
[the style](#the-style) — a 16 grid, stroked, `currentColor`, no fill. Then use it. The
name is a union type, so a typo is a compile error, and `icons.test.ts` checks that the path
data parses and uses only drawing commands, that every name resolves from every call site,
and that every name in the set is drawn somewhere — an icon added and then not used fails
the build rather than sitting in the set forever.

**An overlay.** Render it through a `Teleport` to `body`. A `position: fixed` overlay
positioned inside a transformed ancestor (the mobile drawer uses `transform`) is positioned
against that ancestor and lands off-screen. See the warning comment on `.app`.

## Deliberately not tokenised

Reading as a decision rather than an omission:

- `0`, `100%`, `50%`, `100vw` / `100vh` / `100dvh` — not a scale, and a token adds indirection
  without a meaning to name.
- `1px` borders — the only stroke width in the app, and `--space-*` is for padding, margin and
  gap. Using a spacing token here would let a spacing change silently alter every border.
- `border-radius: 50%` — see [radius](#radius).
- The `body` font stack — the product ships no font files and relies on the system stack.
- `width` / `height` / `min-height` pixel values — these are not spacing and there is no
  scale they belong to.

## Rejected alternatives

Recorded so they are not re-litigated. Each has a real cost, not merely a preference.

**A second `:root` block for new tokens.** The completeness check uses `.find()`, so a second
block escapes it entirely — its colours would never be demanded in the light palette and the
omission would look like a passing test.

**Renaming `--radius` to `--radius-3` for consistency with `--space-N`.** Roughly forty call
sites, and an unresolved `var()` fails silently. If it is ever done it needs a new guard —
"every `var(--x)` resolves to a declaration" — with an allowance for the custom properties
components set inline via `:style` (`--pct` on the token ring).

**Resolving `auto` in JavaScript to collapse the light palette.** See
[the light palette](#the-light-palette).

**Tailwind, UnoCSS or a component library.** The token layer covers the same ground with no
build step and no runtime dependency, and the existing guard suite already enforces the
invariants a framework would otherwise supply.

**Emoji, an icon font, or an icon library.** Emoji are painted by a colour font and so
ignore `color`, which is the bug [the icons section](#icons) opens with. An icon font has
the problem any font has: the glyphs depend on what is installed, so the same page renders
differently on macOS, Windows and Android, and there is nothing a test could hold to. A
library such as `lucide-vue-next` solves the drawing itself and would be a reasonable
answer, but it buys that with a runtime dependency in a stylesheet that has none — the whole
set here is about forty lines of path data, and a guard testing that call sites name a real
icon is needed either way.

**`flex-direction: column-reverse` to stack the composer toolbar on a narrow screen.** It
inverts the reading order for screen readers.

**A hand-rolled focus trap for the mobile drawer.** `inert` on the pane behind the drawer
does the same job with no library and no state machine.
