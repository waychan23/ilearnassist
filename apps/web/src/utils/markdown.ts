import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import * as katexPluginModule from "@vscode/markdown-it-katex";

type KatexPlugin = typeof import("@vscode/markdown-it-katex").default;

/**
 * The KaTeX plugin, dug out of whatever this resolver wrapped it in.
 *
 * `@vscode/markdown-it-katex` is CommonJS (`exports.default = …`) with no ESM build and no
 * `exports` map, so "the default export" is genuinely ambiguous and each resolver stops
 * unwrapping at a different depth. The Vite dev server pre-bundles it to
 * `export default require_dist()`, which is the whole `module.exports` object — so a
 * default import yields `{ __esModule: true, default: fn }` and a namespace import yields
 * the same thing one layer deeper. The production bundler and Vitest honour the
 * `__esModule` flag and hand back the function directly.
 *
 * Getting this wrong is not a cosmetic failure: `md.use` throws `plugin.apply is not a
 * function` while the module is being imported, so the page renders nothing at all. And it
 * is the *unit tests that stay green* — Vitest resolves the way the production build does —
 * so only the browser run sees it. `e2e/math.spec.ts` is what holds this.
 */
function unwrapKatexPlugin(imported: unknown): KatexPlugin {
  let candidate = imported;
  for (let depth = 0; depth < 3 && typeof candidate !== "function"; depth++) {
    candidate = (candidate as { default?: unknown } | null | undefined)?.default;
  }
  return candidate as KatexPlugin;
}

const katexPlugin = unwrapKatexPlugin(katexPluginModule);

/**
 * Single shared markdown renderer. `html: false` escapes raw HTML, which keeps
 * arbitrary HTML injected by a model out of the DOM.
 */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

/**
 * Math, via KaTeX.
 *
 * Synchronous, which is the whole reason for this choice over MathJax: `renderMarkdown`
 * stays a plain `string → string` function, so the `rendered` computed in `MessageItem`
 * needs no rework and neither does the SSE path that feeds it.
 *
 * `throwOnError: false` is the load-bearing option. A model that writes an unbalanced
 * brace would otherwise throw *out of* `renderMarkdown`, which takes the whole message
 * down and leaves a blank bubble; with it, KaTeX renders "KaTeX parse error: …" in place
 * of the formula, so the prose around it still arrives.
 *
 * `trust` is left at its `false` default, on the same footing as `html: false` above:
 * formulas come from the model, and `\href{javascript:…}` must not become a live link.
 *
 * `strict: "ignore"` silences the console warnings KaTeX raises for LaTeX-*incompatible*
 * input (a bare `\\`, a stray character inside `\text{}`) — they are warnings about
 * pedantry, not about the formula, and one per reply is noise.
 *
 * `errorColor` is a token rather than KaTeX's `#cc0000`, which is one red for both themes
 * and dim on the dark one. It reaches CSS as a literal `style="color:…"`, so a `var()` is
 * the only way to make it follow the palette — and it is `--danger-text`, the token the
 * palette spends as *foreground*, not `--danger`, which is the button-and-border tone.
 * Measured on the reply background, `--danger` is 4.36:1 in the light theme and misses
 * WCAG AA; `--danger-text` is 6.5:1 there and 8.7:1 in the dark one.
 *
 * The last two accept the delimiters a model writes when it is not thinking about
 * delimiters at all: `\begin{align}…\end{align}` with no `$$` around it, and a ```math
 * fence. Both otherwise render as raw TeX with every newline as a `<br>`, which is the
 * shape of reply this whole change exists to stop. `enableMathBlockInHtml` and
 * `enableMathInlineInHtml` stay off — they rewrite `html_block` tokens, which
 * `html: false` never produces.
 */
md.use(katexPlugin, {
  throwOnError: false,
  strict: "ignore",
  errorColor: "var(--danger-text)",
  enableBareBlocks: true,
  enableFencedBlocks: true,
});

export function renderMarkdown(text: string): string {
  return md.render(text);
}