import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/utils/markdown.js";

describe("renderMarkdown", () => {
  it("renders basic markdown", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
  });

  it("turns single newlines into line breaks", () => {
    // `breaks: true` — chat replies are written as plain lines and expected to keep them.
    expect(renderMarkdown("one\ntwo")).toContain("one<br>\ntwo");
  });

  it("linkifies a bare URL", () => {
    const html = renderMarkdown("see https://example.com now");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  describe("sanitizing model output", () => {
    it("escapes raw HTML instead of executing it", () => {
      // `html: false` — model output is untrusted content, never markup.
      const html = renderMarkdown("<script>alert(1)</script>");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes a tag carrying an inline event handler", () => {
      // The attribute text survives as escaped characters, which is harmless; what must
      // not survive is a real tag.
      const html = renderMarkdown('<img src=x onerror="alert(1)">');
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
      expect(html).toContain("&quot;");
    });

    it("escapes an iframe", () => {
      expect(renderMarkdown('<iframe src="https://evil.test"></iframe>')).not.toContain("<iframe");
    });

    it("still renders markdown that surrounds the HTML", () => {
      const html = renderMarkdown("**bold** <b>raw</b>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("&lt;b&gt;");
    });
  });

  describe("code blocks", () => {
    it("highlights a known language", () => {
      const html = renderMarkdown("```js\nconst a = 1;\n```");
      expect(html).toContain('<pre class="hljs"><code>');
      expect(html).toContain("hljs-keyword");
    });

    it("falls back to a highlighted-container with escaped code for an unknown language", () => {
      const html = renderMarkdown("```notalanguage\n<b>&\n```");
      expect(html).toContain('<pre class="hljs"><code>');
      expect(html).toContain("&lt;b&gt;&amp;");
    });

    it("escapes code with no language at all", () => {
      const html = renderMarkdown("```\n<script>x</script>\n```");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("renders inline code", () => {
      expect(renderMarkdown("use `npm test`")).toContain("<code>npm test</code>");
    });
  });

  describe("math", () => {
    it("renders inline math between dollar signs", () => {
      const html = renderMarkdown("能量是 $E = mc^2$ 的关系。");
      expect(html).toContain('class="katex"');
      expect(html).not.toContain("$E = mc^2$");
    });

    it("renders $$ as a display block", () => {
      const html = renderMarkdown("推导：\n\n$$\n\\frac{1}{3}\n$$\n\n完毕。");
      expect(html).toContain('<p class="katex-block">');
      expect(html).toContain("katex-display");
      // The prose on either side survives — a display block replaces its paragraph, not
      // the message.
      expect(html).toContain("推导：");
      expect(html).toContain("完毕。");
    });

    it("treats a single-line $$ pair as a display block too", () => {
      expect(renderMarkdown("$$a^2 + b^2 = c^2$$")).toContain('<p class="katex-block">');
    });

    it("renders a bare \\begin block that carries no delimiters", () => {
      // What a model writes when it is not thinking about markdown at all.
      const html = renderMarkdown("结果：\n\n\\begin{align}\na &= b\n\\end{align}");
      expect(html).toContain('<p class="katex-block">');
    });

    it("renders a ```math fence as math rather than as code", () => {
      const html = renderMarkdown("```math\n\\pi r^2\n```");
      expect(html).toContain("katex");
      expect(html).not.toContain("hljs");
    });

    it("reports a broken formula instead of taking the message down", () => {
      // `throwOnError: false`. The failure it prevents is not a bad-looking formula: a
      // throw out of `renderMarkdown` fails the `rendered` computed, so the bubble goes
      // blank and the prose around the formula is lost with it.
      const html = renderMarkdown("看这个 $\\frac{1}{$ 坏掉了。");
      expect(html).toContain("坏掉了");
      expect(html).toContain("katex-error");
      // A palette token, not KaTeX's `#cc0000` — one red for both themes, and dim on the
      // dark one. `--danger-text` specifically: `--danger` is the button-and-border tone
      // and measures 4.36:1 on the light reply background, under WCAG AA.
      expect(html).toContain("var(--danger-text)");
    });

    it("leaves currency and shell variables as plain text", () => {
      // The delimiter rules reject a closing `$` that is followed by a word character.
      // `$100-$200` is the interesting one: it closes on a `$` followed by `2`.
      for (const prose of [
        "价格是 $100 到 $200 之间。",
        "成本 $100-$200 不等。",
        "设置 $HOME 和 $PATH 环境变量。",
      ]) {
        expect(renderMarkdown(prose)).not.toContain("katex");
      }
    });

    it("leaves dollar signs inside a code span alone", () => {
      expect(renderMarkdown("用 `$x$` 表示行内公式。")).toContain("<code>$x$</code>");
    });

    it("does not let a formula turn into a link or an image", () => {
      // `trust` stays at KaTeX's `false`. A formula comes from the model, which makes it
      // the same kind of input `html: false` above is guarding against — an `\href` is
      // rejected and drawn as its own command name instead of becoming an `<a>`.
      for (const formula of [
        "$\\href{javascript:alert(1)}{click}$",
        "$\\url{https://example.com}$",
        "$\\includegraphics{/etc/passwd}$",
        "$\\htmlClass{evil}{x}$",
      ]) {
        const html = renderMarkdown(formula);
        expect(html).not.toContain("<a ");
        expect(html).not.toContain("<img");
        expect(html).not.toContain('class="evil"');
      }
    });
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
