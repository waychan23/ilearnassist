import { describe, expect, it } from "vitest";
import { ICON_NAMES, ICON_PATHS } from "../src/utils/icons";

/**
 * Guards for the icon set, in three directions.
 *
 * *Nothing arrives as a character.* The UI used to draw its icons with Unicode, mixing
 * colour emoji with monochrome text glyphs, and both failure modes that produced are
 * invisible in a screenshot review of one screen. An emoji is painted by a colour font,
 * so it silently ignores `color` — `.icon-btn.danger:hover` was a rule that worked on
 * the dialog close buttons and did nothing on the delete buttons next to them. And a
 * glyph buried in a translated sentence cannot be sized, recoloured or aligned, which is
 * how `✓ Key configured` ended up in the catalog while the same idea in `ModelSelector`
 * carried no mark at all. Both are caught here: the templates and the catalogs are
 * scanned for the characters the set replaced, so the next one has to be an `<Icon>`.
 *
 * *Nothing dangles.* A `<Icon name="…">` that resolves to nothing renders an empty `<svg>`
 * — a blank square where a control should be — and `IconName` only catches it when the
 * name is a literal in a typed position. Every name written in a template is resolved
 * here, and every icon in the set has to be reachable, so the set cannot accumulate
 * entries nothing draws.
 *
 * *Nothing wanders.* The style is a 16x16 grid, stroked, `currentColor`. A pasted icon
 * arrives as a filled shape or with a `transform`, which is exactly the weight mismatch
 * the emoji had, so the path data is checked to start at a moveto and to use only the
 * drawing commands — no fills, no matrices, no dropped-in `E` exponents.
 */

const SOURCES = import.meta.glob("../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `"../src/components/ChatView.vue"` → `"src/components/ChatView.vue"`. */
const shortName = (path: string): string => path.replace(/^.*?\/src\//, "src/");

const ENTRIES = Object.entries(SOURCES).map(([path, raw]) => [shortName(path), raw] as const);
if (ENTRIES.length === 0) throw new Error("no sources matched — has the glob path moved?");

/**
 * The path separator and the metadata separator.
 *
 * These are punctuation the copy is built from, not icons, so they survive the sweep —
 * `Settings → Providers` is a breadcrumb and `1.2 MB · 3 pages · cloud` is a list. They
 * are stripped before the check rather than excluded from the ranges, so the ranges can
 * stay broad: a new `▴` or `★` should be caught, and only these two are known-good.
 */
const TYPOGRAPHIC = /[→·]/g;

/**
 * Everything the icon set replaced, plus the planes a new one would come from.
 *
 * The ranges cover the astral emoji, the arrows, geometric shapes, dingbats and misc
 * symbols, because that is where the next stray glyph would be picked up. The fullwidth
 * block is deliberately *not* ranged — it is mostly Chinese punctuation, and `，` and `。`
 * would light the whole catalog up; the one fullwidth character that was an icon is the
 * plus, named explicitly.
 */
const FORBIDDEN = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{00D7}\u{FF0B}]/u;

/**
 * Strip comments **one line at a time**, so line numbers survive for the report.
 *
 * Comments are documentation, not UI — a glyph in a doc comment cannot reach a screen,
 * and rewriting the codebase's prose is not what this is for. `no-hardcoded-text.test.ts`
 * strips them for the same reason. A glyph in a string literal, which is where one could
 * actually render, is still caught.
 */
function strippedLines(raw: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of raw.split("\n")) {
    let s = line;
    if (inBlock) {
      const end = s.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      s = s.slice(end + 2);
      inBlock = false;
    }
    s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    const blockStart = s.indexOf("/*");
    if (blockStart !== -1) {
      s = s.slice(0, blockStart);
      inBlock = true;
    }
    s = s.replace(/(^|[^:])\/\/.*$/, "$1");
    out.push(s);
  }
  return out;
}

function strayGlyphs(): string[] {
  const found: string[] = [];
  for (const [file, raw] of ENTRIES) {
    strippedLines(raw).forEach((line, i) => {
      if (FORBIDDEN.test(line.replace(TYPOGRAPHIC, ""))) {
        found.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }
  return found;
}

/**
 * A statically-written `name=` on an `<Icon>`.
 *
 * The lookbehind skips `:name`, which is a binding — its value is an expression
 * (`done ? 'check' : 'retry'`), not a name, and the names inside it are covered by the
 * reachability check instead.
 */
function staticIconNames(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const [file, raw] of ENTRIES) {
    if (!file.endsWith(".vue")) continue;
    for (const m of raw.matchAll(/<Icon\b[^>]*?(?<![:-\w])name="([^"]*)"/g)) {
      out.push({ file, name: m[1] ?? "" });
    }
  }
  return out;
}

describe("icons come from the set", () => {
  it("resolves every statically-written icon name", () => {
    const unknown = staticIconNames()
      .filter(({ name }) => !(name in ICON_PATHS))
      .map(({ file, name }) => `${file}: <Icon name="${name}">`);
    expect(unknown).toEqual([]);
  });

  it("has no stray glyph left in a template, a script or a catalog", () => {
    expect(strayGlyphs()).toEqual([]);
  });

  it("draws every icon in the set somewhere", () => {
    const dead = ICON_NAMES.filter(
      (name) =>
        !ENTRIES.some(
          ([file, raw]) =>
            file !== "src/utils/icons.ts" &&
            (raw.includes(`"${name}"`) || raw.includes(`'${name}'`)),
        ),
    );
    expect(dead).toEqual([]);
  });
});

describe("icons keep one style", () => {
  /** The drawing commands SVG defines. A letter outside this set is a malformed path. */
  const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";

  it("starts every path at a moveto and uses only drawing commands", () => {
    const bad: string[] = [];
    for (const name of ICON_NAMES) {
      for (const d of ICON_PATHS[name]) {
        const letters = d.match(/[A-Za-z]/g) ?? [];
        if (!/^[Mm]/.test(d)) bad.push(`${name}: does not start at a moveto — ${d.slice(0, 40)}`);
        const illegal = letters.filter((c) => !COMMANDS.includes(c));
        if (illegal.length) bad.push(`${name}: illegal command ${illegal.join("")} — ${d.slice(0, 40)}`);
        // Everything that is not a command letter has to be a number, a separator or a
        // sign. A stray character here is what a pasted icon looks like.
        if (!/^[\s\d.,+-]*$/.test(d.replace(/[A-Za-z]/g, ""))) {
          bad.push(`${name}: unparsable path data — ${d.slice(0, 40)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("starts inside the 16x16 grid", () => {
    // Only the opening moveto is checked, and only because it is the one coordinate in a
    // path that is absolute by definition. The rest of a path is mostly relative (`l`,
    // `a`, `c`) or an arc's radii and flags, none of which are positions — a range check
    // over every number would flag `l-6.13 6.13` as an off-grid point. Catching a
    // wholesale paste from a 24-unit set is what this is for; the rest is a matter of
    // looking at it, which is why the change that introduced these was reviewed on screen.
    const bad: string[] = [];
    for (const name of ICON_NAMES) {
      for (const d of ICON_PATHS[name]) {
        const start = /^[Mm]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d);
        if (!start) {
          bad.push(`${name}: no readable moveto — ${d.slice(0, 40)}`);
          continue;
        }
        const [x, y] = [Number(start[1]), Number(start[2])];
        if (x < 0 || x > 16 || y < 0 || y > 16) {
          bad.push(`${name}: starts at ${x},${y}, outside the grid — ${d.slice(0, 40)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
