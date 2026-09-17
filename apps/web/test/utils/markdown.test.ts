import { describe, expect, it } from "vitest";
import { highlightFile, renderMarkdown } from "../../src/utils/markdown.js";

/**
 * The labels every call would pass in a component. A helper rather than a second argument at each
 * of the twenty-odd call sites below: these cases are about what markdown *renders*, and the copy
 * control is checked in its own describe.
 */
const LABELS = { copy: "Copy", copied: "Copied" };
const render = (text: string): string => renderMarkdown(text, LABELS);

describe("renderMarkdown", () => {
  it("renders basic markdown", () => {
    expect(render("# Title")).toContain("<h1>Title</h1>");
    expect(render("**bold**")).toContain("<strong>bold</strong>");
  });

  it("turns single newlines into line breaks", () => {
    // `breaks: true` — chat replies are written as plain lines and expected to keep them.
    expect(render("one\ntwo")).toContain("one<br>\ntwo");
  });

  it("linkifies a bare URL", () => {
    const html = render("see https://example.com now");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  describe("sanitizing model output", () => {
    it("escapes raw HTML instead of executing it", () => {
      // `html: false` — model output is untrusted content, never markup.
      const html = render("<script>alert(1)</script>");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes a tag carrying an inline event handler", () => {
      // The attribute text survives as escaped characters, which is harmless; what must
      // not survive is a real tag.
      const html = render('<img src=x onerror="alert(1)">');
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img");
      expect(html).toContain("&quot;");
    });

    it("escapes an iframe", () => {
      expect(render('<iframe src="https://evil.test"></iframe>')).not.toContain("<iframe");
    });

    it("still renders markdown that surrounds the HTML", () => {
      const html = render("**bold** <b>raw</b>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("&lt;b&gt;");
    });
  });

  describe("code blocks", () => {
    it("highlights a known language", () => {
      const html = render("```js\nconst a = 1;\n```");
      expect(html).toContain('<pre class="hljs code-block">');
      expect(html).toContain("hljs-keyword");
    });

    it("falls back to a highlighted-container with escaped code for an unknown language", () => {
      const html = render("```notalanguage\n<b>&\n```");
      expect(html).toContain('<pre class="hljs code-block">');
      expect(html).toContain("&lt;b&gt;&amp;");
    });

    it("escapes code with no language at all", () => {
      const html = render("```\n<script>x</script>\n```");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("renders inline code", () => {
      expect(render("use `npm test`")).toContain("<code>npm test</code>");
    });
  });

  describe("a code block's copy control", () => {
    /*
     * The control is written into the HTML rather than mounted, so these are the assertions that
     * hold its shape: the two attributes the handler reads, both labels on the element, and the
     * absence of anything that would reach the message's *visible* text.
     */
    it("carries both labels and the marker the handler looks for", () => {
      const html = renderMarkdown("```js\nconst a = 1;\n```", { copy: "复制", copied: "已复制" });

      expect(html).toContain("data-copy-code");
      expect(html).toContain('data-copied-label="已复制"');
      expect(html).toContain('data-idle-label="复制"');
      // Both states are drawn, so the swap is an attribute the stylesheet paints rather than a
      // text node the handler writes.
      expect(html.match(/<svg/g)).toHaveLength(2);
    });

    it("contributes no text to the message", () => {
      /*
       * The load-bearing one. `utils/noteAnchor.ts` counts a note's quote over a message's
       * **visible** text, so a label inside this button would shift every anchor in the message
       * below the first code block — and a note made before the code was there would resolve to
       * the wrong occurrence.
       */
      // A fence with no language, so the code comes back escaped rather than tokenised and the
      // visible text is exactly the two lines that were written.
      const html = renderMarkdown("text\n\n```\nconst a = 1;\n```\n", {
        copy: "复制",
        copied: "已复制",
      });
      const visible = html
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      // Trimmed, because markdown-it's own trailing newlines are not what this case is about.
      expect(visible.trim()).toBe("text\nconst a = 1;");
      expect(visible).not.toContain("复制");
    });

    it("offers nothing for an empty fence", () => {
      // A button that copies nothing is the "renders but does nothing" this repo keeps out of its
      // UI. A model writes an empty fence often enough for it to be worth the branch.
      const html = renderMarkdown("```js\n```", { copy: "复制", copied: "已复制" });
      expect(html).not.toContain("data-copy-code");
      expect(html).not.toContain("code-block");
      // The language is still recorded — the branch is about the control, not the marker.
      expect(html).toContain('data-lang="js"');
    });

    it("escapes a label rather than letting it close the attribute", () => {
      // The labels come from the catalog, so this is not reachable today — but the string becomes
      // markup, and "trusted" is a property of today's callers.
      const html = renderMarkdown("```js\nx\n```", { copy: '"><script>', copied: "ok" });
      expect(html).not.toContain("<script>");
      expect(html).toContain("&quot;&gt;&lt;script&gt;");
    });
  });

  describe("the header a code block can carry", () => {
    const labels = { copy: "复制", copied: "已复制" };

    it("shows the file and the language from the fence's info string", () => {
      /*
       * markdown-it already splits the info string: `langName` is the first word and everything
       * after it is handed to the highlight hook as its third argument. The app used to declare
       * `highlight(str, lang)` and drop it, so a filename the model wrote was parsed and thrown
       * away on every render.
       */
      const html = renderMarkdown("```python app.py\nprint(1)\n```", labels);
      expect(html).toContain('<span class="code-head" data-note-skip>');
      expect(html).toContain('<span class="code-file">app.py</span>');
      expect(html).toContain('<span class="code-lang">python</span>');
      // …and the code is still highlighted as Python, not as the filename.
      expect(html).toContain("hljs-built_in");
    });

    it("shows a language with no file, which is the ordinary case", () => {
      const html = renderMarkdown("```ts\nconst a = 1;\n```", labels);
      expect(html).toContain('<span class="code-lang">ts</span>');
      expect(html).not.toContain("code-file");
    });

    it("claims no language it cannot colour", () => {
      /*
       * An info word nothing recognises is not a language, and a pill repeating it would be the
       * app inventing a fact — ` ```app.py ` and ` ```foobar ` are the same thing to highlight.js.
       * The block renders as it always did: escaped text, no header.
       */
      for (const info of ["app.py", "foobar"]) {
        const html = renderMarkdown("```" + info + "\nbody\n```", labels);
        expect(html, info).not.toContain("code-head");
        expect(html).not.toContain("code-lang");
      }
    });

    it("renders exactly as before when the fence names nothing", () => {
      const html = renderMarkdown("```\nplain\n```", labels);
      expect(html).not.toContain("code-head");
      expect(html).toContain("plain");
    });

    it("escapes both halves rather than letting them open a tag", () => {
      // The info string is model-authored, and these values become markup — in element content
      // and in the marker's own attributes.
      const html = renderMarkdown('```python "><img src=x>\nbody\n```', labels);
      expect(html).not.toContain("<img");
      expect(html).toContain("&quot;&gt;&lt;img src=x&gt;");
    });

    it("keeps the header out of the text a note anchor counts over", () => {
      // The strip is the renderer's chrome, like the copy control beside it. Counted as message
      // text it would shift the occurrence arithmetic for every note anchored below it —
      // including notes written before the strip existed.
      const html = renderMarkdown("```python app.py\nbody\n```", labels);
      expect(html).toContain("data-note-skip");
    });

    it("puts the header before the control, which is positioned over the corner", () => {
      const html = renderMarkdown("```python app.py\nbody\n```", labels);
      expect(html.indexOf("code-head")).toBeLessThan(html.indexOf("data-copy-code"));
    });
  });

  describe("math", () => {
    it("renders inline math between dollar signs", () => {
      const html = render("能量是 $E = mc^2$ 的关系。");
      expect(html).toContain('class="katex"');
      expect(html).not.toContain("$E = mc^2$");
    });

    it("renders $$ as a display block", () => {
      const html = render("推导：\n\n$$\n\\frac{1}{3}\n$$\n\n完毕。");
      expect(html).toContain('<p class="katex-block">');
      expect(html).toContain("katex-display");
      // The prose on either side survives — a display block replaces its paragraph, not
      // the message.
      expect(html).toContain("推导：");
      expect(html).toContain("完毕。");
    });

    it("treats a single-line $$ pair as a display block too", () => {
      expect(render("$$a^2 + b^2 = c^2$$")).toContain('<p class="katex-block">');
    });

    it("renders a bare \\begin block that carries no delimiters", () => {
      // What a model writes when it is not thinking about markdown at all.
      const html = render("结果：\n\n\\begin{align}\na &= b\n\\end{align}");
      expect(html).toContain('<p class="katex-block">');
    });

    it("renders a ```math fence as math rather than as code", () => {
      const html = render("```math\n\\pi r^2\n```");
      expect(html).toContain("katex");
      expect(html).not.toContain("hljs");
    });

    it("reports a broken formula instead of taking the message down", () => {
      // `throwOnError: false`. The failure it prevents is not a bad-looking formula: a
      // throw out of `renderMarkdown` fails the `rendered` computed, so the bubble goes
      // blank and the prose around the formula is lost with it.
      const html = render("看这个 $\\frac{1}{$ 坏掉了。");
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
        expect(render(prose)).not.toContain("katex");
      }
    });

    it("leaves dollar signs inside a code span alone", () => {
      expect(render("用 `$x$` 表示行内公式。")).toContain("<code>$x$</code>");
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
        const html = render(formula);
        expect(html).not.toContain("<a ");
        expect(html).not.toContain("<img");
        expect(html).not.toContain('class="evil"');
      }
    });
  });

  it("returns an empty string for empty input", () => {
    expect(render("")).toBe("");
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
