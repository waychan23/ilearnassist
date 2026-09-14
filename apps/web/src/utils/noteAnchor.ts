import type { NoteAnchor } from "@ilearnassist/shared";

/**
 * Turning a text selection into something a note can be put back on.
 *
 * A note's anchor is a text quote plus which occurrence of it, counted over a message's
 * **visible** text — not the character offsets the browser reports, which are offsets into
 * rendered HTML and mean nothing after a re-render (`v-html` replaces the whole subtree, so
 * every text node in it is a new object). A quote is stable across that; an offset is not.
 *
 * Everything here is arithmetic over a rendered element, with no Vue and no store, which is
 * what lets the edge cases be unit-tested at all: the component that calls it is a `.vue`
 * file, and the Vitest config excludes those.
 *
 * Two subtleties are load-bearing, and both are why this is not a `textContent.indexOf`:
 *
 * 1. **Formulas are skipped.** KaTeX renders each one twice by default — a hidden MathML
 *    copy (`.katex-mathml`) and a visible spans copy (`.katex-html`) — so a raw text walk
 *    sees every formula twice, and the two copies make the "which occurrence" count depend
 *    on markup rather than on words. A range boundary inside either copy fails to resolve,
 *    which is deliberate: a `<mark>` inside per-character kerning spans visually breaks the
 *    formula, and one inside the hidden copy is invisible while the note claims to highlight
 *    something. A selection that merely *contains* a formula still anchors — the formula
 *    simply contributes no text, and the highlight runs around it.
 *
 * 2. **Boundaries are resolved, not read off.** A range's container is often an element and
 *    its offset a child index (a selection that starts at a paragraph boundary, or a
 *    drag that ends between two inline elements). `offsetOfPoint` answers for both, so the
 *    quote is always a slice of the same string the resolution searches — a selection
 *    computed one way and looked up another is how a highlight lands on the wrong words.
 */

/** The attribute a message's content element carries, so a selection can be scoped to one. */
export const NOTE_ROOT_ATTR = "data-note-root";

/** Subtree the visible-text walk refuses to enter. See the note above. */
const SKIP_SELECTOR = "[data-note-skip], .katex-mathml, .katex-html";

/**
 * A highlight, as the message list needs it: which note, which message, and what to wrap.
 *
 * `messageId` is not decoration. The same words occur in more than one message routinely —
 * a phrase quoted back in a reply, a formula restated — and a mark applied to the wrong one
 * is a highlight on a passage the note is not about. `applyNoteHighlights` filters on it
 * rather than trusting its caller to, because that is a mistake nothing downstream can
 * detect: the quote resolves, so it looks right.
 */
export interface NoteHighlightMark {
  noteId: string;
  messageId: string;
  anchor: NoteAnchor;
}

/** One visible text node, with where its first character sits in the concatenated text. */
interface TextPoint {
  node: Text;
  start: number;
}

interface VisibleText {
  points: TextPoint[];
  text: string;
}

function isSkipped(node: Node): boolean {
  return node.parentElement?.closest(SKIP_SELECTOR) != null;
}

/**
 * The element's visible text, with a map back to the nodes it came from.
 *
 * `NodeFilter.FILTER_REJECT` rather than `FILTER_SKIP`: skipping a node still walks its
 * children, which is exactly what must not happen to a formula.
 */
function visibleText(root: HTMLElement): VisibleText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node as Text).data && !isSkipped(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });

  const points: TextPoint[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    points.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  return { points, text };
}

/**
 * The first visible text node at or after `node`, as an offset.
 *
 * `DOCUMENT_POSITION_FOLLOWING` covers both cases on its own — a descendant follows its
 * ancestor in document order, which is why the containment bit does not have to be checked
 * separately. That is what lets a boundary expressed as "child 3 of this paragraph" and one
 * expressed as "the end of this paragraph" be answered by the same walk.
 */
function firstVisibleAtOrAfter(node: Node, { points, text }: VisibleText): number {
  for (const point of points) {
    if (node.compareDocumentPosition(point.node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return point.start;
    }
  }
  return text.length;
}

/** Where the visible text *inside* a container ends, or null when it holds none. */
function endOfVisibleTextIn(container: Node, { points }: VisibleText): number | null {
  let end: number | null = null;
  for (const point of points) {
    if (container.compareDocumentPosition(point.node) & Node.DOCUMENT_POSITION_CONTAINED_BY) {
      end = point.start + point.node.data.length;
    }
  }
  return end;
}

/**
 * Where a range boundary sits in the visible text, or null when it sits somewhere the walk
 * refuses to go (inside a formula).
 *
 * A text container answers directly. An element container is a *position among children*, so
 * the answer is where the child at that index begins — or, past the last child, where the
 * container's own text ends. Both are ordinary: a drag that starts at the beginning of a
 * paragraph produces the second, and one that ends between two inline elements produces a
 * position among a paragraph's children.
 */
function offsetOfPoint(
  container: Node,
  offset: number,
  visible: VisibleText
): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const point = visible.points.find((p) => p.node === container);
    return point ? point.start + Math.min(offset, (container as Text).data.length) : null;
  }
  const child = container.childNodes[offset];
  if (child) return firstVisibleAtOrAfter(child, visible);
  return endOfVisibleTextIn(container, visible) ?? firstVisibleAtOrAfter(container, visible);
}

