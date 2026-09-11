/**
 * Failure taxonomy for document text extraction.
 *
 * The codes matter beyond messaging: the parse policy uses them to decide whether a
 * failure is worth retrying on the *other* side (local ⇄ cloud). Getting that split
 * wrong is how a user ends up staring at "parsing failed" for a file the cloud parser
 * would have handled in one call.
 */

import type { ParseErrorCode } from "@guided-learning/shared";

/**
 * Re-exported so the server modules that import the code union from this file keep
 * working. It is *defined* in `packages/shared` because the client translates by code —
 * the wording is no longer the server's to own.
 */
export type { ParseErrorCode };

/** One tier's failed attempt, kept so a failure can explain what was already tried. */
export interface ParseAttempt {
  /** `"local"`, or a parser record id. */
  parserId: string;
  code: ParseErrorCode;
  error: string;
}

export class ParseError extends Error {
  readonly code: ParseErrorCode;
  /**
   * Tiers tried before this error, oldest first. Populated by the policy orchestrator —
   * the log is most valuable precisely when the parse failed, so it rides on the throw
   * rather than only on the success value.
   */
  attempts: ParseAttempt[] = [];

  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

/** Wrap a non-ParseError throw as a `corrupt`-class failure. */
export function asParseError(err: unknown): ParseError {
  if (err instanceof ParseError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ParseError("corrupt", message);
}

/**
 * Codes for which falling back to the other parser tier is pointless.
 *
 * Note what is *absent*: `no_text_layer` and `too_large` are both recoverable, and
 * deliberately so. An image-only PDF is exactly what an OCR-capable cloud parser is for,
 * and the cloud ceiling (200 MB at MinerU) dwarfs the local one — a file too big to parse
 * here is the single most likely candidate to succeed there.
 *
 * `no_cloud_parser` and `local_disabled` are recoverable for the same reason: they say a
 * tier was *unavailable*, not that it read the file and failed. Treating them as terminal
 * would make `cloud-first` with no parsers configured refuse to use the local extractor,
 * which works perfectly well.
 */
const NON_RECOVERABLE: ReadonlySet<ParseErrorCode> = new Set<ParseErrorCode>([
  "password_protected",
  "unsupported_type",
  "missing_file",
  "cancelled",
]);

export function isRecoverable(err: unknown): boolean {
  const code = err instanceof ParseError ? err.code : "corrupt";
  return !NON_RECOVERABLE.has(code);
}

/** The stable code for a throw, so a route can emit it alongside the sentence. */
export function parseErrorCodeOf(err: unknown): ParseErrorCode {
  return err instanceof ParseError ? err.code : "corrupt";
}

/**
 * The provider's own words, when the code alone would lose them.
 *
 * Only the two codes whose message is not self-contained carry a detail. Everything else
 * has a fixed sentence the client renders from the code.
 */
export function parseErrorDetail(err: unknown): string | undefined {
  const code = parseErrorCodeOf(err);
  if (code !== "cloud_failed" && code !== "corrupt") return undefined;
  return err instanceof Error ? err.message : String(err);
}

/**
 * A message aimed at the person who uploaded the file, not at a log reader.
 *
 * Now only a *fallback*: the client renders `parseErrorCodeOf()` in the user's language
 * and reaches for this when it meets a code it does not know. Written in Chinese to match
 * the catalog this project started in.
 */
export function describeParseError(err: unknown): string {
  const code = parseErrorCodeOf(err);
  switch (code) {
    case "password_protected":
      return "文件已加密，需要密码才能读取内容。";
    case "no_text_layer":
      return "未检测到文本层，可能是扫描件或纯图片 PDF。可配置支持 OCR 的云解析服务后重试。";
    case "too_large":
      return "文件超过本地解析上限，已跳过解析。可配置云解析服务后重试，或开启更高上限。";
    case "unsupported_type":
      return "暂不支持解析该文件类型。";
    case "no_cloud_parser":
      return "没有可用的云解析服务。请到「设置 → 文档解析」添加一个并启用。";
    case "local_disabled":
      return "本地解析已在设置中关闭。";
    case "missing_file":
      return "文件已丢失，无法解析。请重新上传。";
    case "cloud_auth":
      return "云解析服务拒绝了凭据，请检查 API Key。";
    case "cloud_failed":
      return `云解析失败：${err instanceof Error ? err.message : String(err)}`;
    case "timeout":
      return "解析超时。文件可能过大，或解析服务无响应。";
    case "cancelled":
      return "解析已取消。";
    default:
      return `解析失败：${err instanceof Error ? err.message : String(err)}`;
  }
}
