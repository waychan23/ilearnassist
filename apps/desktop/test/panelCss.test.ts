import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The panel stylesheet's one structural invariant: **every `var()` it uses is defined in it.**
 *
 * There is no design-system guard on this side of the app — `apps/web/test/style.test.ts` checks
 * the web stylesheet, and the panel is a separate page with its own small token block. That leaves
 * one failure mode wide open: an undefined custom property makes the *whole declaration* invalid
 * at computed-value time, so `background: var(--surface-2)` on a sheet that never defines
 * `--surface-2` does not fall back to a sensible colour — it falls back to transparent, with no
 * warning anywhere. It is the same silent-failure shape as the `--widget-w` note in CLAUDE.md.
 *
 * Written because it happened: the migration row added to this panel used two tokens that do not
 * exist (`--surface-2`, `--radius-2`) and looked correct in the diff.
 */

const CSS = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "renderer", "panel.css"),
  "utf8"
);

/** The tokens the sheet declares, from `:root` and the light-scheme block. */
function declared(): Set<string> {
  return new Set([...CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!));
}

/** The tokens it consumes. */
function consumed(): Set<string> {
  return new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
}

describe("the panel stylesheet", () => {
  it("defines every custom property it uses", () => {
    const missing = [...consumed()].filter((name) => !declared().has(name)).sort();
    expect(missing, `undefined: ${missing.join(", ")} — the declaration using it is dropped`).toEqual(
      []
    );
  });

  /**
   * Colours that are deliberately the same in both themes.
   *
   * An allowlist rather than a blanket "colours need not be restated", because the rule is what
   * catches a colour that was *meant* to change and was forgotten. `--accent-fg` is the text drawn
   * **on** the accent — both palettes' accents are dark enough for white, so restating it would be
   * a second value to keep in agreement with the first for no gain.
   */
  const THEME_INDEPENDENT = new Set(["--accent-fg"]);

  it("declares a light-scheme value for every colour it defines in the dark one", () => {
    /*
     * The same rule the web stylesheet is held to, for the same reason: a colour defined only in
     * the dark palette is one the light theme inherits from the dark block, and the panel's window
     * follows the system rather than a setting.
     */
    const darkBlock = /\n:root \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";
    const lightBlock = /prefers-color-scheme: light[\s\S]*?\n  :root \{([\s\S]*?)\n  \}/.exec(CSS)?.[1] ?? "";
    expect(darkBlock).not.toBe("");
    expect(lightBlock).not.toBe("");

    const isColour = (value: string) =>
      /#|rgb|hsl|oklch/.test(value) && !/shadow|scrim/.test(value);

    const darkColours = [...darkBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)]
      .filter(([, , value]) => isColour(value!))
      .map(([, name]) => name!);
    const lightNames = new Set(
      [...lightBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!)
    );

    const missing = darkColours.filter(
      (name) => !lightNames.has(name) && !THEME_INDEPENDENT.has(name)
    );
    expect(missing, `no light value: ${missing.join(", ")}`).toEqual([]);
  });
});
