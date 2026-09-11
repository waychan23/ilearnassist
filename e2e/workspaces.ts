import { expect, type Page } from "@playwright/test";

/**
 * Enter a workspace's chat pane from the app's front door.
 *
 * The app opens on the workspace home now, and a card there is the only way into a
 * conversation — so every flow that touches the chat pane starts with this call. A spec that
 * skipped it would be waiting on a composer that never renders, and would fail with a
 * timeout pointing at the wrong thing.
 *
 * `name` is optional and defaults to the first card. Cards are ordered oldest-first, so
 * "first" is the workspace the suite seeded or the one `init()` created on a first run —
 * stable for a spec that never creates one of its own.
 *
 * Reloads land back on the home page: the app deliberately does not remember which
 * workspace you were in, since remembering it would defeat the point of the page. A spec
 * that reloads has to call this again.
 */
export async function enterWorkspace(page: Page, name?: string): Promise<void> {
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  const card = name
    ? page.getByTestId("workspace-card").filter({ hasText: name }).first()
    : page.getByTestId("workspace-card").first();
  await card.getByTestId("workspace-open").click();

  // The composer is the chat pane's own signal that it is up. Waiting here rather than in
  // each spec keeps the "did I get there" question in one place.
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

/** Back out to the workspace list, through the chat pane's own back button. */
export async function leaveWorkspace(page: Page): Promise<void> {
  await page.getByTestId("back-to-workspaces").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
}
