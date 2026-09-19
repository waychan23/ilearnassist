import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, translateApiError, translateParseError } from "../../src/utils/apiError";
import { i18n } from "../../src/i18n";

/**
 * The translator is the single point where a server error becomes user-facing text, so it
 * is tested directly rather than only through `api/client.ts`.
 *
 * The locale is pinned per describe block instead of in a global setup: a test that asserts
 * language should say so itself, or a locale-dependent break hides in the suite most likely
 * to have one.
 */

describe("translateApiError", () => {
  beforeEach(() => {
    i18n.global.locale.value = "zh-CN";
  });
  afterEach(() => {
    i18n.global.locale.value = "zh-CN";
  });

  it("renders an API code in the active language", () => {
    expect(translateApiError("SESSION_NOT_FOUND", undefined, "session not found")).toBe(
      "会话不存在，可能已被删除。"
    );
  });

  it("renders a parse code from the same lookup", () => {
    // The two unions share one namespace resolution, so a parse code resolves too.
    expect(translateParseError("local_disabled", undefined, "local disabled")).toBe(
      "本地解析已被关闭。"
    );
  });

  it("interpolates params", () => {
    expect(translateApiError("FILE_TOO_LARGE", { limitMb: 20 }, "too large")).toBe(
      "文件超过 20 MB 限制。"
    );
  });

  it("switches language with the locale", () => {
    i18n.global.locale.value = "en";
    expect(translateApiError("SESSION_NOT_FOUND", undefined, undefined)).toBe(
      "That conversation no longer exists."
    );
  });

  it("falls back to the server's own sentence for an unknown code", () => {
    // A newer server, or a code this build has no message for. It must never render the
    // key path, which is what a bare `t()` on a missing key would return.
    expect(translateApiError("SOMETHING_NEW", undefined, "the server said this")).toBe(
      "the server said this"
    );
  });

  it("returns an empty string when there is neither a code nor a fallback", () => {
    expect(translateApiError(undefined, undefined, undefined)).toBe("");
  });

  it("does not spill a parse code into the API namespace", () => {
    // Both lookups are consulted, but a code only ever has one home — a parse code must
    // not resolve against `errors.*` and vice versa.
    expect(translateParseError("no_text_layer", undefined, undefined)).toContain("文本层");
    expect(translateApiError("MODEL_NOT_FOUND", undefined, undefined)).toContain("模型");
  });
});

describe("ApiError", () => {
  it("carries the code and status alongside the message", () => {
    const err = new ApiError("ONLY_PROVIDER", "cannot delete", 409);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect(err.code).toBe("ONLY_PROVIDER");
    expect(err.status).toBe(409);
    expect(err.message).toBe("cannot delete");
  });
});
