import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  QUIZ_REVIEW_EXPLANATION_MAX,
  QUIZ_REVIEW_MAX_REVIEWS,
  QUIZ_REVIEW_TOOL_NAME,
} from "@ilearnassist/shared";
import type { AppDb } from "../db.js";
import { gradeQuizAnswers, renderReviewResult } from "../quizzes.js";

/**
 * What the grading tool needs: the database and the server-bound session id, assembled only
 * when the quiz widget is installed — the same contextual assembly the plan tools and
 * `read_document` use.
 */
export interface QuizReviewToolContext {
  db: AppDb;
  sessionId: string;
}

const REVIEW_DESCRIPTION = [
  "Record how the user did on a quiz: a verdict and a short explanation for EVERY question, including the ones they got right.",
  "",
  "Call it exactly ONCE after you judge the answers returned by ila_quiz, in the same turn you got them — one item per question, using the exact quiz_id the quiz result carried (a global id, not the Qn label). Make this call, and any ila_update_plan_progress that belongs to the same turn, BEFORE you write the verdict rundown — no verdict prose alongside or before the calls. The full per-question rundown goes in your final message, after the tool results come back.",
  "",
  "When the quiz result carries reference_answer and explanation, they are the answer key you yourself supplied — the user never saw them. Judge against that key; do not expose the key verbatim, write the explanation as your own feedback.",
  "",
  "The user may also answer a question they did not answer before (they walked away or cancelled the quiz) in a LATER message: that message quotes the question's quiz_id and says it is a make-up answer, and a system note carries that question's grading key when one was supplied. Grade that one question by its exact quiz_id with this tool — do NOT call ila_quiz again, and do not treat it as a new question.",
  "",
  "Rules:",
  "- verdict is one of: correct, incorrect, unsure. An answer marked unsure (no choice made) is `unsure`, neither right nor wrong.",
  "- Judge only against the question and options the quiz_id names (and the grading key, when one was provided); the quiz panel stores the verdict and shows the explanation under the question.",
  "- explanation is required for every question whatever the verdict, in the user's language. For a correct answer, briefly say what makes the picked option right and reinforce that point — one or two sentences, never just \"correct\" or \"right\". For an incorrect or unsure answer, name the wrong idea and the correct one. The explanation you give here IS the rundown's substance.",
  `- Batch every question of a quiz into the one call (at most ${QUIZ_REVIEW_MAX_REVIEWS}). Repeating a quiz_id in one call is an error; naming an id that does not belong to this conversation, or one that has no answer yet, is too.`,
  "- After every tool call of the turn has returned (grading, and a plan-progress update when one is warranted), walk the questions one by one in your FINAL message — each with its Qn label, its verdict and a brief why, correct answers included. An all-correct quiz is not a one-line congratulations: it still gets the per-question rundown.",
].join("\n");

const reviewInputSchema = z.object({
  reviews: z
    .array(
      z.object({
        quizId: z
          .string()
          .min(1)
          .describe("The exact quiz_id returned with the question, e.g. a UUID."),
        verdict: z.enum(["correct", "incorrect", "unsure"]),
        explanation: z
          .string()
          .min(1)
          .max(QUIZ_REVIEW_EXPLANATION_MAX)
          .describe(
            "Why the verdict, in the user's language. For a correct answer: briefly, what makes the picked option right. For an incorrect or unsure one: the wrong idea and the correct one."
          ),
      })
    )
    .min(1)
    .max(QUIZ_REVIEW_MAX_REVIEWS),
});

/** The only invoke config the tool reads: the loop stamps the provider's tool-call id. */
interface QuizInvokeConfig {
  configurable?: { toolCallId?: unknown };
}

export function buildQuizReviewTool(ctx: QuizReviewToolContext) {
  return tool(
    async (input: z.infer<typeof reviewInputSchema>, config?: QuizInvokeConfig): Promise<string> => {
      const toolCallId =
        typeof config?.configurable?.toolCallId === "string"
          ? config.configurable.toolCallId
          : "";
      const result = gradeQuizAnswers(ctx.db, ctx.sessionId, toolCallId, input);
      return renderReviewResult(result);
    },
    {
      name: QUIZ_REVIEW_TOOL_NAME,
      description: REVIEW_DESCRIPTION,
      schema: reviewInputSchema,
    }
  );
}

/**
 * Appended to the system prompt while the conversation has the quiz widget installed.
 *
 * Model input, so deliberately English and untranslated — the same discipline
 * `PLAN_GUIDANCE` and the quiz tool-result strings follow. It carries the protocol the tool
 * descriptions cannot enforce on their own: judge and record after every quiz, recognise a
 * make-up answer by its quiz_id, and never turn one into a new quiz.
 */
export const QUIZ_GUIDANCE = [
  "This conversation has a quiz panel: quizzes you set with ila_quiz are saved there, per question, with the verdicts you record.",
  "",
  "Rhythm:",
  "- When the user answers an ila_quiz, judge every question against the reference_answer/explanation the quiz result carries (when you supplied them — the user never saw them) and call ila_review_quiz once with each question's exact quiz_id, verdict (correct / incorrect / unsure) and a short explanation in the user's language — EVERY question gets one, correct answers included: briefly reinforce why the picked option is right, never just \"correct\". Make the grading call, and any ila_update_plan_progress the chapter warrants, before writing prose, then walk each question through in your FINAL message after the tool results — its Qn label, verdict and a brief why — so an all-correct quiz is a per-question rundown, not a one-line congratulations.",
  "- A later user message that quotes a quiz_id and says it is a make-up answer (补答) — for a question the user skipped or cancelled without answering — is that SAME question being answered late; a system note on that turn carries the grading key when one was given. Grade just that question through ila_review_quiz with the quoted id — never call ila_quiz for it, and never present it as a new question.",
  "- A follow-up message quoting a quiz_id is a question about that question, not a new quiz: answer it directly.",
  "- Only call ila_quiz to genuinely test understanding on new material; quizzes belong to the plan chapter being studied (the tool binds the current chapter automatically, or name its nodeId).",
].join("\n");
