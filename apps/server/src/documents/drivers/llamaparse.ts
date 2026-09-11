import { promises as fs } from "node:fs";
import { ParseError } from "../errors.js";
import { pollUntil } from "./async.js";
import {
  authHeaders,
  bodyBytes,
  firstString,
  httpError,
  joinUrl,
  pick,
  requestMultipart,
  toTransportError,
  withTimeout,
} from "./http.js";
import type { DriverConfig, DriverResult, DriverTuning, ParseDriver, ParseRequest } from "./types.js";

/**
 * LlamaParse — the multipart-and-poll shape.
 *
 * Contrast with MinerU: the upload goes straight into the submit call (multipart, no
 * presigned hop) and the Markdown arrives *inside* the poll response rather than in an
 * archive behind a second URL. Reducto follows this same shape, so a `reducto` kind would
 * be a near-copy of this file with different field names.
 *
 * Response fields are read through a tolerant lookup: the v2 API has moved `markdown`
 * between the envelope root and a nested `job` object across revisions, and guessing wrong
 * would surface as "parser returned nothing" rather than as an obvious error.
 */

const DEFAULT_BASE = "https://api.cloud.llamaindex.ai";

interface JobId {
  id: string;
}

async function submit(req: ParseRequest, cfg: DriverConfig, tuning: DriverTuning, signal: AbortSignal): Promise<JobId> {
  const url = joinUrl(cfg.baseURL, "/api/v2/parse/upload");
  const bytes = await fs.readFile(req.path);

  const body = await requestMultipart(
    url,
    cfg,
    {
      file: new Blob([bodyBytes(bytes)], { type: req.mimeType }),
      filename: req.name,
      extra: { configuration: JSON.stringify({ tier: "cost_effective" }) },
    },
    tuning,
    signal
  );

  const id = firstString(pick(body, "id"), pick(body, "job_id"), pick(body, "job.id"));
  if (!id) throw new ParseError("cloud_failed", "LlamaParse did not return a job id.");
  return { id };
}

async function pollJob(jobId: string, cfg: DriverConfig, tuning: DriverTuning, signal: AbortSignal): Promise<string> {
  const url = `${joinUrl(cfg.baseURL, `/api/v2/parse/${jobId}`)}?expand=markdown`;

  return pollUntil<string>(
    async () => {
      const { signal: linked, dispose } = withTimeout(signal, tuning.requestTimeoutMs);
      try {
        const res = await fetch(url, { headers: authHeaders(cfg), signal: linked, redirect: "follow" });
        if (!res.ok) throw await httpError(res, "LlamaParse");
        const body = (await res.json()) as Record<string, unknown>;

        const status = firstString(pick(body, "status"), pick(body, "job.status"))?.toUpperCase();
        if (status === "ERROR" || status === "FAILED" || status === "CANCELLED") {
          return {
            error: new ParseError(
              "cloud_failed",
              `LlamaParse 解析失败：${firstString(pick(body, "error_message"), pick(body, "job.error_message")) ?? "未知原因"}`
            ),
          };
        }

        const markdown = firstString(
          pick(body, "markdown"),
          pick(body, "markdown_full"),
          pick(body, "job.markdown"),
          pick(body, "result.markdown")
        );
        if (markdown) return { value: markdown };

        if (status === "SUCCESS" || status === "COMPLETED") {
          return { error: new ParseError("cloud_failed", "LlamaParse 返回了空内容。") };
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

export const llamaparseDriver: ParseDriver = {
  kind: "llamaparse",
  label: "LlamaParse",
  requiresApiKey: true,
  defaultBaseURL: DEFAULT_BASE,
  helpURL: "https://docs.cloud.llamaindex.ai/llamaparse/getting_started/get_an_api_key",

  async parse(req: ParseRequest, cfg: DriverConfig, tuning, signal): Promise<DriverResult> {
    const { id } = await submit(req, cfg, tuning, signal);
    const text = (await pollJob(id, cfg, tuning, signal)).trim();
    if (!text) throw new ParseError("cloud_failed", "LlamaParse 返回了空内容。");
    return { text };
  },

  async probe(cfg, tuning, signal) {
    // A 404 on an unknown job is a perfectly good outcome: it proves the host is reachable
    // and the token was accepted. Only 401/403 says anything is actually wrong.
    const url = joinUrl(cfg.baseURL, "/api/v2/parse/00000000-0000-0000-0000-000000000000");
    const { signal: linked, dispose } = withTimeout(signal, tuning.requestTimeoutMs);
    try {
      const res = await fetch(url, { headers: authHeaders(cfg), signal: linked, redirect: "follow" });
      if (res.status === 401 || res.status === 403) {
        throw new ParseError("cloud_auth", `LlamaParse 拒绝了凭据（HTTP ${res.status}）。`);
      }
      if (res.status >= 500) {
        throw new ParseError("cloud_failed", `LlamaParse 服务异常（HTTP ${res.status}）。`);
      }
    } catch (err) {
      throw toTransportError(err, url, signal);
    } finally {
      dispose();
    }
  },
};
