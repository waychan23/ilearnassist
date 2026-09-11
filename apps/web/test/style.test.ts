import { describe, expect, it } from "vitest";

/**
 * Guards for the palette in `src/style.css`, in both directions.
 *
 * *Completeness* — a variable declared in `:root` but forgotten in the light palette keeps
 * its dark value. That is invisible for a background (it just stays dark) and unreadable
 * for a foreground: `--warning` was left out, so `.hint.warn` rendered `#e6b33c` on a white
 * dialog at 1.7:1. Adding a variable is the moment to notice, and no screenshot review of
 * a single screen reliably does.
 *
 * *Flips* — restating a variable in the light block is not enough if the value is the same
 * one, so the code surfaces are checked to actually change. The reverse used to be the rule
 * here (code kept a dark background in both themes), which is what made a code surface that
 * inherited a flipping `--text` render dark-on-dark — inline code was `#1f2328` on `#0d1117`,
 * roughly 1.2:1, invisible rather than merely dim.
 *
 * *Consistency* — whatever is painted on a `--code-bg` must state its own foreground, since
 * an inherited one is the other half of that bug.
 *
 * *Not hand-rolled* — the same bug reaches components through a literal rather than an
 * inherited variable: `color: #4cc38a` in a scoped style is the dark palette's `--success`
 * frozen in place, and it stays at 2.2:1 on a light background. The last check scans the
 * component `<style>` blocks for any literal that merely restates a `:root` value.
 *
 * The code-surface checks scan only `src/style.css`. `AttachmentChips.vue` also paints
 * `--code-bg`, on `.thumb` — a placeholder behind a thumbnail `<img>`, with nothing
 * rendered on top of it, so there is no foreground for it to pair with.
 *
 * Which variables are *theme-dependent* is derived from the value (see `isColor`), not kept
 * as a list of names. A list was the original shape and it does not survive a token family:
 * minting thirty non-colour tokens is precisely when someone adds thirty exempt names
 * without re-reading any of them, and the list can then drift from the palette in the
 * silent direction (a name nobody removed). The predicate cannot drift.
 */

const RAW = import.meta.glob("../src/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const COMPONENTS = import.meta.glob("../src/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SOURCE = RAW["../src/style.css"];
if (!SOURCE) throw new Error("src/style.css was not found — has the glob path moved?");

/** `"../src/components/ChatView.vue"` → `"src/components/ChatView.vue"`. */
const shortName = (path: string): string => path.replace(/^.*?\/src\//, "src/");

/** The docblock names these variables in prose; strip comments so only declarations count. */
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "");

interface Block {
  selector: string;
  body: string;
}

/**
 * Every *leaf* rule block. A nested at-rule (`@media … { :root { … } }`) has its inner
 * block matched and its wrapper left unmatched, which is what we want: the wrapper holds
 * no declarations of its own. That does mean the media query around a block is not
 * visible here, which is why the light palette is caught by its `data-theme` selector.
 */
function blocks(css: string): Block[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
  }));
}

/** The two blocks that carry the light palette, exactly as its docblock spells them. */
const LIGHT_SELECTORS = [':root[data-theme="light"]', ':root[data-theme="auto"]'];

const CODE_VARS = ["--code-bg", "--code-fg", "--code-fg-2"];

/**
 * Whether a `:root` variable's value is a colour, and therefore whether the light palette
 * is expected to restate it. Lengths (`--radius`, `--space-*`), durations, layer indices
 * and shadows are not — a shadow that reads correctly on white needs no light variant, and
 * demanding one would mean writing every new token into the palette three times.
 *
 * The blind spot, deliberately: a colour written as `oklch(…)`, `hsl(…)` or a bare name
 * (`red`) is not detected here and would slip through as theme-independent. The palette is
 * hex and `rgba()`, which is the shape this matches; a new token in another notation has to
 * be restated in the light blocks by hand, and `hsl()` would be the moment to widen this.
 */
const isColor = (value: string | undefined): boolean => !!value && /^(#|rgba?\()/i.test(value);

/**
 * Whether the light palette is expected to restate a `:root` variable's value.
 *
 * This was briefly narrowed to exempt a translucent black, on the reasoning that a scrim
 * darkens whatever sits under it rather than carrying a colour of its own and so needs no
 * light variant. That held for shadows and was wrong for `--scrim`: 0.55 of black over a
 * white page composites the whole thing to `#737373`, which erases the sidebar and topbar
 * boundaries and reads as if the theme flipped rather than as if a dialog opened. A colour is
 * a colour — the exemptions are shapes, and a shadow already exempts itself by not starting
 * with a colour.
 */
const needsLightValue = (value: string | undefined): boolean => isColor(value);

/**
 * Token families that are *ramps*, read by their index: `--space-6` is understood as two
 * steps above `--space-4` without a lookup, so a gap or a repeat makes the index lie. A
 * repeat is worse than a gap because CSS accepts it silently — the later declaration simply
 * wins, and nothing else in the toolchain sees two `--space-4`s.
 */
const RAMP_FAMILIES = ["--space-", "--fs-"] as const;

/**
 * Families that are *named* scales. There is no index to check, but a duplicated name is
 * still a bug, and an empty family means the whole scale was dropped in a refactor.
 */
const NAMED_FAMILIES = [
  "--radius",
  "--modal-",
  "--dur-",
  "--z-",
  "--shadow-",
  "--ease-",
  "--lh-",
] as const;

/** Every custom property `body` declares, lowercased. */
function declaredVars(body: string): string[] {
  return [...body.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gi)].map((match) =>
    match[1]!.toLowerCase(),
  );
}

