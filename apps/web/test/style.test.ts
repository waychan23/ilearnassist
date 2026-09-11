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
const FOREGROUNDS = ["--code-fg", "--code-fg-2"];

/**
 * Variables with no reason to appear in the light palette: `--radius` is a length, not a
 * colour. Everything else in `:root` is a colour the light block is expected to restate.
 */
const THEME_INDEPENDENT = ["--radius"];

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

/** Every colour literal in a `<style>` block, normalised the same way. */
function literalsIn(source: string): string[] {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap((block) =>
    [...block[1]!.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((match) =>
      match[0].toLowerCase().replace(/\s+/g, ""),
    ),
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

describe("style.css palette", () => {
  it("restates every :root colour in the light palette, unless it cannot flip", () => {
    const all = blocks(CSS);

    const root = all.find((block) => block.selector === ":root");
    if (!root) throw new Error("style.css has no :root block");

    // Both, not either: the attribute selector and the media query cannot share values,
    // so each is written out separately and each can drift on its own.
    const light = all.filter((block) => LIGHT_SELECTORS.includes(block.selector));
    expect(light.map((block) => block.selector)).toEqual(LIGHT_SELECTORS);

    const missing = declaredVars(root.body).filter(
      (name) =>
        !THEME_INDEPENDENT.includes(name) &&
        light.some((block) => !declares(block.body, name)),
    );

    expect(missing).toEqual([]);
  });

  it("gives the code surfaces a different colour in the light palette, not the same one", () => {
    const root = blocks(CSS).find((block) => block.selector === ":root");
    if (!root) throw new Error("style.css has no :root block");
    const light = blocks(CSS).find((block) => block.selector === LIGHT_SELECTORS[0]);
    if (!light) throw new Error(`style.css has no ${LIGHT_SELECTORS[0]} block`);

    // Restating `--code-bg: #0d1117` in the light block would satisfy the completeness
    // check while changing nothing, leaving dark-on-dark exactly as it was.
    const unchanged = CODE_VARS.filter((name) => {
      const dark = declarationOf(root.body, name);
      return dark !== undefined && dark === declarationOf(light.body, name);
    });

    expect(unchanged).toEqual([]);
  });

  it("pairs every --code-bg background with a --code-fg foreground", () => {
    const offenders = blocks(CSS)
      .filter(
        (block) =>
          paintsBackground(block.body, "--code-bg") &&
          !FOREGROUNDS.some((name) => uses(block.body, name)),
      )
      .map((block) => block.selector);

    expect(offenders).toEqual([]);
  });

  it("does not hand-roll a palette colour in a component style", () => {
    const root = blocks(CSS).find((block) => block.selector === ":root");
    if (!root) throw new Error("style.css has no :root block");
    const palette = paletteColors(root.body);

    // Only literals that *are* a palette value are flagged, so the theme-independent
    // scrims (`rgba(0, 0, 0, 0.4)` behind a dialog) stay legal without an exemption list.
    // The flip side: a colour mixed for the dark theme but never added to the palette —
    // `#e6c06a`, say — is not caught here, only by reading it.
    const offenders = Object.entries(COMPONENTS).flatMap(([path, source]) =>
      literalsIn(source)
        .filter((literal) => palette.has(literal))
        .map((literal) => `${shortName(path)}: ${literal} is ${palette.get(literal)!.join("/")}`),
    );

    expect(offenders).toEqual([]);
  });
});
