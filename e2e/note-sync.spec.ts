import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace, leaveWorkspace } from "./workspaces";

/**
 * Exporting a conversation's notes into the source library, in a browser.
 *
 * The run is asynchronous, so what is only reachable from here is the *watching*: that the topbar
 * control reports a state rather than going silent, that the state comes back from the server
 * rather than from the page that pressed the button, and that the result really is a set of
 * ordinary sources in the library — visible, labelled, and countable.
 *
 * The notes are seeded over the API rather than typed into the notes panel: this spec is about the
 * export, and driving the annotation UI first would make a failure here ambiguous between two
 * features. Each note carries a run-unique marker, because the library is account-wide and every
 * other spec's rows are in it too.
 */

const SUMMARY = "这次会话讨论了递归，重点是基准情形和递推关系的分工。";

/** A workspace with a conversation of its own in it. */
async function newConversation(
  request: APIRequestContext,
  name: string
): Promise<{ workspace: string; sessionId: string }> {
  const created = await request.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()) as { id: string };

  const sessionRes = await request.post(`/api/workspaces/${workspace.id}/sessions`, {
    data: { title: "递归练习" },
  });
  expect(sessionRes.status()).toBe(201);
  const session = (await sessionRes.json()) as { id: string };
  return { workspace: name, sessionId: session.id };
}

async function addNote(
  request: APIRequestContext,
  sessionId: string,
  content: string
): Promise<void> {
  const res = await request.post(`/api/sessions/${sessionId}/notes`, {
    data: { type: "idea", content, quote: "", occurrence: 0 },
  });
  expect(res.status()).toBe(201);
}

/** Open the conversation, which is what renders the topbar control. */
async function openConversation(page: Page, workspace: string): Promise<void> {
  await page.goto("/");
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

test("exports a conversation's notes, and the library shows them as sources", async ({
  page,
  request,
}) => {
  const marker = String(Date.now());
  const { workspace, sessionId } = await newConversation(request, `导出 ${marker}`);
  await addNote(request, sessionId, `递归必须有基准情形 ${marker}`);
  await addNote(request, sessionId, `递推关系要把问题变小 ${marker}`);

  await scriptLlm(request, {
    // No agent turns: this spec never sends a chat message, so the only call the provider sees is
    // the export's summary — matched by its own wrapper, the needle the fake LLM routes on, since
    // all three out-of-band calls reach the same server.
    turns: [],
    matches: [{ includes: "<session_transcript>", content: SUMMARY }],
  });

  await openConversation(page, workspace);

  // Before anything is pressed there is no status line at all: a conversation nobody has exported
  // has nothing to report, and a standing "未同步" would be noise.
  await expect(page.getByTestId("note-sync")).toBeVisible();
  await expect(page.getByTestId("note-sync-status")).toHaveCount(0);

  await page.getByTestId("note-sync").click();

  // Watched rather than awaited: the run outlives the press, so the label goes to "正在同步…" and
  // then reports what it did. The count is `added + updated` as one number.
  await expect(page.getByTestId("note-sync-status")).toHaveText("已同步 2 条笔记", {
    timeout: 20_000,
  });

  /*
   * Walking back in proves the status came from the server rather than from the page that
   * pressed the button — which is the whole point of the state being a row rather than a
   * component's flag. Opening the conversation again reads it as a new reader would.
   */
  await openConversation(page, workspace);
  await expect(page.getByTestId("note-sync-status")).toHaveText("已同步 2 条笔记");

  /*
   * Pressing again with nothing changed reports **zero**, and that is the count's meaning rather
   * than a bug: it is what the run *did*, and a rendered file is a pure function of the note and
   * the summary (`renderNoteExport`). A note whose file already says exactly that is neither added
   * nor updated. The same rule is pinned server-side — `note-sync-routes.test.ts` asserts
   * `{ added: 0, updated: 0 }` for an unchanged export and `{ updated: 2 }` for a resummarised one.
   */
  await page.getByTestId("note-sync").click();
  await expect(page.getByTestId("note-sync-status")).toHaveText("已同步 0 条笔记", {
    timeout: 20_000,
  });

  /*
   * So the rewrite is driven by the one input that can move. Scripting a different summary before
   * pressing again is what makes this deterministic, and it is also the honest shape of the claim
   * being tested: a second export *reconciles* rather than appends.
   *
   * This used to script the model once and assert "the same two" on the second press, which held
   * only when the fixture's answer happened to differ between the two runs — the spec never
   * controlled that, so the assertion passed or failed on the fixture's behaviour rather than on
   * the app's. It was the note-export suite's own intermittent failure, before the write lock
   * existed.
   */
  const RESUMED = "这次会话讨论了递归，并补充了基准情形的作用。";
  await scriptLlm(request, {
    turns: [],
    matches: [{ includes: "<session_transcript>", content: RESUMED }],
  });
  await page.getByTestId("note-sync").click();
  await expect(page.getByTestId("note-sync-status")).toHaveText("已同步 2 条笔记", {
    timeout: 20_000,
  });

  // --- the library, through its own front door ---
  await leaveWorkspace(page);
  await page.getByTestId("open-sources").click();
  await expect(page.getByTestId("sources-dialog")).toBeVisible();
  await expect(page.getByTestId("sources-loading")).toHaveCount(0);

  // Scoped by this run's marker: the library is account-wide, and every other spec's rows are in
  // it too. Exactly two, after a second export — which is the claim that it reconciled rather
  // than appended.
  const rows = page.getByTestId("source-row").filter({ hasText: marker });
  await expect(rows).toHaveCount(2);
  // Filed under their own provenance — the learner's words under the learner's name, not the
  // assistant's, and not "found in a folder".
  await expect(rows.getByTestId("source-origin").filter({ hasText: "学习笔记" })).toHaveCount(2);

  // The export did not disturb the notes it read.
  const notes = await request.get(`/api/sessions/${sessionId}/notes`);
  expect(((await notes.json()) as { notes: unknown[] }).notes).toHaveLength(2);
});

test("reports an empty conversation rather than calling the model", async ({ page, request }) => {
  /*
   * The third settled outcome, and the one a single failure state would misreport: a conversation
   * with nothing in it did not fail to export — there was nothing to export. The model is never
   * asked, so this also pins that the button does not spend a call to find that out.
   */
  const { workspace } = await newConversation(request, `空 ${Date.now()}`);

  await scriptLlm(request, { turns: [] });

  await page.goto("/");
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  await page.getByTestId("note-sync").click();
  await expect(page.getByTestId("note-sync-status")).toHaveText("这次会话还没有笔记", {
    timeout: 20_000,
  });

  // And the model was never asked. Asserted against the provider rather than only through the
  // state, because "empty" is also what a run that called the model and got nothing back would
  // have to report — the two are told apart here and nowhere else.
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as unknown[];
  expect(sent).toHaveLength(0);
});
