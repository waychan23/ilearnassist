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

/** A drawing's own size in CSS pixels, as its `viewBox` declares it. */
export interface SvgSize {
  width: number;
  height: number;
}

/**
 * What size a drawing *wants* to be, read off the SVG text.
 *
 * This exists for the one thing mermaid's output cannot tell anyone: **how big the drawing is**.
 * Under `useMaxWidth: true` — its default, and the setting this app keeps for the message card,
 * where a diagram must shrink to fit the bubble — every SVG it emits is `width="100%"` with an
 * inline `max-width`, which makes the element's laid-out size a function of its container rather
 * than a property of the drawing. The viewer needs the drawing's own size to scale it honestly:
 * zooming a box whose content refits itself is how `zoom` came to look like a control that did
 * nothing (see `DiagramDialog`).
 *
 * `viewBox` is the authority because it is the coordinate system the drawing was laid out in, so
 * it is what "100% of this picture" means. Null when there is nothing to read: an SVG without one
 * is a drawing whose size nobody declared, and the caller falls back to mermaid's own behaviour
 * rather than guessing a number.
 *
 * Pure, and takes the string rather than an element, so the arithmetic is unit-testable — the same
 * seam `diagramThemeVariables` takes its reader through.
 */
export function svgSize(svg: string): SvgSize | null {
  const box = /\bviewBox\s*=\s*"([^"]*)"/.exec(svg)?.[1];
  if (!box) return null;

  const parts = box.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return null;
  const [, , width, height] = parts;
  // `noUncheckedIndexedAccess` makes every one of those `number | undefined`, and a `viewBox` of
  // `0 0 0 0` is a real thing mermaid emits for an empty graph — neither is a size.
  if (width === undefined || height === undefined) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

/**
 * The mermaid `themeVariables` this app's palette implies.
 *
 * Takes the resolved theme and a *reader* rather than reaching for `getComputedStyle` itself,
 * and that seam is what makes it testable: jsdom does not apply `style.css`, so a real
 * computed-style read returns `""` in a unit test and the mapping would only ever be exercised
 * in a browser. The caller passes
 * `(name) => getComputedStyle(document.documentElement).getPropertyValue(name)`.
 *
 * Values are read as **concrete colours**, never as `var(--token)` strings. Mermaid computes
 * with them in JavaScript — derived borders, the pie and git-graph palettes — and a `var()` in
 * those positions is not a colour, it is a string mermaid hands to a colour function.
 *
 * The mapping is deliberately short. Every variable mermaid does not hear about falls back to
 * its own `base` theme value, which is what keeps a diagram type added later (a mindmap, a
 * timeline) from rendering in colours nobody chose — and what keeps this list from having to
 * grow with mermaid's.
 *
 * The `base` theme is built for a *light* page, and a few of its values are fixed or derived
 * for one rather than read from what we overrode — ER attribute rows are lightened to near
 * white, a completed gantt task is hard lightgrey, the xychart palette is cream. Under the
 * dark theme those are light fills under *light* labels, so they are restated below.
 */
export function diagramThemeVariables(
  theme: ResolvedTheme,
  read: (name: string) => string
): Record<string, string | Record<string, string>> {
  const value = (name: string, fallback: string): string => read(name).trim() || fallback;

  const vars: Record<string, string | Record<string, string>> = {
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

  if (theme === "dark") {
    Object.assign(vars, {
      /*
       * ER attribute rows. The base theme derives `rowOdd`/`rowEven` by *lightening*
       * `mainBkg`, which on our palette lands at ~92% lightness — near white — while the
       * attribute labels keep the light `textColor`. Odd rows restate one step behind the
       * entity header (`--panel`), even rows level with it (`--panel-2`).
       */
      rowOdd: value("--panel", "#202327"),
      rowEven: value("--panel-2", "#262a2f"),
      /*
       * Completed gantt tasks. The base value is hard `lightgrey` for a light page; the done
       * label uses `textColor` — light on our palette — so the fill is the thing that moves:
       * a muted grey that still reads as a *finished* bar, with the lighter border.
       */
      doneTaskBkgColor: value("--text-3", "#6b7280"),
      doneTaskBorderColor: value("--text-2", "#9aa0a6"),
      // The nested object the xychart styles read — see `xyChartThemeVariables` for why it is
      // supplied whole.
      xyChart: xyChartThemeVariables(read),
    });
  }

  return vars;
}

/**
 * The nested `xyChart` theme object, for the dark palette.
 *
 * A nested override *replaces* the whole object rather than merging — mermaid's `calculate`
 * assigns it verbatim before and after its own `updateColors` — so every sub-field the base
 * derivation would have filled is named here. The text fields all take `--text`, matching the
 * base derivation, which routes every one of them through `primaryTextColor`.
 */
function xyChartThemeVariables(read: (name: string) => string): Record<string, string> {
  const value = (name: string, fallback: string): string => read(name).trim() || fallback;
  const text = value("--text", "#e6e8eb");

  return {
    backgroundColor: value("--panel", "#202327"),
    titleColor: text,
    dataLabelColor: text,
    legendTextColor: text,
    xAxisTitleColor: text,
    xAxisLabelColor: text,
    xAxisTickColor: text,
    xAxisLineColor: text,
    yAxisTitleColor: text,
    yAxisLabelColor: text,
    yAxisTickColor: text,
    yAxisLineColor: text,
    /*
     * The base palette (`#FFF4DD,…`) is built for a light page. This is the app's own series
     * colours, in the same order the statistics charts take them; it cycles past the sixth
     * plot if a chart has more.
     */
    plotColorPalette: [
      value("--accent", "#4c8bf5"),
      value("--success", "#4cc38a"),
      value("--warning", "#e6b33c"),
      value("--lock-held", "#f0883e"),
      value("--danger", "#e5534b"),
      value("--text-2", "#9aa0a6"),
    ].join(","),
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
    themeVariables: diagramThemeVariables(theme, read),
  });
  initializedFor = theme;
  return mermaid;
}

