/**
 * Support for the catalog guards in `test/i18n/`. Kept out of the test files so the
 * assertions stay readable — the same reason `apps/server/test/helpers/` exists.
 *
 * Sources are read through Vite's `import.meta.glob` rather than `node:fs`: the web
 * tsconfig deliberately limits `types` to `vite/client`, so Node built-ins are not typed
 * there, and widening that would let Node globals leak into browser code unnoticed.
 */

const SOURCES = import.meta.glob("../../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `"../../src/components/ChatView.vue"` → `"src/components/ChatView.vue"`. */
const shortName = (path: string): string => path.replace(/^.*?\/src\//, "src/");

const isCatalog = (path: string): boolean => path.includes("/locales/");

/** A catalog leaf is a string, or an array of lines vue-i18n joins with `\n`. */
export type Leaf = string | string[];

/** Flatten `{ a: { b: "x" } }` to `{ "a.b": "x" }`. */
export function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, Leaf> {
  const out: Record<string, Leaf> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    } else {
      out[path] = value as Leaf;
    }
  }
  return out;
}

/** A leaf's text, with multi-line arrays joined the way vue-i18n joins them. */
export function textOf(leaf: Leaf): string {
  return Array.isArray(leaf) ? leaf.join("\n") : leaf;
}

/** Every `{placeholder}` name in a message, deduplicated. */
export function placeholders(message: string): Set<string> {
  return new Set([...message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!));
}

/**
 * Strip comments so a key mentioned in prose is not mistaken for a call site.
 *
 * Regex-based and therefore approximate — it will mis-handle a `//` or `<!--` inside a
 * string literal. That errs toward stripping, which at worst hides a real call site from
 * the forward check (`catalog.test.ts`); the hardcoded-text guard has its own escape
 * hatch for exactly this and is the test that would notice.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `.ts` / `.vue` source file, as `src/…` path → contents. */
export function sourceFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith(".d.ts"))
      .map(([path, source]) => [shortName(path), source]),
  );
}

export interface CallSite {
  file: string;
  key: string;
}

/**
 * Every statically-written `t("some.key")` / `$t("some.key")` / `te("some.key")` in the
 * source tree. Interpolated keys (`` t(`theme.${mode}`) ``) are deliberately not matched —
 * they are covered by the dynamic-prefix allowlist in the test, not by this scan.
 */
export function translationCallSites(): CallSite[] {
  const pattern = /(?<![\w$.])(?:\$?t|te)\(\s*["']([a-zA-Z0-9_][a-zA-Z0-9_.-]*)["']/g;
  const sites: CallSite[] = [];
  for (const [file, raw] of Object.entries(sourceFiles())) {
    // The catalogs themselves are message *definitions*, not call sites.
    if (isCatalog(file)) continue;
    const source = stripComments(raw);
    for (const match of source.matchAll(pattern)) sites.push({ file, key: match[1]! });
  }
  return sites;
}
