import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The JS half of the breakpoint contract.
 *
 * A breakpoint is a literal in two languages — a CSS media query and a JavaScript string —
 * and nothing can make them one value: a media query cannot read a custom property, and the
 * JS side cannot evaluate CSS. So the number is written twice and the only defence is to
 * pin both. `style.test.ts` asserts the sheet's `@media (max-width: …)` values are the
 * documented ones; this asserts the strings that reach `matchMedia` are the same two.
 *
 * The *values* are what is asserted, not the exported constants. Importing `COMPACT` and
 * comparing it against itself would pass whatever it was changed to.
 */

interface Stub {
  matches: boolean;
  addEventListener: (type: string, cb: (event: MediaQueryListEvent) => void) => void;
  removeEventListener: () => void;
  _listeners: ((event: MediaQueryListEvent) => void)[];
}

const queries: string[] = [];
const stubs = new Map<string, Stub>();

/** Load a fresh module, recording every query it asks for. */
async function load(matches: Record<string, boolean> = {}) {
  vi.resetModules();
  queries.length = 0;
  stubs.clear();

  vi.stubGlobal("matchMedia", (query: string) => {
    queries.push(query);
    const listeners: ((event: MediaQueryListEvent) => void)[] = [];
    const stub: Stub = {
      matches: matches[query] ?? false,
      addEventListener: (_type, cb) => listeners.push(cb),
      removeEventListener: () => undefined,
      _listeners: listeners,
    };
    stubs.set(query, stub);
    return stub;
  });

  return import("../../src/composables/breakpoints.js");
}

/** Fire the registered change listeners, as the browser would. */
function raise(query: string, matches: boolean) {
  const stub = stubs.get(query);
  if (!stub) throw new Error(`nothing asked for ${query}`);
  stub.matches = matches;
  for (const listener of stub._listeners) listener({ matches } as MediaQueryListEvent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("breakpoints", () => {
  it("asks for the documented queries, and only those", async () => {
    await load();

    // Not `.sort()` on the exported constants — see the file docblock.
    expect([...queries].sort()).toEqual(
      ["(hover: none), (pointer: coarse)", "(max-width: 560px)", "(max-width: 900px)"].sort(),
    );
  });

  it("reads each query's initial answer", async () => {
    const { isCompact, isNarrow, isCoarsePointer } = await load({
      "(max-width: 900px)": true,
      "(max-width: 560px)": false,
    });

    expect(isCompact.value).toBe(true);
    expect(isNarrow.value).toBe(false);
    expect(isCoarsePointer.value).toBe(false);
  });

  it("follows the query when it changes", async () => {
    const { isCompact } = await load();
    expect(isCompact.value).toBe(false);

    raise("(max-width: 900px)", true);
    expect(isCompact.value).toBe(true);

    raise("(max-width: 900px)", false);
    expect(isCompact.value).toBe(false);
  });

  it("tracks width and pointer separately", async () => {
    // The point of `isCoarsePointer` existing at all: a 1024px tablet has no narrow-layout
    // problem and still cannot hover, so a fix keyed to a width query would miss it.
    const { isCompact, isCoarsePointer } = await load({
      "(hover: none), (pointer: coarse)": true,
    });

    expect(isCompact.value).toBe(false);
    expect(isCoarsePointer.value).toBe(true);
  });

  it("reports everything false where matchMedia is missing", async () => {
    // jsdom does not implement it. Reading a query it cannot answer has to mean "no"
    // rather than a crash — the guard `ChatView.vue` used to carry by hand.
    vi.resetModules();
    vi.stubGlobal("matchMedia", undefined);

    const { isCompact, isNarrow, isCoarsePointer } = await import(
      "../../src/composables/breakpoints.js"
    );

    expect([isCompact.value, isNarrow.value, isCoarsePointer.value]).toEqual([
      false,
      false,
      false,
    ]);
  });
});
