import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../src/i18n.js";
import { relativeTime } from "../../src/composables/relativeTime.js";

/**
 * The shared "how long ago" wording.
 *
 * Both surfaces that show a timestamp read it from here — the workspace cards and the file
 * lists — so what is worth pinning is that the bucket arithmetic reaches the right *key*, and
 * that `en`'s plural branches are actually taken. jsdom's navigator is en-US, so the locale is
 * pinned rather than inherited: an assertion on wording that passed because of the ambient
 * locale would be passing for the wrong reason.
 */

/** `ms` ago, as the ISO string a `FileEntry.modifiedAt` or a `Workspace` arrives with. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

afterEach(() => {
  i18n.global.locale.value = "zh-CN";
});

describe("relativeTime", () => {
  it("words each bucket from the shared time.* keys", () => {
    i18n.global.locale.value = "zh-CN";

    expect(relativeTime(ago(5 * SECOND))).toBe("刚刚");
    expect(relativeTime(ago(5 * MINUTE))).toBe("5 分钟前");
    expect(relativeTime(ago(3 * HOUR))).toBe("3 小时前");
    expect(relativeTime(ago(2 * DAY))).toBe("2 天前");
  });

  it("falls back to the bare date past a week", () => {
    // Ten days ago is a date rather than a count: "10 days ago" is a number the reader has to
    // convert back, which is the whole reason the buckets stop where they do.
    const iso = ago(10 * DAY);
    expect(relativeTime(iso)).toBe(iso.slice(0, 10));
  });

  it("takes the count in the plural position, which is where en branches", () => {
    i18n.global.locale.value = "en";

    expect(relativeTime(ago(1 * MINUTE))).toBe("1 minute ago");
    expect(relativeTime(ago(5 * MINUTE))).toBe("5 minutes ago");
    expect(relativeTime(ago(1 * DAY))).toBe("1 day ago");
  });

  it("shows an unparseable timestamp rather than calling it now", () => {
    // A server bug, not a user-facing state. "just now" would be a lie dressed as a fallback,
    // so the value that actually arrived is what is rendered.
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});
