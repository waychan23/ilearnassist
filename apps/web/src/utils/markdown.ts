import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import * as katexPluginModule from "@vscode/markdown-it-katex";
import { iconSvg } from "./icons";

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
 * The two words a code block's copy control needs, as *values* rather than keys.
 *
 * Passed in rather than read from the catalog here, because this module is pure and synchronous
 * and the strings belong to whatever component is rendering — the same rule `widgetLabel(id, t)`
 * follows in the widget registry. Required rather than optional: a default would let a new call
 * site silently render code blocks with no copy control, which is the failure mode a required
 * argument turns into a compile error.
 */
export interface MarkdownLabels {
  /** The control's accessible name, and its tooltip. */
  copy: string;
  /** What it announces for a moment after a successful copy. */
  copied: string;
}

/**
 * The copy control, as markup.
 *
 * **No text nodes, on purpose.** `utils/noteAnchor.ts` counts occurrences of a note's quote over
 * a message's *visible* text, so anything this button contributed to it would shift every note
 * anchor in the message below the first code block. Both states are drawn instead — two icons, one
 * hidden by CSS — which is also why the handler swaps an attribute rather than a label.
 *
 * `aria-hidden` is on the SVGs (they are decoration) and the name is on the button, so a screen
 * reader announces one control with one name in either state.
 */
function codeCopyControl(labels: MarkdownLabels): string {
  // From the catalog, so it is trusted — but escaped anyway, because "trusted" is a property of
  // today's callers and this string becomes markup.
  const name = md.utils.escapeHtml(labels.copy);
  const copied = md.utils.escapeHtml(labels.copied);
  // Both labels are carried on the element: the handler has no catalog access, and reading the
  // *current* label back to restore it would capture "copied" on a second press inside the reset
  // window. `data-idle-label` is the one that never changes.
  return (
    `<button type="button" class="code-copy" data-copy-code data-copy-state="idle" ` +
    `data-idle-label="${name}" data-copied-label="${copied}" ` +
    `title="${name}" aria-label="${name}">` +
    `${iconSvg("copy")}${iconSvg("check")}</button>`
  );
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
   *
   * **`attrs` is markdown-it's own parsing of the rest of the info string**, and it is the
   * filename: ` ```python app.py ` arrives here as `("…", "python", "app.py")`. That is the
   * whole reason this feature needs no parser of its own — the app used to drop the third
   * argument on the floor, so a filename the model wrote was already being computed and thrown
   * away. Both halves ride out on the marker as **escaped attributes** so the post-pass can
   * render them; `escapeHtml` is what keeps that honest, since the values come from the model.
   *
   * The language is carried only when `highlight.js` knows it. An info word nothing recognises
   * is not a language, and a pill claiming `app.py` is one would be the app inventing a fact.
   */
  highlight(str, lang, attrs) {
    const named = lang && hljs.getLanguage(lang) ? lang : null;
    const language = named ? ` data-lang="${md.utils.escapeHtml(named)}"` : "";
    const file = attrs ? ` data-file="${md.utils.escapeHtml(attrs)}"` : "";
    return `<pre class="hljs"${language}${file}><code>${highlightCode(str, named)}</code></pre>`;
  },
});

/**
 * Every fenced code block in a rendered string, with its contents and its two labels.
 *
 * The marker is **unforgeable**, which is what makes a post-pass safe rather than a rewrite of
 * generated HTML: it is emitted by the hook directly above, and a model cannot reproduce it
 * because `highlightCode` escapes its input — a fence whose text is literally `<pre
 * class="hljs"><code>` arrives as `&lt;pre …`. So a match can only be a code block this module
 * made. The two attributes are escaped on the way in for the same reason: a model that wrote
 * `data-lang="` inside a fence's info string gets `&quot;`, and the marker still cannot be
 * forged from the code's own text.
 *
 * A post-pass at all because markdown-it's `highlight` hook is registered once on the instance
 * and is called with `(str, lang, attrs)` — there is no per-call channel to carry the labels
 * through, and the alternatives are a mutable module-level value or a second renderer rule that
 * would re-implement the hook's own `<pre>` decision. This keeps the hook a pure function of its
 * input.
 */
const FENCED_CODE =
  /<pre class="hljs"(?: data-lang="([^"]*)")?(?: data-file="([^"]*)")?><code>([\s\S]*?)<\/code><\/pre>/g;

/**
 * The strip above a code block: which file it is, and what language that file is.
 *
 * Both halves are optional and independent — a snippet with a language and no file is the common
 * case, and one with neither produces no strip at all.
 *
 * **The values are inserted as they were captured, already escaped.** They went through
 * `md.utils.escapeHtml` on the way onto the marker, so what comes back is entity text: it renders
 * as the original characters and cannot open a tag, in element content or in an attribute. Running
 * `escapeHtml` a second time would be the bug — `a & b` would render as `a &amp; b`.
 *
 * `data-note-skip` is what keeps the strip out of `utils/noteAnchor.ts`'s visible-text walk. It is
 * the renderer's own chrome rather than anything the model wrote, exactly like the copy control
 * next to it, and a filename counted as message text would shift the occurrence arithmetic for
 * every note anchored below it — including notes written before this strip existed.
 */
function codeHead(language: string | undefined, file: string | undefined): string {
  if (!language && !file) return "";
  const parts = [
    file ? `<span class="code-file">${file}</span>` : "",
    language ? `<span class="code-lang">${language}</span>` : "",
  ];
  return `<span class="code-head" data-note-skip>${parts.join("")}</span>`;
}

export function renderMarkdown(text: string, labels: MarkdownLabels): string {
  return md.render(text).replace(
    FENCED_CODE,
    (whole, language: string | undefined, file: string | undefined, code: string) => {
      // An empty fence gets no control: there is nothing to copy, and a button that copies nothing
      // is the "renders but does nothing" this repository keeps out of its UI.
      if (!code) return whole;
      /*
       * The button sits **inside** the `<pre>`, which is valid (`<button>` is phrasing content) and
       * is why the opening tag is rewritten rather than wrapped: a wrapper div would be a block
       * inside a `<pre>`, and the CSS positions this absolutely so it cannot disturb the code's own
       * whitespace. No whitespace between the elements either — `<pre>` keeps it, and
       * `utils/noteAnchor.ts` counts the text it would become.
       *
       * The head goes **first**, before the control, because the control is absolutely positioned
       * in the top-right corner and the head is a flow element at the top-left: the other order
       * would put the head's own text under the button.
       */
      return (
        `<pre class="hljs code-block">${codeHead(language, file)}` +
        `${codeCopyControl(labels)}<code>${code}</code></pre>`
      );
    }
  );
}

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

