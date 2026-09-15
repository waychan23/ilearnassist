import { describe, expect, it } from "vitest";
import {
  anchorFromRange,
  applyNoteHighlights,
  clearNoteHighlights,
  noteIdAt,
  rangeForAnchor,
  NOTE_ROOT_ATTR,
} from "../../src/utils/noteAnchor";

/**
 * The anchor arithmetic, which is the one part of the notes feature that can be tested
 * without a browser.
 *
 * Two of these cases are the reason the module exists rather than a `textContent.indexOf` in
 * the component. The formula case is a correctness bug: KaTeX renders each formula twice, so
 * a raw walk counts every occurrence twice and a highlight can land in the invisible copy.
 * The second-occurrence case is the same bug in miniature — "quote" alone is not an anchor,
 * and a message that repeats a phrase is ordinary.
 *
 * The fixtures are written against `textContent` offsets, which is an independent way of
 * naming a selection from the one the module uses — a test that built its ranges with
 * `rangeForAnchor` would prove only that the module agrees with itself.
 */

function rootOf(html: string): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute(NOTE_ROOT_ATTR, "");
  root.innerHTML = html;
  return root;
}

/** A range from `textContent` offsets. Deliberately walks every text node, formulas included. */
function rangeOf(root: HTMLElement, from: number, to: number): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);

  const locate = (offset: number): [Text, number] => {
    let seen = 0;
    for (const node of nodes) {
      if (offset <= seen + node.data.length) return [node, offset - seen];
      seen += node.data.length;
    }
    const last = nodes[nodes.length - 1]!;
    return [last, last.data.length];
  };

  const range = document.createRange();
  range.setStart(...locate(from));
  range.setEnd(...locate(to));
  return range;
}

/** A range over the `occurrence`-th appearance of `needle` in the root's text. */
function rangeOfQuote(root: HTMLElement, needle: string, occurrence = 0): Range {
  const full = root.textContent ?? "";
  let at = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    at = full.indexOf(needle, at + 1);
    if (at === -1) throw new Error(`fixture has no occurrence ${occurrence} of ${needle}`);
  }
  return rangeOf(root, at, at + needle.length);
}

function textOf(root: HTMLElement): string {
  return root.textContent ?? "";
}

describe("anchorFromRange", () => {
  it("records the selected words and their occurrence", () => {
    const root = rootOf("<p>The cell's energy currency is ATP.</p>");
    const anchor = anchorFromRange(root, rangeOfQuote(root, "energy currency"));
    expect(anchor).toEqual({ quote: "energy currency", occurrence: 0 });
  });

  it("counts which occurrence it was, so a repeated phrase is still one place", () => {
    const root = rootOf("<p>ATP again. Not ATP but ATP.</p>");
    // The third "ATP" — the whole reason an anchor is a quote *and* a count. With the quote
    // alone, the second and third are the same anchor and the highlight would land on
    // whichever one the search happened to find first.
    const anchor = anchorFromRange(root, rangeOfQuote(root, "ATP", 2));
    expect(anchor).toEqual({ quote: "ATP", occurrence: 2 });
    expect(rangeForAnchor(root, anchor!)?.toString()).toBe("ATP");

    const first = anchorFromRange(root, rangeOfQuote(root, "ATP", 0));
    expect(first).toEqual({ quote: "ATP", occurrence: 0 });
  });

  it("spans markup without the tags becoming part of the quote", () => {
    const root = rootOf("<p>the <strong>energy</strong> currency of the cell</p>");
    const anchor = anchorFromRange(root, rangeOfQuote(root, "energy currency"));
    expect(anchor).toEqual({ quote: "energy currency", occurrence: 0 });
  });

  it("anchors a selection whose ends are element boundaries", () => {
    // What a drag across a block boundary produces: the container is the paragraph and the
    // offset is a child index, so the quote cannot be read off a text node.
    const root = rootOf("<p>first line</p><p>second line</p>");
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(root, 2);
    const anchor = anchorFromRange(root, range);
    expect(anchor?.quote).toBe("first linesecond line");
  });

  it("refuses a selection that is only whitespace", () => {
    // An empty quote is the stored state of a note the user *typed*, so an accidental
    // double-click must not be able to produce one.
    const root = rootOf("<p>one</p>\n<p>two</p>");
    const between = root.childNodes[1] as Text;
    expect(between.data).toMatch(/^\s+$/);
    const range = document.createRange();
    range.selectNodeContents(between);
    expect(anchorFromRange(root, range)).toBeNull();
  });

  it("refuses a collapsed selection and one that leaves the message", () => {
    const root = rootOf("<p>inside</p>");
    const outside = rootOf("<p>outside</p>");
    expect(anchorFromRange(root, rangeOf(root, 2, 2))).toBeNull();

    const spanning = document.createRange();
    spanning.setStart(root.firstChild!, 0);
    spanning.setEnd(outside.firstChild!, 1);
    // A drag across two messages has no single place to hang a note on, which is the
    // product's "no cross-message selection" rule expressed as arithmetic.
    expect(anchorFromRange(root, spanning)).toBeNull();
  });
});

