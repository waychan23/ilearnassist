import {
  ASK_USER_TOOL_NAME,
  QUIZ_TOOL_NAME,
  type AnswerToolCallInput,
  type InteractiveAnswer,
  type ToolCall,
} from "@ilearnassist/shared";
import { readAskUserQuestions, renderAskUserResult, validateAnswers } from "./askUser.js";
import { readQuizQuestions, renderQuizResult, validateQuizAnswers } from "./quiz.js";

/**
 * What the answers route needs from a suspending tool.
 *
 * One method rather than three (read, validate, render), because what has to hold is the
 * *pairing* of a tool's question type with the validator that understands it — split across
 * three maps keyed by the same name, the pairing is a thing to get wrong rather than a thing
 * the types enforce. `resolve` answers all three questions the route has: does this call
 * hold a question set at all, was the submission acceptable, and what are the two copies of
 * the answer that the two readers need.
 */
export interface SuspendingTool {
  /**
   * `undefined` — this call holds no question set (the route answers 409).
   * `ok: false` — the submission is not acceptable (the route answers 400).
   */
  resolve(
    call: ToolCall,
    submission: AnswerToolCallInput
  ):
    | { ok: true; answer: InteractiveAnswer; output: string }
    | { ok: false; reason: string }
    | undefined;
}

const askUserSpec: SuspendingTool = {
  resolve(call, submission) {
    const questions = readAskUserQuestions(call);
    if (!questions) return undefined;

    const validated = validateAnswers(questions, submission);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    return {
      ok: true,
      answer: validated.answers,
      output: renderAskUserResult(questions, validated.answers, submission.action),
    };
  },
};

const quizSpec: SuspendingTool = {
  resolve(call, submission) {
    const questions = readQuizQuestions(call);
    if (!questions) return undefined;

    const validated = validateQuizAnswers(questions, submission);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    return {
      ok: true,
      answer: validated.answers,
      output: renderQuizResult(questions, validated.answers, submission.action),
    };
  },
};

/**
 * Every tool whose calls can be answered, keyed by the name recorded on the call.
 *
 * The lookup is by the *stored call's* name rather than by anything the client sent, so a
 * client cannot choose how its own submission is read. A suspending tool missing from here
 * gets the same 409 as a stale question, which is the safe direction — refusing rather than
 * guessing at a shape.
 */
export const SUSPENDING_TOOLS: Record<string, SuspendingTool> = {
  [ASK_USER_TOOL_NAME]: askUserSpec,
  [QUIZ_TOOL_NAME]: quizSpec,
};
