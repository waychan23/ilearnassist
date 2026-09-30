import { WEB_FETCH_TOOL_NAME, type ToolCall } from "../api/types";

/**
 * The URL a `web_fetch` card can offer to keep, or `null` when its card offers nothing.
 *
 * Two questions with one answer: the call must be one the control can act on at all — a
 * `web_fetch` that finished without failing — and the URL is the one the model asked for.
 *
 * **A failed fetch must not offer to keep.** The press re-fetches through the same SSRF guard, so
 * a page that just refused to load would refuse again, and a control whose only reachable outcome
 * is an error toast is worse than no control. The error prefix is the loop's contract with the
 * model — `Tool error: …`, the same one `FileCard` reads by — and the parse lives here rather than
 * in the component because a component is covered by Playwright alone, so this rule could only be
 * pinned by a browser run restating the sentence it depends on.
 *
 * The URL comes from the call's **arguments**, not the `URL:` header its result opens with: the
 * keep route fetches whatever it is given and follows redirects itself, so the model's address is
 * the honest input — the page's final address is the server's to decide, not this parse's.
 */
export function keepablePageUrl(call: ToolCall): string | null {
  if (call.name !== WEB_FETCH_TOOL_NAME) return null;
  if (call.output === undefined || call.output.startsWith("Tool error:")) return null;

  try {
    const url = (JSON.parse(call.input) as { url?: unknown }).url;
    return typeof url === "string" && url.trim().length > 0 ? url.trim() : null;
  } catch {
    return null;
  }
}
