import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSearchConfig } from "../../src/config.js";
import { buildWebSearchTool, searchWeb } from "../../src/tools/webSearch.js";

/**
 * The search providers are scraped HTML endpoints, so the parsing is what needs holding
 * down — the markup below is a trimmed copy of what each provider actually returns.
 */

const BING_HTML = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://example.com/one">Example   One</a></h2>
    <div class="b_caption"><p>A first snippet.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.com/two">Example Two</a></h2>
    <div class="b_caption"><p>A second snippet.</p></div>
  </li>
  <li class="b_algo"><div class="b_caption"><p>No link here.</p></div></li>
</ol>`;

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdeep&amp;rut=abc">Deep Result</a>
  <a class="result__snippet">A deep snippet.</a>
</div>
<div class="result">
  <a class="result__a" href="https://direct.example.com/plain">Plain Result</a>
  <a class="result__snippet">A plain snippet.</a>
</div>`;

function stubFetch(body: string, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => {
    if (init.ok === false) return new Response("nope", { status: init.status ?? 500 });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const cfg = (overrides: Partial<WebSearchConfig> = {}): WebSearchConfig => ({
  provider: "bing",
  maxResults: 5,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bing", () => {
  it("extracts title, url and snippet", async () => {
    stubFetch(BING_HTML);
    await expect(searchWeb("q", cfg())).resolves.toEqual([
      { title: "Example One", url: "https://example.com/one", snippet: "A first snippet." },
      { title: "Example Two", url: "https://example.com/two", snippet: "A second snippet." },
    ]);
  });

  it("skips results with no link", async () => {
    stubFetch(BING_HTML);
    const results = await searchWeb("q", cfg());
    expect(results).toHaveLength(2);
  });

  it("stops at maxResults", async () => {
    stubFetch(BING_HTML);
    await expect(searchWeb("q", cfg({ maxResults: 1 }))).resolves.toHaveLength(1);
  });

  it("reports a non-OK response rather than parsing the error page", async () => {
    stubFetch("", { ok: false, status: 503 });
    await expect(searchWeb("q", cfg())).rejects.toThrow("HTTP 503");
  });

  it("sends the query and count to the configured endpoint", async () => {
    const fetchMock = stubFetch(BING_HTML);
    await searchWeb("hello world", cfg({ bingEndpoint: "https://bing.test/search" }));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://bing.test/search?q=hello%20world&count=5");
  });
});

describe("duckduckgo", () => {
  it("unwraps the redirect parameter into the real target url", async () => {
    stubFetch(DDG_HTML);
    const results = await searchWeb("q", cfg({ provider: "duckduckgo" }));
    expect(results[0]).toEqual({
      title: "Deep Result",
      url: "https://example.com/deep",
      snippet: "A deep snippet.",
    });
  });

  it("leaves a direct url alone", async () => {
    stubFetch(DDG_HTML);
    const results = await searchWeb("q", cfg({ provider: "duckduckgo" }));
    expect(results[1]!.url).toBe("https://direct.example.com/plain");
  });
});

describe("tavily", () => {
  it("requires an api key", async () => {
    await expect(searchWeb("q", cfg({ provider: "tavily" }))).rejects.toThrow(/tavilyApiKey/);
  });

  it("maps the JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ results: [{ title: "T", url: "https://t", content: "C" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    await expect(searchWeb("q", cfg({ provider: "tavily", tavilyApiKey: "k" }))).resolves.toEqual([
      { title: "T", url: "https://t", snippet: "C" },
    ]);
  });
});

describe("searxng", () => {
  it("requires a base url", async () => {
    await expect(searchWeb("q", cfg({ provider: "searxng" }))).rejects.toThrow(/searxngBaseURL/);
  });

  it("maps and caps the JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ results: [{ title: "A", url: "https://a", content: "x" }, { title: "B", url: "https://b", content: "y" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const results = await searchWeb("q", cfg({ provider: "searxng", searxngBaseURL: "http://sx/", maxResults: 1 }));
    expect(results).toEqual([{ title: "A", url: "https://a", snippet: "x" }]);
  });
});

describe("the web_search tool", () => {
  it("formats results as a numbered list", async () => {
    stubFetch(BING_HTML);
    const result = (await buildWebSearchTool(cfg()).invoke({ query: "q" })) as string;
    expect(result).toContain("1. Example One");
    expect(result).toContain("URL: https://example.com/one");
    expect(result).toContain("A first snippet.");
  });

  it("says so when nothing was found", async () => {
    stubFetch("<html><body>nothing</body></html>");
    await expect(buildWebSearchTool(cfg()).invoke({ query: "q" })).resolves.toBe("No search results found.");
  });
});