describe("formulas", () => {
  /**
   * KaTeX's default output is both copies at once, which is the hazard: the math is in the
   * text twice, and only one of them is on screen.
   */
  const withFormula = () =>
    rootOf(
      `<p>Water is ` +
        `<span class="katex">` +
        `<span class="katex-mathml"><math><semantics><annotation>H_2O</annotation></semantics></math></span>` +
        `<span class="katex-html">H₂O</span>` +
        `</span>` +
        ` and it is wet.</p>`
    );

  it("counts only the visible copy, so a formula is not two occurrences", () => {
    const root = withFormula();
    // Every text node still contributes to `textContent`; only one copy is visible.
    expect(textOf(root)).toContain("H_2O");
    expect(textOf(root)).toContain("H₂O");

    const anchor = anchorFromRange(root, rangeOfQuote(root, "wet"));
    expect(anchor).toEqual({ quote: "wet", occurrence: 0 });
    expect(rangeForAnchor(root, anchor!)?.toString()).toBe("wet");
  });

  it("anchors a selection that merely contains a formula", () => {
    // The formula contributes nothing to the visible text, so the quote is the prose around
    // it and the highlight runs around the formula rather than through it. Both boundaries
    // are in ordinary text — it is the middle that is skipped, not the ends.
    const root = withFormula();
    const paragraph = root.querySelector("p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.lastChild as Text, 4);
    expect(range.toString()).toContain("H_2O");
    expect(anchorFromRange(root, range)).toEqual({ quote: "Water is  and", occurrence: 0 });
  });

  it("refuses a boundary inside a formula rather than highlighting the hidden copy", () => {
    const root = withFormula();
    const glyphed = root.querySelector(".katex-html")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(glyphed, 0);
    range.setEnd(glyphed, 2);
    expect(anchorFromRange(root, range)).toBeNull();
  });
});

describe("highlighting", () => {
  it("wraps the anchored words and takes them back out unchanged", () => {
    const root = rootOf("<p>The energy currency of the cell is ATP.</p>");
    const before = root.innerHTML;

    applyNoteHighlights(root, "m1", [
      { noteId: "n1", messageId: "m1", anchor: { quote: "energy currency", occurrence: 0 } },
    ]);
    const marks = root.querySelectorAll("mark[data-note-id]");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute("data-note-id")).toBe("n1");
    expect(marks[0]!.textContent).toBe("energy currency");

    clearNoteHighlights(root);
    // Byte for byte, because the next anchor is computed against this same text.
    expect(root.innerHTML).toBe(before);
  });

  it("wraps both halves of a quote that spans markup", () => {
    const root = rootOf("<p>the <strong>energy</strong> currency of the cell</p>");
    applyNoteHighlights(root, "m1", [
      { noteId: "n1", messageId: "m1", anchor: { quote: "energy currency", occurrence: 0 } },
    ]);
    // Two marks, one highlight: the code that reads it back goes by the note id.
    const marks = [...root.querySelectorAll("mark[data-note-id]")];
    expect(marks.map((m) => m.textContent)).toEqual(["energy", " currency"]);
    expect(marks.every((m) => m.getAttribute("data-note-id") === "n1")).toBe(true);
    expect(noteIdAt(marks[1]!)).toBe("n1");
  });

  it("is repeatable: applying twice leaves one set of marks and the same text", () => {
    const root = rootOf("<p>one two three</p>");
    const marks = [{ noteId: "n1", messageId: "m1", anchor: { quote: "two", occurrence: 0 } }];
    applyNoteHighlights(root, "m1", marks);
    const once = root.innerHTML;
    applyNoteHighlights(root, "m1", marks);
    expect(root.innerHTML).toBe(once);
    expect(root.querySelectorAll("mark[data-note-id]")).toHaveLength(1);
  });

  it("holds two overlapping highlights at once", () => {
    // Two notes on overlapping words is ordinary — mark a phrase, then mark a longer one that
    // contains it — so the mark sets have to be independent rather than nested.
    const root = rootOf("<p>alpha beta gamma</p>");
    applyNoteHighlights(root, "m1", [
      { noteId: "n1", messageId: "m1", anchor: { quote: "alpha beta", occurrence: 0 } },
      { noteId: "n2", messageId: "m1", anchor: { quote: "beta gamma", occurrence: 0 } },
    ]);
    const words = (id: string) =>
      [...root.querySelectorAll(`[data-note-id="${id}"]`)].map((m) => m.textContent).join("");
    // The second one crosses the first one's boundary, so it is more than one mark — while
    // still being one highlight, which is what the shared id says.
    expect(words("n1")).toBe("alpha beta");
    expect(words("n2")).toBe("beta gamma");
    expect(textOf(root)).toBe("alpha beta gamma");
  });

  it("marks the right occurrence when a phrase repeats", () => {
    const root = rootOf("<p>ATP and ATP and ATP</p>");
    applyNoteHighlights(root, "m1", [{ noteId: "n1", messageId: "m1", anchor: { quote: "ATP", occurrence: 2 } }]);
    const marked = root.querySelector("mark")!;
    // The third one: the text after the wrap is the giveaway, since the first two stay bare.
    expect(marked.textContent).toBe("ATP");
    expect(marked.nextSibling?.textContent ?? "").toBe("");
    expect(root.textContent).toBe("ATP and ATP and ATP");
  });

  it("never marks a message the note is not about", () => {
    // The same words turn up in more than one message routinely — a phrase quoted back in the
    // reply, a formula restated. A mark applied to the wrong one looks entirely correct: the
    // quote resolves, so nothing downstream can tell.
    const root = rootOf("<p>alpha beta</p>");
    applyNoteHighlights(root, "m1", [
      { noteId: "n1", messageId: "m2", anchor: { quote: "alpha", occurrence: 0 } },
    ]);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    expect(textOf(root)).toBe("alpha beta");
  });

  it("skips a highlight that no longer resolves instead of throwing", () => {
    const root = rootOf("<p>rewritten since the note was made</p>");
    expect(rangeForAnchor(root, { quote: "gone", occurrence: 0 })).toBeNull();
    applyNoteHighlights(root, "m1", [{ noteId: "n1", messageId: "m1", anchor: { quote: "gone", occurrence: 0 } }]);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    expect(root.textContent).toBe("rewritten since the note was made");
  });

  it("skips an occurrence that is out of range", () => {
    const root = rootOf("<p>once</p>");
    expect(rangeForAnchor(root, { quote: "once", occurrence: 3 })).toBeNull();
  });

  it("reports no note for a click that is not on a highlight", () => {
    const root = rootOf("<p>plain text</p>");
    applyNoteHighlights(root, "m1", [{ noteId: "n1", messageId: "m1", anchor: { quote: "plain", occurrence: 0 } }]);
    expect(noteIdAt(root.querySelector("p"))).toBeNull();
    expect(noteIdAt(null)).toBeNull();
  });
});
