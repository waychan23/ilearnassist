import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * `@`-referencing a source in the composer.
 *
 * The requirement's own shape: a source is named with `@`, the model may only read one that has
 * been parsed, and the parse is what referencing triggers. All three are checked here, through
 * the real picker and the real turn — the pure caret arithmetic is unit-tested beside it.
 *
 * The last case is the one worth stating: a *file in a workspace* is referenced, not an upload.
 * That is the half that did not exist before this change — the composer could attach a file to
 * one turn, and nothing could point at what was already there.
 */

async function seedWorkspace(
  request: APIRequestContext,
  name: string,
  file: string,
  body = "the referenced contents"
): Promise<string> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { workdirPath } = (await res.json()) as { workdirPath: string };
  writeFileSync(join(workdirPath, file), body);
  return name;
}

/**
 * Open the picker by typing `@query`, and wait for its options.
 *
 * It waits for an **option**, not merely for the picker element, and the difference is one this
 * change had to make explicit. The picker's frame is now drawn immediately — the tabs and the
 * type filter are the control, and an empty list still needs them — so its visibility no longer
 * implies the fetch has landed. Waiting for a row is what this helper always *meant*: a caller
 * that presses Enter with nothing loaded is testing a picker mid-fetch.
 */
async function typeMention(page: Page, query: string): Promise<void> {
  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-input").type(`看 @${query}`);
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await expect(page.getByTestId("mention-option").first()).toBeVisible();
}

test("picks a workspace file with @ and sends it as a reference", async ({ page, request }) => {
  const name = `Mention-${Date.now()}`;
  await seedWorkspace(request, name, "report.md");

  await scriptLlm(request, {
    title: "看文件",
    turns: [{ content: "我看到了。" }],
  });

  await page.goto("/");
  await enterWorkspace(page, name);

  await typeMention(page, "report");
  // Scoped to this test's workspace: the picker searches the whole account, and every case in
  // this file seeds a file called `report.md`. The row shows which workspace each one is in,
  // which is what makes them tellable apart.
  await page.getByTestId("mention-option").filter({ hasText: name }).click();

  // The name goes into the sentence, and the reference becomes a chip — the `@` is how it is
  // *picked*, the chip is what it *means*.
  await expect(page.getByTestId("composer-input")).toHaveValue("看 @report.md ");
  await expect(
    page.getByTestId("composer-resources").getByTestId("attachment-chip").filter({ hasText: "report.md" })
  ).toBeVisible();

  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("我看到了。");

  // The model was handed the file's text, which is the whole point of the reference. Asked of
  // the fake LLM directly — it records every request body — because the alternative is
  // asserting on a reply, and a scripted reply says nothing about what it was sent.
  await expect
    .poll(
      async () => {
        const bodies = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as unknown;
        return JSON.stringify(bodies);
      },
      { timeout: 15000 }
    )
    .toContain("the referenced contents");
});

test("a mention inside an address or a word does not open the picker", async ({ page, request }) => {
  // The refusal that keeps the feature from feeling broken: typing an email address must not
  // put a list of files over the composer.
  const name = `MentionNeg-${Date.now()}`;
  await seedWorkspace(request, name, "report.md");
  await page.goto("/");
  await enterWorkspace(page, name);

  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-input").type("mail ada@example.com");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
});

test("Enter picks from the picker instead of sending", async ({ page, request }) => {
  // The two controls want the same key, and the picker is the one that is open: sending here
  // would put a half-typed mention into the conversation.
  const name = `MentionKey-${Date.now()}`;
  await seedWorkspace(request, name, "report.md");
  await page.goto("/");
  await enterWorkspace(page, name);

  await typeMention(page, "report");
  await page.getByTestId("composer-input").press("Enter");

  await expect(page.getByTestId("composer-input")).toHaveValue("看 @report.md ");
  // Nothing was sent: the conversation is still empty.
  await expect(page.getByTestId("message-user")).toHaveCount(0);
});

test("a reference can be dropped before sending", async ({ page, request }) => {
  const name = `MentionDrop-${Date.now()}`;
  await seedWorkspace(request, name, "report.md");
  await page.goto("/");
  await enterWorkspace(page, name);

  await typeMention(page, "report");
  await page.getByTestId("mention-option").filter({ hasText: name }).click();

  const chips = page.getByTestId("composer-resources");
  await expect(chips.getByTestId("attachment-chip")).toHaveCount(1);
  await chips.getByTestId("attachment-chip").first().getByTestId("attachment-remove").click();
  await expect(chips.getByTestId("attachment-chip")).toHaveCount(0);
});

/**
 * The picker as a *selector*: two kinds of reference in one list, a tab per kind, and a type
 * filter over the sources.
 *
 * The list holds both at once on 全部 — grouped, workspaces first — because a bare `@` is how
 * somebody browses, and being made to choose a tab before seeing what exists is a question they
 * cannot yet answer.
 */
