import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Keeping a page from its `web_fetch` card — the user's half of `ila_collect_page`.
 *
 * The success path cannot be fetched for real: the fetch goes through `web_fetch`'s SSRF guard,
 * which refuses loopback by design, and the suite must stay offline — the same constraint
 * `library.spec.ts` names for the library's add-link, whose happy path is likewise unit-tested
 * over `captureWebPage` rather than reached through a browser. What is real here is everything the
 * browser does: the control is gated on a call that did not fail, the press sends the URL the call
 * asked for, the button lands in its kept state, and the sources panel re-reads because a
 * reference appeared. The success shape is assembled by reading the real messages response and
 * rewriting that one call's output — a rewrite of a real row, not a fabricated transcript.
 */

const PAGE_URL = "https://example.com/article";

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A fresh conversation in its own workspace, with the sources panel installed and open. */
async function sourcesSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-sources").check();
  await page.getByTestId("create-session").click();

  await page.getByTestId("widget-tab-sources").click();
  await expect(page.getByTestId("widget-sources")).toBeVisible();
}

test("a fetch that failed offers no way to keep it", async ({ page, request }) => {
  /*
   * Keeping a page re-fetches it, so a control on a call that just failed could only fail again.
   * The refusal is the guard's own — a loopback address — so it is deterministic offline and
   * needs no network to be slow or absent about it.
   */
  await scriptLlm(request, {
    turns: [
      {
        content: "我抓一下。",
        toolCalls: [
          { id: "call_fetch", name: "web_fetch", args: { url: "http://127.0.0.1:9/nope" } },
        ],
      },
      { content: "抓不到。" },
    ],
  });

  await sourcesSession(page, unique("Keep failed"));

  await page.getByTestId("composer-input").fill("看一下这个页面");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("抓不到。");

  await expect(page.getByTestId("tool-call")).toHaveCount(1);
  await expect(page.getByTestId("keep-page")).toHaveCount(0);
});

test("a finished fetch can be kept, and the sources panel hears about it", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    turns: [
      {
        content: "我读一下。",
        toolCalls: [{ id: "call_fetch", name: "web_fetch", args: { url: PAGE_URL } }],
      },
      { content: "读完了。" },
    ],
  });

  const name = unique("Keep page");
  await sourcesSession(page, name);

  await page.getByTestId("composer-input").fill("读一下这篇文章");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("读完了。");

  // The real messages read, with the one call's result rewritten to the success shape a fetch of
  // a public page would have produced. Installed before the reload because that reload is what
  // makes the card read from it.
  await page.route("**/api/sessions/*/messages", async (route) => {
    const response = await route.fetch();
    const messages = (await response.json()) as Array<{
      toolCalls?: Array<Record<string, unknown>>;
    }>;
    const patched = messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((call) =>
        call.name === "web_fetch"
          ? { ...call, output: `URL: ${PAGE_URL}\nTitle: 示例文章\nContent-Type: text/html\n\n正文。` }
          : call
      ),
    }));
    await route.fulfill({ response, json: patched });
  });

  await page.reload();
  await enterWorkspace(page, name);
  await page.getByTestId("session-item").first().click();
  await page.getByTestId("widget-tab-sources").click();

  // The keep request is answered here rather than by the server: the real route would re-fetch
  // the page, and the fetch is the one thing the suite cannot reach offline.
  const sent: unknown[] = [];
  await page.route("**/api/sessions/*/resources/pages", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: "kept-stub" }),
    });
  });

  const button = page.getByTestId("keep-page");
  await expect(button).toBeVisible();
  await expect(button).toContainText("保留为参考资料");

  // Count only from here: the panel read on the way in has already happened, so a count after the
  // press is the announcement's own read.
  let panelReads = 0;
  page.on("request", (request_) => {
    if (request_.method() === "GET" && new URL(request_.url()).pathname === "/api/resources") {
      panelReads++;
    }
  });

  await button.click();

  await expect(button).toHaveAttribute("data-kept", "true");
  await expect(button).toContainText("已保留到参考资料");
  expect(sent).toEqual([{ url: PAGE_URL }]);
  await expect.poll(() => panelReads).toBeGreaterThan(0);
});
