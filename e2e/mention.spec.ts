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

/** Open the picker by typing `@query`, and wait for its options. */
async function typeMention(page: Page, query: string): Promise<void> {
  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-input").type(`看 @${query}`);
  await expect(page.getByTestId("mention-picker")).toBeVisible();
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
    page.getByTestId("composer-sources").getByTestId("attachment-chip").filter({ hasText: "report.md" })
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

  const chips = page.getByTestId("composer-sources");
  await expect(chips.getByTestId("attachment-chip")).toHaveCount(1);
  await chips.getByTestId("attachment-chip").first().getByTestId("attachment-remove").click();
  await expect(chips.getByTestId("attachment-chip")).toHaveCount(0);
});
