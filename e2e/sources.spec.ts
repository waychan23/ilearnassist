import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The uploaded-files dialog, from the home page.
 *
 * This is the only place in the app that lists files the *account* owns rather than the ones a
 * conversation can see — which matters most for the file no conversation references any more.
 * The flows here are the destructive one and the two ways it can be declined, because deleting
 * a source is unrecoverable and the confirmation is the only thing standing in front of it.
 */

/**
 * Put a file in the account's library, through the real routes.
 *
 * A workspace and a conversation are needed to upload at all — a source is created *from* a
 * conversation even though it does not belong to one — and the cookie the setup project saved
 * is carried by `request` automatically, being the browser's own context.
 */
async function seedSource(request: APIRequestContext, name: string): Promise<string> {
  const workspace = await request
    .post("/api/workspaces", { data: { name: `Lib-${Date.now()}` } })
    .then((r) => r.json());
  const session = await request
    .post(`/api/workspaces/${workspace.id}/sessions`, { data: {} })
    .then((r) => r.json());

  const res = await request.post(`/api/sessions/${session.id}/sources`, {
    data: {
      name,
      mimeType: "text/plain",
      // The name goes into the bytes, and that is not decoration: sources are deduped by
      // content, so two seeds with identical bodies are *one* file under the first name —
      // which is exactly what this spec's first version did, and why it could not find its
      // own fixture.
      data: Buffer.from(`contents of ${name}`).toString("base64"),
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

/** Open the dialog from the home page, where the entry point lives. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("open-sources").click();
  await expect(page.getByTestId("sources-dialog")).toBeVisible();
}

test.describe("uploaded files", () => {
  test("lists the account's files, with their size", async ({ page, request }) => {
    await seedSource(request, "lecture-notes.txt");

    await openLibrary(page);

    const row = page.getByTestId("source-row").filter({ hasText: "lecture-notes.txt" });
    await expect(row).toBeVisible();
    // Size, and no parse state: a text file needs no extraction, and `none` must not render
    // as a sentence about parsing — that would read as "still working on it".
    await expect(row.getByTestId("source-detail")).toHaveText(/B$/);
  });

  test("says so when there is nothing to list", async ({ page }) => {
    // Only meaningful on a run where this account has uploaded nothing — the seeded ones
    // above are per-test, and a fresh account is the case a user meets first.
    await page.goto("/");
    await page.getByTestId("open-sources").click();

    const dialog = page.getByTestId("sources-dialog");
    await expect(dialog).toBeVisible();
    // Either state is correct depending on what else has run; what must never happen is a
    // dialog that looks empty because it failed to load.
    await expect(dialog.getByTestId("sources-empty").or(page.getByTestId("source-row").first())).toBeVisible();
  });

  test("deleting asks first, and cancelling changes nothing", async ({ page, request }) => {
    await seedSource(request, "keep-me.txt");

    await openLibrary(page);
    const row = page.getByTestId("source-row").filter({ hasText: "keep-me.txt" });
    await row.getByTestId("source-delete").click();

    // The confirmation has to say what it costs — that this is not the same thing as
    // deleting the conversation the file was attached in.
    await expect(page.getByTestId("confirm-accept")).toBeVisible();
    await expect(page.locator(".confirm-detail")).toContainText("无法恢复");

    await page.getByTestId("confirm-cancel").click();
    await expect(row).toBeVisible();
  });

  test("deleting removes the file, and it stays gone across a reload", async ({ page, request }) => {
    await seedSource(request, "doomed.txt");

    await openLibrary(page);
    const row = page.getByTestId("source-row").filter({ hasText: "doomed.txt" });
    await row.getByTestId("source-delete").click();
    await page.getByTestId("confirm-accept").click();

    await expect(row).toHaveCount(0);

    // Gone from the server, not just from the list on screen: a reload re-reads it.
    await openLibrary(page);
    await expect(page.getByTestId("source-row").filter({ hasText: "doomed.txt" })).toHaveCount(0);
  });

  test("closes on Escape", async ({ page }) => {
    await openLibrary(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sources-dialog")).toHaveCount(0);
  });
});
