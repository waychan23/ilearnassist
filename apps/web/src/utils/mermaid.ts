import { MAX_DIAGRAM_CHARS } from "../api/types";
import type { ResolvedTheme } from "../composables/theme";

/**
 * Mermaid, loaded on demand, drawn with the app's own colours.
 *
 * **Not** part of `renderMarkdown`, and that is the reason this module exists at all.
 * `renderMarkdown` is a synchronous `string → string` function on purpose — the KaTeX wiring
 * above it says so, and it is why `MessageItem`'s `rendered` computed needs no lifecycle.
 * Mermaid's API is async: it parses, lays out, measures text and returns SVG. A diagram
 * therefore cannot arrive through the markdown path, and pretending otherwise would mean
 * making the whole render pipeline async for the one case that needs it. `MermaidDiagram.vue`
 * is the component that owns the async half; this module is the part of it that has no DOM.
 *
 * The import is behind a memoized promise, inside a function, so that importing this module
 * costs nothing: the ~1 MB chunk is fetched the first time a diagram is actually on screen,
 * and N diagrams appearing at once share one fetch.
 */

/** A source past this is not rendered, only shown. Shared with the server, which refuses to
 *  write one — see `MAX_DIAGRAM_CHARS`, whose comment is the argument for one number. */
export function diagramTooLarge(source: string): boolean {
  return source.length > MAX_DIAGRAM_CHARS;
}

/**
 * The mermaid `themeVariables` this app's palette implies.
 *
 * Takes a *reader* rather than reaching for `getComputedStyle` itself, and that seam is what
 * makes it testable: jsdom does not apply `style.css`, so a real computed-style read returns
 * `""` in a unit test and the mapping would only ever be exercised in a browser. The caller
 * passes `(name) => getComputedStyle(document.documentElement).getPropertyValue(name)`.
 *
 * Values are read as **concrete colours**, never as `var(--token)` strings. Mermaid computes
 * with them in JavaScript — derived borders, the pie and git-graph palettes — and a `var()` in
 * those positions is not a colour, it is a string mermaid hands to a colour function.
 *
 * The mapping is deliberately short. Every variable mermaid does not hear about falls back to
 * its own `base` theme value, which is what keeps a diagram type added later (a mindmap, a
 * timeline) from rendering in colours nobody chose — and what keeps this list from having to
 * grow with mermaid's.
 */
export function diagramThemeVariables(read: (name: string) => string): Record<string, string> {
  const value = (name: string, fallback: string): string => read(name).trim() || fallback;

  return {
    // The surface the diagram lands on, which is a card or a dialog body rather than the page.
    background: value("--panel", "#ffffff"),
    primaryColor: value("--panel-2", "#f0f2f5"),
    primaryTextColor: value("--text", "#1f2328"),
    primaryBorderColor: value("--border", "#d0d7de"),
    secondaryColor: value("--panel-2", "#f0f2f5"),
    tertiaryColor: value("--panel-2", "#f0f2f5"),
    lineColor: value("--text-3", "#6e7781"),
    nodeBorder: value("--border", "#d0d7de"),
    clusterBkg: value("--panel-2", "#f0f2f5"),
    clusterBorder: value("--border", "#d0d7de"),
    /*
     * Mermaid's default is hard white. On a dark theme that is a white box sitting on top of
     * every edge label — the classic symptom of a diagram that was themed everywhere except
     * here.
     */
    edgeLabelBackground: value("--panel", "#ffffff"),
    /*
     * The error palette matches the KaTeX `errorColor` reasoning: `--danger` is the
     * button-and-border tone and misses AA as text, so the *text* token is the one that goes
     * where text goes.
     */
    errorBkgColor: value("--danger-bg", "#ffebe9"),
    errorTextColor: value("--danger-text", "#b35900"),
  };
}

/** The one import of mermaid in the app, memoized as a *promise* so concurrent callers share it. */
let loading: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  loading ??= import("mermaid")
    .then((mod) => mod.default)
    .catch((err: unknown) => {
      // Cleared so a transient chunk failure can be retried by the next diagram rather than
      // poisoning every one after it with a rejected promise nobody can re-run.
      loading = null;
      throw err;
    });
  return loading;
}

/** Which theme the module was last initialized for — initializing is global, rendering is not. */
let initializedFor: ResolvedTheme | null = null;

/**
 * Put mermaid in the state this app wants, once per theme.
 *
 * Its configuration is module-global, so this is not something a render can do for itself: two
 * diagrams on screen are two renders and one configuration.
 */
async function prepare(theme: ResolvedTheme): Promise<typeof import("mermaid").default> {
  const mermaid = await loadMermaid();
  if (initializedFor === theme) return mermaid;

  const read = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name);

  mermaid.initialize({
    // Otherwise mermaid scans the document on import and renders any `.mermaid` node it finds,
    // including ones this app never made.
    startOnLoad: false,
    /*
     * The source is model-authored. This is the boundary, and it is the same decision as
     * `html: false` in the markdown renderer and `trust: false` in the KaTeX wiring — mermaid
     * sanitizes labels under it. Do not relax it: the temptation ("a label with `<b>` would
     * look nicer") is real and the blast radius is content a model wrote.
     */
    securityLevel: "strict",
    /*
     * SVG `<text>` rather than a foreignObject holding HTML. Two reasons: there is no HTML
     * injection surface at all, and the labels are *searchable text in the output* — which is
     * what lets the browser suite assert on a label instead of on coordinates.
     */
    htmlLabels: false,
    // An error is reported by returning a rejected promise; mermaid must not additionally
    // inject its own error graphic into the document, where this app has its own panel.
    suppressErrorRendering: true,
    // The theme designed to take `themeVariables`. `default`/`dark` would override them.
    theme: "base",
    fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: diagramThemeVariables(read),
  });
  initializedFor = theme;
  return mermaid;
}

/** A unique id per render. See `renderMermaid` for why it cannot come from the file name. */
let seq = 0;

/**
 * Draw a diagram, as an SVG string.
 *
 * Rejects — with mermaid's own message — when the source is not a diagram this build can draw.
 * The caller must treat that as a *rendering* outcome rather than a failure of the app: the
 * source is model-authored, so a syntax error is something the user needs to see explained
 * beside what they asked for, not a blank space where a diagram should be.
 *
 * The id is a module counter, and it has to be. Mermaid inserts a temporary element carrying
 * this id into the document for the duration of the render, so two renders that share one
 * collide ("element with id … already exists") or cross their SVG strings. The file name is
 * the tempting source and the wrong one: two cards can show one file.
 *
 * The parse happens first and touches no DOM. That is what keeps a malformed diagram away
 * from `render`'s own error path entirely — the failure is decided before anything is drawn,
 * so there is nothing to leave behind.
 */
export async function renderMermaid(source: string, theme: ResolvedTheme): Promise<string> {
  const mermaid = await prepare(theme);

  const parsed = await mermaid.parse(source, { suppressErrors: true });
  if (parsed === false) {
    throw new Error("This is not something mermaid can draw.");
  }

  const { svg } = await mermaid.render(`mmd-${++seq}`, source);
  return svg;
}
