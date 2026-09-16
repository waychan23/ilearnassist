import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Following a page source out of the app.
 *
 * The two halves are tested differently on purpose. `isOpenableUrl` is the predicate the rows
 * *render* on, so it is a pure function and every case is a line. `openExternal` is the one that
 * touches `window` and the confirm dialog, so what matters there is the **ordering** — nothing
 * opens before the user has agreed, and a refusal opens nothing at all — which a stub records.
 */

const confirmMock = vi.fn<(options: unknown) => Promise<boolean>>();

vi.mock("../../src/composables/confirm", () => ({
  confirm: (options: unknown) => confirmMock(options),
}));

const { isOpenableUrl, openExternal, urlHost } = await import("../../src/utils/externalLink");
const { i18n } = await import("../../src/i18n");

let opened: { url: string; target: string; features: string }[] = [];

beforeEach(() => {
  /*
   * Pinned, because the case below asserts the sentence the user reads. A test that inherited
   * jsdom's `en-US` navigator would pass against the English catalog and fail against the
   * Chinese one, which is a test passing for the wrong reason.
   */
  i18n.global.locale.value = "zh-CN";
  opened = [];
  confirmMock.mockReset();
  vi.stubGlobal("open", (url: string, target: string, features: string) => {
    opened.push({ url, target, features });
    return null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isOpenableUrl", () => {
  it("accepts the two schemes a page can have been fetched over", () => {
    expect(isOpenableUrl("http://example.com/a")).toBe(true);
    expect(isOpenableUrl("https://example.com/a?b=c#d")).toBe(true);
  });

  it("refuses every other scheme", () => {
    /*
     * The point of the check, and it is about *where the value is used* rather than about the
     * server: `source_url` is written once and rendered into a click later. A `javascript:` or
     * `data:` value reaching `window.open` runs in this app's own origin, which is a stored-XSS
     * shape rather than the fetch shape `web_fetch`'s guard is about.
     */
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "//example.com/x",
      "/relative/path",
      "not a url",
    ]) {
      expect(isOpenableUrl(bad), bad).toBe(false);
    }
  });

  it("treats an absent URL as nothing to open", () => {
    // Every non-page source is this case: an upload, a file the agent wrote, a diagram.
    expect(isOpenableUrl(undefined)).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });
});

describe("urlHost", () => {
  it("answers with the origin, which is the part that says whose site it is", () => {
    expect(urlHost("https://example.com/a/very/long/path?q=1")).toBe("example.com");
    expect(urlHost("https://sub.example.com:8443/x")).toBe("sub.example.com:8443");
  });

  it("falls back to the value itself when it cannot be parsed", () => {
    // Only reachable through a row whose URL passed `isOpenableUrl`, so this is belt and braces —
    // but a warning line that renders nothing would be worse than one that renders the raw string.
    expect(urlHost("nonsense")).toBe("nonsense");
  });
});

describe("openExternal", () => {
  it("confirms before opening, and opens in a new tab without a handle back", async () => {
    confirmMock.mockResolvedValue(true);

    await expect(openExternal("https://example.com/page")).resolves.toBe(true);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const options = confirmMock.mock.calls[0]![0] as { title: string; detail: string };
    // The warning names what is happening and where it goes; the destination is the detail.
    expect(options.title).toBe("即将打开第三方网址");
    expect(options.detail).toBe("example.com");

    expect(opened).toEqual([
      { url: "https://example.com/page", target: "_blank", features: "noopener,noreferrer" },
    ]);
  });

  it("opens nothing when the user declines", async () => {
    // The whole point of asking. Asserted as "no call at all" rather than as a return value, since
    // a `window.open` that happened before the confirmation would satisfy either signature.
    confirmMock.mockResolvedValue(false);

    await expect(openExternal("https://example.com/page")).resolves.toBe(false);
    expect(opened).toEqual([]);
  });

  it("opens nothing for a URL it would not offer, and does not even ask", async () => {
    // A row cannot reach this — the control renders on `isOpenableUrl` — so the case is about the
    // function being safe on its own rather than about a reachable UI state. Asking first would be
    // the worse failure: a confirmation for something that will not happen.
    await expect(openExternal("javascript:alert(1)")).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });
});
