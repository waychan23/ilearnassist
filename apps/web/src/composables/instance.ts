import { INSTANCE_STORAGE_KEY } from "@ilearnassist/shared";
import type { HealthResponse } from "@ilearnassist/shared";
import { api, setStoredTokens } from "../api/client";

/**
 * Whether the database behind this origin is still the one this browser was using.
 *
 * A bearer token has no way to tell "my session aged out" from "somebody pointed this origin at a
 * different installation", and the two want opposite answers: the first is a sign-in form, the
 * second is a **stale credential and a stale address** that will fail in confusing ways. This is
 * the second, and it is not theoretical — the desktop control panel's data-root picker restarts
 * the server on the same port, so a tab that was already open comes back to a different database
 * holding a token that means nothing there and a URL naming a workspace that never existed in it.
 * The reported symptom is a 会话不存在 toast on a page the reader did nothing to reach.
 *
 * **One request, before anything else happens.** The check runs ahead of the router — see
 * `main.ts` — because the question has to be settled before the token is *used*: afterwards, the
 * answer arrives as a 401 whose handling is indistinguishable from an expired session, which is
 * the confusion this exists to remove.
 *
 * **Stored in the database, compared in the browser.** The id is the installation's own and lives
 * in `app_settings`, which is what makes a *moved* data folder the same installation — its
 * accounts and its tokens travelled with it — while a different folder is a different one. See
 * `SETTING_INSTANCE_ID`.
 *
 * **A failure to reach the server is not a change.** Nothing can be concluded from a request that
 * did not come back, and clearing a working session over a dropped connection would be the worse
 * of the two mistakes by a wide margin: it signs somebody out of an installation that is fine.
 */
export async function syncInstallation(): Promise<void> {
  let health: HealthResponse;
  try {
    health = await api.health();
  } catch {
    return;
  }

  const server = health.instance;
  // A build older than this field, or one that answered without it. Nothing to compare against,
  // and inventing a difference would sign everybody out on a version skew.
  if (!server) return;

  const known = readStoredInstance();
  writeStoredInstance(server);
  // First visit from this browser: there is nothing to have gone stale, and the id is now
  // recorded so the *next* difference is detectable.
  if (known === null || known === server) return;

  resetForNewInstallation();
}

/**
 * Drop what belonged to the installation that is gone.
 *
 * Two things, and each is a different way the stale state bites. The **token** is a credential the
 * new database has never issued, so every request carrying it is a 401 dressed up as an expired
 * session. The **address** is a `/w/<id>/s/<id>` that named a workspace in the old database — and
 * it outlives the token, because the guard that sends a signed-out reader to the sign-in screen
 * remembers where they were going and hands it back after they sign in.
 *
 * The address is dealt with **twice, on purpose, because one of the two does not work alone.**
 * `history.replaceState` takes it out of the address bar, which is what a reload then reads —
 * but the router captured the location when `createWebHistory()` ran at *import* time, which is
 * before this function can possibly have finished its request. So the first navigation still goes
 * to the old path, and `staleAddress` is what tells the guard not to carry it forward as a
 * `?redirect=`.
 *
 * The theme and the language are **not** cleared, deliberately: they are properties of this
 * browser rather than of the account, they live in the same storage, and losing them would be a
 * cost with nothing on the other side of it.
 */
function resetForNewInstallation(): void {
  setStoredTokens(null);
  staleAddress = true;
  try {
    window.history.replaceState(null, "", "/");
  } catch {
    // A history that refuses to be rewritten (a sandboxed frame, an exotic embedding) is not a
    // reason to keep a token that does not work, and the guard's own half still stands.
  }
}

/** Whether the address this tab opened on belonged to an installation that is gone. */
let staleAddress = false;

/**
 * Read that, **once**.
 *
 * A one-shot rather than a flag, because the statement it carries is about *the navigation that
 * is already in flight*: "where you were going is not somewhere to come back to". Read on every
 * refusal it would go on suppressing the redirect after a later sign-out, which is the opposite
 * of what a reader who has just been signed out wants — `routes.spec.ts` covers a bookmark
 * surviving a sign-in, and that behaviour has to keep working for everybody who did not switch
 * installations.
 */
export function consumeStaleAddress(): boolean {
  const stale = staleAddress;
  staleAddress = false;
  return stale;
}

/** Absent means "this browser has not talked to an installation yet", which is not a change. */
function readStoredInstance(): string | null {
  try {
    return localStorage.getItem(INSTANCE_STORAGE_KEY);
  } catch {
    // Private browsing with storage disabled. Every visit then looks like a first one, which
    // resets nothing — the safe direction to fail in.
    return null;
  }
}

function writeStoredInstance(id: string): void {
  try {
    localStorage.setItem(INSTANCE_STORAGE_KEY, id);
  } catch {
    /* see `readStoredInstance` */
  }
}
