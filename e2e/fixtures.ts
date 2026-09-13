import { test as base, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { AUTH_STATE, AUTH_STORAGE_KEY } from "./auth.js";

/**
 * The suite's `test`, with an authenticated `request` fixture.
 *
 * Playwright builds the built-in `request` context out of `storageState` — and it can only
 * take the *cookies* from it, because that is all an `APIRequestContext` can be pointed at.
 * The session is not a cookie any more, it is a bearer token in `localStorage`, so every
 * `request.post("/api/...")` in the suite started coming back 401.
 *
 * Overriding the fixture rather than adding a second one means the fix is one import per spec
 * and no call site changes: `request` keeps its name, its `baseURL` and its lifetime, and the
 * only thing that moves is that it now carries the session the setup project saved.
 *
 * Browser requests are deliberately *not* touched — `extraHTTPHeaders` at the project level
 * would put a stale token on every request the app makes, including the ones it makes before
 * anyone signs in, which is exactly the kind of thing that hides a real bug.
 */

/** The access token the setup project saved, or undefined when it has not run. */
function savedToken(): string | undefined {
  try {
    const state = JSON.parse(readFileSync(AUTH_STATE, "utf8")) as {
      origins?: { localStorage?: { name: string; value: string }[] }[];
    };
    for (const origin of state.origins ?? []) {
      const entry = origin.localStorage?.find((item) => item.name === AUTH_STORAGE_KEY);
      if (!entry) continue;
      return (JSON.parse(entry.value) as { accessToken?: string }).accessToken;
    }
  } catch {
    // No saved state — a run that never reached the setup project, or a single spec pointed at
    // with `--project`. An unauthenticated context is the honest answer, and whatever needed
    // the session will say so rather than silently acting as nobody.
  }
  return undefined;
}

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ playwright, baseURL }, use) => {
    const accessToken = savedToken();
    const context = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    await use(context);
    await context.dispose();
  },
});

export { expect } from "@playwright/test";
export type { APIRequestContext, Page, Locator, BrowserContext } from "@playwright/test";
