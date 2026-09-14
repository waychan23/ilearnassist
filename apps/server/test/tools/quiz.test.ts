import { describe, expect, it, vi } from "vitest";
import {
  QUIZ_NOTES_MAX,
  QUIZ_UNSURE_REASON_MAX,
  type AnswerToolCallInput,
  type QuizAnswers,
  type QuizQuestion,
  type QuizQuestionInput,
  type ToolCall,
} from "@ilearnassist/shared";
import {
  QuizSuspension,
  buildQuizTool,
  readQuizQuestions,
  redactQuizInput,
  renderQuizResult,
  validateQuizAnswers,
  type QuizRegisterInput,
} from "../../src/tools/quiz.js";
import { Suspension } from "../../src/tools/suspension.js";

/**
 * The `quiz` contract, from both ends: what the model is allowed to ask, and what the client
 * is allowed to answer with.
 *
 * Both are enforced before anything reaches the UI. A malformed question set fails the
 * tool's own schema and never becomes a card; a malformed submission fails validation and
 * never becomes a tool result the model reads as the user's own words.
 *
 * Numbering is the third thing here and the only one with no `ask_user` counterpart: the ids
 * come from a counter the caller supplies, so the tests supply one too.
 */

/** A reserve that hands out `count` consecutive numbers from `start`. */
const numbering =
  (start: number) =>
  (count: number): number[] =>
    Array.from({ length: count }, (_, i) => start + i);

/** A registration stand-in: one deterministic uid per numbered question. */
const register = (input: QuizRegisterInput) =>
  input.items.map((item) => ({ uid: `uid-${item.qid}`, qid: item.qid }));

const tool = (start = 1) =>
  buildQuizTool({ reserveQuestionNumbers: numbering(start), registerQuestions: register });

const option = (label: string) => ({ label });

const question = (overrides: Partial<QuizQuestionInput> = {}): QuizQuestionInput => ({
  header: "窗口",
  question: "Flink 有哪几种窗口？",
  options: [option("滚动"), option("滑动")],
  ...overrides,
});

/** Deliberately untyped: most of these cases are shapes the schema is meant to reject. */
const ask = (questions: unknown, start = 1) => tool(start).invoke({ questions } as never);

/** The suspension a call produced, or a thrown failure — the tool's only two outcomes. */
const suspend = async (questions: unknown, start = 1): Promise<QuizSuspension> => {
  const err = await ask(questions, start).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(QuizSuspension);
  return err as QuizSuspension;
};

