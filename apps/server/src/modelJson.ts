/**
 * Reading JSON out of an out-of-band model answer.
 *
 * The secondary calls (the titler, the thread classifier, the insight pass) all ask a model for
 * a machine-readable answer, and all of them get back the same two indirections: models wrap
 * JSON in a ```json fence, and they write a sentence about it before or after. Both are stripped
 * here rather than at each call site — this is arithmetic that can be wrong in a way no log
 * shows (an off-by-one in the bracket search turns a valid answer into `null`, which every
 * caller reads as "the model failed"), and a second copy is where the two would drift.
 */

/**
 * The model's answer with a fenced block unwrapped, if it used one.
 *
 * A fence wins over prose: an answer that says "here it is:" and then fences the payload is
 * unambiguous, while one that mentions a fence *inside* a sentence is not worth guessing about.
 */
export function stripFence(raw: string): string {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence?.[1] ? fence[1].trim() : text;
}

/**
 * Parse the model's answer as JSON of the given shape, or `null` when nothing usable is there.
 *
 * `shape` is which bracket pair delimits the payload — `"object"` for `{…}`, `"array"` for `[…]`
 * — because the bracket search is what finds the payload inside surrounding prose, and the two
 * are not interchangeable: scanning for `{` in an array answer finds a brace inside an element.
 * The caller decides which it asked for, and a mismatch is a `null` it can treat as a failure
 * rather than a value it has to re-inspect.
 *
 * Pure and total: it never throws, so a caller cannot have a malformed answer turn into a
 * rejection it did not plan for.
 */
export function parseModelJson(raw: string, shape: "object" | "array"): unknown | null {
  const text = stripFence(raw);
  const open = shape === "object" ? "{" : "[";
  const close = shape === "object" ? "}" : "]";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
