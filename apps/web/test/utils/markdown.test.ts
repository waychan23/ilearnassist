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

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
