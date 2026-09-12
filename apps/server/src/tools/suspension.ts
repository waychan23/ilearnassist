/**
 * Thrown by a tool that suspends the turn until the user answers.
 *
 * **This is control flow, not failure.** It is the same trick LangGraph's `interrupt()`
 * uses, and for the same reason: a tool cannot return "pause the loop now" through its
 * normal return value without inventing a sentinel string that every other reader of a
 * tool result would then have to know about. `runAgentStream` catches this class *before*
 * its generic tool-error arm, so it never becomes a `Tool error:` string — and it must stay
 * that way, or the model would be told its own question failed.
 *
 * Do not wrap `interrupt`-style code in a bare `try/catch` on the way out: a catch that
 * swallows this would turn a suspension into a silent no-op.
 *
 * A base class rather than one class per tool, because the loop recognises a suspension by
 * **instance** and not by name — so a second suspending tool extends this and the loop's
 * single arm keeps working unchanged. Matching on a list of names was the alternative, and
 * that list would then have to stay in step with what each tool actually does.
 *
 * It imports nothing, so the tools that extend it and the registry that dispatches them can
 * both depend on it without a cycle.
 */
export class Suspension extends Error {
  /**
   * The arguments to persist on the suspended call, when the tool has something to add to
   * what the model sent.
   *
   * Omitted means "the model's own arguments, unchanged", which is the ordinary case. It
   * exists for the case where the tool *assigns* something the model could not have — an id
   * that must be stable across a reload, say. The loop stringifies a call's arguments before
   * invoking the tool, so a tool that numbers its own input has no other way to get those
   * numbers into the record the card is later re-rendered from.
   */
  readonly recordedInput?: Record<string, unknown>;

  constructor(name: string, message: string, recordedInput?: Record<string, unknown>) {
    super(message);
    this.name = name;
    this.recordedInput = recordedInput;
  }
}
