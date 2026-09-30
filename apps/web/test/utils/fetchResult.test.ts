import { describe, expect, it } from "vitest";
import { WEB_FETCH_TOOL_NAME, type ToolCall } from "../../src/api/types";
import { keepablePageUrl } from "../../src/utils/fetchResult";

/**
 * Which `web_fetch` calls offer "keep as a source", and with what URL.
 *
 * The rule is two gates and one field: the call must be this tool, it must have finished without
 * failing, and its arguments must name a URL. Each gate has a case below, because the failure it
 * prevents is a live control that can only fail: the press re-fetches through the same guard the
 * call already went through, so a fetch that errored would error again.
 */

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "call_1",
    name: WEB_FETCH_TOOL_NAME,
    input: JSON.stringify({ url: "https://flink.apache.org/downloads/" }),
    output: "URL: https://flink.apache.org/downloads/\nTitle: Downloads\n\nApache Flink 2.3.0",
    ...over,
  };
}

describe("keepablePageUrl", () => {
  it("returns the URL a finished fetch asked for", () => {
    expect(keepablePageUrl(call())).toBe("https://flink.apache.org/downloads/");
  });

  it("offers nothing while the call is still running", () => {
    // No output yet — the card draws the control only once there is a page to keep.
    expect(keepablePageUrl(call({ output: undefined }))).toBeNull();
  });

  it("offers nothing for a failed fetch", () => {
    // The loop's own error contract, the sentence `FileCard` reads by. Keeping would re-fetch
    // through the same guard and fail again; the toast is the only outcome, so there is no control.
    expect(keepablePageUrl(call({ output: "Tool error: HTTP 404 from https://flink.apache.org/x" })))
      .toBeNull();
    expect(keepablePageUrl(call({ output: "Tool error: Refusing to fetch private address: 127.0.0.1" })))
      .toBeNull();
  });

  it("offers nothing on any other tool's call", () => {
    // `ila_collect_page` is the model's own keep and has already happened; a search has no one URL.
    expect(keepablePageUrl(call({ name: "web_search" }))).toBeNull();
    expect(keepablePageUrl(call({ name: "ila_collect_page" }))).toBeNull();
    expect(keepablePageUrl(call({ name: "read_file" }))).toBeNull();
  });

  it("offers nothing when the arguments carry no usable URL", () => {
    expect(keepablePageUrl(call({ input: JSON.stringify({}) }))).toBeNull();
    expect(keepablePageUrl(call({ input: JSON.stringify({ url: 42 }) }))).toBeNull();
    expect(keepablePageUrl(call({ input: JSON.stringify({ url: "   " }) }))).toBeNull();
    // A truncated or hand-edited argument string is not a URL either — the card simply shows no
    // control rather than throwing inside a render.
    expect(keepablePageUrl(call({ input: "not json" }))).toBeNull();
  });

  it("trims the URL the model typed", () => {
    // `captureWebPage` trims too, but the request body is what a test and a log read.
    expect(keepablePageUrl(call({ input: JSON.stringify({ url: "  https://example.com/a  " }) })))
      .toBe("https://example.com/a");
  });
});