/**
 * Every colour `body`'s declarations resolve to, normalised (lowercased, whitespace
 * stripped) → the variables declaring it. Normalising is what lets a component's literal
 * be compared against the sheet's without worrying about spacing.
 */
function paletteColors(body: string): Map<string, string[]> {
  const colors = new Map<string, string[]>();
  for (const decl of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
    const value = decl[2]!.trim().toLowerCase().replace(/\s+/g, "");
    if (!/^(#|rgba?\()/.test(value)) continue;
    colors.set(value, [...(colors.get(value) ?? []), decl[1]!]);
  }
  return colors;
}

/**
 * The CSS text of every `<style>` block in a component, with comments removed — a docblock
 * in a component quotes values in prose as readily as `style.css`'s does.
 */
function styleCss(source: string): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((block) => block[1]!.replace(/\/\*[\s\S]*?\*\//g, ""))
    .join("\n");
}

/** A `padding` / `margin` / `gap` declaration and its value, logical variants included. */
const SPACING_DECLARATION =
  /(?<![\w-])(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?\s*:\s*([^;{}]+)/gi;

/** Every px length the `--space-*` tokens already carry. */
function spacingValues(): Set<string> {
  const palette = paletteBlock();
  return new Set(
    declaredVars(palette.body)
      .filter((name) => name.startsWith("--space-"))
      .map((name) => declarationOf(palette.body, name)!),
  );
}

/** Every colour literal in a rule body, normalised the same way as `paletteColors`. */
function literalsInBody(body: string): string[] {
  return [...body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((match) =>
    match[0].toLowerCase().replace(/\s+/g, ""),
  );
}

/** Every colour literal in a `<style>` block, normalised the same way. */
function literalsIn(source: string): string[] {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap((block) =>
    literalsInBody(block[1]!),
  );
}

/**
 * Whether `body` *declares* `name` (`--code-bg: …`) — as opposed to using it as a value,
 * like `background: var(--code-bg)`, which has no colon after the name.
 */
function declares(body: string, name: string): boolean {
  return declaredVars(body).includes(name);
}

/** The normalised value `body` gives `name`, or `undefined` if it does not declare it. */
function declarationOf(body: string, name: string): string | undefined {
  for (const decl of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
    if (decl[1]!.toLowerCase() === name) {
      return decl[2]!.trim().toLowerCase().replace(/\s+/g, "");
    }
  }
  return undefined;
}

/** Whether `body` paints `name`, e.g. `background: var(--code-bg)`. */
function paintsBackground(body: string, name: string): boolean {
  return new RegExp(`background(-\\w+)?\\s*:[^;]*var\\(${name}\\)`).test(body);
}

/** Whether `body` uses `name` as a value, e.g. `color: var(--code-fg)`. */
function uses(body: string, name: string): boolean {
  return body.includes(`var(${name})`);
}

/**
 * The block that defines the palette.
 *
 * Selected by *what it declares* rather than by selector position. `:root` legitimately
 * appears more than once — a media query overrides the motion tokens on it, which is how
 * `prefers-reduced-motion` is honoured without auditing every `transition` in the app — and
 * a bare `.find()` would silently take whichever came first. That is the failure this
 * guards: a second palette block would escape every check below and look like a pass.
 *
 * Throwing rather than asserting so the message names the problem; the callers would
 * otherwise fail several assertions later with a confusing diff.
 */
function paletteBlock(all: Block[] = blocks(CSS)): Block {
  const roots = all.filter((block) => block.selector === ":root");
  const carriers = roots.filter((block) =>
    declaredVars(block.body).some((name) => isColor(declarationOf(block.body, name))),
  );

  if (carriers.length !== 1) {
    throw new Error(
      `expected exactly one :root block declaring colours, found ${carriers.length} ` +
        `(of ${roots.length} :root blocks) — a second palette block escapes the light-palette checks`,
    );
  }
  return carriers[0]!;
}

/**
 * Surfaces that follow the theme, each with the foreground tokens that are legitimate on it.
 *
 * A rule that paints one of these must state its own foreground: an inherited `--text` is
 * the other half of the dark-on-dark bug, because it flips independently of the surface it
 * lands on. The user bubble is the pair that was missing here — it carried its own
 * hard-coded colour for so long that it never needed a foreground token, and the moment the
 * surface became themed the omission would have become live.
 */
const PAIRED_SURFACES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["--code-bg", ["--code-fg", "--code-fg-2"]],
  ["--bubble-bg", ["--bubble-fg"]],
];

/** The two selectors that carry a light palette, and the one they both restate. */
const PALETTE_SELECTORS = [":root", ...LIGHT_SELECTORS];

describe("style.css palette", () => {
  it("restates every palette colour in the light palette, unless it cannot flip", () => {
    const all = blocks(CSS);
    const root = paletteBlock();

    // Both, not either: the attribute selector and the media query cannot share values,
    // so each is written out separately and each can drift on its own.
    const light = all.filter((block) => LIGHT_SELECTORS.includes(block.selector));
    expect(light.map((block) => block.selector)).toEqual(LIGHT_SELECTORS);

    const missing = declaredVars(root.body).filter(
      (name) =>
        needsLightValue(declarationOf(root.body, name)) &&
        light.some((block) => !declares(block.body, name)),
    );

    expect(missing).toEqual([]);
  });

  it("neutralises every duration when the user prefers reduced motion", () => {
    // Durations are tokens so this is one override rather than an audit of every
    // `transition`. The cost of that bargain: a transition that hard-codes its duration
    // silently opts out of the preference, so the override is asserted on the tokens rather
    // than on a recording of the drawer.
    const all = blocks(CSS);
    const palette = paletteBlock(all);
    const durations = declaredVars(palette.body).filter((name) => name.startsWith("--dur-"));

    expect(durations.length).toBeGreaterThan(0);
    expect(CSS, "style.css has no reduced-motion block").toContain(
      "@media (prefers-reduced-motion: reduce)",
    );

    // The other `:root` blocks: the palette declares the durations, a media query overrides
    // them. An empty list here would make the check below vacuously true, so it is asserted
    // rather than assumed.
    const overrides = all.filter((block) => block.selector === ":root" && block !== palette);
    expect(overrides.length, "no :root block overrides the duration tokens").toBeGreaterThan(0);

    const notNeutralised = durations.filter((name) =>
      overrides.some((block) => declarationOf(block.body, name) !== "0.01ms"),
    );

    expect(notNeutralised, "a --dur-* token is not neutralised under reduced motion").toEqual([]);
  });

  it("declares each token family, with no gap and no duplicate step", () => {
    const names = declaredVars(paletteBlock().body);

    for (const family of RAMP_FAMILIES) {
      const steps = names
        .filter((name) => name.startsWith(family))
        .map((name) => Number(name.slice(family.length)));

      expect(steps.length, `${family}* declares nothing`).toBeGreaterThan(0);
      expect(steps, `${family}* repeats a step`).toEqual([...new Set(steps)]);
      expect([...steps].sort((a, b) => a - b), `${family}* has a gap`).toEqual(
        steps.map((_, index) => index + 1),
      );
    }

    for (const family of NAMED_FAMILIES) {
      const declared = names.filter((name) => name.startsWith(family));

      expect(declared.length, `${family}* declares nothing`).toBeGreaterThan(0);
      expect(declared, `${family}* repeats a name`).toEqual([...new Set(declared)]);
    }
  });

  it("gives every themed surface a different colour in the light palette, not the same one", () => {
    const root = paletteBlock();
    const light = blocks(CSS).find((block) => block.selector === LIGHT_SELECTORS[0]);
    if (!light) throw new Error(`style.css has no ${LIGHT_SELECTORS[0]} block`);

    // Restating `--code-bg: #0d1117` in the light block would satisfy the completeness check
    // while changing nothing, leaving dark-on-dark exactly as it was.
    //
    // The list is colours whose *magnitude* matters as much as their hue. `--scrim` is here
    // because it was once exempt from the light palette on the argument that a translucent
    // black dims whatever is under it and so needs no variant — true of a shadow, false of
    // this: 0.55 of black over a white page composites everything to `#737373`.
    const mustFlip = [
      ...CODE_VARS,
      ...PAIRED_SURFACES.map(([surface]) => surface),
      "--scrim",
    ];

    const unchanged = mustFlip.filter((name) => {
      const dark = declarationOf(root.body, name);
      return dark !== undefined && dark === declarationOf(light.body, name);
    });

    expect(unchanged).toEqual([]);
  });

  it("pairs every themed surface with a foreground from its own family", () => {
    const offenders = PAIRED_SURFACES.flatMap(([background, foregrounds]) =>
      blocks(CSS)
        .filter(
          (block) =>
            paintsBackground(block.body, background) &&
            !foregrounds.some((name) => uses(block.body, name)),
        )
        .map((block) => `${block.selector} paints ${background} without ${foregrounds.join("/")}`),
    );

    expect(offenders).toEqual([]);
  });

  it("does not hand-roll a palette colour in a rule", () => {
    const root = paletteBlock();
    const palette = paletteColors(root.body);

    // Only literals that *are* a palette value are flagged, so the theme-independent
    // scrims and the `#fff` on a saturated button stay legal without an exemption list.
    // The flip side: a colour mixed for the dark theme but never added to the palette —
    // `#e6c06a`, say — is not caught here, only by reading it.
    const inSheet = blocks(CSS)
      .filter((block) => !PALETTE_SELECTORS.includes(block.selector))
      .flatMap((block) =>
        literalsInBody(block.body)
          .filter((literal) => palette.has(literal))
          .map(
            (literal) =>
              `src/style.css ${block.selector}: ${literal} is ${palette.get(literal)!.join("/")}`,
          ),
      );

    // The sheet's own rules, not just the components'. `#2b3f6b` on `.msg .bubble` lived
    // here: it was correct for the dark theme and frozen at it, so it stayed dark navy on a
    // white background — and scanning only the components could not see it.
    const inComponents = Object.entries(COMPONENTS).flatMap(([path, source]) =>
      literalsIn(source)
        .filter((literal) => palette.has(literal))
        .map((literal) => `${shortName(path)}: ${literal} is ${palette.get(literal)!.join("/")}`),
    );

    expect([...inSheet, ...inComponents]).toEqual([]);
  });

  it("uses only the documented breakpoints", () => {
    // The CSS half of the lock-step in `composables/breakpoints.ts`: the JS half asserts the
    // strings that reach `matchMedia`, this asserts the sheet's media queries are the same
    // values. Media queries cannot read custom properties, so the number is spelt out in
    // both languages and this is the only place the two are compared.
    //
    // It has nothing to check yet — no layout media query exists — and is written now so
    // that the responsive work cannot introduce a stray 768px by habit.
    const noted = [...CSS.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => m[1]);

    expect(noted.filter((px) => !["900", "560"].includes(px!))).toEqual([]);
  });

  it("keeps every breakpoint after the rules it overrides", () => {
    // Position, not specificity, is what decides a media-query override — which is how the
    // narrow `position: fixed` on `.overlay-popover` silently lost to the same class declared
    // further down the file, leaving the popover absolutely positioned and 155px off-screen.
    // Checking the marker exists catches the other half: a `@media` block is easy to append
    // wherever it reads well, and only a positional rule notices.
    // Against `SOURCE`, not `CSS`: the marker lives in a comment, and `CSS` is the sheet with
    // its comments stripped — scanning that for it would never find one.
    const marker = SOURCE.indexOf("responsive ---");
    expect(marker, "style.css has no responsive section marker").toBeGreaterThan(-1);

    const strays = [...SOURCE.matchAll(/@media\s*\(max-width:\s*\d+px\)/g)]
      .map((match) => match.index!)
      .filter((at) => at < marker);

    expect(strays, "a breakpoint is declared above the responsive section").toEqual([]);
  });

  it("does not hand-write a spacing value that a token already carries", () => {
    // The colour scan's counterpart for lengths, and the guard that keeps the token layer
    // from eroding: without it the next `padding: 8px 12px` is indistinguishable from the
    // ones the sweep replaced, and the scale quietly stops meaning anything.
    //
    // Scoped to padding, margin and gap on purpose. `width`, `height`, `min-height` and
    // border widths legitimately carry pixels — a spacing token there would claim a
    // relationship that does not exist, and would tie a hairline border to a spacing edit.
    const values = spacingValues();
    expect(values.size, "no --space-* tokens to check against").toBeGreaterThan(0);

    // `style.css`'s rules, not its palette: the palette's own values are the tokens.
    const sources: ReadonlyArray<readonly [string, string]> = [
      ...Object.entries(COMPONENTS).map(
        ([path, source]) => [shortName(path), styleCss(source)] as const,
      ),
      [
        "src/style.css",
        blocks(CSS)
          .filter((block) => !PALETTE_SELECTORS.includes(block.selector))
          .map((block) => block.body)
          .join("\n"),
      ],
    ];

    const offenders = sources.flatMap(([name, css]) =>
      [...css.matchAll(SPACING_DECLARATION)].flatMap((declaration) =>
        [...declaration[1]!.matchAll(/\d+px/g)]
          .map((match) => match[0])
          .filter((px) => values.has(px))
          .map((px) => `${name}: ${declaration[0].trim().replace(/\s+/g, " ")}`),
      ),
    );

    expect(offenders).toEqual([]);
  });
});
