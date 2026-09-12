import type { DocumentParsePolicy, DocumentParserKind } from "@ilearnassist/shared";
import {
  ParseError,
  asParseError,
  isRecoverable,
  type ParseAttempt,
  type ParseErrorCode,
} from "./errors.js";
import { driverFor, type DriverResult, type DriverTuning, type ParseDriver } from "./drivers/index.js";
import { parseLocal } from "./local/index.js";

export {
  ParseError,
  asParseError,
  describeParseError,
  isRecoverable,
  parseErrorCodeOf,
  parseErrorDetail,
} from "./errors.js";
export type { ParseAttempt, ParseErrorCode } from "./errors.js";
export { documentFormatFor, isDocumentMime, FORMAT_LABEL } from "./formats.js";
export type { DocumentFormat } from "./formats.js";
export { buildPdf, probePdf } from "./sample.js";
export { driverFor, driverInfos, DRIVER_KINDS, isDocumentParserKind } from "./drivers/index.js";
export type { DriverInfo } from "@ilearnassist/shared";
export type { DriverTuning } from "./drivers/index.js";

/** A cloud parser as the orchestrator sees it (includes the key, and the ordering). */
export interface ParserTarget {
  id: string;
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey?: string;
}

export interface ParsePolicy {
  localEnabled: boolean;
  policy: DocumentParsePolicy;
  fallbackEnabled: boolean;
  /** Pinned parser record id; `null` means "try every enabled parser in order". */
  defaultParserId: string | null;
}

export interface ParseDocumentInput {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  policy: ParsePolicy;
  /** Enabled cloud parsers, already in preference order. */
  parsers: ParserTarget[];
  localMaxBytes: number;
  /** Ceiling on what gets written to disk, so one pathological file cannot fill it. */
  maxTextChars: number;
  tuning: DriverTuning;
  signal: AbortSignal;
}

export interface ParseOutcome {
  text: string;
  pageCount?: number;
  /** `"local"`, or the id of the parser record that produced the text. */
  parserId: string;
  /** Every tier that was attempted and failed, for the server log. */
  attempts: { parserId: string; error: string }[];
}

/** Which tiers to try, in order. */
function tiersFor(policy: ParsePolicy): ("local" | "cloud")[] {
  const local = "local" as const;
  const cloud = "cloud" as const;

  let order: ("local" | "cloud")[];
  switch (policy.policy) {
    case "local-only":
      order = [local];
      break;
    case "cloud-only":
      order = [cloud];
      break;
    case "cloud-first":
      order = [cloud, local];
      break;
    case "local-first":
    default:
      order = [local, cloud];
      break;
  }

  // With fallback off, a hybrid policy degrades to its first tier only — a failure
  // surfaces to the user instead of being silently retried on the other side.
  return policy.fallbackEnabled ? order : order.slice(0, 1);
}

/** The cloud tier's own order: a pinned parser first, then the rest as configured. */
function orderParsers(parsers: ParserTarget[], defaultParserId: string | null): ParserTarget[] {
  if (!defaultParserId) return parsers;
  const pinned = parsers.find((p) => p.id === defaultParserId);
  if (!pinned) return parsers;
  return [pinned, ...parsers.filter((p) => p.id !== defaultParserId)];
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... 内容过长，已在 ${maxChars} 字符处截断]`;
}

async function runLocalTier(input: ParseDocumentInput): Promise<DriverResult & { parserId: string }> {
  if (!input.policy.localEnabled) {
    throw new ParseError("local_disabled", "Local extraction is switched off.");
  }
  const result = await parseLocal({
    path: input.path,
    mimeType: input.mimeType,
    size: input.size,
    maxBytes: input.localMaxBytes,
  });
  return { ...result, parserId: "local" };
}

/**
 * Try each cloud parser in turn.
 *
 * Failing over *within* the tier is the point: two configured services are two chances,
 * and a wrong key on the first should not cost the user a parse when the second works.
 */
async function runCloudTier(input: ParseDocumentInput): Promise<DriverResult & { parserId: string }> {
  const targets = orderParsers(input.parsers, input.policy.defaultParserId);
  if (targets.length === 0) {
    throw new ParseError("no_cloud_parser", "No enabled cloud parser is configured.");
  }

  let lastError: unknown;
  for (const target of targets) {
    const driver: ParseDriver = driverFor(target.kind);
    try {
      const result = await driver.parse(
        { path: input.path, name: input.name, mimeType: input.mimeType, size: input.size },
        { id: target.id, name: target.name, baseURL: target.baseURL, apiKey: target.apiKey },
        input.tuning,
        input.signal
      );
      return { ...result, parserId: target.id };
    } catch (err) {
      lastError = asParseError(err);
    }
  }
  throw lastError ?? new ParseError("cloud_failed", "所有云解析服务均失败。");
}

/**
 * Extract a document's text under the configured policy.
 *
 * Every failure is re-thrown as a `ParseError`, so callers get a code they can map to a
 * message rather than a raw fetch/parse exception. A failure the other tier could not
 * plausibly fix (`password_protected`, `unsupported_type`) aborts the walk immediately
 * instead of burning a cloud round-trip on a document no parser can read.
 */
export async function parseDocument(input: ParseDocumentInput): Promise<ParseOutcome> {
  const tiers = tiersFor(input.policy);
  const attempts: ParseAttempt[] = [];
  let lastError: ParseError | undefined;

  for (const tier of tiers) {
    try {
      const result = tier === "local" ? await runLocalTier(input) : await runCloudTier(input);
      const text = truncate(result.text.trim(), input.maxTextChars);
      if (!text) {
        throw new ParseError("no_text_layer", "解析结果为空。");
      }
      return { text, pageCount: result.pageCount, parserId: result.parserId, attempts };
    } catch (err) {
      const error = asParseError(err);
      lastError = error;
      attempts.push({ parserId: tier, code: error.code, error: error.message });
      // A non-recoverable failure means no other tier can read this file — walking on
      // would spend a cloud round-trip to learn what we already know.
      if (!isRecoverable(error)) break;
    }
  }

  const final = pickReportableError(attempts, lastError);
  final.attempts = attempts;
  throw final;
}

/**
 * Choose which failure the user actually gets told about.
 *
 * "The cloud tier has no parser configured" is a statement about the *configuration*, and
 * it is the least useful thing to say when a document was genuinely unreadable — a scanned
 * PDF under `local-first` with no cloud parser would otherwise report "unsupported file
 * type" rather than "no text layer, this looks like a scan". So any real read failure
 * outranks a tier that never ran. When every tier was merely unavailable, the last one
 * still wins, so `cloud-only` with nothing configured explains itself.
 */
function pickReportableError(attempts: ParseAttempt[], lastError: ParseError | undefined): ParseError {
  const informative = attempts.find((a) => !UNAVAILABLE_TIERS.has(a.code));

  if (informative) {
    const error = new ParseError(informative.code, informative.error);
    // The tier that never ran is still worth naming — it is usually the fix.
    const skipped = attempts.find((a) => UNAVAILABLE_TIERS.has(a.code));
    if (skipped) error.message += `（${skipped.error}）`;
    return error;
  }
  return lastError ?? new ParseError("corrupt", "All parsing tiers failed.");
}

/** Codes meaning "this tier never ran", as opposed to "this tier could not read the file". */
const UNAVAILABLE_TIERS: ReadonlySet<ParseErrorCode> = new Set<ParseErrorCode>([
  "no_cloud_parser",
  "local_disabled",
]);
