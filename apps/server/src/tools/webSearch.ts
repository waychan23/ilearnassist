import { load } from "cheerio";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { WebSearchConfig } from "../config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeDdgUrl(href: string): string {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const param = url.searchParams.get("uddg");
    return param ? decodeURIComponent(param) : href;
  } catch {
    return href;
  }
}

async function fetchText(path: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const res = await fetch(path, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
    ...init,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.text();
}

async function searchBing(query: string, cfg: WebSearchConfig): Promise<SearchResult[]> {
  const endpoint = cfg.bingEndpoint ?? "https://www.bing.com/search";
  const html = await fetchText(`${endpoint}?q=${encodeURIComponent(query)}&count=${cfg.maxResults}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  const $ = load(html);
  const results: SearchResult[] = [];
  $("li.b_algo").each((_, el) => {
    const a = $(el).find("h2 a").first();
    const title = a.text().replace(/\s+/g, " ").trim();
    const url = a.attr("href") ?? "";
    const snippet = $(el).find(".b_caption p, p").first().text().replace(/\s+/g, " ").trim();
    if (title && url) results.push({ title, url, snippet });
    if (results.length >= cfg.maxResults) return false;
  });
  return results;
}

async function searchDuckDuckGo(query: string, cfg: WebSearchConfig): Promise<SearchResult[]> {
  const endpoint = cfg.duckduckgoEndpoint ?? "https://html.duckduckgo.com/html/";
  const html = await fetchText(`${endpoint}?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA },
  });
  const $ = load(html);
  const results: SearchResult[] = [];
  $("div.result").each((_, el) => {
    const a = $(el).find("a.result__a").first();
    const title = a.text().replace(/\s+/g, " ").trim();
    const url = decodeDdgUrl(a.attr("href") ?? "");
    const snippet = $(el).find("a.result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && url) results.push({ title, url, snippet });
    if (results.length >= cfg.maxResults) return false;
  });
  return results;
}

async function searchTavily(query: string, cfg: WebSearchConfig): Promise<SearchResult[]> {
  if (!cfg.tavilyApiKey) {
    throw new Error("Web search provider 'tavily' requires tools.webSearch.tavilyApiKey in config.");
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      api_key: cfg.tavilyApiKey,
      query,
      max_results: cfg.maxResults,
      search_depth: "basic",
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function searchSearxng(query: string, cfg: WebSearchConfig): Promise<SearchResult[]> {
  if (!cfg.searxngBaseURL) {
    throw new Error("Web search provider 'searxng' requires tools.webSearch.searxngBaseURL in config.");
  }
  const base = cfg.searxngBaseURL.replace(/\/$/, "");
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (data.results ?? [])
    .slice(0, cfg.maxResults)
    .map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

/** Run a web search with whichever provider is configured. */
export async function searchWeb(query: string, cfg: WebSearchConfig): Promise<SearchResult[]> {
  switch (cfg.provider) {
    case "bing":
      return searchBing(query, cfg);
    case "duckduckgo":
      return searchDuckDuckGo(query, cfg);
    case "tavily":
      return searchTavily(query, cfg);
    case "searxng":
      return searchSearxng(query, cfg);
    default:
      return searchBing(query, cfg);
  }
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No search results found.";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

/** Build the web-search tool from the configured provider. */
export function buildWebSearchTool(cfg: WebSearchConfig) {
  return tool(
    async ({ query }) => {
      const results = await searchWeb(query, cfg);
      return formatResults(results);
    },
    {
      name: "web_search",
      description:
        "Search the web for up-to-date information. Returns a numbered list of results with title, URL and a text snippet. Use this to answer questions about recent events or facts you are unsure about.",
      schema: z.object({
        query: z.string().describe("The search query to look up."),
      }),
    }
  );
}