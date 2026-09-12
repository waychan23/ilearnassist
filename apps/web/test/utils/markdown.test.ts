import { describe, expect, it } from "vitest";
import { highlightFile, renderMarkdown } from "../../src/utils/markdown.js";

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

describe("highlightFile", () => {
  /** The class the token spans carry — its presence is what "highlighted" means. */
  const isHighlighted = (html: string) => html.includes("hljs-");

  it("highlights a language named by its own extension", () => {
    // No alias entry for any of these: the extension *is* the highlight.js name, which is the
    // common case and the reason the table stays short.
    for (const [name, code] of [
      ["data.json", '{"a": 1}'],
      ["Main.java", "public class Main {}"],
      ["q.sql", "SELECT * FROM t"],
      ["main.go", "package main"],
    ] as const) {
      expect(isHighlighted(highlightFile(code, name)), name).toBe(true);
    }
  });

  it("resolves the extensions that are not language names", () => {
    expect(isHighlighted(highlightFile("const a = 1;", "app.js"))).toBe(true);
    expect(isHighlighted(highlightFile("x: number = 1", "a.ts"))).toBe(true);
    expect(isHighlighted(highlightFile("def f(): pass", "a.py"))).toBe(true);
    expect(isHighlighted(highlightFile("key: value", "ci.yml"))).toBe(true);
    expect(isHighlighted(highlightFile("fun main() {}", "a.kt"))).toBe(true);
  });

  it("highlights LaTeX", () => {
    expect(isHighlighted(highlightFile("\\frac{1}{2}", "paper.tex"))).toBe(true);
  });

  it("highlights Markdown source", () => {
    // The source view's whole reason for being: rendering hides what was written, and the
    // file browser is often opened to see exactly that.
    expect(isHighlighted(highlightFile("# Title\n\n**bold**", "README.md"))).toBe(true);
  });

  it("ignores the directory part of the path", () => {
    expect(isHighlighted(highlightFile("const a = 1;", "src/deep/app.js"))).toBe(true);
  });

  it("escapes instead of colouring a language it does not know", () => {
    // `.vue` is the deliberate case: a template, a script and a style in one file, which no
    // highlight.js language describes. A wrong colouring would be worse than none.
    const html = highlightFile("<template><b>x</b></template>", "App.vue");
    expect(isHighlighted(html)).toBe(false);
    expect(html).toBe("&lt;template&gt;&lt;b&gt;x&lt;/b&gt;&lt;/template&gt;");
  });

  it("escapes a file with no extension", () => {
    expect(highlightFile("a < b", "NOTES")).toBe("a &lt; b");
  });

  it("never lets a file's contents become markup", () => {
    // The preview renders this with `v-html`, so a script tag surviving as a tag would be
    // injection from a file the agent may have written.
    for (const html of [
      highlightFile("<script>alert(1)</script>", "a.js"),
      highlightFile("<script>alert(1)</script>", "a.txt"),
      highlightFile('<img src=x onerror="alert(1)">', "a.html"),
    ]) {
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img");
    }
  });

  it("falls back to escaped text past the size cap rather than colouring it", () => {
    // A quarter-megabyte is the preview cap and is reachable in one click on a minified
    // bundle; the text still arrives, it just is not tokenised.
    const huge = "const a = 1;\n".repeat(15_000);
    expect(huge.length).toBeGreaterThan(120_000);

    const html = highlightFile(huge, "bundle.js");
    expect(isHighlighted(html)).toBe(false);
    expect(html).toContain("const a = 1;");
  });

  it("keeps multi-byte characters intact", () => {
    expect(highlightFile("// 工作空间\nconst a = 1;", "a.ts")).toContain("工作空间");
  });
});
