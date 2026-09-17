import { expect, type Page } from "@playwright/test";

/**
 * Enter a workspace's chat pane from the app's front door.
 *
 * A card on the workspace home is the only way into a conversation — so every flow that
 * touches the chat pane starts with this call. A spec that skipped it would be waiting on a
 * composer that never renders, and would fail with a timeout pointing at the wrong thing.
 *
 * `name` is optional and defaults to the first card. Cards are ordered oldest-first, so
 * "first" is the workspace the suite seeded or the one `loadApp` created on a first run —
 * stable for a spec that never creates one of its own.
 *
 * **The front door is where this starts from, and the app no longer guarantees it is there.**
 * A reload used to land on the workspace list, because the page was held in memory; a page is
 * a URL now, so a reload lands back in the conversation it was in — including in the ~20 specs
 * that reload to prove something survived a round trip to the database and then call this to
 * get back. Rather than have each of them remember to leave first, this normalises: if the
 * workspace home is not on screen, it goes there. The specs keep testing what they were
 * testing, and `routing.spec.ts` is where staying put is the assertion.
 */
export async function enterWorkspace(page: Page, name?: string): Promise<void> {
  if (!(await page.getByTestId("workspace-home").isVisible())) {
    await page.goto("/");
  }
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  const card = name
    ? page.getByTestId("workspace-card").filter({ hasText: name }).first()
    : page.getByTestId("workspace-card").first();
  await card.getByTestId("workspace-open").click();

  // The composer is the chat pane's own signal that it is up. Waiting here rather than in
  // each spec keeps the "did I get there" question in one place.
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

/**
 * Back out to the workspace list, through the sidebar header's own back button.
 *
 * It is the sidebar's rather than the chat header's, which is the only one there is: the
 * workspace list is reached from the rail that names the workspace you are in, and that rail is
 * a drawer on a compact viewport — so this opens it first and the click closes it on the way out.
 */
export async function leaveWorkspace(page: Page): Promise<void> {
  // The toggle is `v-if="isCompact"`, so its presence is the viewport's answer rather than a
  // guess: on a wide screen the sidebar is in flow and the click below is the whole of it. On a
  // compact one the click has to be what *opens* it first — the back button lives inside the
  // drawer, and the drawer closes itself on the way out.
  const navToggle = page.getByTestId("nav-toggle");
  if (await navToggle.count()) await navToggle.click();
  await page.getByTestId("all-workspaces").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
}