/** The text node position at a visible-text offset, as a `[node, offset]` pair. */
function pointAtOffset(points: TextPoint[], offset: number): [Text, number] | null {
  for (const point of points) {
    if (offset < point.start + point.node.data.length) {
      return [point.node, offset - point.start];
    }
  }
  const last = points[points.length - 1];
  return last ? [last.node, last.node.data.length] : null;
}

/**
 * How many occurrences of `quote` start before `at`. Overlapping matches count, and the scan
 * advances by one rather than by the quote's length — `offsetOfOccurrence` below advances
 * the same way, and the pair has to agree or a note would resolve to a different occurrence
 * than the one it recorded.
 */
function occurrenceAt(text: string, quote: string, at: number): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const found = text.indexOf(quote, from);
    if (found === -1 || found >= at) return count;
    count += 1;
    from = found + 1;
  }
}

/** Where the anchor's occurrence begins in `text`, or null when the quote is not there. */
function offsetOfOccurrence(text: string, anchor: NoteAnchor): number | null {
  const quote = anchor.quote;
  if (!quote) return null;
  let count = 0;
  let from = 0;
  for (;;) {
    const found = text.indexOf(quote, from);
    if (found === -1) return null;
    if (count === anchor.occurrence) return found;
    count += 1;
    from = found + 1;
  }
}

/**
 * The anchor for a selection, or null when there is nothing to anchor.
 *
 * Null is the answer for a collapsed selection, for one whose ends are not both inside
 * `root` (a drag across two messages has no single place to hang a note on), and for one
 * that is only whitespace — the empty-quote state is reserved for a note the user typed
 * rather than marked, so an accidental double-click cannot produce one.
 */
export function anchorFromRange(root: HTMLElement, range: Range): NoteAnchor | null {
  if (range.collapsed) return null;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const visible = visibleText(root);
  const start = offsetOfPoint(range.startContainer, range.startOffset, visible);
  const end = offsetOfPoint(range.endContainer, range.endOffset, visible);
  if (start === null || end === null || end <= start) return null;

  const quote = visible.text.slice(start, end);
  if (!quote.trim()) return null;
  return { quote, occurrence: occurrenceAt(visible.text, quote, start) };
}

/**
 * The DOM range an anchor points at, or null when it does not resolve.
 *
 * Not resolving is an ordinary outcome rather than an error: the message may have been
 * re-rendered by a different markdown-it or KaTeX version since, and the note still has its
 * quote on file. The caller shows the note and skips the highlight.
 */
export function rangeForAnchor(root: HTMLElement, anchor: NoteAnchor): Range | null {
  const visible = visibleText(root);
  const start = offsetOfOccurrence(visible.text, anchor);
  if (start === null) return null;

  const from = pointAtOffset(visible.points, start);
  const to = pointAtOffset(visible.points, start + anchor.quote.length);
  if (!from || !to) return null;

  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  return range;
}

/**
 * The text-node slices a range covers, trimmed to it.
 *
 * Computed for the whole range before anything is split, so that splitting one node cannot
 * move the offsets the next one is read from.
 */
function slicesOf(range: Range): Array<{ node: Text; start: number; end: number }> {
  const common = range.commonAncestorContainer;
  const scope = common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
  if (!scope) return [];

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const slices: Array<{ node: Text; start: number; end: number }> = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data || !range.intersectsNode(text)) continue;
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : text.data.length;
    // A node the range only *touches* — its boundary sitting at this node's edge — is not
    // covered, and wrapping it would highlight a whole paragraph the selection did not reach.
    if (end > start) slices.push({ node: text, start, end });
  }
  return slices;
}

/**
 * Wrap everything under `root` that the marks point at.
 *
 * One `<mark>` per covered text node, all sharing the note's id, so a highlight that crosses
 * a `<strong>` is still one highlight to whoever reads it back. Replaces any previous
 * highlighting rather than adding to it — the panel calls this with its whole list on every
 * change, and two ways to arrive at the same set of marks is how they double.
 *
 * `messageId` names the message `root` holds, and marks for any other are skipped here
 * rather than at the call site: see `NoteHighlightMark`.
 */
export function applyNoteHighlights(
  root: HTMLElement,
  messageId: string,
  highlights: readonly NoteHighlightMark[]
): void {
  clearNoteHighlights(root);
  for (const highlight of highlights) {
    if (highlight.messageId !== messageId) continue;
    const range = rangeForAnchor(root, highlight.anchor);
    if (!range) continue;
    for (const slice of slicesOf(range)) {
      // Split so the marked span is the selection itself and not the text node it happened
      // to share with its surroundings.
      const target = slice.start > 0 ? slice.node.splitText(slice.start) : slice.node;
      if (slice.end - slice.start < target.data.length) target.splitText(slice.end - slice.start);

      const mark = document.createElement("mark");
      mark.className = "note-highlight";
      mark.dataset.noteId = highlight.noteId;
      target.parentNode?.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }
}

/**
 * Take every highlight back out, restoring the text byte for byte.
 *
 * The `normalize` is what keeps this repeatable: without it each apply/clear cycle leaves a
 * scattering of empty text nodes, and the next walk pays for all of them.
 */
export function clearNoteHighlights(root: HTMLElement): void {
  const parents = new Set<Node>();
  for (const mark of root.querySelectorAll("mark[data-note-id]")) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parents.add(parent);
  }
  for (const parent of parents) (parent as Element).normalize?.();
}

/** The note a click landed on, if any — the `mark` or an ancestor of it. */
export function noteIdAt(target: Element | null): string | null {
  return target?.closest("mark[data-note-id]")?.getAttribute("data-note-id") ?? null;
}
