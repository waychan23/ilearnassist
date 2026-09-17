/**
 * A rendered table, as HTML that survives leaving the app.
 *
 * The app's own table styling lives in `style.css` — `.markdown table` and its cells — and none of
 * it travels with a clipboard fragment: a document, a mail client or a wiki pastes the markup and
 * whatever styles are *on* the elements, and a table with no borders arrives as a heap of words in
 * a grid nobody can see. So the styles are written onto the elements here.
 *
 * ## Why the colours are literals
 *
 * Every other rule in this codebase draws its colours and lengths from tokens, and this one
 * deliberately does not, because this is not *app* styling — it is the payload. The tokens are
 * custom properties resolved by our own stylesheet, which is exactly what the destination does not
 * have, so a `var(--border)` here would arrive as an unresolvable string and paint nothing. A
 * neutral grey border is what a pasted table wants in a document whose own palette is unknown.
 *
 * The padding and border are `pt`-free pixel literals for the same reason: they are part of the
 * exported artifact, not part of this app's spacing scale, and rounding them to the nearest token
 * would tie a document's table to a decision about our own margins.
 */

/** What is written onto the cells. Sized for a document, not for this app's density. */
const CELL_STYLE = "border:1px solid #b0b0b0;padding:4px 8px;text-align:left;vertical-align:top";

/** What is written onto the table itself. `collapse` is what makes the per-cell borders into one
 *  grid rather than doubled lines. */
const TABLE_STYLE = "border-collapse:collapse;width:auto";

/** The first table in a rendered fragment, or null when there is none. */
function firstTable(html: string): string | null {
  return /<table\b[\s\S]*?<\/table>/i.exec(html)?.[0] ?? null;
}

/**
 * Add the inline styles a table needs to be legible where it lands.
 *
 * The *first* table, because the only caller renders one tool call's own markdown and a table tool
 * writes one table. A second table in the fragment is not a case this invents an answer for — the
 * alternative would be a silent concatenation of two grids into one.
 *
 * Null when the fragment holds no table at all, which is the honest answer for the caller: it
 * means the row's content was not the markdown table it claimed to be, and copying *something*
 * would be copying the wrong thing.
 */
export function tableHtmlForClipboard(html: string): string | null {
  const table = firstTable(html);
  if (!table) return null;

  return table
    // `style` first, then the cells: an element that already carries a `style` attribute (nothing
    // this renderer emits does, but a table's own HTML from a model could if `html: false` ever
    // changed) would otherwise end up with two of them, and the browser keeps only the first.
    .replace(/^<table\b/i, `<table style="${TABLE_STYLE}"`)
    .replace(/<(td|th)\b/gi, `<$1 style="${CELL_STYLE}"`);
}
