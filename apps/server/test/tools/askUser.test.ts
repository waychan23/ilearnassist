import { describe, expect, it } from "vitest";
import { ASK_USER_OTHER_MAX, type AskUserQuestion } from "@guided-learning/shared";
import {
  AskUserSuspension,
  buildAskUserTool,
  renderAskUserResult,
  validateAnswers,
} from "../../src/tools/askUser.js";

/**
 * The `ask_user` contract, from both ends: what the model is allowed to ask, and what the
 * client is allowed to answer with.
 *
 * Both are enforced before anything reaches the UI. A malformed question set fails the
 * tool's own schema and never becomes a card; a malformed submission fails validation and
 * never becomes a tool result the model reads as the user's own words.
 */

const tool = buildAskUserTool();

const option = (label: string) => ({ label });

const question = (overrides: Partial<AskUserQuestion> = {}): AskUserQuestion => ({
  header: "认证方式",
  question: "要用哪种认证方式？",
  options: [option("OAuth"), option("API Key")],
  ...overrides,
});

/** Deliberately untyped: most of these cases are shapes the schema is meant to reject. */
const ask = (questions: unknown) => tool.invoke({ questions } as never);

describe("ask_user schema", () => {
  it("accepts a well-formed question and suspends the turn with it", async () => {
    const questions = [question()];

    // The suspension is the tool's *success* path: reaching this means the questions were
    // valid, and the only thing left to do is hand them to the loop and stop.
    await expect(ask(questions)).rejects.toBeInstanceOf(AskUserSuspension);

    const err = await ask(questions).catch((e: unknown) => e);
    expect((err as AskUserSuspension).questions).toEqual(questions);
  });

  it("rejects an empty question list", async () => {
    await expect(ask([])).rejects.toThrow(/did not match expected schema/);
  });

  it("rejects more questions than the card can tab through", async () => {
    await expect(ask(new Array(5).fill(question()))).rejects.toThrow(
      /did not match expected schema/
    );
  });

  it("rejects a question with too few choices to be a choice", async () => {
    await expect(ask([question({ options: [option("Only one")] })])).rejects.toThrow(
      /did not match expected schema/
    );
  });

  it("rejects a question with too many choices", async () => {
    const options = ["a", "b", "c", "d", "e"].map(option);
    await expect(ask([question({ options })])).rejects.toThrow(/did not match expected schema/);
  });

  it("rejects duplicate option labels", async () => {
    // Two identical labels are two radio buttons the user cannot tell apart, and an answer
    // that cannot say which one was meant.
    await expect(ask([question({ options: [option("Same"), option("Same")] })])).rejects.toThrow(
      /unique/
    );
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

  it("tells the model not to offer its own 'other' choice", async () => {
    // The schema cannot forbid a *label* that happens to read "Other" — only persuasion
    // can — and the reason it matters is that the client appends a real free-text choice
    // to every question. A model that spent one of its four slots on "Other" would be
    // offering a button with nothing behind it.
    expect(tool.description).toMatch(/Never offer an option like "Other"/);
    expect(tool.description).toMatch(/the client appends its own free-text choice/);
  });
});

describe("validateAnswers", () => {
  const questions = [question(), question({ header: "数据库", options: [option("PG"), option("MySQL")] })];

  const submit = (answers: Record<string, unknown>) =>
    validateAnswers(questions, { toolCallId: "c1", action: "submit", answers } as never);

  it("accepts a complete submission", () => {
    const result = submit({ "0": { selected: ["OAuth"] }, "1": { selected: ["PG"] } });

    expect(result).toEqual({
      ok: true,
      answers: { "0": { selected: ["OAuth"] }, "1": { selected: ["PG"] } },
    });
  });

  it("accepts free text under 'other' alongside no preset choice", () => {
    const result = submit({ "0": { selected: [], other: "SAML" }, "1": { selected: ["PG"] } });

    expect(result).toEqual({
      ok: true,
      answers: { "0": { selected: [], other: "SAML" }, "1": { selected: ["PG"] } },
    });
  });

  it("trims the free text rather than storing the user's stray whitespace", () => {
    const result = submit({ "0": { selected: [], other: "  SAML  " }, "1": { selected: ["PG"] } });

    expect(result).toMatchObject({ ok: true, answers: { "0": { other: "SAML" } } });
  });

  it("rejects a label the model never offered", () => {
    // The answer is replayed to the model as the user's own words, so this is where the
    // client stops being able to put arbitrary text in their mouth.
    const result = submit({ "0": { selected: ["Something else"] }, "1": { selected: ["PG"] } });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/never offered/);
  });

  it("rejects a submission that skips a question", () => {
    expect(submit({ "0": { selected: ["OAuth"] } })).toMatchObject({ ok: false });
  });

  it("rejects a question with neither a choice nor free text", () => {
    const result = submit({ "0": { selected: [] }, "1": { selected: ["PG"] } });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/no answer/);
  });

  it("rejects two choices for a single-select question", () => {
    const result = submit({ "0": { selected: ["OAuth", "API Key"] }, "1": { selected: ["PG"] } });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/single choice/);
  });

  it("accepts two choices for a multi-select question", () => {
    const multi = [question({ multiSelect: true, options: [option("A"), option("B")] })];
    const result = validateAnswers(multi, {
      toolCallId: "c1",
      action: "submit",
      answers: { "0": { selected: ["A", "B"] } },
    } as never);

    expect(result).toEqual({ ok: true, answers: { "0": { selected: ["A", "B"] } } });
  });

  it("rejects free text longer than the cap", () => {
    const result = submit({
      "0": { selected: [], other: "x".repeat(ASK_USER_OTHER_MAX + 1) },
      "1": { selected: ["PG"] },
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("accepts a cancel without any answers", () => {
    const result = validateAnswers(questions, { toolCallId: "c1", action: "cancel" } as never);

    expect(result).toEqual({ ok: true, answers: {} });
  });

  it("ignores an answer key that belongs to no question", () => {
    const result = submit({
      "0": { selected: ["OAuth"] },
      "1": { selected: ["PG"] },
      "9": { selected: ["nonsense"] },
    });

    expect(result).toMatchObject({ ok: true });
    expect((result as { answers: object }).answers).not.toHaveProperty("9");
  });
});

describe("renderAskUserResult", () => {
  const questions = [question()];

  it("gives the model one record per question, in the order it asked them", () => {
    const rendered = renderAskUserResult(questions, { "0": { selected: ["OAuth"] } }, "submit");

    expect(JSON.parse(rendered)).toEqual({
      user_answers: [
        { question: "要用哪种认证方式？", selected: ["OAuth"] },
      ],
    });
  });

  it("carries the free text as its own field, not folded into the choice", () => {
    const rendered = renderAskUserResult(
      questions,
      { "0": { selected: [], other: "SAML" } },
      "submit"
    );

    expect(JSON.parse(rendered).user_answers[0]).toEqual({
      question: "要用哪种认证方式？",
      selected: [],
      other: "SAML",
    });
  });

  it("tells the model plainly when the user dismissed the questions", () => {
    // A cancelled question has no `user_answers` at all, so the note is the only thing
    // stopping the model from reading "no answer" as an empty one and asking again.
    const parsed = JSON.parse(renderAskUserResult(questions, {}, "cancel")) as {
      user_answers: null;
      note: string;
    };

    expect(parsed.user_answers).toBeNull();
    expect(parsed.note).toMatch(/dismissed the questions without answering/);
    expect(parsed.note).toMatch(/Do not ask again/);
  });

  it("leaves an unanswered question visible rather than dropping it", () => {
    const rendered = renderAskUserResult(questions, {}, "submit");

    expect(JSON.parse(rendered).user_answers).toHaveLength(1);
    expect(JSON.parse(rendered).user_answers[0].selected).toEqual([]);
  });
});
