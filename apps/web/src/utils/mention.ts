/**
 * The `@`-mention, as arithmetic on a string and a caret position.
 *
 * The composer's picker is the only interactive part of referencing a source, and it is the
 * part that is easy to get subtly wrong: what counts as "the user is typing a mention", and
 * where the chosen name goes. Both are questions about the text *around the caret*, they have
 * one right answer each, and neither needs a DOM — so they live here and are tested, rather
 * than being inferred from an `input` event inside a component that only Playwright can reach.
 */

/** A mention being typed: where its `@` is, and what has been typed after it. */
export interface ActiveMention {
  /** Index of the `@` in the text. */
  start: number;
  /** What the user has typed since it, possibly empty. */
  query: string;
}

/**
 * The mention the caret is inside, or `null`.
 *
 * Three rules, and each exists to keep the picker from appearing when it is not wanted:
 *
 * - **The `@` must not be glued to a word** — it must follow nothing, or punctuation. Otherwise
 *   the `@` in an email address opens a picker in the middle of typing something else, which is
 *   the failure that makes a feature like this feel broken. Punctuation *is* allowed, so
 *   `(@report.pdf)` works and so does a mention on its own line.
 * - **No whitespace between it and the caret.** A mention's query is a word: once the user
 *   types a space they have finished naming the thing, and a picker that stayed open would be
 *   filtering on a sentence.
 * - **An empty query is still a mention**, because `@` alone is how the picker is opened.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null;

  // Backwards from the caret to the nearest `@` or word boundary, whichever comes first.
  let start = caret;
  while (start > 0) {
    const char = text[start - 1]!;
    if (char === "@") break;
    if (/\s/.test(char)) return null;
    start -= 1;
  }
  if (start === 0 && text[0] !== "@") return null;
  if (text[start - 1] !== "@") return null;

  const at = start - 1;
  // A `@` glued to a word is not one: `ada@example.com` is an address. Punctuation is fine —
  // `(@report.pdf)` and a mention at the start of a line are both natural — so the test is a
  // *word character* before it rather than "whitespace", which would refuse the parenthesis.
  if (at > 0 && /[\p{Letter}\p{Number}_]/u.test(text[at - 1]!)) return null;

  return { start: at, query: text.slice(at + 1, caret) };
}

/**
 * Replace the mention with the chosen name, and say where the caret lands.
 *
 * A space is appended after the name rather than left to the user: the mention is over the
 * moment something is chosen, and a caret sitting against a word boundary is what makes the
 * next keystroke start a new word instead of extending the reference.
 *
 * The name is inserted as plain text, and stays plain — the *reference* is not the `@name` in
 * the sentence, it is the chip beside the composer. Which is why deleting the text does not
 * drop the reference, and why nothing downstream has to parse the message for mentions.
 */
export function insertMention(
  text: string,
  mention: ActiveMention,
  name: string
): { text: string; caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.start + 1 + mention.query.length);
  const inserted = `@${name} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
