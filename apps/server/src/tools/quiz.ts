import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  QUIZ_HEADER_MAX,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MIN_OPTIONS,
  QUIZ_NOTES_MAX,
  QUIZ_TOOL_NAME,
  QUIZ_UNSURE_REASON_MAX,
  type AnswerToolCallInput,
  type QuizAnswer,
  type QuizAnswers,
  type QuizQuestion,
  type ToolCall,
} from "@ilearnassist/shared";
import { Suspension } from "./suspension.js";

export { QUIZ_TOOL_NAME };

/**
 * The counter this tool numbers its questions from.
 *
 * Exported so the name lives with the tool that owns the sequence rather than at the route
 * that happens to build the context. Nothing else may number into it: the ids in it are a
 * session's quiz questions, and a second writer would make them mean two things.
 */
export const QUIZ_QUESTION_COUNTER = "quiz_question";

/** One question as handed to the registration callback, numbered but not yet persisted. */
export interface QuizRegistrationItem {
  qid: string;
  /** The Qn number; also the quiz panel's stable ordering across a session. */
  position: number;
  header: string;
  question: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface QuizRegisterInput {
  /** The provider's tool-call id, the anchor the panel scrolls to. */
  toolCallId: string;
  /** The plan node the model named; undefined means "bind the current chapter". */
  modelNodeId?: string;
  items: QuizRegistrationItem[];
}

export interface QuizRegisteredQuestion {
  /** The question's GLOBAL id (database UUID), distinct from its session-scoped Qn. */
  uid: string;
  qid: string;
}

/**
 * What the tool needs from the turn it is running in.
 *
 * Callbacks rather than ids, because the tool must not know where a number or a database
 * comes from — the agent loop holds no database by design, and which store is authoritative
 * belongs to whoever can read one. `count` is reserved as a single block so a quiz's ids
 * are consecutive rather than merely distinct. `registerQuestions` persists the questions
 * (with their global uids) the moment the quiz suspends, before the user answers.
 */
export interface QuizToolContext {
  reserveQuestionNumbers(count: number): number[];
  registerQuestions(input: QuizRegisterInput): QuizRegisteredQuestion[];
}

/** The invoke config the loop stamps the provider's tool-call id into (see plan tools). */
interface QuizInvokeConfig {
  configurable?: { toolCallId?: unknown };
}

/**
 * Thrown by `quiz` to suspend the turn until the user answers.
 *
 * Control flow rather than failure — `Suspension` owns that reasoning and the loop's arm.
 * What this class adds is the numbering: the tool assigns the ids because it is the only
 * thing positioned to reach the counter, and `recordedInput` is how they reach the persisted
 * tool call that the card is re-rendered from.
 */
export class QuizSuspension extends Suspension {
  readonly questions: QuizQuestion[];

  constructor(questions: QuizQuestion[]) {
    super(
      "QuizSuspension",
      `ila_quiz: suspended awaiting the user (${questions.length} question(s))`,
      { questions }
    );
    this.questions = questions;
  }
}

const optionSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(80)
    .describe("The choice, as the user should read it, with no letter in front of it."),
  description: z
    .string()
    .max(200)
    .optional()
    .describe("One sentence on what picking this implies. Optional."),
});

const questionSchema = z.object({
  header: z
    .string()
    .min(1)
    .max(QUIZ_HEADER_MAX)
    .describe(`Tab label, at most ${QUIZ_HEADER_MAX} characters.`),
  question: z.string().min(1).max(500).describe("The full question, ending in a question mark."),
  multiSelect: z
    .boolean()
    .optional()
    .describe('True to let the user tick several options. Omit for a single choice.'),
  options: z
    .array(optionSchema)
    .min(QUIZ_MIN_OPTIONS)
    .max(QUIZ_MAX_OPTIONS)
    .refine(
      (opts) => new Set(opts.map((o) => o.label)).size === opts.length,
      "Option labels must be unique within a question."
    )
    .describe(`${QUIZ_MIN_OPTIONS}–${QUIZ_MAX_OPTIONS} distinct choices.`),
});

const inputSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "The plan node these questions check, by the opaque id ila_read_plan returned. Omit it to " +
        "bind the quiz to the chapter currently in progress. Only use it when the quiz is " +
        "about a specific node."
    ),
  questions: z
    .array(questionSchema)
    .min(1)
    .max(QUIZ_MAX_QUESTIONS)
    .describe(`1–${QUIZ_MAX_QUESTIONS} questions, shown one at a time as tabs.`),
});

