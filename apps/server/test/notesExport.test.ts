import { describe, expect, it } from "vitest";
import type { Message, Note } from "@ilearnassist/shared";
import {
  buildSummaryPrompt,
  isNoteSyncStuck,
  noteExportRelPath,
  noteLabel,
  renderNoteExport,
  HEAD_MESSAGES,
  NOTE_LABEL_MAX,
  STUCK_AFTER_MS,
  TAIL_MESSAGES,
} from "../src/notesExport.js";

/**
 * The export's decisions, with no database and no model in sight.
 *
 * The text a note becomes is the whole feature — it is read by a person in the browser and by a
 * model through `read_document`, and both are looking for the *context* the note alone does not
 * carry. So the header's fields, the line that is omitted rather than faked, and the sampled ends
 * of a long transcript are each worth pinning here rather than through a route test that would
 * have to arrange a conversation around them.
 */

function note(over: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    sessionId: "sess-1",
    messageId: null,
    type: "annotation",
    quote: "",
    occurrence: 0,
    content: "",
    messageMissing: false,
    createdAt: "2026-09-16T06:03:00.000Z",
    updatedAt: "2026-09-16T06:03:00.000Z",
    ...over,
  };
}

function message(role: "user" | "assistant", content: string): Message {
  return {
    id: `m-${Math.random()}`,
    sessionId: "sess-1",
    role,
    content,
    createdAt: "2026-09-16T06:03:00.000Z",
  };
}