test("the tabs filter by kind, and the pills filter by source type", async ({ page, request }) => {
  const name = `Picker-${Date.now()}`;
  // One workspace holding one file per type, so each pill has exactly one row to keep — and a
  // shared `zz` prefix, because the picker searches the whole account and every other case in
  // this file seeds a `report.md`.
  const res = await request.post("/api/workspaces", { data: { name } });
  const { workdirPath } = (await res.json()) as { workdirPath: string };
  const files: Array<[string, string]> = [
    ["zz-notes.md", "# notes"],
    ["zz-photo.png", "png"],
    ["zz-code.ts", "export {}"],
  ];
  for (const [file, body] of files) writeFileSync(join(workdirPath, file), body);

  await page.goto("/");
  await enterWorkspace(page, name);

  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-input").type("看 @zz");
  await expect(page.getByTestId("mention-picker")).toBeVisible();

  // 全部: the sources that match. No workspace matches `zz`, so only one group is drawn.
  await expect(page.getByTestId("mention-option")).toHaveCount(3);
  await expect(page.getByTestId("mention-heading")).toHaveCount(1);

  // 工作区: no source rows at all, and no type filter either — a workspace has no source type,
  // so a control that provably cannot change the list would be a control that lies.
  await page.getByTestId("mention-tab-workspace").click();
  await expect(page.getByTestId("mention-option")).toHaveCount(0);
  await expect(page.getByTestId("mention-pill-image")).toHaveCount(0);

  await page.getByTestId("mention-tab-source").click();
  await expect(page.getByTestId("mention-option")).toHaveCount(3);

  // 图片 narrows to the one image. The pill is a toggle, so clicking it again clears it — which
  // is how you get back, since the five pills deliberately have no "all" of their own.
  await page.getByTestId("mention-pill-image").click();
  await expect(page.getByTestId("mention-option")).toHaveCount(1);
  await expect(page.getByTestId("mention-option").first()).toContainText("zz-photo.png");

  await page.getByTestId("mention-pill-image").click();
  await expect(page.getByTestId("mention-option")).toHaveCount(3);
});

test("picking a workspace names it, raises a chip, and survives a reload", async ({
  page,
  request,
}) => {
  const here = `Ref-${Date.now()}`;
  const there = `RefThere-${Date.now()}`;
  await seedWorkspace(request, here, "note.md");
  await seedWorkspace(request, there, "note.md");
  await scriptLlm(request, { title: "打开工作区", turns: [{ content: "好。" }] });
  await page.goto("/");
  await enterWorkspace(page, here);

  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-input").type(`@${there}`);
  await page.getByTestId("mention-option").filter({ hasText: there }).click();

  // The name goes into the sentence, the way a source's does: the `@` is how it is *picked*.
  await expect(page.getByTestId("composer-input")).toHaveValue(`@${there} `);

  // The reference is a chip, and it is *not* a source chip — a grant is access being held rather
  // than material being sent, which is exactly why it has to be visible.
  const chips = page.getByTestId("composer-scope");
  await expect(chips.getByTestId("scope-chip")).toHaveCount(1);
  await expect(chips.getByTestId("scope-chip").first()).toContainText(there);

  // Send, so the grant lands on a conversation that exists rather than on a draft.
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("好。");

  // --- reload: the grant must come back from the database, not from memory ---
  await page.reload();
  await enterWorkspace(page, here);
  await page.getByTestId("session-item").first().click();

  // This is the whole reason it is a session *setting* rather than a field on the turn: a
  // reload must not silently close a workspace the user opened.
  await expect(page.getByTestId("composer-scope").getByTestId("scope-chip")).toHaveCount(1);

  // And taking it back off closes it.
  await page.getByTestId("composer-scope").getByTestId("scope-chip").click();
  await expect(page.getByTestId("composer-scope")).toHaveCount(0);
  await page.reload();
  await enterWorkspace(page, here);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("composer-scope")).toHaveCount(0);
});

test("the all-workspaces row opens everything, and is removable", async ({ page, request }) => {
  const here = `All-${Date.now()}`;
  await seedWorkspace(request, here, "note.md");
  await page.goto("/");
  await enterWorkspace(page, here);

  await page.getByTestId("composer-input").click();
  // Matched on the label itself — the Chinese one, since the suite is pinned to zh-CN — and the
  // row also answers to the literal `all`, which is what a user on an English screen would type.
  await page.getByTestId("composer-input").type("@所有");
  await page.getByTestId("mention-option").filter({ hasText: "所有工作区" }).click();

  await expect(page.getByTestId("composer-scope").getByTestId("scope-chip-all")).toHaveCount(1);
  await page.getByTestId("composer-scope").getByTestId("scope-chip-all").click();
  await expect(page.getByTestId("composer-scope")).toHaveCount(0);
});
