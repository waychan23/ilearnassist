/**
 * Keeping two conversations in one workspace from sharing a name.
 *
 * A conversation's title is a label in a list, so two rows reading `学习计划` are a list the
 * reader has to open one at a time to tell apart. The fix is the one every file manager
 * reached: the newcomer gets a number, `学习计划 (2)`.
 *
 * The arithmetic lives here, with no database and no import of its own, on the `uniqueSlug`
 * precedent in `workspace.ts` — the decision is "which of these strings is free", and that is
 * answerable from a predicate. The caller reads the sibling titles and hands them over.
 *
 * Three write paths reach this: creation, a rename, and the auto-titler's own suggestion. It is
 * applied on the **server** because that is the only place all three meet — a rule enforced in
 * the client is a rule the next client does not have.
 */

/**
 * A trailing ` (n)`, split off the way a file manager reads one.
 *
 * Non-greedy with the anchor at the end, so only the **last** group is the ordinal:
 * `报告 (2) (3)` is the third copy of `报告 (2)`, not the second copy of `报告`. That is what
 * keeps the numbering from stacking into `报告 (2) (2) (2)` as copies of copies are made.
 */
const ORDINAL = /^(.*?) \((\d+)\)$/;

/**
 * `{ base, n }` for a title ending in ` (n)`, or null for one that does not.
 *
 * The base must be non-empty, so `" (2)"` — a title that is nothing but a number — is its own
 * name rather than the second copy of the empty string.
 */
export function parseOrdinal(title: string): { base: string; n: number } | null {
  const match = ORDINAL.exec(title);
  if (!match) return null;
  const base = match[1]!;
  const n = Number(match[2]!);
  if (!base || !Number.isSafeInteger(n) || n < 1) return null;
  return { base, n };
}

/**
 * `title` when it is free, and otherwise the next free number for it.
 *
 * The search **starts where the name already is** rather than always at 2. A name carrying no
 * ordinal starts at 2, which is the file-manager convention — the original keeps the plain name
 * and the first copy is `(2)`. A name that already ends in ` (n)` starts at `n`, so somebody
 * renamed to `报告 (5)` is given `报告 (6)` rather than being quietly moved *down* to `报告 (2)`
 * because that slot happened to be empty.
 *
 * The number is the **lowest free** one from there, not one past the highest in use: deleting
 * `报告 (2)` and making another copy gives `报告 (2)` back, which is what makes the numbers stay
 * dense instead of climbing for the life of the workspace.
 */
export function uniqueSessionTitle(title: string, isTaken: (t: string) => boolean): string {
  if (!isTaken(title)) return title;

  const parsed = parseOrdinal(title);
  const base = parsed?.base ?? title;
  let n = parsed?.n ?? 2;
  while (isTaken(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}