const DESCRIPTION = [
  "Put a short quiz to the user — multiple-choice questions that check what landed — and stop this turn until they answer.",
  "",
  `Use it when you have just explained or taught something and want to find out whether it was understood, when the user asks to be tested, or when you need to place their level before teaching the next thing. Ask 1–${QUIZ_MAX_QUESTIONS} questions in one call; they are presented one at a time as tabs with a single submit at the end. Each question is single-choice, or multiple-choice with "multiSelect": true.`,
  "",
  "This checks understanding; it does not ask permission. If you need a choice in order to continue, or you need the user to approve something you made, that is ask_user.",
  "",
  "Rules:",
  "- Never reveal the answer: not in the question, not in an option's label, and not in an option's description. A question with its answer in it measures nothing.",
  '- Write plain option labels with no letter in front of them — the client renders A, B, C… from the order you list them.',
  '- Do not offer your own "I don\'t know", "unsure" or "Other" choice: the client appends one to every question automatically, along with a box for the user to explain it or add their own take.',
  "- Do not invent or pass ids: the tool assigns each question a session-scoped id (Q1, Q2, …) AND a global quiz_id, both returned in the result, so you can refer to a question by id later.",
  "- Make every option one a person who half-understood would plausibly pick. A filler choice makes a quiz easier without making it informative.",
  "- Do not call it more than once per step. It ends the step; any other tool calls in that step still run first.",
  "",
  "The answers come back as the tool result, each with its question id and quiz_id. A question the user marked unsure — with their reason — and anything they wrote in the notes come back too: treat those as the most informative part, and respond to them rather than only to what was right or wrong.",
  "After judging the answers, call ila_review_quiz ONCE with each question's exact quiz_id, a verdict (correct / incorrect / unsure) and a short explanation in the user's language; then give the rundown in your reply. The quiz panel reads those verdicts.",
  "The user may also answer, in a later message that quotes the quiz_id, a question they originally did not answer (they skipped it or cancelled the quiz): grade that one question by its exact id through ila_review_quiz, and do NOT call ila_quiz again for it.",
  "If they dismiss the quiz instead, the result says so. Do not present the same questions again; continue with your best judgement or ask them in chat.",
].join("\n");

/**
 * The `quiz` tool.
 *
 * Its implementation only ever throws: by the time `runAgentStream` invokes it, the zod
 * schema above has already run, so reaching this body means the questions are well-formed
 * and the only thing left to do is number them, hand them to the loop and stop. An *invalid*
 * call never gets here — it fails validation and becomes an ordinary tool error, which is
 * what keeps a malformed question set from ever reaching the card.
 */
export function buildQuizTool(ctx: QuizToolContext) {
  return tool(
    async (input: z.infer<typeof inputSchema>, config?: QuizInvokeConfig): Promise<string> => {
      // The reservation happens before the suspension is thrown, so a crash between here and
      // the message being persisted burns the block. That is a gap in the numbering and never
      // a collision, and a gap is invisible because an id is only ever shown as it was issued.
      const numbers = ctx.reserveQuestionNumbers(input.questions.length);

      const numbered: { question: QuizQuestion; position: number }[] = input.questions.map(
        (question, index) => {
          const number = numbers[index];
          // A context that reserved a short block would otherwise hand two questions the same
          // id — a card with one answer slot for two questions. Louder as a tool error.
          if (number === undefined) {
            // Named as the tool the model called: this one reaches it as a `Tool error:`.
            throw new Error(`ila_quiz: no question number was reserved for question ${index}`);
          }
          return { question: { ...question, id: `Q${number}` }, position: number };
        }
      );

      // Persist the questions (with their global uids) BEFORE suspending, so the panel can
      // list even the ones the learner walks away from. The loop stamps the provider's
      // tool-call id into the invoke config, exactly as the plan progress tool reads it.
      const toolCallId =
        typeof config?.configurable?.toolCallId === "string"
          ? config.configurable.toolCallId
          : "";
      const registered = ctx.registerQuestions({
        toolCallId,
        modelNodeId: input.nodeId,
        items: numbered.map(({ question, position }) => ({
          qid: question.id,
          position,
          header: question.header,
          question: question.question,
          multiSelect: question.multiSelect,
          options: question.options,
        })),
      });

      const questions: QuizQuestion[] = numbered.map(({ question }, index) => {
        const record = registered[index];
        if (!record || record.qid !== question.id) {
          throw new Error("ila_quiz: question registration did not return the question set");
        }
        return { ...question, uid: record.uid };
      });

      throw new QuizSuspension(questions);
    },
    {
      name: QUIZ_TOOL_NAME,
      description: DESCRIPTION,
      schema: inputSchema,
    }
  );
}

/**
 * Check a client's submission against the questions that were actually asked.
 *
 * This is a trust boundary, not a formality. Whatever passes here is written into the
 * conversation and replayed to the model as the user's own answer, so the client does not
 * get to send prose: every label must be one the model offered, the question's mode decides
 * how many may be chosen, and a `submit` must leave no question unanswered. A stale browser
 * tab holding a question that has since been skipped is the ordinary way this rejects, not
 * only a hostile request.
 */
