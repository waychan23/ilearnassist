import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY, INSTANCE_STORAGE_KEY } from "@ilearnassist/shared";

/**
 * Which installation is behind this origin, decided before the token is used.
 *
 * The claims worth pinning are the ones that decide whether somebody stays signed in: a *new*
 * installation drops the credential and the address, a *reachable but unchanged* one changes
 * nothing, and an **unreachable** one concludes nothing at all — a dropped connection clearing a
 * working session would be the worse of the two mistakes by a wide margin.
 */

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  api: { health: mocks.health },
  // The real one writes the same key this test reads, which is the point: the reset goes through
  // the client's own clear rather than reaching into storage behind it.
  setStoredTokens: vi.fn((next: unknown) => {
    if (next) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }),
}));

import { syncInstallation } from "../../src/composables/instance";

const TOKENS = JSON.stringify({ accessToken: "a", refreshToken: "r" });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("syncInstallation", () => {
  it("records the id on a first visit and changes nothing", async () => {
    mocks.health.mockResolvedValue({ ok: true, instance: "inst-1" });
    localStorage.setItem(AUTH_STORAGE_KEY, TOKENS);

    await syncInstallation();

    expect(localStorage.getItem(INSTANCE_STORAGE_KEY)).toBe("inst-1");
    // Nothing to have gone stale: this browser had never talked to an installation.
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(TOKENS);
  });

  it("leaves a session alone when it is the same installation", async () => {
    mocks.health.mockResolvedValue({ ok: true, instance: "inst-1" });
    localStorage.setItem(INSTANCE_STORAGE_KEY, "inst-1");
    localStorage.setItem(AUTH_STORAGE_KEY, TOKENS);

    await syncInstallation();

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(TOKENS);
  });

  it("drops the token and the address when the installation differs", async () => {
    /*
     * The reported failure, in one case. A different database has never issued this token, so
     * every request carrying it is a 401 dressed up as an expired session; and the address names a
     * workspace in the database that is gone, which the guard would hand back after the sign-in.
     */
    mocks.health.mockResolvedValue({ ok: true, instance: "inst-2" });
    localStorage.setItem(INSTANCE_STORAGE_KEY, "inst-1");
    localStorage.setItem(AUTH_STORAGE_KEY, TOKENS);
    window.history.replaceState(null, "", "/w/old-workspace/s/old-session");

    await syncInstallation();

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(window.location.pathname).toBe("/");
    // And the new id is recorded, so the next difference is detectable too.
    expect(localStorage.getItem(INSTANCE_STORAGE_KEY)).toBe("inst-2");
  });

  it("keeps the browser's own preferences", async () => {
    // The theme and the language live in the same storage and are properties of this *browser*
    // rather than of the account — nothing about them belongs to the installation that went away.
    mocks.health.mockResolvedValue({ ok: true, instance: "inst-2" });
    localStorage.setItem(INSTANCE_STORAGE_KEY, "inst-1");
    localStorage.setItem("gl-theme", "dark");
    localStorage.setItem("gl-locale", "en");

    await syncInstallation();

    expect(localStorage.getItem("gl-theme")).toBe("dark");
    expect(localStorage.getItem("gl-locale")).toBe("en");
  });

  it("concludes nothing from a server it cannot reach", async () => {
    /*
     * A request that did not come back says nothing about which database is behind the origin —
     * and clearing a working session over a dropped connection signs somebody out of an
     * installation that is fine.
     */
    mocks.health.mockRejectedValue(new Error("offline"));
    localStorage.setItem(INSTANCE_STORAGE_KEY, "inst-1");
    localStorage.setItem(AUTH_STORAGE_KEY, TOKENS);

    await expect(syncInstallation()).resolves.toBeUndefined();

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(TOKENS);
    expect(localStorage.getItem(INSTANCE_STORAGE_KEY)).toBe("inst-1");
  });

  it("treats a reply with no id as an older server rather than a different one", async () => {
    // A version skew is not an installation change, and inventing a difference would sign
    // everybody out on a rolling upgrade.
    mocks.health.mockResolvedValue({ ok: true });
    localStorage.setItem(INSTANCE_STORAGE_KEY, "inst-1");
    localStorage.setItem(AUTH_STORAGE_KEY, TOKENS);

    await syncInstallation();

    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(TOKENS);
    expect(localStorage.getItem(INSTANCE_STORAGE_KEY)).toBe("inst-1");
  });
});
