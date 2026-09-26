/**
 * Writing to the clipboard, once, for every control that does it.
 *
 * ## Why this exists
 *
 * `navigator.clipboard` is **undefined outside a secure context**, and this app is served over one
 * that is not: LAN sharing hands out `http://192.168.x.x:<port>` (see `api/client.ts`, which says
 * so about the same address). Every copy control therefore has a second path to take, and the
 * three that existed each took none — they dereferenced `.writeText` straight through, so on that
 * origin a press threw a `TypeError` synchronously, *before* the `.then`/`.catch` a caller had
 * written around it. In a code block the throw escaped into the message list's click handler and
 * the control did nothing at all, which is worse than the "copy failed" state the code was
 * written to show: a control that says nothing is indistinguishable from one that is broken.
 *
 * So the fallback lives here, and it is one implementation rather than four: a hidden textarea and
 * the old `document.execCommand("copy")`, which is deprecated and still the only thing that works
 * on a plain-http origin. The branch is **feature-detected, never gated on `isSecureContext`** —
 * the question is "can this browser write to the clipboard", and a browser that answers yes from a
 * context we did not expect should be allowed to.
 *
 * Both functions **reject** when neither route worked, and that is the interface: every caller
 * has a failed state to show (`CopyButton`'s label, the copy control's `data-copy-state`), and
 * swallowing the failure here would leave them showing a success that did not happen.
 */

/** The clipboard API, or `undefined` where the browser has none at all. */
function clipboardApi(): Clipboard | undefined {
  // `navigator` itself can be missing in a non-browser context, and jsdom has no `clipboard`.
  return typeof navigator === "undefined" ? undefined : navigator.clipboard;
}

/**
 * Whether the rich flavour — text *and* markup as one item — can be written.
 *
 * The two halves are separate questions: `ClipboardItem` is a constructor the browser may not
 * have, and `write` is a method it may not have. Where either is missing the plain text is what
 * gets written, which is `CopyButton.vue`'s rule and the reason this is a function rather than a
 * boolean constant: the answer is about the browser, not about this module.
 */
export function canWriteRich(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof clipboardApi()?.write === "function";
}

/**
 * The textarea-and-`execCommand` route.
 *
 * The element is moved **off-screen rather than hidden**: a `display: none` box cannot be
 * selected, and an unselected box copies nothing. It is removed in a `finally` so a throw cannot
 * leave it in the document — the `<input type="file">` rule in the other direction: this element
 * is never meant to be seen, so it must never be left behind either.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Write plain text, by the clipboard API or by the fallback. Rejects when neither worked. */
export async function copyText(text: string): Promise<void> {
  const api = clipboardApi();
  if (api && typeof api.writeText === "function") {
    await api.writeText(text);
    return;
  }
  if (!legacyCopy(text)) throw new Error("clipboard unavailable");
}

/**
 * Write the text, and the markup beside it when there is any and the browser can carry it.
 *
 * The two flavours are for two *targets*, not for two preferences — pasted into a document the
 * reader wants the table, pasted into a source file or a chat box the text is what they want — so
 * one press writes both and the target decides. Where the rich half is not available the plain
 * text still goes: a copy that took the plainer of the two is a copy, and a rejection there would
 * report a failure that did not happen.
 */
export async function copyRich(text: string, html: string | null): Promise<void> {
  const api = clipboardApi();
  if (html && api && canWriteRich()) {
    await api.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  await copyText(text);
}
