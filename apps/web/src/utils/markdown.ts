import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

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

export function renderMarkdown(text: string): string {
  return md.render(text);
}