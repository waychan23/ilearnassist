import type { ApiErrorCode } from "@ilearnassist/shared";

/**
 * Recognise a provider rejection that is really a *setting* the user can change, and name it.
 *
 * DeepSeek's thinking mode requires the chain of thought back on any replayed message that
 * carries tool calls, and answers with this sentence when the field is missing. In this app
 * there is exactly one way to reach that state: the model record does not declare the
 * `reasoning` capability, so `createReasoningFetch` is never handed a `replayReasoning` map
 * and leaves the request untouched. See `withReplayedReasoning` in `model.ts` for the wire
 * half and `isReasoningModel` in `loop.ts` for the gate.
 *
 * The provider's words are accurate and useless: nothing in "The `reasoning_content` in the
 * thinking mode must be passed back to the API" tells a user that a checkbox named
 * 推理模型 is what turns the field back on. That gap is the whole reason this function
 * exists.
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
