import { promises as fs } from "node:fs";
import { ParseError } from "../errors.js";
import { probePdf } from "../sample.js";
import { authHeaders, bodyBytes, httpError, toTransportError, withTimeout } from "./http.js";
import type { DriverConfig, DriverResult, DriverTuning, ParseDriver, ParseRequest } from "./types.js";

/**
 * The generic single-round-trip driver: POST the file, get text back.
 *
 * This is what a self-hosted service looks like — `docling-serve` (IBM), Marker, a
 * self-hosted MinerU — and it is the reason the "just point it at a base URL" story works
 * for the self-hosted case: no credential, no job polling, no vendor SDK.
 *
 * Both the request and the response are treated loosely on purpose. The request is always
 * multipart with the file in a `file` field, which every one of those services accepts.
 * The response is read as Markdown/text when the service returns raw content, and searched
 * for the longest plausible text field when it returns JSON — a generic driver has to
 * tolerate a JSON envelope without knowing which one it will get.
 */

/** Response keys that may hold the extracted document, most specific first. */
const TEXT_KEYS = ["markdown", "md_content", "text", "content", "text_content", "body"];

function deepestText(node: unknown, depth = 0): string | undefined {
  if (depth > 8 || !node || typeof node !== "object") return undefined;

  if (Array.isArray(node)) {
    const found = node.map((child) => deepestText(child, depth + 1)).filter(Boolean) as string[];
    return found.sort((a, b) => b.length - a.length)[0];
  }

  const record = node as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of TEXT_KEYS) {
    const value = record[key];
    if (typeof value === "string") candidates.push(value);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const nested = deepestText(value, depth + 1);
      if (nested) candidates.push(nested);
    }
  }
  // Longest wins: a short `content` field is more likely a status message than the document.
  return candidates.sort((a, b) => b.length - a.length)[0];
}

async function readText(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  if (!contentType.includes("json")) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  return deepestText(parsed) ?? "";
}

async function post(
  cfg: DriverConfig,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  tuning: DriverTuning,
  signal: AbortSignal
): Promise<string> {
  const { signal: linked, dispose } = withTimeout(signal, tuning.jobTimeoutMs);
  try {
    const form = new FormData();
    form.append("file", new Blob([bodyBytes(bytes)], { type: mimeType }), filename);

    const res = await fetch(cfg.baseURL, {
      method: "POST",
      headers: authHeaders(cfg),
      body: form,
      signal: linked,
      redirect: "follow",
    });
    if (!res.ok) throw await httpError(res, cfg.baseURL);
    return await readText(res);
  } catch (err) {
    throw toTransportError(err, cfg.baseURL, signal);
  } finally {
    dispose();
  }
}

export const syncDriver: ParseDriver = {
  kind: "sync",
  label: "同步解析服务（Docling / Marker / 自建 MinerU）",
  requiresApiKey: false,
  defaultBaseURL: "http://127.0.0.1:5001/v1/convert/file",

  async parse(req: ParseRequest, cfg: DriverConfig, tuning, signal): Promise<DriverResult> {
    const bytes = await fs.readFile(req.path);
    const text = await post(cfg, bytes, req.name, req.mimeType, tuning, signal);
    if (!text.trim()) {
      throw new ParseError("cloud_failed", `${cfg.name} returned no text.`);
    }
    return { text: text.trim() };
  },

  async probe(cfg, tuning, signal) {
    // The only honest test of a generic endpoint is to send it a document and see whether
    // real text comes back — a health path would not prove the parsing route works.
    const bytes = probePdf();
    const text = await post(cfg, bytes, "connection-test.pdf", "application/pdf", tuning, signal);
    if (!text.trim()) {
      throw new ParseError(
        "cloud_failed",
        "服务可达，但未返回文本内容。请确认地址指向文档解析接口。"
      );
    }
  },
};
