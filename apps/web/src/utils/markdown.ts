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
 * Extensions whose language name is not the extension, for `highlightFile`.
 *
 * Deliberately short. `highlight.js` registers 190-odd languages, and most of them are
 * already keyed by their own extension — `.json`, `.java`, `.sql`, `.go`, `.rs`, `.css`,
 * `.xml` all resolve by looking the extension up directly, so an entry here for those would
 * be a second name to keep in step for no gain. What is listed is only where the two
 * genuinely differ: a shortened extension (`py`), an abbreviation (`ts`), or a name that is
 * an adjective (`yml`, `rb`).
 *
 * `.vue` is absent on purpose. It is a template, a script and a style in one file, and no
 * highlight.js language describes that — `xml` would mis-colour everything inside `<script>`.
 * A file it cannot describe falls back to escaped plain text, which is honest; a wrong
 * colouring is not.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  tex: "latex",
  sty: "latex",
  bib: "bibtex",
  sh: "bash",
  zsh: "bash",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  htm: "xml",
  html: "xml",
  jsonc: "json",
  json5: "json",
  toml: "ini",
  conf: "ini",
};

/** Files that name a language without an extension to key on. */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/**
 * How much text is worth colouring.
 *
 * `highlight.js` is roughly linear, but linear in a quarter of a megabyte is still a third of
 * a second on a fast machine and several on a slow one — and that is the *preview cap*, so it
 * is reachable by a single click on a minified bundle. Past this the text is escaped rather
 * than coloured: nobody reads 120,000 characters of highlighted source, so the cap costs
 * nothing, and it keeps the panel from stalling on the one file most likely to be huge.
 */
const MAX_HIGHLIGHT_CHARS = 120_000;

/**
 * Code as highlighted HTML — the raw spans, with no container. Returns escaped text when the
 * language is unknown, so a caller can drop the result inside `<pre><code>` either way and
 * never has to ask which of the two it got.
 *
 * Identical to what `highlight.js` itself does for an unknown language, and safe for the same
 * reason: the input is escaped before any span is wrapped around it.
 */
function highlightCode(code: string, language: string | null): string {
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return md.utils.escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    // A language that is registered but rejects the input outright is still not a reason to
    // lose the file's contents.
    return md.utils.escapeHtml(code);
  }
}

/** The language `highlight.js` knows a file by, or null when it knows nothing by that name. */
function languageFor(fileName: string): string | null {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1).toLowerCase();
  const byName = FILENAME_LANGUAGES[base];
  if (byName) return hljs.getLanguage(byName) ? byName : null;

  const dot = base.lastIndexOf(".");
  const extension = dot === -1 ? "" : base.slice(dot + 1);
  if (!extension) return null;

  const named = LANGUAGE_ALIASES[extension] ?? extension;
  return hljs.getLanguage(named) ? named : null;
}

/**
 * A file's contents as highlighted HTML, for the workspace browser's preview.
 *
 * Takes the file's *name* rather than a language, because that is what a file browser has —
 * the mapping from one to the other belongs here, beside the highlighting it is for, and the
 * call site stays `highlightFile(text, content.name)`.
 *
 * The Markdown this returns is the *source*, coloured — which is why `.md` is in the alias
 * table at all. Rendering a Markdown file is a separate question and a separate view.
 */
export function highlightFile(code: string, fileName: string): string {
  return highlightCode(code, languageFor(fileName));
}

/**
 * Single shared markdown renderer. `html: false` escapes raw HTML, which keeps
 * arbitrary HTML injected by a model out of the DOM.
 */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  /*
   * A fence names its language directly (` ```ts `), so this resolves it the same way
   * `highlight.js` would and hands off to the one highlighter — which keeps the message
   * bubbles and the file preview from colouring the same code two different ways, and leaves
   * a single escaper (`md.utils.escapeHtml`) doing the escaping for both.
   */
  highlight(str, lang) {
    const named = lang && hljs.getLanguage(lang) ? lang : null;
    return `<pre class="hljs"><code>${highlightCode(str, named)}</code></pre>`;
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