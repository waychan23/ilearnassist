import { ParseError } from "../errors.js";
import type { DriverConfig, DriverTuning } from "./types.js";

/**
 * HTTP plumbing shared by the cloud drivers: timeouts, auth headers, and a consistent
 * mapping from transport/HTTP failures onto the `ParseError` taxonomy — which is what the
 * parse policy reads to decide whether a retry elsewhere is worth attempting.
 */

export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Copy bytes into a plainly-backed view suitable as a request body.
 *
 * `fetch`'s `BodyInit` accepts `ArrayBufferView<ArrayBuffer>`, while a `Buffer` from
 * `fs.readFile` is typed `Uint8Array<ArrayBufferLike>` — `ArrayBufferLike` covers
 * `SharedArrayBuffer`, which is not a legal body. The copy is what makes the type honest;
 * it also detaches nothing the caller still needs.
 */
export function bodyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * An `AbortSignal` that fires on the caller's abort *or* the timeout, whichever is first.
 *
 * Spelled out rather than using `AbortSignal.any`, which needs Node ≥ 20.3 — this project
 * advertises Node ≥ 20. Returns a disposer so the timer never keeps the process alive.
 */
export function withTimeout(
  signal: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

export function authHeaders(cfg: DriverConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

/** Map a non-2xx response onto a `ParseError`, reading the body for context. */
export async function httpError(res: Response, what: string): Promise<ParseError> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* the body is best-effort context; the status alone is enough */
  }
  if (res.status === 401 || res.status === 403) {
    return new ParseError("cloud_auth", `${what} rejected the credentials (HTTP ${res.status}).`);
  }
  return new ParseError(
    "cloud_failed",
    `${what} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}.`
  );
}

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal: AbortSignal;
  tuning: DriverTuning;
}

export async function requestJson(
  url: string,
  cfg: DriverConfig,
  options: JsonRequestOptions
): Promise<Record<string, unknown>> {
  const { signal, dispose } = withTimeout(options.signal, options.tuning.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...authHeaders(cfg),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "follow",
    });
    if (!res.ok) throw await httpError(res, url);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw toTransportError(err, url, options.signal);
  } finally {
    dispose();
  }
}

export async function requestOk(
  url: string,
  cfg: DriverConfig,
  options: JsonRequestOptions
): Promise<Response> {
  const { signal, dispose } = withTimeout(options.signal, options.tuning.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...authHeaders(cfg),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "follow",
    });
    if (!res.ok) throw await httpError(res, url);
    return res;
  } catch (err) {
    throw toTransportError(err, url, options.signal);
  } finally {
    dispose();
  }
}

/**
 * Turn a thrown fetch error into a `ParseError`.
 *
 * A cancelled parse and a timed-out request look alike at the socket, so `callerAborted`
 * is what tells them apart — the former must not be retried, the latter should be.
 */
export function toTransportError(err: unknown, url: string, callerSignal: AbortSignal): ParseError {
  if (err instanceof ParseError) return err;
  if (callerSignal.aborted) return new ParseError("cancelled", "Parsing was cancelled.");
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return new ParseError("timeout", `${url} did not respond in time.`);
  }
  return new ParseError("cloud_failed", `${url} could not be reached: ${message}`);
}

/**
 * POST with `multipart/form-data`.
 *
 * Built on the global `FormData`/`Blob` so no multipart dependency is needed — the whole
 * reason attachment uploads elsewhere in this server are base64 JSON is to avoid one.
 */
export async function requestMultipart(
  url: string,
  cfg: DriverConfig,
  fields: { file: Blob; filename: string; extra?: Record<string, string> },
  tuning: DriverTuning,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const { signal: linked, dispose } = withTimeout(signal, tuning.requestTimeoutMs);
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields.extra ?? {})) form.append(key, value);
    form.append("file", fields.file, fields.filename);

    // No Content-Type header: fetch must set it itself to include the multipart boundary.
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(cfg),
      body: form,
      signal: linked,
      redirect: "follow",
    });
    if (!res.ok) throw await httpError(res, url);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw toTransportError(err, url, signal);
  } finally {
    dispose();
  }
}

/** Walk a dotted path (`data.job.id`) through parsed JSON. */
export function pick(node: unknown, path: string): unknown {
  let current: unknown = node;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}