export function validateQuizAnswers(
  questions: QuizQuestion[],
  input: AnswerToolCallInput
): { ok: true; answers: QuizAnswers } | { ok: false; reason: string } {
  if (input.action === "cancel") return { ok: true, answers: {} };

  // The tool call's name selected this validator, so the payload is this tool's shape.
  const submitted = (input.answers ?? {}) as QuizAnswers;
  const answers: QuizAnswers = {};

  for (const question of questions) {
    const given = submitted[question.id];
    if (!given) return { ok: false, reason: `question ${question.id} was not answered` };

    const offered = new Set(question.options.map((o) => o.label));
    const selected = Array.isArray(given.selected) ? given.selected : [];
    if (selected.some((label) => !offered.has(label))) {
      return {
        ok: false,
        reason: `question ${question.id} chose an option that was never offered`,
      };
    }
    if (!question.multiSelect && selected.length > 1) {
      return { ok: false, reason: `question ${question.id} accepts a single choice` };
    }

    const unsure = given.unsure === true;
    if (unsure && selected.length > 0) {
      // Enforced here and not only in the card, because the two are different claims and an
      // answer that makes both cannot be read as either.
      return {
        ok: false,
        reason: `question ${question.id} cannot be both unsure and a choice`,
      };
    }
    if (selected.length === 0 && !unsure) {
      // Notes alone are not an answer — they are optional, so they cannot be the thing that
      // makes a question answered. `unsure` is the escape hatch for "I have no choice to give".
      return { ok: false, reason: `question ${question.id} has no answer` };
    }

    const unsureReason = typeof given.unsureReason === "string" ? given.unsureReason.trim() : "";
    if (unsureReason.length > QUIZ_UNSURE_REASON_MAX) {
      return { ok: false, reason: `the reason for question ${question.id} is too long` };
    }
    const notes = typeof given.notes === "string" ? given.notes.trim() : "";
    if (notes.length > QUIZ_NOTES_MAX) {
      return { ok: false, reason: `the notes for question ${question.id} are too long` };
    }

    const answer: QuizAnswer = { selected };
    if (unsure) answer.unsure = true;
    // Only ever alongside `unsure`: a reason on a question the user actually answered is
    // free text with nothing to attach it to.
    if (unsure && unsureReason) answer.unsureReason = unsureReason;
    if (notes) answer.notes = notes;
    answers[question.id] = answer;
  }

  return { ok: true, answers };
}

/**
 * The tool result the model reads.
 *
 * A tool-result string is *model input*, so it is deliberately not translated and not
 * phrased for a person — see the note in CLAUDE.md. Every question appears, including one
 * left unanswered, because dropping it would read as a question that was never asked.
 *
 * The id is always present: it is how the model refers to a question afterwards, and it is
 * the one thing here it could not have reconstructed. The option letters are deliberately
 * absent — they are a UI affordance the model never sees, so putting them here would invent
 * a vocabulary it cannot use.
 */
export function renderQuizResult(
  questions: QuizQuestion[],
  answers: QuizAnswers,
  action: "submit" | "cancel"
): string {
  if (action === "cancel") {
    return JSON.stringify(
      {
        user_answers: null,
        note: "The user dismissed the quiz without answering. Do not present the same questions again; continue with your best judgement or ask them in chat.",
      },
      null,
      2
    );
  }

  const rendered = questions.map((question) => {
    const answer = answers[question.id];
    return {
      id: question.id,
      // The GLOBAL id `ila_review_quiz` names; falls back to the Qn on a legacy call that
      // predates the quiz widget (grading it fails the lookup, since no row exists).
      quiz_id: question.uid ?? question.id,
      question: question.question,
      selected: answer?.selected ?? [],
      ...(answer?.unsure ? { unsure: true } : {}),
      ...(answer?.unsureReason ? { unsure_reason: answer.unsureReason } : {}),
      ...(answer?.notes ? { notes: answer.notes } : {}),
    };
  });

  return JSON.stringify({ user_answers: rendered }, null, 2);
}

/**
 * The question set a suspended `quiz` call recorded, or undefined when the stored `input`
 * is not one.
 *
 * Stricter than `readAskUserQuestions`, because these questions carry an id: one that is
 * missing or repeated lets two questions share a single answer slot, with no error anywhere
 * to say so. Refusing the whole set turns it into the same 409 as a question that has
 * already been answered.
 */
export function readQuizQuestions(call: ToolCall): QuizQuestion[] | undefined {
  try {
    const parsed = JSON.parse(call.input) as { questions?: unknown };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return undefined;
    const questions = parsed.questions as QuizQuestion[];
    const ids = questions.filter((q) => typeof q.id === "string" && q.id !== "").map((q) => q.id);
    if (ids.length !== questions.length || new Set(ids).size !== ids.length) return undefined;
    return questions;
  } catch {
    return undefined;
  }
}
