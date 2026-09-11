import { afterEach, describe, expect, it, vi } from "vitest";
import darkSyntax from "highlight.js/styles/github-dark.css?inline";
import lightSyntax from "highlight.js/styles/github.css?inline";
import type { useTheme as UseTheme } from "../../src/composables/theme.js";

/**
 * The theme composable is the only stateful bit of the theme feature — CSS keys off a
 * `data-theme` attribute it owns, and localStorage is its persistence — so it is unit
 * tested in jsdom while the components themselves are left to the Playwright suite.
 */

type ThemeApi = ReturnType<typeof UseTheme>;

/** The media stub the composable's `matchMedia` call captured, for the "live flip" test. */
let mediaStub:
  | {
      matches: boolean;
      addEventListener: (type: string, cb: () => void) => void;
      removeEventListener: () => void;
      addListener: (cb: () => void) => void;
      removeListener: () => void;
      _listeners: (() => void)[];
    }
  | undefined;

/** The module reads storage at import time, so a fresh import is needed per scenario. */
async function loadTheme(stored: string | null, matchesDark = false): Promise<ThemeApi> {
  vi.resetModules();
  localStorage.clear();
  if (stored !== null) localStorage.setItem("gl-theme", stored);

  // `matchMedia` does not exist in jsdom. Return a singleton so `loadTheme`'s later
  // reference and the composable's import-time reference are the same object.
  const listeners: (() => void)[] = [];
  mediaStub = {
    matches: matchesDark,
    addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
    removeEventListener: () => undefined,
    addListener: (cb: () => void) => listeners.push(cb),
    removeListener: () => undefined,
    _listeners: listeners,
  };
  vi.stubGlobal("matchMedia", () => mediaStub);

  const mod = await import("../../src/composables/theme.js");
  return mod.useTheme();
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useTheme", () => {
  it("defaults to auto and applies it as the data-theme attribute", async () => {
    const { mode } = await loadTheme(null);
    expect(mode.value).toBe("auto");
    expect(document.documentElement.getAttribute("data-theme")).toBe("auto");
  });

  it("reads a stored choice back", async () => {
    const { mode } = await loadTheme("dark");
    expect(mode.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores a stored value that is not a known theme", async () => {
    // A hand-edited or legacy localhost value must not wedge the theme.
    const { mode } = await loadTheme("sepia" as string);
    expect(mode.value).toBe("auto");
  });

  it("persists a change and applies it to the document", async () => {
    const { setTheme, mode } = await loadTheme("auto");
    setTheme("light");
    expect(mode.value).toBe("light");
    expect(localStorage.getItem("gl-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("cycles light → dark → auto → light", async () => {
    const { cycle, mode } = await loadTheme("light");
    expect(cycle()).toBe("dark");
    expect(cycle()).toBe("auto");
    expect(cycle()).toBe("light");
    expect(mode.value).toBe("light");
  });

  it("resolves `auto` from the system preference", async () => {
    expect((await loadTheme("auto", true)).resolved.value).toBe("dark");
    expect((await loadTheme("auto", false)).resolved.value).toBe("light");
  });

  it("resolves a forced theme regardless of the system", async () => {
    expect((await loadTheme("light", true)).resolved.value).toBe("light");
  });

  it("flips `resolved` live when the system theme changes", async () => {
    const theme = await loadTheme("auto", false);

    // Simulate the OS switching to dark: recompute `matches`, then fire the listener the
    // composable registered on that same media object.
    mediaStub!.matches = true;
    mediaStub!._listeners.forEach((fn) => fn());

    expect(theme.resolved.value).toBe("dark");
  });

  it("survives unavailable storage, falling back to auto", async () => {
    const denied = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
      clear: () => undefined,
    } as unknown as Storage);
    const { mode, setTheme } = await loadTheme(null);
    expect(mode.value).toBe("auto");
    // A failed write must not throw, and the in-memory + DOM theme still update.
    expect(() => setTheme("dark")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

/**
 * `highlight.js` ships one stylesheet per theme and both key off `.hljs`, so the resolved
 * theme decides which one is in the document. The assertions compare against the same
 * imports the composable uses, rather than poking at vendor colours — the precondition
 * test below is what keeps them from passing vacuously if `?inline` ever returns a stub.
 */
describe("useTheme's syntax stylesheet", () => {
  /** The `<style>` element the composable swaps the highlight.js theme into. */
  const syntaxStyle = (): HTMLStyleElement | null =>
    document.getElementById("gl-syntax-theme") as HTMLStyleElement | null;

  /** Which vendor sheet the element is currently carrying. */
  const served = (): "light" | "dark" | "none" => {
    const text = syntaxStyle()?.textContent ?? "";
    if (text.includes(darkSyntax)) return "dark";
    if (text.includes(lightSyntax)) return "light";
    return "none";
  };

  it("imports both vendor themes as text, and they are different stylesheets", () => {
    expect(lightSyntax).toContain(".hljs");
    expect(darkSyntax).toContain(".hljs");
    expect(lightSyntax).not.toBe(darkSyntax);
  });

  it("lays the vendor rules down, so document order cannot decide a tie", async () => {
    // Vite puts style.css after this element in dev but before it in a build. Layered rules
    // lose to unlayered ones either way, which is what keeps our `pre code { padding: 0 }`
    // from losing to the vendor's `pre code.hljs { padding: 1em }` in a build.
    await loadTheme("light");
    expect(syntaxStyle()?.textContent).toContain("@layer hljs");
  });

  it("serves the stylesheet matching the resolved theme", async () => {
    await loadTheme("light");
    expect(served()).toBe("light");

    await loadTheme("dark");
    expect(served()).toBe("dark");
  });

  it("follows the system while the theme is auto", async () => {
    await loadTheme("auto", true);
    expect(served()).toBe("dark");

    await loadTheme("auto", false);
    expect(served()).toBe("light");
  });

  it("swaps on a theme change, reusing one element rather than stacking them", async () => {
    const { setTheme } = await loadTheme("light");
    expect(served()).toBe("light");

    setTheme("dark");
    // Synchronous: a deferred swap would leave the attribute and the token colours out of
    // step for a frame.
    expect(served()).toBe("dark");

    setTheme("light");
    expect(served()).toBe("light");

    expect(document.querySelectorAll("#gl-syntax-theme")).toHaveLength(1);
  });

  it("swaps when the system flips under auto", async () => {
    await loadTheme("auto", false);
    expect(served()).toBe("light");

    mediaStub!.matches = true;
    mediaStub!._listeners.forEach((fn) => fn());

    expect(served()).toBe("dark");
  });
});