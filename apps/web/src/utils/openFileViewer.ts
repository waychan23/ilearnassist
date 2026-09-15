import type { PreviewPlugin } from "@open-file-viewer/core";

/**
 * The viewer chunk, and the vendor sheet, fetched once and shared.
 *
 * **The only module in the app that imports `@open-file-viewer/core`.** That is a rule rather
 * than an observation: the library is one entry point with no `sideEffects` field, so importing
 * it anywhere reachable from the initial bundle drags its whole dependency graph along — `three`,
  * `leaflet`, `xlsx`, `hls.js`, a second copy of `mermaid` and its ELK layout engine. Measured:
  * the entry chunk does not move by a single gzip byte as long as this stays behind `import()`.
  *
  * Memoized promise rather than a boolean, the same shape as `loadMermaid()`: two files opened
  * in quick succession share one load rather than racing two, and the rejected promise is
  * **cleared** so a transient chunk failure is retryable by the next open instead of poisoning
  * every open after it with an error nobody can re-run.
  */

type ViewerModule = typeof import("@open-file-viewer/core");

/** What a loaded viewer gives its caller: the module, and the plugin list built once. */
export interface LoadedViewer {
  module: ViewerModule;
  plugins: PreviewPlugin[];
}

const STYLE_ID = "gl-ofv";

/**
 * Why the sheet is injected by us rather than imported as a stylesheet.
 *
 * `composables/theme.ts` makes the same move for highlight.js and the reasoning carries over
 * whole. Vite injects a lazily-imported sheet at a moment we do not control, and an unlayered
 * vendor rule that lands after `style.css` beats ours on a specificity tie. That tie is not
 * hypothetical here: the library ships 33 custom properties and a toolbar, and we override a
 * dozen of them from tokens in `style.css`.
 *
 * The layer is what makes the outcome the same in both environments, and they genuinely
 * differ — in dev both are `<style>` elements injected at module evaluation, in a build the
 * vendor text travels inside this lazy JS chunk while `style.css` is a `<link>` in the initial
 * HTML. Source order flips between the two; a layer does not. Unlayered rules beat layered
 * ones, so our overrides win in both without depending on which stylesheet the browser saw
 * first.
 */
function injectStyle(css: string): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = `@layer ofv {\n${css}\n}`;
}

let loading: Promise<LoadedViewer> | null = null;

/**
 * The plugin set this build offers, in `match()` order.
 *
 * **`textPlugin` is deliberately absent**, on two grounds and the second is the stronger one.
 * It renders with prismjs, which would contradict the enforced invariant that there is one code
 * highlighter and `highlight.js` is it — but more decisively, every format it claims
 * (`txt md json yaml csv js ts vue html css py go rs sql sh`) is classified by the server as
 * `text` or `markdown` and goes to the existing `<pre>`/markdown path. It is unreachable by
 * construction, so including it would add prismjs to the chunk for a code path that cannot run.
 * (The library bundles prismjs regardless — it is emitted either way; what this avoids is
 * *routing* to it.)
 *
 * **`cadPlugin` is absent too**, and must stay so: its optional peers are
 * `@mlightcad/libredwg-web` (GPL-3.0) and two `@mlightcad/*` viewers, plus ~6 MB of WASM. Not
 * installing them is the decision; the plugin degrades to a thumbnail path without them, and
 * adding them back "to finish the set" would import a licence obligation into this repo.
 *
 * **`fallbackPlugin()` must never be added.** It is terminal by definition — it matches
 * everything — so `isPreviewSupported` would answer *yes* for every file and any format no real
 * plugin claims would render an empty box instead of the unsupported panel. The browser suite
 * asserts that panel for a `.bin`; passing the fallback would break that assertion and, worse,
 * hide every genuine "cannot show this" behind a blank frame. It would have to be last if it
 * were ever wanted, which is the other reason to say so here.
 *
 * Order is first-match-wins, so the specific plugins precede the broad ones — `assetPlugin`
 * recognizes a whole family of files by content and is the one that would otherwise shadow
 * something that can actually be drawn.
 */
function buildPlugins(mod: ViewerModule): PreviewPlugin[] {
  return [
    mod.officePlugin(),
    mod.pdfPlugin(),
    mod.epubPlugin(),
    mod.xpsPlugin(),
    mod.ofdPlugin(),
    mod.imagePlugin(),
    mod.videoPlugin(),
    mod.audioPlugin(),
    mod.archivePlugin(),
    mod.emailPlugin(),
    mod.drawingPlugin(),
    mod.xmindPlugin(),
    mod.model3dPlugin(),
    mod.gisPlugin(),
    mod.assetPlugin(),
  ];
}

/**
 * Load the viewer, its stylesheet, and the plugin list — once.
 *
 * The plugins are built here rather than by the caller because the Vue adapter remounts the
 * viewer whenever `plugins` changes *identity*: a caller building the array inside a render
 * would destroy and re-create the viewer on every unrelated re-render, which during a
 * streaming turn is once per token.
 */
export function loadFileViewer(): Promise<LoadedViewer> {
  loading ??= Promise.all([
    import("@open-file-viewer/core"),
    // `?inline` so the sheet travels with this chunk as a string instead of being injected by
    // Vite at a moment we do not choose. See `injectStyle`.
    import("@open-file-viewer/core/style.css?inline"),
  ])
    .then(([mod, css]) => {
      injectStyle(css.default);
      return { module: mod, plugins: buildPlugins(mod) };
    })
    .catch((err: unknown) => {
      loading = null;
      throw err;
    });
  return loading;
}
