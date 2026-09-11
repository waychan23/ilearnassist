import { promises as fs } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { ParseError } from "../errors.js";
import { pollUntil } from "./async.js";
import {
  authHeaders,
  bodyBytes,
  firstString,
  httpError,
  joinUrl,
  pick,
  toTransportError,
  withTimeout,
} from "./http.js";
import type { DriverConfig, DriverResult, DriverTuning, ParseDriver, ParseRequest } from "./types.js";

/**
 * MinerU — the parser chatbox integrates.
 *
 * Three steps, none of them optional: ask for a presigned upload URL, `PUT` the bytes,
 * then poll until the batch reports `done` and download a ZIP that contains Markdown.
 * That ZIP is the reason this cannot be folded into the generic driver: the result is not
 * in the poll response, it is one HTTP hop further away, inside an archive.
 *
 * The same protocol is served by the hosted API and by a self-hosted MinerU deployment,
 * which is why `baseURL` is configurable — the default points at the hosted v4 API.
 */

const DEFAULT_BASE = "https://mineru.net/api/v4";

interface BatchInfo {
  batchId: string;
  uploadUrl: string;
}

async function submitBatch(
  req: { name: string },
  cfg: DriverConfig,
  tuning: DriverTuning,
  signal: AbortSignal
): Promise<BatchInfo> {
  const url = joinUrl(cfg.baseURL, "/file-urls/batch");
  const { signal: linked, dispose } = withTimeout(signal, tuning.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ name: req.name, data_id: `gl-${Date.now()}` }],
        model_version: "vlm",
        enable_formula: true,
        enable_table: true,
      }),
      signal: linked,
      redirect: "follow",
    });
    if (!res.ok) throw await httpError(res, "MinerU");
    const body = (await res.json()) as Record<string, unknown>;

    const batchId = firstString(pick(body, "data.batch_id"), pick(body, "batch_id"));
    const uploadUrl = firstString(
      pick(body, "data.file_urls.0"),
      // Some deployments answer a single-file request with a scalar instead of a list.
      pick(body, "data.file_url"),
      pick(body, "file_urls.0")
    );
    if (!batchId || !uploadUrl) {
      throw new ParseError("cloud_failed", "MinerU did not return an upload URL.");
    }
    return { batchId, uploadUrl };
  } catch (err) {
    throw toTransportError(err, url, signal);
  } finally {
    dispose();
  }
}

async function upload(uploadUrl: string, bytes: Uint8Array, tuning: DriverTuning, signal: AbortSignal): Promise<void> {
  const { signal: linked, dispose } = withTimeout(signal, tuning.jobTimeoutMs);
  try {
    // Presigned: adding an Authorization header would invalidate the signature.
    const res = await fetch(uploadUrl, { method: "PUT", body: bodyBytes(bytes), signal: linked });
    if (!res.ok) throw await httpError(res, "MinerU upload");
  } catch (err) {
    throw toTransportError(err, uploadUrl, signal);
  } finally {
    dispose();
  }
}

async function pollBatch(
  batchId: string,
  cfg: DriverConfig,
  tuning: DriverTuning,
  signal: AbortSignal
): Promise<string> {
  const url = joinUrl(cfg.baseURL, `/extract-results/batch/${batchId}`);

  return pollUntil<string>(
    async () => {
      const { signal: linked, dispose } = withTimeout(signal, tuning.requestTimeoutMs);
      try {
        const res = await fetch(url, { headers: authHeaders(cfg), signal: linked, redirect: "follow" });
        if (!res.ok) throw await httpError(res, "MinerU");
        const body = (await res.json()) as Record<string, unknown>;

        const result = pick(body, "data.extract_result");
        const entry = Array.isArray(result) ? (result[0] as Record<string, unknown>) : result;
        const state = firstString(pick(entry, "state"), pick(entry, "status"));

        if (state === "failed" || state === "error") {
          return {
            error: new ParseError(
              "cloud_failed",
              `MinerU 解析失败：${firstString(pick(entry, "err_msg"), pick(entry, "errmsg")) ?? "未知原因"}`
            ),
          };
        }
        if (state === "done" || state === "success") {
          const zipUrl = firstString(pick(entry, "full_zip_url"), pick(entry, "full_zip"));
          if (!zipUrl) return { error: new ParseError("cloud_failed", "MinerU 未返回结果下载地址。") };
          return { value: zipUrl };
        }
        return {};
      } catch (err) {
        throw toTransportError(err, url, signal);
      } finally {
        dispose();
      }
    },
    tuning,
    signal
  );
}

/** The archive holds the Markdown (plus intermediate JSON we ignore). */
function markdownFromZip(archive: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive);
  } catch (err) {
    throw new ParseError("cloud_failed", err instanceof Error ? err.message : String(err));
  }
  const mdName = Object.keys(files)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.length - b.length)[0]; // `full.md` over `x/full.md`

  const bytes = mdName ? files[mdName] : undefined;
  if (!bytes) throw new ParseError("cloud_failed", "MinerU 返回的压缩包中没有 Markdown 文件。");
  return strFromU8(bytes);
}

async function downloadZip(zipUrl: string, tuning: DriverTuning, signal: AbortSignal): Promise<Uint8Array> {
  const { signal: linked, dispose } = withTimeout(signal, tuning.jobTimeoutMs);
  try {
    const res = await fetch(zipUrl, { signal: linked, redirect: "follow" });
    if (!res.ok) throw await httpError(res, "MinerU result");
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw toTransportError(err, zipUrl, signal);
  } finally {
    dispose();
  }
}

export const mineruDriver: ParseDriver = {
  kind: "mineru",
  label: "MinerU",
  requiresApiKey: true,
  defaultBaseURL: DEFAULT_BASE,
  helpURL: "https://mineru.net/apiManage",

  async parse(req: ParseRequest, cfg: DriverConfig, tuning, signal): Promise<DriverResult> {
    const bytes = await fs.readFile(req.path);
    const { batchId, uploadUrl } = await submitBatch(req, cfg, tuning, signal);
    await upload(uploadUrl, bytes, tuning, signal);
    const zipUrl = await pollBatch(batchId, cfg, tuning, signal);
    const archive = await downloadZip(zipUrl, tuning, signal);

    const text = markdownFromZip(archive).trim();
    if (!text) throw new ParseError("cloud_failed", "MinerU 返回了空内容。");
    return { text };
  },

  async probe(cfg, tuning, signal) {
    // No cheap health endpoint exists, so submit a deliberately empty batch and read the
    // status: 401/403 means the token is wrong, anything else (a 400 about the payload)
    // means the request was authenticated and got far enough to be rejected on content.
    const url = joinUrl(cfg.baseURL, "/file-urls/batch");
    const { signal: linked, dispose } = withTimeout(signal, tuning.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
        body: JSON.stringify({ files: [] }),
        signal: linked,
        redirect: "follow",
      });
      if (res.status === 401 || res.status === 403) {
        throw new ParseError("cloud_auth", `MinerU 拒绝了凭据（HTTP ${res.status}）。`);
      }
      // Reaching the service at all is the other half of what the probe proves.
      if (res.status >= 500) {
        throw new ParseError("cloud_failed", `MinerU 服务异常（HTTP ${res.status}）。`);
      }
    } catch (err) {
      throw toTransportError(err, url, signal);
    } finally {
      dispose();
    }
  },
};