/**
 * Translate hardcoded node-style colours to a dark page.
 *
 * Inline `style`/`classDef` statements paint nodes directly and **bypass** `themeVariables` —
 * a `style A fill:#e8f5e9` written for a light page stays a light fill in dark mode, under
 * the theme's light label, so the text becomes unreadable. The source is model-authored and
 * only the source is persisted, so it is rewritten at render time rather than edited on disk:
 * light `fill:` hexes move to the same hue at dark lightness, and dark `color:` hexes (the
 * node's text colour) invert the same way. Fills already dark and named/rgb colours are left
 * alone.
 *
 * Pure string work for the same reason every other helper here is: unit-testable without a
 * browser, and applied identically to diagrams drawn years ago and ones drawn this turn.
 */
export function darkenDiagramStyles(source: string): string {
  return source.replace(/^[ \t]*(?:style|classDef)\b.*$/gm, (line) =>
    line
      .replace(/\bfill:[ \t]*(#[0-9a-fA-F]{3,8})\b/g, (_m, hex: string) =>
        // [0.5,1] lightness maps onto [0.13,0.29] — dark enough for light labels, spread
        // widely enough that a green, blue, amber and purple fill stay tellable apart.
        "fill:" +
          mapHex(hex, (hsl) =>
            hsl.l > 0.5
              ? { ...hsl, s: Math.min(1, hsl.s * 1.05), l: 0.13 + (hsl.l - 0.5) * 0.32 }
              : hsl
          )
      )
      .replace(/\bcolor:[ \t]*(#[0-9a-fA-F]{3,8})\b/g, (_m, hex: string) =>
        // The inverse range of the fill mapping: [0,0.5) → (0.63,0.95].
        "color:" +
          mapHex(hex, (hsl) =>
            hsl.l < 0.5
              ? { ...hsl, s: Math.min(1, hsl.s * 1.05), l: 0.95 - (0.5 - hsl.l) * 0.64 }
              : hsl
          )
      )
  );
}

/** RGB channels, expanded from a 3/6/8-digit hex. `null` when it is not a plain hex colour. */
function hexChannels(hex: string): { r: number; g: number; b: number; alpha?: string } | null {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const channel = (at: number): number => parseInt(h.slice(at, at + 2), 16);
  const r = channel(0);
  const g = channel(2);
  const b = channel(4);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b, alpha: h.length === 8 ? h.slice(6, 8) : undefined };
}

/** Hue-saturation-lightness in [0,1], the space a light-page/dark-page translation happens in. */
interface Hsl {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/** Apply an HSL change to a hex literal, keeping any alpha suffix. Returns the input unchanged
 *  when it is not a usable hex colour. */
function mapHex(hex: string, change: (hsl: Hsl) => Hsl): string {
  const channels = hexChannels(hex);
  if (!channels) return hex;
  const [r, g, b] = hslToRgb(change(rgbToHsl(channels.r, channels.g, channels.b)));
  const byte = (v: number): string =>
    Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${channels.alpha ?? ""}`;
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

  // Hardcoded style colours only need translating on a dark page; light renders the source as
  // written. The rewrite rides the render, so the stored source is never modified.
  const effective = theme === "dark" ? darkenDiagramStyles(source) : source;

  const parsed = await mermaid.parse(effective, { suppressErrors: true });
  if (parsed === false) {
    throw new Error("This is not something mermaid can draw.");
  }

  const { svg } = await mermaid.render(`mmd-${++seq}`, effective);
  return svg;
}
