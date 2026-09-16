import { describe, expect, it } from "vitest";
import { activeMention, insertMention } from "../../src/utils/mention";

/**
 * The `@`-mention's two questions: is the caret inside one, and where does the name go.
 *
 * The refusals matter as much as the detections. An email address and a CSS at-rule both
 * contain `@`, and a picker that opened on either would appear in the middle of typing
 * something else — which is the failure that makes a feature like this feel broken rather than
 * merely unhelpful.
 */

describe("activeMention", () => {
  it("detects an empty mention, which is how the picker opens", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("detects a query in progress", () => {
    const text = "look at @report";
    expect(activeMention(text, text.length)).toEqual({ start: 8, query: "report" });
  });

  it("only reads as far as the caret", () => {
    // Typing in the middle of a line is the case a naive "does the string contain @" gets
    // wrong: the query is what is *before* the caret, not after it.
    const text = "@reports and more";
    expect(activeMention(text, 8)).toEqual({ start: 0, query: "reports" });
  });

  it("closes once the user types a space", () => {
    const text = "look at @report and";
    expect(activeMention(text, text.length)).toBeNull();
  });

  it("ignores an @ that does not start a word", () => {
    // An address, and a CSS at-rule: neither is somebody naming a source.
    for (const text of ["mail me at ada@example.com", "a@b", "中文@符"]) {
      expect(activeMention(text, text.length), text).toBeNull();
    }
  });

  it("opens after whitespace", () => {
    // A brace, and a newline: punctuation before the `@` is still a word boundary, which is
    // what makes "(@report.pdf)" and a mention at the start of a line both work.
    expect(activeMention("see (@rep", 9)).toEqual({ start: 5, query: "rep" });
    expect(activeMention("see\n@rep", 8)).toEqual({ start: 4, query: "rep" });
  });

  it("reads the *nearest* @ when there are two", () => {
    const text = "@one @two";
    expect(activeMention(text, text.length)).toEqual({ start: 5, query: "two" });
  });

  it("answers null for a caret outside the text", () => {
    expect(activeMention("@a", 99)).toBeNull();
    expect(activeMention("@a", -1)).toBeNull();
  });
});

describe("insertMention", () => {
  it("replaces the mention with the name and a trailing space", () => {
    const text = "look at @rep";
    const mention = activeMention(text, text.length)!;
    expect(insertMention(text, mention, "report.pdf")).toEqual({
      text: "look at @report.pdf ",
      caret: 20,
    });
  });

  it("keeps what came after the caret", () => {
    const text = "@rep was interesting";
    const mention = activeMention(text, 4)!;
    expect(insertMention(text, mention, "report.pdf").text).toBe(
      "@report.pdf  was interesting"
    );
  });

  it("replaces only the mention, not the text before it", () => {
    const text = "one two @th";
    const mention = activeMention(text, text.length)!;
    const result = insertMention(text, mention, "three");
    expect(result.text).toBe("one two @three ");
  });
});