describe("quiz schema", () => {
  it("accepts a well-formed question and suspends the turn with it", async () => {
    const questions = [question()];

    // The suspension is the tool's *success* path: reaching this means the questions were
    // valid, and the only thing left to do is number them and stop.
    const err = await suspend(questions);
    expect(err.questions[0]).toEqual({ ...questions[0], id: "Q1", uid: "uid-Q1" });
  });

  it("registers the numbered questions and gives each back a global uid", async () => {
    const registerQuestions = vi.fn(register);
    const built = buildQuizTool({
      reserveQuestionNumbers: numbering(1),
      registerQuestions,
    });
    const err = await built
      .invoke({ nodeId: "node-7", questions: [question(), question({ header: "状态" })] } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuizSuspension);

    // One call for the whole quiz: the Qn, its numeric position, and the model's node
    // binding travel together, so the rows and the numbering cannot disagree.
    expect(registerQuestions).toHaveBeenCalledTimes(1);
    const arg = registerQuestions.mock.calls[0]![0];
    expect(arg.modelNodeId).toBe("node-7");
    expect(arg.items.map((i) => [i.qid, i.position])).toEqual([
      ["Q1", 1],
      ["Q2", 2],
    ]);
    expect((err as QuizSuspension).questions.map((q) => q.uid)).toEqual(["uid-Q1", "uid-Q2"]);
  });

  it("surfaces a registration failure as a tool error, not a suspension", async () => {
    const built = buildQuizTool({
      reserveQuestionNumbers: numbering(1),
      registerQuestions: () => {
        throw new Error("ila_quiz: node x is not a live node in this conversation's plan");
      },
    });
    await expect(built.invoke({ questions: [question()] } as never)).rejects.toThrow(
      /not a live node/
    );
  });

  it("is a Suspension, so the loop's one arm catches it without knowing the tool", async () => {
    // The loop matches on the base class rather than on `QuizSuspension` by name, which is
    // what lets a third suspending tool be added without touching `runAgentStream`.
    expect(await suspend([question()])).toBeInstanceOf(Suspension);
  });

  it("numbers the questions consecutively from the counter it was given", async () => {
    // From 5, so a passing test cannot be an id derived from the question's position.
    const err = await suspend([question(), question({ header: "状态" })], 5);
    expect(err.questions.map((q) => q.id)).toEqual(["Q5", "Q6"]);
  });

  it("records the numbered questions as the input to persist", async () => {
    // The card is re-rendered from the persisted `input`, and the loop stringifies the
    // model's arguments before invoking the tool — so this is the only way the ids reach it.
    const err = await suspend([question(), question({ header: "状态" })]);
    expect(err.recordedInput).toEqual({
      questions: err.questions,
    });
    expect((err.recordedInput?.questions as QuizQuestion[])[1]!.id).toBe("Q2");
  });

  it("reserves nothing when the question set is malformed", async () => {
    // Validation runs before the body, which is what keeps a rejected call from burning
    // counter numbers. An empty set is the simplest malformed one.
    const reserve = vi.fn(numbering(1));
    const registerQuestions = vi.fn(register);
    await expect(
      buildQuizTool({ reserveQuestionNumbers: reserve, registerQuestions }).invoke({
        questions: [],
      } as never)
    ).rejects.toThrow(/did not match expected schema/);
    expect(reserve).not.toHaveBeenCalled();
    expect(registerQuestions).not.toHaveBeenCalled();
  });

  it("fails loudly when the context reserves the wrong number of ids", async () => {
    // Two questions sharing one id would be one answer slot for two questions, and a card
    // cannot show that. A tool error is louder than a duplicate id on screen.
    const short = buildQuizTool({
      reserveQuestionNumbers: () => [1],
      registerQuestions: register,
    });
    const err = await short
      .invoke({ questions: [question(), question({ header: "状态" })] } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(QuizSuspension);
    expect((err as Error).message).toMatch(/no question number was reserved/);
  });

  it("rejects an empty question list", async () => {
    await expect(ask([])).rejects.toThrow(/did not match expected schema/);
  });

  it("rejects more questions than the card can tab through", async () => {
    await expect(ask(new Array(11).fill(question()))).rejects.toThrow(
      /did not match expected schema/
    );
  });

  it("rejects a question with too few choices to be a choice", async () => {
    await expect(ask([question({ options: [option("Only one")] })])).rejects.toThrow(
      /did not match expected schema/
    );
  });

  it("rejects a question with more choices than the alphabet the card letters", async () => {
    const options = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(option);
    await expect(ask([question({ options })])).rejects.toThrow(/did not match expected schema/);
  });

  it("rejects duplicate option labels", async () => {
    // Two identical labels are two choices the user cannot tell apart, and an answer that
    // cannot say which one was meant.
    await expect(
      ask([question({ options: [option("Same"), option("Same")] })])
    ).rejects.toThrow(/unique/);
  });

  it("rejects an empty label", async () => {
    await expect(ask([question({ options: [option(""), option("B")] })])).rejects.toThrow(
      /did not match expected schema/
    );
  });

  it("rejects a tab label longer than the strip allows", async () => {
    await expect(ask([question({ header: "x".repeat(13) })])).rejects.toThrow(
      /did not match expected schema/
    );
  });

  it("accepts a mixed set, where one question is multi-select and the rest are not", async () => {
    // The mode is per question, not per call — so a quiz may mix them.
    const err = await suspend([question(), question({ header: "状态", multiSelect: true })]);
    expect(err.questions[0]!.multiSelect).toBeUndefined();
    expect(err.questions[1]!.multiSelect).toBe(true);
  });
});

describe("quiz answer key", () => {
  const keyed = () =>
    question({
      referenceAnswer: ["滑动"],
      explanation: "滑动窗口才会按滑动步长触发。",
    });

  it("passes the key to registration, but strips it from the suspension the client sees", async () => {
    const registerQuestions = vi.fn(register);
    const built = buildQuizTool({
      reserveQuestionNumbers: numbering(1),
      registerQuestions,
    });
    const err = await built
      .invoke({ questions: [keyed()] } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuizSuspension);

    // The row keeps the key — it is what grading reads after the answer comes back.
    const item = registerQuestions.mock.calls[0]![0].items[0]!;
    expect(item.referenceAnswer).toEqual(["滑动"]);
    expect(item.explanation).toMatch(/滑动窗口/);

    // Everything that re-renders the card is clean: the thrown questions and the recorded
    // input both omit the fields, so the answer cannot leak before it is answered.
    const suspension = err as QuizSuspension;
    expect(suspension.questions[0]).not.toHaveProperty("referenceAnswer");
    expect(suspension.questions[0]).not.toHaveProperty("explanation");
    const recorded = JSON.stringify(suspension.recordedInput);
    expect(recorded).not.toMatch(/referenceAnswer|滑动窗口才会/);
  });

  it("rejects a reference answer that names an option never offered", async () => {
    // A key the answer could never match would grade every real choice wrong.
    await expect(
      ask([question({ referenceAnswer: ["不存在的选项"] })])
    ).rejects.toThrow(/referenceAnswer must name options that were offered/);
  });

  it("accepts a question posed without any key", async () => {
    const err = await suspend([question()]);
    expect(err.questions[0]).not.toHaveProperty("referenceAnswer");
  });

  it("redacts the key from a raw tool call the client receives while it runs", () => {
    const raw = JSON.stringify({
      questions: [
        {
          header: "窗口",
          question: "Flink 有哪几种窗口？",
          options: [{ label: "滚动" }, { label: "滑动" }],
          referenceAnswer: ["滑动"],
          explanation: "secret analysis",
        },
      ],
    });

    const redacted = redactQuizInput(raw);
    expect(redacted).not.toMatch(/referenceAnswer|secret analysis/);
    // The rest of the call is untouched, so the card still renders the question.
    expect(JSON.parse(redacted).questions[0].options).toHaveLength(2);
  });

  it("leaves non-quiz JSON and malformed input alone", () => {
    expect(redactQuizInput("not json")).toBe("not json");
    expect(redactQuizInput(JSON.stringify({ something: 1 }))).toBe(
      JSON.stringify({ something: 1 })
    );
  });
});

describe("quiz description", () => {
  const description = tool().description;

  it("keeps the answer out of the question", () => {
    // Nothing in the schema can express this, so the sentence is the whole mechanism: a
    // question with its answer in it measures nothing.
    expect(description).toMatch(/Never reveal the answer/);
    expect(description).toMatch(/not in an option's description/);
  });

  it("tells the model to write plain labels, because the client letters them", () => {
    expect(description).toMatch(/no letter in front of them/);
    expect(description).toMatch(/renders A, B, C/);
  });

  it("tells the model not to offer its own unsure or other choice", () => {
    // The schema cannot forbid a *label* that reads "I don't know" — only persuasion can —
    // and the client appends a real one to every question. A model that spent a slot on it
    // would be offering a control with nothing behind it.
    expect(description).toMatch(/Do not offer your own/);
    expect(description).toMatch(/the client appends one to every question automatically/);
  });

  it("tells the model it does not choose the ids", () => {
    expect(description).toMatch(/Do not invent or pass ids/);
    expect(description).toMatch(/session-scoped id/);
    expect(description).toMatch(/you can refer to a question by id later/);
  });

  it("draws the boundary against ask_user", () => {
    // The two tools overlap — both ask the user something mid-turn — and the difference is
    // the whole reason they are separate: one gathers a decision, the other measures
    // understanding. A model that conflates them asks permission with options.
    expect(description).toMatch(/it does not ask permission/);
    expect(description).toMatch(/that is ask_user/);
  });

  it("permits other tools in the same step, and still forbids a second quiz", () => {
    // The runtime runs a step's other calls *before* suspending, so the description states
    // the ordering rather than forbidding something the engine does. The once-per-step rule
    // is the guard that is real — two live question sets is a state the UI cannot show.
    expect(description).toMatch(/any other tool calls in that step still run first/);
    expect(description).toMatch(/Do not call it more than once per step/);
  });

  it("asks the model to respond to the notes and the unsure answers", () => {
    // Those are the parts a quiz exists to surface; a model that only reacts to right and
    // wrong has learnt the least interesting half.
    expect(description).toMatch(/treat those as the most informative part/);
  });
});

describe("validateQuizAnswers", () => {
  const questions: QuizQuestion[] = [
    { ...question(), id: "Q1" },
    { ...question({ header: "状态", options: [option("RocksDB"), option("内存")] }), id: "Q2" },
  ];

  const multi: QuizQuestion[] = [
    { ...question({ multiSelect: true }), id: "Q1" },
    { ...question({ header: "状态", options: [option("RocksDB"), option("内存")] }), id: "Q2" },
  ];

  const submit = (answers: Record<string, unknown>) =>
    validateQuizAnswers(questions, {
      toolCallId: "c1",
      action: "submit",
      answers,
    } as unknown as AnswerToolCallInput);

  it("accepts a complete submission, keyed by question id", () => {
    const result = submit({ Q1: { selected: ["滚动"] }, Q2: { selected: ["RocksDB"] } });
    expect(result).toEqual({
      ok: true,
      answers: { Q1: { selected: ["滚动"] }, Q2: { selected: ["RocksDB"] } },
    });
  });

  it("rejects a submission keyed by position, which is ask_user's shape", () => {
    // The two tools key differently on purpose, and this is the boundary that catches a
    // client which sent one tool's payload to the other.
    const result = submit({ 0: { selected: ["滚动"] }, 1: { selected: ["RocksDB"] } });
    expect(result).toMatchObject({ ok: false });
  });

  it("accepts unsure on its own, with the reason the user gave", () => {
    const result = submit({
      Q1: { selected: [], unsure: true, unsureReason: "  没听过这个词  " },
      Q2: { selected: ["内存"] },
    });

    expect(result).toEqual({
      ok: true,
      answers: { Q1: { selected: [], unsure: true, unsureReason: "没听过这个词" }, Q2: { selected: ["内存"] } },
    });
  });

  it("rejects an answer that is both unsure and a choice", () => {
    // The card clears one when the other is picked; this is the enforcement that matters,
    // because the card is not the boundary and the two are different claims.
    const result = submit({ Q1: { selected: ["滚动"], unsure: true }, Q2: { selected: ["内存"] } });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/cannot be both unsure and a choice/);
  });

  it("rejects notes with nothing selected and no unsure", () => {
    // Notes are optional, so they cannot be the thing that makes a question answered —
    // "unsure" is the escape hatch for having no choice to give.
    const result = submit({ Q1: { selected: [], notes: "有点印象" }, Q2: { selected: ["内存"] } });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/has no answer/);
  });

  it("carries notes alongside a choice, without inventing an unsure", () => {
    const result = submit({
      Q1: { selected: ["滚动"], notes: "  不确定是不是这个  " },
      Q2: { selected: ["内存"] },
    });

    expect(result).toEqual({
      ok: true,
      answers: { Q1: { selected: ["滚动"], notes: "不确定是不是这个" }, Q2: { selected: ["内存"] } },
    });
  });

  it("drops a reason given on a question that was not unsure", () => {
    // A reason on an answered question is free text with nothing to attach it to.
    const result = submit({
      Q1: { selected: ["滚动"], unsureReason: "随便写的" },
      Q2: { selected: ["内存"] },
    });

    expect(result).toMatchObject({ ok: true });
    expect((result as { answers: QuizAnswers }).answers.Q1).not.toHaveProperty("unsureReason");
  });

  it("rejects a label the model never offered", () => {
    // The answer is replayed to the model as the user's own words, so this is where the
    // client stops being able to put arbitrary text in their mouth.
    const result = submit({ Q1: { selected: ["别的"] }, Q2: { selected: ["内存"] } });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/never offered/);
  });

  it("rejects a submission that skips a question", () => {
    expect(submit({ Q1: { selected: ["滚动"] } })).toMatchObject({ ok: false });
  });

  it("rejects two choices for a single-select question", () => {
    const result = submit({ Q1: { selected: ["滚动", "滑动"] }, Q2: { selected: ["内存"] } });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/single choice/);
  });

  it("accepts two choices for a multi-select question", () => {
    const result = validateQuizAnswers(multi, {
      toolCallId: "c1",
      action: "submit",
      answers: { Q1: { selected: ["滚动", "滑动"] }, Q2: { selected: ["内存"] } },
    } as unknown as AnswerToolCallInput);

    expect(result).toEqual({
      ok: true,
      answers: { Q1: { selected: ["滚动", "滑动"] }, Q2: { selected: ["内存"] } },
    });
  });

  it("accepts a single choice on a multi-select question", () => {
    // "Multi" means as many as apply, not several: one is a legitimate answer, which is why
    // the arity rule is a ceiling rather than a floor.
    const result = validateQuizAnswers(multi, {
      toolCallId: "c1",
      action: "submit",
      answers: { Q1: { selected: ["滚动"] }, Q2: { selected: ["内存"] } },
    } as unknown as AnswerToolCallInput);

    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a reason longer than the cap", () => {
    const result = submit({
      Q1: { selected: [], unsure: true, unsureReason: "x".repeat(QUIZ_UNSURE_REASON_MAX + 1) },
      Q2: { selected: ["内存"] },
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/reason for question Q1 is too long/);
  });

  it("rejects notes longer than the cap", () => {
    const result = submit({
      Q1: { selected: ["滚动"], notes: "x".repeat(QUIZ_NOTES_MAX + 1) },
      Q2: { selected: ["内存"] },
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/notes for question Q1 are too long/);
  });

  it("accepts a cancel without any answers", () => {
    const result = validateQuizAnswers(questions, {
      toolCallId: "c1",
      action: "cancel",
    } as AnswerToolCallInput);

    expect(result).toEqual({ ok: true, answers: {} });
  });

  it("ignores an answer key that belongs to no question", () => {
    const result = submit({
      Q1: { selected: ["滚动"] },
      Q2: { selected: ["内存"] },
      Q9: { selected: ["nonsense"] },
    });

    expect(result).toMatchObject({ ok: true });
    expect((result as { answers: object }).answers).not.toHaveProperty("Q9");
  });
});

