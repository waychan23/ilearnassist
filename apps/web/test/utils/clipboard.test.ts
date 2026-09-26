import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canWriteRich, copyRich, copyText } from "../../src/utils/clipboard";

/**
 * The clipboard writer every copy control goes through.
 *
 * The branch this file exists for is the one the app is *served* on: LAN sharing hands out
 * `http://192.168.x.x:<port>`, which is not a secure context, so `navigator.clipboard` is
 * `undefined` there and the reported failure was a synchronous `TypeError` thrown out of
 * `navigator.clipboard.writeText` before any `.catch` could see it. jsdom has no clipboard API
 * either, so the second branch is the default here rather than a contrived state — and the third
 * branch (no fallback available at all) is the one the callers' "failed" labels are for.
 *
 * jsdom also has no `document.execCommand`, so the fallback is stubbed rather than assumed; that
 * is itself worth knowing, because it means `legacyCopy`'s own feature check is what the last
 * case exercises.
 */

/** jsdom does not implement it, so it is defined rather than spied on. */
const originalExec = (document as unknown as { execCommand?: unknown }).execCommand;

function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", { value: fn, configurable: true, writable: true });
  return fn;
}

/**
 * What the fallback's textarea looked like at the moment the copy was attempted.
 *
 * The selection range rather than `document.activeElement`: `select()` sets the range without
 * moving focus, and the range is the part `execCommand("copy")` actually reads.
 */
function captureTextarea(): { value?: string; selected?: boolean } {
  const area = document.querySelector("textarea");
  return {
    value: area?.value,
    selected: area != null && area.selectionStart === 0 && area.selectionEnd === area.value.length,
  };
}

/** Enough of `ClipboardItem` for the rich path: the constructor and its `types` list. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Blob>) {}
  get types(): string[] {
    return Object.keys(this.data);
  }
}

const writeText = vi.fn<(text: string) => Promise<void>>();
const write = vi.fn<(items: unknown[]) => Promise<void>>();

function withClipboard(): void {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText, write } });
}

function withoutClipboard(): void {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  write.mockReset();
  write.mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, "execCommand", {
    value: originalExec,
    configurable: true,
    writable: true,
  });
});

describe("copyText", () => {
  it("uses the clipboard API when the browser has one", async () => {
    withClipboard();
    const exec = stubExecCommand(true);

    await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to a selectable box where there is no clipboard API", async () => {
    /*
     * The reported bug, as a test: the origin is a plain-http LAN address, so `navigator.clipboard`
     * is undefined and the write has to happen some other way. `execCommand` is deprecated and is
     * the only thing a non-secure context has.
     */
    withoutClipboard();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
    let seen: { value?: string; selected?: boolean } = {};
    exec.mockImplementation(() => {
      seen = captureTextarea();
      return true;
    });

    await expect(copyText("const a = 1;")).resolves.toBeUndefined();

    expect(exec).toHaveBeenCalledWith("copy");
    // Off-screen rather than hidden, and *selected*: `display: none` cannot be selected, and an
    // unselected box copies nothing. The textarea holds everything, from 0 to the end.
    expect(seen).toEqual({ value: "const a = 1;", selected: true });
    // Never left behind: this element is not meant to be seen at all.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("rejects when the fallback is not there either", async () => {
    // What the "copy failed" labels are for. Swallowing it here would leave every caller showing
    // a success that did not happen.
    withoutClipboard();
    Object.defineProperty(document, "execCommand", { value: undefined, configurable: true, writable: true });

    await expect(copyText("hello")).rejects.toThrow();
  });

  it("rejects when the fallback refuses", async () => {
    withoutClipboard();
    stubExecCommand(false);

    await expect(copyText("hello")).rejects.toThrow();
  });
});

describe("canWriteRich", () => {
  it("is false without a clipboard API, and false without ClipboardItem", () => {
    withoutClipboard();
    expect(canWriteRich()).toBe(false);

    withClipboard();
    vi.stubGlobal("ClipboardItem", undefined);
    expect(canWriteRich()).toBe(false);
  });

  it("is true when both halves are there", () => {
    withClipboard();
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    expect(canWriteRich()).toBe(true);
  });
});

describe("copyRich", () => {
  it("writes the text and the markup together", async () => {
    withClipboard();
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    await copyRich("a | b", "<table><tr><td>a</td></tr></table>");

    expect(writeText).not.toHaveBeenCalled();
    const items = write.mock.calls[0]?.[0] as FakeClipboardItem[];
    expect(items).toHaveLength(1);
    // Both flavours in one item, so the *target* decides which one it takes — the table pasted
    // into a document, the text pasted into a source file.
    expect(items[0]?.types.sort()).toEqual(["text/html", "text/plain"]);
  });

  it("writes the text alone when there is no markup", async () => {
    withClipboard();
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    await copyRich("plain", null);

    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("plain");
  });

  it("writes the text alone where the browser cannot carry markup", async () => {
    // A copy that took the plainer of the two is a copy; rejecting here would report a failure
    // that did not happen.
    withClipboard();
    vi.stubGlobal("ClipboardItem", undefined);

    await copyRich("plain", "<b>plain</b>");

    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("plain");
  });

  it("falls through to the non-secure route when there is no clipboard API", async () => {
    withoutClipboard();
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const exec = stubExecCommand(true);

    await copyRich("plain", "<b>plain</b>");

    expect(exec).toHaveBeenCalledWith("copy");
  });
});
