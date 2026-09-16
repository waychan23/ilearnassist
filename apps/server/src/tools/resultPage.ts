/**
 * The paging engine two tools share: clip one field, and serialise an answer that shrinks to
 * fit rather than being cut.
 *
 * It lives here because `ila_query` and `ila_explore` answer the same shape of question — "here
 * is a set, and here is part of it" — and two implementations would be two answers to what
 * `truncated: true` means. The model reads that flag to decide whether to page or to stop; a
 * second engine whose ceiling or note differed would make the same word mean two things in one
 * conversation.
 */

/**
 * How much of one field the model is shown. Generous enough for a whole quiz question, a note
 * body or a message, short enough that twenty of them cannot dwarf the context.
 */
export const RESULT_TEXT_MAX = 400;

/**
 * The whole result's ceiling, in characters of serialised JSON. The page shrinks to fit
 * rather than the text being cut: a truncated JSON string is not a smaller answer, it is an
 * unparseable one, and the `FileContent.truncated` precedent (a result with a flag, never an
 * error) only works if what comes back is still the thing it claims to be.
 */
export const RESULT_MAX = 12_000;

/** Items per call when the model does not say. `RESULT_MAX_LIMIT` is what it may ask for. */
export const RESULT_DEFAULT_LIMIT = 20;
export const RESULT_MAX_LIMIT = 50;

/** A field as the model reads it: one line, clipped, never a wall of text. */
export function clip(text: string, max = RESULT_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "…" : flat;
}

/** The same, for a field that may legitimately be absent. */
export function text(value: string | null, max = RESULT_TEXT_MAX): string | null {
  return value === null ? null : clip(value, max);
}

/**
 * Serialise an answer, keeping as many items as fit under `RESULT_MAX`.
 *
 * Built by adding items one at a time, so the reply is always valid JSON and the counts
 * always describe what is actually in it. `truncated` is what tells the model to narrow with
 * `limit`/`offset`/`query` rather than assume it has seen everything — the same "a result
 * with a flag, never an error" shape the file preview uses.
 *
 * `tool` names the tool in the truncation note, because the note is the model's instruction for
 * what to do next and an instruction naming the wrong tool is worse than none.
 */
export function renderPage(input: {
  tool: string;
  kind: string;
  note: string;
  items: unknown[];
  total: number;
  offset: number;
  extra?: Record<string, unknown>;
}): string {
  /*
   * `truncated` answers one question — "is there more of this set that you have not seen" — and
   * there are two ways the answer becomes yes. The page may have been shrunk to fit the ceiling,
   * or the caller's own `limit` may have been smaller than what remained.
   *
   * It used to report only the first, so a caller asking for 20 of 200 items was told
   * `truncated: false` while looking at a tenth of the set. That contradicts what the flag is
   * documented to mean above, and the flag is the signal the model pages on: `total` and
   * `returned` sitting beside it are only a hint for a model that thinks to compare them.
   */
  const items = input.items;
  /**
   * The full reply as it will be sent — measured *after* the indicator, the counts and the
   * pretty-printing, because those are part of the bytes the model reads. Measuring the items
   * alone is how a "12 000 character" cap produces a 12 311 character reply.
   */
  const render = (items: unknown[], truncated: boolean): string =>
    JSON.stringify(
      {
        kind: input.kind,
        ...(input.extra ?? {}),
        total: input.total,
        offset: input.offset,
        returned: items.length,
        truncated,
        items,
        note: truncated
          ? `${input.note} Only ${items.length} of the ${input.total - input.offset} items ` +
            `from this offset are here. Call ${input.tool} again with a larger offset, ` +
            "or narrow with a filter, rather than treating this as the whole set."
          : input.note,
      },
      null,
      2
    );

  const kept: unknown[] = [];
  for (const item of items) {
    // Each candidate is measured in the truncated shape, which carries the longer note, so the
    // reply that is actually returned can only be shorter than the one that was checked.
    if (render([...kept, item], true).length > RESULT_MAX) break;
    kept.push(item);
  }
  const moreAfterThisPage = input.offset + kept.length < input.total;
  return render(kept, kept.length < items.length || moreAfterThisPage);
}
