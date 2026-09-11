import { afterEach, describe, expect, it, vi } from "vitest";
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