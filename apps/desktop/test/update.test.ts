import { describe, expect, it, vi } from "vitest";
import {
  RELEASES_API,
  RELEASES_PAGE,
  checkForUpdate,
  isNewer,
  parseVersion,
} from "../src/main/update.js";

/**
 * The version check, driven entirely through an injected `fetch`.
 *
 * The success path is the least interesting half. What matters is that **it cannot go wrong
 * loudly**: a control panel is the one screen that exists for when something else is broken, so a
 * failed version check must read as "nothing to report" rather than as an error — and a malformed
 * reply must not be cached as "you are up to date", which would suppress the next launch's check
 * too.
 */

/** A `fetch` that answers one canned response. */
function answering(init: { ok?: boolean; json?: () => Promise<unknown>; status?: number }): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: init.json ?? (async () => ({})),
    }) as unknown as Response) as unknown as typeof fetch;
}

const release = (tag: string, url = "https://github.com/waychan23/ilearnassist/releases/tag/x") =>
  answering({ json: async () => ({ tag_name: tag, html_url: url }) });

describe("parseVersion", () => {
  it("reads a plain or v-prefixed semver, and ignores a suffix", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" v1.2.3 ")).toEqual([1, 2, 3]);
    // A pre-release compares as its release, which is the right answer for "is there something
    // newer to look at".
    expect(parseVersion("0.2.0-beta.1")).toEqual([0, 2, 0]);
  });

  it("refuses anything that is not a version rather than guessing", () => {
    for (const bad of ["", "latest", "1.2", "v", null, 42, undefined]) {
      expect(parseVersion(bad), String(bad)).toBeNull();
    }
  });
});

describe("isNewer", () => {
  it("compares numbers, not strings", () => {
    // The one that a string comparison gets exactly backwards, and it is not a hypothetical: a
    // project that reaches double digits would start telling users to "upgrade" to an older
    // release.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("is false for the same version, and for one behind", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
  });

  it("is false rather than throwing when either side is unreadable", () => {
    // A dev build with a hand-edited version must not be told it is behind, and a tag that is not
    // semver must not crash the panel.
    expect(isNewer(null, "0.1.0")).toBe(false);
    expect(isNewer("not-a-version", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "also-not-a-version")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("reports a newer release, with the page to download it from", async () => {
    const result = await checkForUpdate({
      current: "0.1.0",
      fetchImpl: release("v0.2.0", "https://github.com/waychan23/ilearnassist/releases/tag/v0.2.0"),
    });

    expect(result).toEqual({
      latest: "0.2.0",
      url: "https://github.com/waychan23/ilearnassist/releases/tag/v0.2.0",
      available: true,
    });
  });

  it("asks the right endpoint, and identifies itself", async () => {
    // GitHub answers 403 without a `User-Agent`, and asserts on the URL so a typo in the repo path
    // fails here rather than silently reporting "no updates" forever.
    const spy = vi.fn(
      (async () => ({ ok: true, json: async () => ({ tag_name: "v0.1.0" }) })) as unknown as typeof fetch
    );
    await checkForUpdate({ current: "0.1.0", fetchImpl: spy as unknown as typeof fetch });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RELEASES_API);
    expect(url).toContain("waychan23/ilearnassist");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });

  it("reports nothing when the running version is the latest, or ahead of it", async () => {
    expect(await checkForUpdate({ current: "0.1.0", fetchImpl: release("v0.1.0") })).toEqual({
      latest: "0.1.0",
      url: expect.any(String),
      available: false,
    });
    // A dev build ahead of the last release: it knows the version, and it is not behind.
    expect((await checkForUpdate({ current: "0.3.0", fetchImpl: release("v0.2.0") })).available).toBe(
      false
    );
  });

  it("answers 'nothing' for every way the network can fail", async () => {
    // Each of these is a real shape: no connection, a rate limit, a proxy's HTML error page, and a
    // reply that is JSON but not a release.
    const failures: [string, typeof fetch][] = [
      ["offline", (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch],
      ["rate limited", answering({ ok: false, status: 403 })],
      ["not found", answering({ ok: false, status: 404 })],
      ["HTML", answering({ json: async () => { throw new SyntaxError("Unexpected token <"); } })],
      ["not a release", answering({ json: async () => ({ message: "Not Found" }) })],
      ["no tag", answering({ json: async () => ({ html_url: "x" }) })],
    ];

    for (const [what, fetchImpl] of failures) {
      const result = await checkForUpdate({ current: "0.1.0", fetchImpl });
      expect(result, what).toEqual({ latest: null, url: null, available: false });
    }
  });

  it("falls back to the releases page when the reply has no link of its own", async () => {
    // `html_url` is what GitHub sends, but a reply without it should still be actionable rather
    // than leaving a notice with nothing to click.
    const result = await checkForUpdate({
      current: "0.1.0",
      fetchImpl: answering({ json: async () => ({ tag_name: "v9.9.9" }) }),
    });
    expect(result.url).toBe(RELEASES_PAGE);
  });
});
