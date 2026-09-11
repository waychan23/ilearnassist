import { API_ERROR_CODES, PARSE_ERROR_CODES, type ParseErrorCode } from "../api/types";
import { i18n } from "../i18n";

/**
 * Turning a server error into something a person can read.
 *
 * The server sends `{ error: { code, message, params? } }`: `code` is canonical and drives
 * the wording, `message` is its own sentence kept as a fallback. Putting the lookup here —
 * in the client layer rather than in the store — is what lets the ~15 existing
 * `catch (e) { setError(e.message) }` sites keep working *and* become translated, with no
 * change to any of them.
 */

/** Members of the two code unions, as sets, for O(1) membership tests. */
const PARSE_CODES: ReadonlySet<string> = new Set(PARSE_ERROR_CODES);
const API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** Params a message may interpolate. Matches `ApiErrorBody["error"]["params"]`. */
export type ErrorParams = Record<string, string | number>;

/** A failed request, carrying its machine code so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The catalog key for a code, or null when neither union knows it — a newer server, or a
 * code that has not been given a message yet.
 */
function keyFor(code: string): string | null {
  if (PARSE_CODES.has(code)) return `parseErrors.${code}`;
  if (API_CODES.has(code)) return `errors.${code}`;
  return null;
}

/**
 * Render a server error in the user's language.
 *
 * `te()` rather than a `??` guard on `t()`: a missing key makes `t()` return the *key
 * path*, which would render as `parseErrors.foo` rather than falling back to the server's
 * sentence.
 */
export function translateApiError(
  code: string | undefined,
  params: ErrorParams | undefined,
  fallback: string | undefined
): string {
  if (code) {
    const key = keyFor(code);
    if (key && i18n.global.te(key)) return i18n.global.t(key, params ?? {});
  }
  return fallback ?? "";
}

/** The same lookup for a parse failure that arrived on an attachment rather than an error. */
export function translateParseError(
  code: ParseErrorCode | undefined,
  params: ErrorParams | undefined,
  fallback: string | undefined
): string {
  return translateApiError(code, params, fallback);
}
