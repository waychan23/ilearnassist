import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@ilearnassist/shared";

/**
 * Reporting that the reader has gone.
 *
 * The behaviour worth testing is *when* a request happens, so every case is written as "how many
 * calls after how long" rather than as a return value — the function reports and forgets, and a
 * version that fired on every `noteSession` would satisfy any assertion about its result.
 */

const reportSessionLeave = vi.fn();

vi.mock("../../src/api/client", () => ({ api: { reportSessionLeave: (...a: unknown[]) => reportSessionLeave(...a) } }));

const { forgetSession, needsTitleRetry, noteSession, onRetitled, reportLeave } = await import(
  "../../src/composables/sessionLeave"
);

function session(id: string, titleSource: Session["titleSource"] = "auto", titleState?: Session["titleState"]): Session {
  return {
    id,
    workspaceId: "w1",
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: "某个标题",
    titleSource,
    titleState,
    settings: {},
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  reportSessionLeave.mockReset();
  reportSessionLeave.mockResolvedValue({ status: "skipped" });
  // The module keeps the conversation on screen, its timers and its handler — all three carry
  // between cases, and a leftover handler would collect titles from the next case's reports.
  forgetSession();
  vi.clearAllTimers();
  onRetitled(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("needsTitleRetry", () => {
  it("is true for a title the model never wrote", () => {
    // The fallback case, and the one the whole feature exists for: the call failed and what is
    // showing is the user's own clipped words.
    expect(needsTitleRetry({ titleSource: "auto", titleState: "fallback" })).toBe(true);
    // …and the never-attempted case, where the title is still the create-time placeholder.
    expect(needsTitleRetry({ titleSource: "auto", titleState: undefined })).toBe(true);
  });

  it("is false once the model has named it, and false for the user's own name", () => {
    expect(needsTitleRetry({ titleSource: "auto", titleState: "model" })).toBe(false);
    expect(needsTitleRetry({ titleSource: "user", titleState: undefined })).toBe(false);
    expect(needsTitleRetry({ titleSource: "user", titleState: "fallback" })).toBe(false);
  });
});

describe("leaving a conversation", () => {
  it("reports the one being left, and not before the debounce", async () => {
    const first = session("s1");
    noteSession(first);

    // Nothing yet: this is the conversation being *entered*, and no leave has happened.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reportSessionLeave).not.toHaveBeenCalled();

    noteSession(session("s2"));
    // Still nothing — the debounce is what stops a reader flicking between conversations from
    // producing a model call per click.
    expect(reportSessionLeave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportSessionLeave).toHaveBeenCalledTimes(1);
    expect(reportSessionLeave).toHaveBeenCalledWith("s1");
  });

  it("says nothing for a conversation the model already named", async () => {
    // The gate that makes this feature free in the common case: no request at all, which is what
    // the same predicate on the wire is a second opinion about.
    noteSession(session("s1", "auto", "model"));
    noteSession(session("s2"));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reportSessionLeave).not.toHaveBeenCalled();
  });

  it("says nothing for a conversation a person named", async () => {
    noteSession(session("s1", "user"));
    noteSession(null);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reportSessionLeave).not.toHaveBeenCalled();
  });

  it("reports once per conversation however often it is left in the window", async () => {
    /*
     * The debounce in one assertion: out to s2, back to s1, out again — all inside three seconds.
     * The count is what is asserted, not the total: leaving *two* conversations legitimately
     * reports both, and the "reports the one being left" case above is where that is pinned. What
     * a per-conversation debounce buys is that the second departure of s1 replaces the first
     * rather than queueing another model call behind it.
     */
    noteSession(session("s1"));
    noteSession(session("s2"));
    noteSession(session("s1"));
    noteSession(session("s2"));

    await vi.advanceTimersByTimeAsync(3_000);
    const ids = reportSessionLeave.mock.calls.map((c) => c[0]);
    expect(ids.filter((id) => id === "s1")).toHaveLength(1);
    expect(ids.filter((id) => id === "s2")).toHaveLength(1);
  });

  it("reports the conversation that was on screen when the view leaves the chat pane", async () => {
    // The transition `activeSessionId` deliberately does not move for: going back to the workspace
    // home leaves the id in place, so nothing about the session *changed* and only an explicit
    // report can say the reader went.
    noteSession(session("s1"));
    reportLeave();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportSessionLeave).toHaveBeenCalledWith("s1");
  });

  it("hands a title the server settled on to the registered handler", async () => {
    reportSessionLeave.mockResolvedValue({ status: "titled", title: "递归入门" });
    const seen: [string, string][] = [];
    onRetitled((id, title) => seen.push([id, title]));
    noteSession(session("s1"));
    noteSession(session("s2"));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual([["s1", "递归入门"]]);
  });

  it("stays silent when the attempt failed or had nothing to do", async () => {
    const seen: [string, string][] = [];
    onRetitled((id, title) => seen.push([id, title]));
    for (const status of ["failed", "skipped"] as const) {
      reportSessionLeave.mockResolvedValue({ status });
      noteSession(session("s1"));
      noteSession(session("s2"));
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(seen).toEqual([]);
  });

  it("swallows a request that never landed", async () => {
    // A leave is not a critical operation: the reader has gone, the conversation is not broken, and
    // the next leave tries again. An unhandled rejection here would be a console error about a
    // title nobody is looking at.
    reportSessionLeave.mockRejectedValue(new Error("offline"));
    noteSession(session("s1"));
    noteSession(session("s2"));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportSessionLeave).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a conversation that was forgotten rather than left", async () => {
    // A deleted conversation, or a signed-out one: there is nowhere to keep a new title.
    noteSession(session("s1"));
    forgetSession();
    noteSession(null);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reportSessionLeave).not.toHaveBeenCalled();
  });
});