describe("renderQuizResult", () => {
  const questions: QuizQuestion[] = [{ ...question(), id: "Q1" }];

  it("carries the id, which is the one thing the model could not reconstruct", () => {
    const rendered = renderQuizResult(questions, { Q1: { selected: ["滚动"] } }, "submit");

    expect(JSON.parse(rendered)).toEqual({
      // No uid on a legacy question: quiz_id falls back to the Qn.
      user_answers: [
        {
          id: "Q1",
          quiz_id: "Q1",
          question: "Flink 有哪几种窗口？",
          selected: ["滚动"],
        },
      ],
    });
  });

  it("uses the global uid as quiz_id when the question was registered", () => {
    const withUid: QuizQuestion[] = [{ ...question(), id: "Q1", uid: "uuid-123" }];
    const rendered = renderQuizResult(withUid, { Q1: { selected: ["滚动"] } }, "submit");
    expect(JSON.parse(rendered).user_answers[0].quiz_id).toBe("uuid-123");
  });

  it("omits the optional fields rather than sending empty strings", () => {
    const rendered = renderQuizResult(
      questions,
      { Q1: { selected: ["滚动"] } },
      "submit"
    );
    expect(JSON.parse(rendered).user_answers[0]).not.toHaveProperty("notes");
    expect(JSON.parse(rendered).user_answers[0]).not.toHaveProperty("unsure");
  });

  it("reports an unsure answer as unsure, with its reason and its notes", () => {
    const rendered = renderQuizResult(
      questions,
      { Q1: { selected: [], unsure: true, unsureReason: "题目有歧义", notes: "想再确认一下" } },
      "submit"
    );

    expect(JSON.parse(rendered).user_answers[0]).toEqual({
      id: "Q1",
      quiz_id: "Q1",
      question: "Flink 有哪几种窗口？",
      selected: [],
      unsure: true,
      unsure_reason: "题目有歧义",
      notes: "想再确认一下",
    });
  });

  it("leaves an unanswered question visible rather than dropping it", () => {
    const rendered = renderQuizResult(questions, {}, "submit");

    expect(JSON.parse(rendered).user_answers).toHaveLength(1);
    expect(JSON.parse(rendered).user_answers[0].selected).toEqual([]);
  });

  it("hands the answer key back with a submitted answer, for grading", () => {
    // The one moment the key is visible to the model: the resumed tool result. It comes
    // from the quiz rows (keyed by Qn), not from the persisted call.
    const keys = new Map([
      ["Q1", { referenceAnswer: ["滚动", "滑动"], explanation: "窗口只有这两类" }],
    ]);
    const rendered = renderQuizResult(
      questions,
      { Q1: { selected: ["滚动"] } },
      "submit",
      keys
    );

    expect(JSON.parse(rendered).user_answers[0]).toMatchObject({
      reference_answer: ["滚动", "滑动"],
      explanation: "窗口只有这两类",
    });
  });

  it("omits key fields that were not supplied, and never carries them on a cancel", () => {
    const keys = new Map([["Q1", { referenceAnswer: null, explanation: null }]]);
    const submitted = JSON.parse(
      renderQuizResult(questions, { Q1: { selected: ["滚动"] } }, "submit", keys)
    );
    expect(submitted.user_answers[0]).not.toHaveProperty("reference_answer");
    expect(submitted.user_answers[0]).not.toHaveProperty("explanation");

    const fullKeys = new Map([
      ["Q1", { referenceAnswer: ["滑动"], explanation: "analysis" }],
    ]);
    const cancelled = JSON.parse(
      renderQuizResult(questions, {}, "cancel", fullKeys)
    );
    // A dismissed question was never answered, so its key stays hidden.
    expect(JSON.stringify(cancelled)).not.toMatch(/reference_answer|analysis/);
  });

  it("tells the model plainly when the user dismissed the quiz", () => {
    // A cancelled quiz has no `user_answers` at all, so the note is the only thing stopping
    // the model from reading "no answer" as an empty one and re-asking the same questions.
    const parsed = JSON.parse(renderQuizResult(questions, {}, "cancel")) as {
      user_answers: null;
      note: string;
    };

    expect(parsed.user_answers).toBeNull();
    expect(parsed.note).toMatch(/dismissed the quiz without answering/);
    expect(parsed.note).toMatch(/Do not present the same questions again/);
  });
});

