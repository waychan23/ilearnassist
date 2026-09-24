import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  QUIZ_MAKEUP_MAX,
  QUIZ_MAKEUP_TOOL_NAME,
  type QuizAnswers,
  type QuizQuestion,
} from "@ilearnassist/shared";
import { renderPrompt } from "../prompts.js";
import { renderQuizResult, type QuizAnswerKey } from "./quiz.js";
import { Suspension } from "./suspension.js";

/**
 * The make-up card: the questions this conversation asked and the learner never answered.
 *
 * ## Why this is a tool rather than a message
 *
 * A make-up used to be a *user message* the client composed — the question, its options and the
 * learner's answer, quoted as prose — and the answer key arrived through a hidden per-turn
 * system-prompt note. That is one question per turn by construction: the message has to carry the
 * whole question, so a batch of eight is eight questions' worth of text in the transcript, replayed
 * to the model on every later turn, and a client that has to compose it is a client that has to
 * know what a question looks like. As a tool call, **the questions are the call's input and the
 * answers are its result** — the same two places every other tool's data lives — which is what
 * makes a batch the same thing as one, and what retires the prose template, the hidden note and
 * the `makeupQuizId` route field together.
 *
 * ## What it shares with `ila_quiz`
 *
 * Deliberately nearly everything, because "the interaction is like the first time" is the
 * requirement rather than a nicety:
 *
 * - The card is the **same card** — `ToolCallCard` maps this name to the quiz card, which parses
 *   `input.questions` and submits `QuizAnswers` through the same store action.
 * - The questions are recorded in the **same shape**, `{ questions: QuizQuestion[] }`, so
 *   `readQuizQuestions` parses them and `validateQuizAnswers` is the trust boundary — one reader
 *   and one validator, not a second pair that could drift.
 * - The result is `renderQuizResult`'s own output, so the model grades a make-up with the
 *   instruction it already has for a quiz, and the answer key returns in the result exactly as it
 *   does after a live answer.
 *
 * ## What is different, and it is the whole point
 *
 * The questions are **already rows**, so the model supplies ids and never text: it cannot reword a
 * question, change an option, or invent one. `selectQuestions` reads the conversation's own
 * unanswered questions and refuses an id that is not one of them. The tool also does not register
 * anything and writes nothing — the rows stay `skipped`/`dismissed` while the card is live, so a
 * crashed card costs nothing and the questions are still make-up-eligible afterwards.
 */

/**
 * The one thing the tool needs, and it is a reader.
 *
 * A callback rather than the database, the `QuizToolContext` split: the tool owns the contract
 * (which questions, refused how loudly) and `quizzes.ts` owns the selection (which statuses are
 * eligible, ordered how). `selectQuestions` throws for a named id that is not an unanswered
 * question of this conversation, which the loop turns into a `Tool error:` the model can correct
 * inside the same turn.
 */
export interface MakeupQuizToolContext {
  selectQuestions(ids?: string[]): QuizQuestion[];
}

/** What the card is re-rendered from after a reload — the recorded questions, and no key. */
export class MakeupQuizSuspension extends Suspension {
  readonly questions: QuizQuestion[];

  constructor(questions: QuizQuestion[]) {
    super(
      "MakeupQuizSuspension",
      `ila_makeup_quiz: suspended awaiting the user (${questions.length} question(s))`,
      { questions }
    );
    this.questions = questions;
  }
}

/**
 * The tool's description, in the voice of `ila_quiz`'s and `ila_review_quiz`'s.
 *
 * It has to carry three things the model cannot infer: that this *is* the answer to "the learner
 * never answered that", that a partial answer is allowed, and that an id it made up is refused. It
 * is also where the requirement's own ask lands — that the description tells the model the tool is
 * for bringing the learner back to questions they skipped.
 */
const DESCRIPTION = [
  "Bring back quiz questions the user never answered — the make-up (补答) card — and stop this turn",
  "until they answer. It looks and behaves exactly like a fresh quiz: the same card, the same",
  "options, one submit for the whole set.",
  "",
  "Use it when the conversation has questions the learner skipped (they walked away mid-quiz, or",
  "sent a new message instead of answering) or cancelled with the quiz, and answering them now is",
  "worth a turn: you have taught past the gap, they asked what they missed, or they want to be",
  "tested on something already asked and never answered.",
  "",
  "The card allows a partial answer. Whatever they leave unanswered stays unanswered and can be",
  "brought back later — it is reported in the result, so do not grade it.",
  "",
  "This tool never creates a question and never changes one that was answered. An answered question",
  "is not make-up-eligible, and neither is one still waiting in a live quiz card: to ask about",
  "something new, check what has already been asked with ila_query (kind \"quiz\") and write a",
  "genuinely different question with ila_quiz.",
  "",
  "Call it with no id to bring back every unanswered question in this conversation, or name the ones",
  "you want with quiz_ids (the global ids ila_query kind \"quiz\" returns, not the Qn labels). An id",
  "that is not an unanswered question of this conversation is refused, and more than",
  `${QUIZ_MAKEUP_MAX} at once is refused: name them in batches instead.`,
  "",
  "This ends the turn, like ila_quiz. The answers come back as the tool result, each with its",
  `quiz_id and — for the ones you posed with a key — the reference answer. Grade them exactly as you`,
  "grade a fresh quiz: ONE ila_review_quiz call with each answered quiz_id, then the per-question",
  "rundown in your final message.",
].join("\n");