describe("noteLabel", () => {
  it("names a note by its own opening words", () => {
    expect(noteLabel(note({ content: "光合作用是植物把光变成化学能的过程。" }))).toBe(
      "光合作用是植物把光变成化学能的过程。"
    );
  });

  it("takes the first line that has anything on it", () => {
    expect(noteLabel(note({ content: "\n\n  第一行  \n第二行" }))).toBe("第一行");
  });

  it("falls back to the quote for a bare annotation", () => {
    expect(noteLabel(note({ quote: "被划住的那一句" }))).toBe("被划住的那一句");
  });

  it("falls back to a timestamp when the note has no text at all", () => {
    // A value, not a sentence: `sources.name` is a library row's title, and a phrase there would
    // be a catalog entry on the wrong side of the wire.
    expect(noteLabel(note())).toBe("2026-09-16T06:03");
  });

  it("clips a long note to the label cap", () => {
    const label = noteLabel(note({ content: "字".repeat(500) }));
    expect(label.length).toBe(NOTE_LABEL_MAX);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("renderNoteExport", () => {
  const summary = "这次会话讨论了光合作用，重点在光反应与暗反应的分工。";

  it("leads with the same string the library row is named", () => {
    const rendered = renderNoteExport({
      note: note({ content: "叶绿体里进行" }),
      sessionTitle: "光合作用",
      summary,
    });
    expect(rendered.text.startsWith(`# ${rendered.label}\n`)).toBe(true);
    expect(rendered.label).toBe("叶绿体里进行");
  });

  it("carries the conversation, the time, the quote and the summary as a header", () => {
    const { text } = renderNoteExport({
      note: note({ content: "叶绿体里进行", quote: "光合作用发生在叶绿体中" }),
      sessionTitle: "光合作用",
      summary,
    });
    const header = text.slice(0, text.indexOf("\n---\n"));
    expect(header).toContain("> 来自会话《光合作用》");
    expect(header).toContain("> 原文引用：光合作用发生在叶绿体中");
    expect(header).toContain(`> 会话摘要：${summary}`);
  });

  it("omits the quote line entirely when there is no quote", () => {
    // Not `（无）`: a placeholder is a fact nobody recorded dressed up as one, which is the same
    // rule a blank page summary follows by being NULL rather than ''.
    const { text } = renderNoteExport({ note: note({ content: "只有正文" }), sessionTitle: "S", summary });
    expect(text).not.toContain("原文引用");
  });

  it("separates the header from the note with a rule, and ends on the note", () => {
    const { text } = renderNoteExport({ note: note({ content: "正文" }), sessionTitle: "S", summary });
    // The body is the last thing in the file, not the middle of it.
    expect(text).toContain("\n---\n\n正文\n");
    expect(text.indexOf("\n---\n")).toBeGreaterThan(text.indexOf("会话摘要"));
  });

  it("makes the quote the body of a bare annotation", () => {
    const { text } = renderNoteExport({ note: note({ quote: "划住的句子" }), sessionTitle: "S", summary });
    expect(text).toContain("> 划住的句子");
    expect(text).toContain("原文引用：划住的句子");
  });

  it("stands on its header alone when the note has neither body nor quote", () => {
    const { text } = renderNoteExport({ note: note(), sessionTitle: "S", summary });
    expect(text).not.toContain("---");
    expect(text).toContain("会话摘要");
  });

  it("leaves the body untouched, including its own markdown", () => {
    const content = "## 我的标题\n\n- 一\n- 二";
    const { text } = renderNoteExport({ note: note({ content }), sessionTitle: "S", summary });
    expect(text.endsWith(`${content}\n`)).toBe(true);
  });
});

describe("buildSummaryPrompt", () => {
  const many = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => message("user", `第 ${i + 1} 条`));

  it("names the conversation and lists the messages", () => {
    const prompt = buildSummaryPrompt([message("user", "你好"), message("assistant", "在")], "递归练习");
    expect(prompt).toContain("Conversation title: 递归练习");
    expect(prompt).toContain("user: 你好");
    expect(prompt).toContain("assistant: 在");
  });

  it("keeps every message when the conversation is short enough", () => {
    const prompt = buildSummaryPrompt(many(10), "S");
    expect(prompt).not.toContain("omitted");
    expect(prompt).toContain("第 10 条");
  });

  it("keeps the opening of a long conversation, which is where the goal was stated", () => {
    // The reason this call samples both ends rather than the most recent N: a summary of a whole
    // conversation that dropped its first messages is a summary of the middle of a story.
    const prompt = buildSummaryPrompt(many(HEAD_MESSAGES + TAIL_MESSAGES + 5), "S");
    expect(prompt).toContain("第 1 条");
    expect(prompt).toContain("第 10 条");
  });

  it("keeps the end too, and says how much it skipped", () => {
    const total = HEAD_MESSAGES + TAIL_MESSAGES + 5;
    const prompt = buildSummaryPrompt(many(total), "S");
    expect(prompt).toContain(`第 ${total} 条`);
    expect(prompt).toContain("[… 5 messages omitted …]");
  });

  it("clips a single enormous message", () => {
    const prompt = buildSummaryPrompt([message("user", "字".repeat(5_000))], "S");
    expect(prompt.length).toBeLessThan(1_000);
  });
});

describe("isNoteSyncStuck", () => {
  const started = "2026-09-16T06:00:00.000Z";
  const at = (offsetMs: number): number => Date.parse(started) + offsetMs;

  it("is not stuck while the run is inside its window", () => {
    expect(isNoteSyncStuck("running", started, at(STUCK_AFTER_MS - 1))).toBe(false);
  });

  it("is stuck once it is past it", () => {
    expect(isNoteSyncStuck("running", started, at(STUCK_AFTER_MS + 1))).toBe(true);
  });

  it("is never stuck when it is not running", () => {
    for (const status of ["ok", "empty", "failed"]) {
      expect(isNoteSyncStuck(status, started, at(STUCK_AFTER_MS * 100))).toBe(false);
    }
  });

  it("does not call a run dead on a timestamp it cannot read", () => {
    // The safe answer: leaving the row alone costs a retry, and declaring it dead on the strength
    // of an unreadable value costs a second concurrent run over the same files.
    expect(isNoteSyncStuck("running", "not a date", at(STUCK_AFTER_MS * 100))).toBe(false);
  });
});

describe("noteExportRelPath", () => {
  it("is a pure function of the note id, which is what makes a re-sync update rather than add", () => {
    expect(noteExportRelPath(note({ id: "abc" }))).toBe("notes/abc.md");
    expect(noteExportRelPath(note({ id: "abc", content: "改过了" }))).toBe("notes/abc.md");
  });
});
