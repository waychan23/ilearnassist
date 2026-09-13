import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Signing in, for the browser suite.
 *
 * Every spec needs a session — the API refuses everything without one — and almost none of
 * them are *about* sessions. So the bootstrap happens once, in a setup project, and its result
 * is handed to every other project as browser state: no spec has to know how a token is
 * obtained, and `workspaces.ts`'s front door is unchanged.
 *
 * **The session is a bearer token in `localStorage`, not a cookie**, and that changes one thing
 * about this harness worth stating here rather than in each spec that trips over it: signing
 * out *revokes* the token server-side. The state every spec starts from is one session, shared
 * through `storageState`, so a spec that signs out would sign out everything that runs after
 * it. `forgetSession` is the way round that — it drops the local copy without telling the
 * server, so the next sign-in opens a session of its own.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The `localStorage` key the browser keeps its token pair under.
 *
 * Spelled here as well as in `packages/shared`, and the duplication is deliberate: the root
 * tsconfig does not resolve the workspace package, and pulling the whole shared module into
 * every spec's import graph for one string is worse than repeating it. The two copies are held
 * in step by an assertion rather than by this comment — see
 * `apps/web/test/authStorageKey.test.ts`, the same arrangement `composables/breakpoints.ts`
 * has with `style.css`.
 */
export const AUTH_STORAGE_KEY = "ila-auth";

/**
 * Where the signed-in state is written, and read back.
 *
 * Under `.e2e/`, which `global-teardown.ts` removes — so a stale session cannot survive into
 * the next run, and a run that fails before the setup project cannot inherit one from the
 * run before it.
 */
export const AUTH_STATE = join(ROOT, ".e2e", "auth.json");

/**
 * The administrator every spec acts as, and the password the chained CLI creates it with.
 *
 * Fixed rather than random so a failure names something a person can type into the sign-in
 * form and reproduce. The account is made before the server starts — see
 * `playwright.config.ts`, which chains `cli ensure-admin` — not through the browser: the web
 * app cannot create accounts. The same two constants name that account on both sides.
 */
export const SIGNED_IN_AS = "tester";
export const SIGNED_IN_PASSWORD = "e2e-password-123";

/**
 * Sign in through the real form.
 *
 * Shared with `login.spec.ts`, which is the point: the spec that proves the form works is
 * exercising the same path every other spec depends on, so the two cannot drift apart.
 */
export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
}

/**
 * Drop the session this tab holds, without telling the server.
 *
 * The shared state every spec starts from is one session, and signing out through the app
 * *revokes* it — so a spec that is about signing out, or that wants a different account, must
 * let go of it locally rather than spend it. The next `signIn` then opens a session of its
 * own, and the state file's session stays alive for everything that runs afterwards.
 *
 * Nothing else clears storage: `localStorage.clear()` would take the locale with it, and the
 * app would come back in English with every selector in this suite broken.
 */
export async function forgetSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate((key) => window.localStorage.removeItem(key), AUTH_STORAGE_KEY);
  await page.reload();
  await expect(page.getByTestId("login-form")).toBeVisible();
}

/* --------------------------------- the API ---------------------------------- */
/*
 * Two helpers that go round the UI on purpose.
 *
 * An account can only be made from the console, and a spec that needs a *second* one should
 * not have to drive a dialog to get it — so these use the same routes the console does, with a
 * token obtained the same way. Everything they exercise is pinned by `apps/server/test/`; what
 * they are for here is setting a scene.
 */

async function tokenFor(
  request: APIRequestContext,
  username: string,
  password: string
): Promise<string> {
  const res = await request.post("/api/auth/login", { data: { username, password } });
  expect(res.ok(), `signing in over the API as "${username}"`).toBeTruthy();
  return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken;
}

/**
 * Make sure an ordinary account exists, and answer with the password it signs in with.
 *
 * Created with a generated one and settled onto a known one, which is the whole journey a
 * person takes: an administrator hands over a password, and the first thing the account does
 * with it is replace it. Going round that would leave a `mustChangePassword` account that
 * every route refuses, and a spec using it would be testing a state no real account is in.
 */
export async function ensureUser(request: APIRequestContext, username: string): Promise<string> {
  const password = `e2e-${username}-password`;
  const admin = await tokenFor(request, SIGNED_IN_AS, SIGNED_IN_PASSWORD);
  const created = await request.post("/api/admin/users", {
    headers: { Authorization: `Bearer ${admin}` },
    data: { username },
  });

  // Already made earlier in this run. Signing in with the settled password is also the check
  // that the earlier call got all the way through it, rather than answering a password nobody
  // can use.
  if (created.status() === 409) {
    await tokenFor(request, username, password);
    return password;
  }
  expect(created.ok(), `creating "${username}"`).toBeTruthy();
  const issued = ((await created.json()) as { password: string }).password;

  const first = await tokenFor(request, username, issued);
  const changed = await request.post("/api/auth/password", {
    headers: { Authorization: `Bearer ${first}` },
    data: { oldPassword: issued, newPassword: password },
  });
  expect(changed.ok(), `settling the password for "${username}"`).toBeTruthy();
  return password;
}