describe("readQuizQuestions", () => {
  const call = (input: unknown): ToolCall => ({
    id: "c1",
    name: "ila_quiz",
    input: typeof input === "string" ? input : JSON.stringify(input),
  });

  it("reads back the numbered questions a suspended call recorded", () => {
    const questions = [{ ...question(), id: "Q1" }];
    expect(readQuizQuestions(call({ questions }))).toEqual(questions);
  });

  it("refuses a set whose questions share an id", () => {
    // Two questions with one id is one answer slot for two questions, with no error
    // anywhere to say so. The caller turns this into the same 409 as a stale question.
    const questions = [
      { ...question(), id: "Q1" },
      { ...question({ header: "状态" }), id: "Q1" },
    ];
    expect(readQuizQuestions(call({ questions }))).toBeUndefined();
  });

  it("refuses a set with a missing or empty id", () => {
    expect(readQuizQuestions(call({ questions: [question()] }))).toBeUndefined();
    expect(readQuizQuestions(call({ questions: [{ ...question(), id: "" }] }))).toBeUndefined();
  });

  it("refuses an empty set and a stored input that is not JSON", () => {
    expect(readQuizQuestions(call({ questions: [] }))).toBeUndefined();
    expect(readQuizQuestions(call("not json"))).toBeUndefined();
  });
});
