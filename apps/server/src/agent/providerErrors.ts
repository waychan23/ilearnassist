import type { ApiErrorCode } from "@ilearnassist/shared";

/**
 * Recognise a provider rejection that is really a *setting* the user can change, and name it.
 *
 * DeepSeek's thinking mode requires the chain of thought back on any replayed message that
 * carries tool calls, and answers with this sentence when the field is missing or empty.
 *
 * **Two ways to reach that state, and this function cannot tell them apart.** The model record may
 * not declare the `reasoning` capability — `createReasoningFetch` then has no map to replay and
 * `isReasoningModel` gates the whole thing — which is the case the sentence below is about. Or the
 * field was sent and refused anyway, which is what a message with no reasoning of its own used to
 * produce before `FALLBACK_REASONING` (see `model.ts`) stopped an empty value going out. The
 * sentence therefore names the setting to check rather than asserting it is the cause: a user who
 * has already ticked the box was being told to tick the box.
 *
 * The provider's words are accurate and useless on their own: nothing in "The `reasoning_content`
 * in the thinking mode must be passed back to the API" tells a user that a checkbox named 推理模型
 * is what turns the field back on. That gap is the whole reason this function exists.
 *
 * Matching the sentence is deliberate, and it is the only thing DeepSeek gives us to key on.
 * Two halves rather than one, so a different 400 that merely mentions the field — an unknown
 * parameter, say — is not misfiled as a misconfiguration.
 */
const MENTIONS_REASONING_CONTENT = /reasoning_content/i;
const DEMANDS_IT_BACK = /must be passed back/i;

export function classifyProviderError(message: string): ApiErrorCode | undefined {
  if (MENTIONS_REASONING_CONTENT.test(message) && DEMANDS_IT_BACK.test(message)) {
    return "REASONING_NOT_DECLARED";
  }
  return undefined;
}
