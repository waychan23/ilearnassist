import { confirm } from "../composables/confirm";
import { i18n } from "../i18n";

/**
 * Leaving the app for a page the model chose to keep.
 *
 * A page source carries the URL it was fetched from (`Source.url`), and until now that URL was
 * unreachable: the row opened the *stored HTML* in the preview dialog, which is the app's copy of
 * the reading rather than the page. Following it is a different action with a different risk, so it
 * gets its own control, its own warning and its own module.
 *
 * ### Why the scheme is checked here
 *
 * Every caller already knows the row is a page — the server sets `source_url` only for something
 * `web_fetch` guarded — so an `http`/`https` check is not the security boundary. `web_fetch`'s SSRF
 * guard is (the server fetches, so a private address never becomes a page in the first place), and
 * nothing here re-opens that question: the browser is the one making this request, from the user's
 * own machine, which is the whole difference from the tool.
 *
 * It is checked anyway because the value is *stored* and then *rendered into a click*, and those
 * are two different moments. A scheme like `javascript:` or `data:` reaching `window.open` would
 * run in the app's own origin — a stored-XSS shape, not a fetch shape. One predicate, applied at
 * the point of use, is what keeps a future writer of that column from being the thing that
 * decides.
 */

/** Only the two schemes a page can legitimately have been fetched over. */
export function isOpenableUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    // A relative or malformed value is not a page. `new URL` throwing is the same answer.
    return false;
  }
}

/**
 * The host alone, for the warning's second line.
 *
 * The point of showing *something* rather than only asking "are you sure" is that the decision is
 * about **where** you are going: a reader who cannot see the destination is being asked to trust
 * the row they clicked, which is the habit the warning exists to interrupt. The origin rather than
 * the whole URL, because the path is often long and unreadable, and the origin is the part that
 * answers "whose site is this".
 */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Confirm, then open in a new tab.
 *
 * The confirmation is the requirement rather than a courtesy: the destination is a third party the
 * model picked, and leaving the app for it is not something a click on a file row should do
 * silently. It reads 即将打开第三方网址 and names the host.
 *
 * `window.open` is called in the continuation of the confirm dialog's own accept click, which is a
 * fresh user gesture — so this is not popup-blocked, the way a call made from a timer or after a
 * `fetch` would be.
 *
 * `noopener,noreferrer` because the destination is untrusted: without `noopener` the opened page
 * gets a `window.opener` handle on the app, and `noreferrer` keeps the app's URL — which contains
 * nothing secret today and is not worth betting the future on — out of the other site's referrer
 * log.
 *
 * A blocked popup returns `null` and nothing else happens. That is deliberate: the user's own
 * browser said no, and a second sentence about it would be the app arguing with a setting.
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!isOpenableUrl(url)) return false;
  const accepted = await confirm({
    title: i18n.global.t("sources.openExternal.title"),
    message: i18n.global.t("sources.openExternal.message"),
    detail: urlHost(url),
    confirmText: i18n.global.t("sources.openExternal.confirm"),
  });
  if (!accepted) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