const inputSchema = z.object({
  quiz_ids: z
    .array(z.string().min(1).max(100))
    .max(QUIZ_MAKEUP_MAX)
    .optional()
    .describe(
      "The global quiz_ids to bring back, as ila_query (kind \"quiz\") returned them — not the Qn " +
        "labels. Omit to include every question this conversation asked and the user has not " +
        "answered."
    ),
});

export function buildMakeupQuizTool(ctx: MakeupQuizToolContext) {
  return tool(
    async (input: { quiz_ids?: string[] }) => {
      const questions = ctx.selectQuestions(input.quiz_ids);

      /*
       * Nothing to make up is a *result*, not an empty card. A card with no questions in it is a
       * control that does nothing, and the model needs to hear this as much as the learner: it
       * asked to bring something back that does not exist, and its next move should be different.
       */
      if (questions.length === 0) {
        return JSON.stringify(
          {
            outcome: "nothing_to_make_up",
            note:
              "Every question this conversation has asked has been answered or is still waiting in " +
              "a live quiz card. There is nothing to bring back — do not ask these questions again; " +
              "write a new one with ila_quiz if the learner wants more practice.",
          },
          null,
          2
        );
      }

      /*
       * Over the cap: refused rather than truncated, and the model is told what to do about it.
       * Silently taking the first twenty would leave it believing it had brought back all of them,
       * and the learner with a card that is missing questions nobody said were missing.
       */
      if (questions.length > QUIZ_MAKEUP_MAX) {
        throw new Error(
          `ila_makeup_quiz: this conversation has ${questions.length} unanswered questions, and one ` +
            `card may hold at most ${QUIZ_MAKEUP_MAX}. Name the ones to bring back with quiz_ids ` +
            `(ila_query kind "quiz" lists them), or bring them back in batches.`
        );
      }

      throw new MakeupQuizSuspension(questions);
    },
    { name: QUIZ_MAKEUP_TOOL_NAME, description: DESCRIPTION, schema: inputSchema }
  );
}

/**
 * The tool's result: `ila_quiz`'s own, over the questions that were answered, plus the ones the
 * learner passed over.
 *
 * The second half is not decoration. A partial answer is allowed, and without this the questions
 * left unanswered are simply *absent* from the result — so "do not grade the ones they skipped" is
 * an instruction with nothing to apply it to, and the model's only clue would be an empty
 * `selected: []`, which is also what a malformed answer would look like. Naming them makes the
 * card's own arithmetic visible: what was written, and what is still open.
 *
 * It is composed here rather than by extending `renderQuizResult`, because everything in that
 * function's output is a fact about a quiz the model asked; this is the one thing that is a fact
 * about a *make-up*, and the live path has no use for it.
 */
export function renderMakeupResult(
  questions: QuizQuestion[],
  answers: QuizAnswers,
  keys: ReadonlyMap<string, QuizAnswerKey>
): string {
  const written = questions.filter((question) => answers[question.id] !== undefined);
  const left = questions.filter((question) => answers[question.id] === undefined);

  const rendered = JSON.parse(
    renderQuizResult(written, answers, "submit", keys)
  ) as Record<string, unknown>;

  if (left.length > 0) {
    rendered.left_unanswered = left.map((question) => ({
      id: question.id,
      quiz_id: question.uid ?? question.id,
      question: question.question,
    }));
  }
  return JSON.stringify(rendered, null, 2);
}

/**
 * The positive half of the tool: what this conversation's unanswered questions are for, and when
 * bringing them back is worth a turn.
 *
 * A function rather than a constant, and read at call time: the catalog is patched by the process
 * entry point, so a module-level string would be the bundled text for the process's whole life and
 * a tuned prompt would silently do nothing — `quizGuidance()`'s reason verbatim.
 */
export function makeupGuidance(): string {
  return renderPrompt("chat.guidance.makeupCard");
}
