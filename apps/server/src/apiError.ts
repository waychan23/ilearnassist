import type { AnyErrorCode, CodedErrorBody } from "@ilearnassist/shared";

/**
 * The error envelope for a curated reply.
 *
 * `code` is what the client renders — it owns the wording, in the user's language. The English
 * `message` rides along as the fallback for a client that does not know the code yet, and
 * `params` carries anything the client needs to interpolate so it never has to receive a
 * pre-built sentence. See `ApiErrorBody` in `packages/shared`.
 *
 * Its own module rather than a local function in `routes.ts`, which is where it lived until
 * the administrator CLI needed to produce the same envelope without a request to attach it to.
 * The two channels must name a refusal identically or the client has two vocabularies for one
 * thing — and the CLI's codes are a closed set precisely so the panel's catalog can be checked
 * against them.
 *
 * Generic over the code rather than widened to the whole union, so a caller that can only
 * produce five of them says so in its return type. Every existing `ApiErrorBody` annotation
 * still accepts one: a narrower body is assignable to the wider shape.
 */
export function apiError<C extends AnyErrorCode>(
  code: C,
  message: string,
  params?: Record<string, string | number>
): CodedErrorBody<C> {
  return { error: params ? { code, message, params } : { code, message } };
}
