import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The sources panel end to end.
 *
 * What only a browser can answer: the panel lists what the *conversation* holds rather than what
 * the model may read, its category filter is derived from the rows on screen, and a load that
 * fails is reported inside the panel rather than as a toast over a conversation that worked.
 *
 * The material is made the two ways a conversation really gets some — an upload through the
 * composer, and a file the agent wrote during a turn — rather than through the API, because the
 * claim being tested is that *those* two land in the same list. That is the whole point of the
 * registry, and a fixture written straight into `sources` would not prove it.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/**
 * A file to upload, with bytes **unique to this run**.
 *
 * Not a fixture with fixed content, and the reason is the registry rather than tidiness:
 * `UNIQUE (user_id, sha256)` makes identical uploaded bytes **one row**, so a fixed buffer
 * uploaded by two specs is one source — and the second upload *revives* the first row, keeping
 * the name it was first given. This spec asserted on its own filename and was handed an earlier
 * spec's screenshot. A unique name is not enough; the content has to differ too.
 */
async function upload(page: Page, name: string): Promise<void> {
  await page.getByTestId("composer-file-input").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(`lecture notes ${name}\n`),
  });
  await expect(page.getByTestId("attachment-chip")).toBeVisible();
}

/**
 * A fresh conversation with the sources panel installed and open on it.
 *
 * Its own workspace per call, so the panel's list cannot inherit a neighbour's rows — the
 * workspace is part of what `?sessionId=` scopes away, but a shared one would still make a
 * failure ambiguous.
 */
async function sourcesSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-sources").check();
  await page.getByTestId("create-session").click();

  // The only widget installed, so it is the strip's first tab and already on screen.
  await expect(page.getByTestId("widget-sources")).toBeVisible();
}

test("an empty conversation says so, and offers no filter to press", async ({ page }) => {
  /*
   * Two claims about the empty state. It is a sentence rather than a blank panel — a tab that
   * renders nothing reads as broken — and the filter strip is **absent**, because a control over
   * an empty list is a control that does nothing.
   */
  await sourcesSession(page, unique("Empty Sources"));

  await expect(page.getByTestId("sources-empty")).toBeVisible();
  await expect(page.getByTestId("sources-filter")).toHaveCount(0);
  await expect(page.getByTestId("sources-list")).toHaveCount(0);
});

test("an upload and a file the agent wrote appear in the same list", async ({ page, request }) => {
  /*
   * The registry's whole claim, seen from a panel: a file uploaded *for this conversation* and a
   * file a tool wrote *into it* are two rows of one list, whatever their storage or origin. They
   * are made two different ways here on purpose — upload through the composer, write through a
   * scripted tool call — because that is the difference a per-origin implementation would show.
   */
  await scriptLlm(request, {
    turns: [
      {
        content: "我把它写下来了。",
        toolCalls: [
          { id: "call_1", name: "write_file", args: { path: "summary.md", content: "# 小结" } },
        ],
      },
      { content: "写好了。" },
    ],
  });

  const name = unique("Two Kinds");
  await sourcesSession(page, name);

  const uploaded = `lecture-${Date.now()}.txt`;
  await upload(page, uploaded);

  await page.getByTestId("composer-input").fill("把这次的小结写下来");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("写好了。");

  // The turn is what links the upload and what wrote the file, so `turn.finished` is what the
  // panel refreshes on. Both rows, without a reload.
  await expect(page.getByTestId("source-row")).toHaveCount(2);
  await expect(page.getByTestId("sources-list")).toContainText(uploaded);
  await expect(page.getByTestId("sources-list")).toContainText("summary.md");

  // Reloaded and reopened, because a list that only exists in the store is not a list.
  await page.reload();
  await enterWorkspace(page, name);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("source-row")).toHaveCount(2);
});

