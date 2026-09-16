import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { load } from "cheerio";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { WebFetchConfig } from "../config.js";
import type { PageCache } from "../webCapture.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * Whether an IP literal points somewhere we must not reach from the server: loopback,
 * private, link-local, CGNAT or reserved ranges. The web_fetch tool is the one place the
 * model can make the server issue an arbitrary outbound request, so this is a genuine
 * security boundary rather than a nicety.
 */
export function isPrivateAddress(addr: string): boolean {
  const version = isIP(addr);

  if (version === 6) {
    const a = addr.toLowerCase().split("%")[0] ?? "";
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd")) return true;
    // IPv4-mapped (::ffff:127.0.0.1) must be judged by the embedded IPv4 address.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }

  if (version !== 4) return true; // unknown form — refuse rather than guess

  const parts = addr.split(".").map(Number);
  const [a, b] = parts as [number, number, number, number];
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Throw unless `rawUrl` is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing to fetch non-http(s) URL: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("URL has no host.");

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`Refusing to fetch private address: ${host}`);
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve host: ${host}`);

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Refusing to fetch "${host}" — it resolves to a private address (${address}).`);
    }
  }

  return url;
}

/** Read at most `maxBytes` from a response body. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();

  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Follow redirects manually so that *every* hop is re-validated. Using
 * `redirect: "follow"` would let a public URL bounce the server to an internal address.
 */
/**
 * One guarded fetch, exported for the page-capture tool.
 *
 * `ila_collect_page` needs exactly this: the SSRF check on the URL *and on every redirect hop*,
 * the capped body, the content type. A second implementation would be a second chance to get
 * the guard wrong, and this is the one place the model can make the server issue an arbitrary
 * outbound request — so it is one function with two callers rather than two functions.
 */
export async function fetchGuarded(
  rawUrl: string
): Promise<{ finalUrl: string; body: string; contentType: string }> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);

    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status} redirect without a Location header.`);
      current = new URL(location, current).toString();
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} from ${current}`);

    const contentType = res.headers.get("content-type") ?? "";
    const body = await readCapped(res, MAX_BODY_BYTES);
    return { finalUrl: current, body, contentType };
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

/** Collapse an HTML document down to readable text, preferring <main>/<article>. */
export function htmlToText(html: string): { title: string; text: string } {
  const $ = load(html);
  const title = $("title").first().text().trim();

  $("script, style, noscript, iframe, svg, nav, header, footer, aside, form").remove();

  const main = $("main, article").first();
  const body = $("body");
  const raw = main.length > 0 ? main.text() : body.length > 0 ? body.text() : $.root().text();

  const text = (raw || "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text };
}

/**
 * Build the URL-fetch tool. The configured `maxChars` caps what reaches the model.
 *
 * `cache` is where a fetch is *remembered*, and it is what makes `ila_collect_page` free for a
 * page the model has already read: keeping a page it just fetched costs no second request.
 * Optional, because a test that only exercises this tool has nothing to share it with.
 */
export function buildWebFetchTool(cfg: WebFetchConfig, cache?: PageCache) {
  return tool(
    async ({ url, maxChars }) => {
      const limit = Math.min(maxChars ?? cfg.maxChars, cfg.maxChars);
      const { finalUrl, body, contentType } = await fetchGuarded(url);
      // Keyed by the URL the model asked for *and* by the one it landed on: a redirect means
      // the two differ, and a model that collects the address it typed is the common case.
      cache?.set(url, { finalUrl, body, contentType });
      cache?.set(finalUrl, { finalUrl, body, contentType });

      let text: string;
      let title = "";
      if (contentType.includes("json") || contentType.startsWith("text/plain")) {
        text = body.trim();
      } else {
        const extracted = htmlToText(body);
        title = extracted.title;
        text = extracted.text;
      }

      const truncated = text.length > limit;
      if (truncated) text = text.slice(0, limit);

      const header =
        `URL: ${finalUrl}\n` +
        (title ? `Title: ${title}\n` : "") +
        `Content-Type: ${contentType || "unknown"}\n\n`;

      return header + text + (truncated ? `\n\n[... truncated at ${limit} characters]` : "");
    },
    {
      name: "web_fetch",
      description:
        "Fetch a specific web page by URL and return its readable text content. Use this after web_search when you need the actual contents of a result, or when the user gives you a URL. Only http(s) URLs are allowed.",
      schema: z.object({
        url: z.string().describe("The absolute http(s) URL to fetch."),
        maxChars: z
          .number()
          .optional()
          .describe("Optional cap on how many characters of text to return."),
      }),
    }
  );
}
