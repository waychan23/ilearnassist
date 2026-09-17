import { CLIENT_ID_HEADER, expect, test, type Browser, type Page } from "./fixtures";
import { AUTH_STATE } from "./auth";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterWorkspace, leaveWorkspace } from "./workspaces";

/**
 * Two clients of one account, and the conversation they cannot both write to.
 *
 * The situation the feature exists for — a desktop and a phone, or two tabs — is the one thing a
 * single `page` cannot produce. Two **browser contexts** are two clients: Playwright gives each
 * its own `localStorage` and `sessionStorage`, so the same saved session is a different client id
 * on each side, which is exactly the split the server's lease is keyed on.
 *
 * Both contexts load the same `storageState`, because the point is two clients of one **account**.
 * A second account would be a different test — that one is a 404, and the server suite has it.
 */

/**
 * The header name, in the two places it is written down.
 *
 * `fixtures.ts` carries the suite's copy because the root tsconfig does not resolve the workspace
 * package — the arrangement `storage-key.spec.ts` already has for the storage key, and held in
 * step the same way. A rename on one side that the other did not follow would leave the suite's
 * `request` fixture sending a header the server ignores, and the ~40 specs that write to a
 * conversation would go on passing while being, to the gate, anonymous clients that hold nothing.
 */
test("the suite's client-id header matches the app's", () => {
  const shared = readFileSync(
    fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url)),
    "utf8"
  );

  expect(shared).toContain(`export const CLIENT_ID_HEADER = "${CLIENT_ID_HEADER}"`);
});

/** A second client: its own storage, the same session. */
async function openSecondClient(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: AUTH_STATE,
    // Pinned like the projects are, so the catalog assertions below are about the copy.
    locale: "zh-CN",
  });
  const page = await context.newPage();
  await page.goto("/");
  return { page, close: () => context.close() };
}

/** The dot on a conversation's row, as the session list draws it. */
function dot(page: Page) {
  return page.getByTestId("session-item").first().getByTestId("session-lock-dot");
}

/**
 * A workspace of its own, with one conversation in it, so this spec never disturbs another's
 * sidebar. Both names are the caller's, because a spec that has to tell two rows apart cannot
 * have one title be a prefix of the other — `hasText` is a substring match, and a prefix is how a
 * locator aimed at one row quietly matches two.
 */
async function newConversation(page: Page, name: string): Promise<void> {
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("session-title-input").fill(`${name} 会话`);
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("session-item")).toHaveCount(1);
}

test("a conversation one client holds is read-only in another", async ({ page, browser }) => {
  const name = `Lock ${Date.now()}`;
  await page.goto("/");
  await newConversation(page, name);

  // The first client is looking at the conversation, so it holds it: green, and it can write.
  await expect(dot(page)).toHaveAttribute("data-lock", "mine");
  await expect(page.getByTestId("readonly-banner")).toBeHidden();
  await page.getByTestId("composer-input").fill("我来说一句");
  await expect(page.getByTestId("composer-send")).toBeEnabled();

  const second = await openSecondClient(browser);
  try {
    await enterWorkspace(second.page, name);
    await second.page.getByTestId("session-item").first().click();

    // Orange, read-only, and said out loud in two places: the dot on the row and the banner over
    // the conversation. A disabled button with no explanation is indistinguishable from a broken
    // one, which is what the second of those is for.
    await expect(dot(second.page)).toHaveAttribute("data-lock", "other");
    await expect(second.page.getByTestId("readonly-banner")).toBeVisible();
    await expect(second.page.getByTestId("readonly-banner")).toContainText("另一个客户端");

    // The composer refuses before anything is attempted, which is the half the client owns. The
    // server's half — that a turn sent anyway is refused — is
    // `apps/server/test/session-locks.test.ts`. The contrast with the first client's enabled
    // button is the point: the same box, the same text, one writable and one not.
    await second.page.getByTestId("composer-input").fill("让我也说一句");
    await expect(second.page.getByTestId("composer-send")).toBeDisabled();
  } finally {
    await second.close();
  }
});

test("the conversation becomes writable again when the first client leaves it", async ({
  page,
  browser,
}) => {
  const name = `Handover ${Date.now()}`;
  await page.goto("/");
  await newConversation(page, name);
  await expect(dot(page)).toHaveAttribute("data-lock", "mine");

  const second = await openSecondClient(browser);
  try {
    await enterWorkspace(second.page, name);
    await second.page.getByTestId("session-item").first().click();
    await expect(dot(second.page)).toHaveAttribute("data-lock", "other");

    /*
     * The first client leaves the workspace, which is the transition the release hangs on: the
     * chat view unmounts, its scope stops, and `onScopeDispose` gives the lease back — the
     * "取消所有检测逻辑" half of the requirement, and the release at the same time.
     */
    await leaveWorkspace(page);

    /*
     * The second client takes it by opening the conversation again, which is the user-visible
     * recovery: a conversation that has become free is claimed on entry. Asserted rather than
     * waited for, because *this* is the observable consequence of the release having landed — if
     * the lease were still held, the acquire would be refused and the dot would stay orange.
     */
    await second.page.getByTestId("session-item").first().click();
    await expect(dot(second.page)).toHaveAttribute("data-lock", "mine");
    await expect(second.page.getByTestId("readonly-banner")).toBeHidden();
  } finally {
    await second.close();
  }
});

test("a client is locked out of one conversation, not of the app", async ({ page, browser }) => {
  // The lock is per conversation, not per account or per client. Without this the feature would
  // read as "only one device may use this at a time", which is a different and much worse
  // product — so the assertion is that the *other* conversation is still free to the second
  // client while the first one holds the one it is in.
  const tag = `Mine ${Date.now()}`;
  await page.goto("/");
  await newConversation(page, tag);
  await expect(dot(page)).toHaveAttribute("data-lock", "mine");

  // A second conversation. Making it moves the first client out of the first one, so it holds
  // exactly one at a time — the conversation it is looking at. Neither title is a prefix of the
  // other, which is what keeps the two locators below apart.
  const first = `${tag} 甲`;
  const second_ = `${tag} 乙`;
  await page.getByTestId("session-item").first().dblclick();
  await page.locator(".session-item .rename-input").fill(first);
  await page.keyboard.press("Enter");
  await page.getByTestId("new-session").click();
  await page.getByTestId("session-title-input").fill(second_);
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("session-item")).toHaveCount(2);
  await expect(page.getByTestId("session-lock-dot")).toHaveCount(1);

  const second = await openSecondClient(browser);
  try {
    await enterWorkspace(second.page, tag);

    // One mark, and it is the first client's: the conversation it is sitting in. The one it left
    // is unmarked — free to anybody, including this client.
    const held = second.page.getByTestId("session-item").filter({ hasText: second_ });
    const free = second.page.getByTestId("session-item").filter({ hasText: first });
    await expect(held.getByTestId("session-lock-dot")).toHaveAttribute("data-lock", "other");
    await expect(free.getByTestId("session-lock-dot")).toHaveCount(0);

    // And it can write in the free one, which is the half that makes this "one conversation"
    // rather than "one client at a time".
    await free.click();
    await expect(second.page.getByTestId("readonly-banner")).toBeHidden();
    await second.page.getByTestId("composer-input").fill("这边也能写");
    await expect(second.page.getByTestId("composer-send")).toBeEnabled();
  } finally {
    await second.close();
  }
});
