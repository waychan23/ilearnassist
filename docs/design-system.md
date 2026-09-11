# Design system

The styling conventions for `apps/web`, and the reasoning behind them. The token tables here
are the source of truth for *what to use*; [`apps/web/src/style.css`](../apps/web/src/style.css)
is the source of truth for *what exists*, and [`apps/web/test/style.test.ts`](../apps/web/test/style.test.ts)
is what keeps the two from drifting.

Read this before adding a colour, a size, a class or a breakpoint.

> **Status.** The token layer, the focus ring, reduced motion and the surface pairing are
> implemented and guarded. The shared-class inventory and the responsive work (breakpoints,
> the drawer, `Teleport` for overlays) are the agreed target and are not in the code yet —
> those sections say so where it matters. Nothing in this document is aspirational about the
> token tables: they describe what is in `style.css` today.

## How this document is organised

| Section | Answers |
| --- | --- |
| [Tokens](#tokens) | Which value do I use for this spacing / size / radius? |
| [Shared classes](#shared-classes) | Is there already a class for this control? |
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
layer indices and shadows are identical in both themes. `--scrim` is the one exception among
colours, because a translucent black darkens what is under it rather than carrying a colour
of its own.

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
| `--scrim` | The dim behind a modal or the mobile drawer. Shared so the two agree |

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

> The tier-1 vocabulary below is in `style.css` today. The tier-2 composites — the popover
> surface, the form grid, the settings rows, the tab strip — are the agreed target of the
> class-consolidation pass and do not exist yet. Until then, the duplication described under
> [when to promote](#when-to-promote) is still live.

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
| `.input`, `.textarea`, `.select` | | Form controls |
| `.field` | child `label`, child `.hint` | A labelled form row |
| `.modal-overlay` → `.modal` → `.modal-head` / `.modal-body` / `.modal-foot` | | Every dialog |

Tier 1 is the vocabulary to reach for first. A component that defines `.model-btn`,
`.token-btn` or `.tab` from scratch instead of using `.btn` or `.icon-btn` is the
duplication this tier exists to prevent.

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

## Accessibility

### Every control needs an accessible name

A glyph is not a copy string. `🗑 ✎ ＋ ✕ ☰ 📎 ⚙` stay in the templates, and the accessible
name comes from the catalog via `t()`. An icon-only button carries both a `title` (for
mouse users) and an `aria-label` (for everyone else) — a `title` never renders on touch, so
a button whose only label is a `title` is unlabelled on a phone.

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

> Which of these are enforced today: the token rules and the colour/surface rules are, by
> `style.test.ts`. The spacing guard, the breakpoint guard and the overlay rule land with the
> phases that introduce what they guard — they are stated here because they are the
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

**A breakpoint.** Breakpoints are literals in CSS *and* strings in JavaScript, because a
media query cannot read a custom property. Nothing can make that one value shared, so it is
guarded instead: `style.test.ts` asserts every `@media (max-width: …)` in the sheet is one of
the documented values, and the breakpoints composable's unit test asserts the same strings
reach `matchMedia`. **Change both together** — a CSS/JS breakpoint mismatch produces a
drawer that opens on a screen with no toggle, or a toggle that does nothing.

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

**`flex-direction: column-reverse` to stack the composer toolbar on a narrow screen.** It
inverts the reading order for screen readers.

**A hand-rolled focus trap for the mobile drawer.** `inert` on the pane behind the drawer
does the same job with no library and no state machine.