test("the category filter is built from what is there, and narrows to it", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    turns: [
      {
        content: "我把它写下来了。",
        toolCalls: [
          { id: "call_1", name: "write_file", args: { path: "summary.md", content: "# 小结" } },
        ],
      },
      { content: "写好了。" },
    ],
  });

  await sourcesSession(page, unique("Filtered"));

  const uploaded = `lecture-${Date.now()}.txt`;
  await upload(page, uploaded);
  await page.getByTestId("composer-input").fill("把这次的小结写下来");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("source-row")).toHaveCount(2);

  const filter = page.getByTestId("sources-filter");
  // Only the categories actually present — the one question the server cannot answer in the same
  // request, which is why this list is derived from the rows rather than fetched.
  await expect(filter.locator("option")).toHaveCount(3); // 全部类型 + 文本 + Markdown
  await expect(filter).toContainText("文本");
  await expect(filter).toContainText("Markdown");

  await filter.selectOption("text");
  await expect(page.getByTestId("source-row")).toHaveCount(1);
  await expect(page.getByTestId("sources-list")).toContainText(uploaded);
  // The count is what makes the filter honest about what it is hiding.
  await expect(page.getByTestId("sources-count")).toHaveText("1");

  await filter.selectOption("markdown");
  await expect(page.getByTestId("sources-list")).toContainText("summary.md");
  await expect(page.getByTestId("sources-list")).not.toContainText(uploaded);

  await filter.selectOption("");
  await expect(page.getByTestId("source-row")).toHaveCount(2);
});

test("opening a row goes through the ordinary file preview", async ({ page, request }) => {
  // The same dialog the file tree opens, not a second viewer — a source is reached by id here
  // and by path there, and both end in one `readPreviewFile`.
  await scriptLlm(request, {
    turns: [
      {
        content: "我把它写下来了。",
        toolCalls: [
          { id: "call_1", name: "write_file", args: { path: "summary.md", content: "# 小结" } },
        ],
      },
      { content: "写好了。" },
    ],
  });

  await sourcesSession(page, unique("Openable"));
  await page.getByTestId("composer-input").fill("把这次的小结写下来");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("source-row")).toHaveCount(1);

  await page.getByTestId("source-row").first().click();
  const preview = page.locator("body > .modal-overlay");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("summary.md");
  // Rendered, not shown as source: a `.md` goes through the markdown path, so the file's own
  // bytes are only findable if the preview fell back to a `<pre>`. This is the assertion the
  // `kind` union exists for.
  await expect(preview.locator("h1")).toHaveText("小结");
});

test("a load that fails is reported in the panel, and the retry is what fixes it", async ({
  page,
  request,
}) => {
  /*
   * Contract 3 of `docs/widgets.md`: a widget that cannot load its numbers is not a failure of
   * the conversation the user is having, so it never becomes a toast. The panel says so and
   * offers the retry — which is the only control that can, since nothing else on screen knows
   * the list is stale.
   *
   * The failure is forced at the network layer and cleared before the retry, so this is the real
   * `catch` and the real recovery rather than a stubbed state.
   */
  await scriptLlm(request, {
    turns: [
      {
        content: "我把它写下来了。",
        toolCalls: [
          { id: "call_1", name: "write_file", args: { path: "summary.md", content: "# 小结" } },
        ],
      },
      { content: "写好了。" },
    ],
  });

  const name = unique("Failing");
  await sourcesSession(page, name);
  await page.getByTestId("composer-input").fill("把这次的小结写下来");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("source-row")).toHaveCount(1);

  await page.route("**/api/sources?**", (route) => route.abort());
  await page.reload();
  await enterWorkspace(page, name);
  await page.getByTestId("session-item").first().click();

  await expect(page.getByTestId("widget-sources")).toContainText("读取参考资料失败");
  await expect(page.getByTestId("source-row")).toHaveCount(0);
  // Never the toast: the conversation itself did nothing wrong.
  await expect(page.locator("body > .toast")).toHaveCount(0);

  await page.unroute("**/api/sources?**");
  await page.getByTestId("widget-retry").click();
  await expect(page.getByTestId("source-row")).toHaveCount(1);
});
