import { DIAGRAM_TOOL_NAME, isInteractiveTool, type ToolCall } from "../api/types";

/**
 * Runs of consecutive action tool calls, as the message list renders them.
 *
 * A turn that searches, fetches a page, reads a file and reads a document renders four
 * full-width cards, and the reply they were on the way to is pushed off the screen. The
 * arithmetic lives here rather than in the component because this is a list problem, and
 * because the repo unit-tests utils and deliberately does not unit-test `.vue` files — a
 * grouping rule that only a browser run can reach is a rule nobody pins.
 */

/** The shortest run worth collapsing. One call is already one line. */
export const GROUP_MIN = 2;

export type ToolCallRun =
  | { kind: "single"; call: ToolCall }
  | { kind: "group"; calls: ToolCall[] };

/**
 * Whether a call may be hidden inside a group.
 *
 * A collapsed group is a log line — "3 个工具调用" — so only a call whose card is *itself* a
 * log line belongs in one. Two kinds are not:
 *
 *   - an interactive call (`ask_user`, `ila_quiz`, `ila_make_plan`) is a question, and
 *     `MessageItem` already renders those below the reply for a reason. It never reaches this
 *     function, and saying so here keeps that true if a call site changes.
 *   - `ila_diagram` renders a drawing. Folding it into a count hides the artifact behind a
 *     number, which is the opposite of what that card is for.
 *
 * A non-groupable call *breaks* a run rather than sitting inside one: `[a, diagram, b]` becomes
 * three singles, never a group with a picture hidden in it.
 */
export function isGroupableToolCall(call: ToolCall): boolean {
  return !isInteractiveTool(call.name) && call.name !== DIAGRAM_TOOL_NAME;
}

/** Split the action calls into what to render, in order. */
export function groupToolCalls(calls: readonly ToolCall[]): ToolCallRun[] {
  const runs: ToolCallRun[] = [];
  let run: ToolCall[] = [];

  const flush = (): void => {
    const [only] = run;
    if (run.length === 1 && only) runs.push({ kind: "single", call: only });
    else if (run.length >= GROUP_MIN) runs.push({ kind: "group", calls: run });
    run = [];
  };

  for (const call of calls) {
    if (isGroupableToolCall(call)) {
      run.push(call);
    } else {
      flush();
      runs.push({ kind: "single", call });
    }
  }
  flush();

  return runs;
}

/**
 * The call a run is currently inside, or `undefined` when every one of them has finished.
 *
 * `output === undefined` is the *only* running flag there is — it is exactly how `ToolCallCard`
 * derives its `done`, and an ordinary call carries no `status` to read instead. The test is on
 * presence rather than truthiness, so `output: ""` (a finished call that returned nothing)
 * counts as done.
 *
 * The **last** such call, not the first: a step may run two calls in parallel, and the newest
 * is where the model is now — the same reading `ReasoningBlock` takes of its own lines.
 */
export function runningToolCall(calls: readonly ToolCall[]): ToolCall | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call && call.output === undefined) return call;
  }
  return undefined;
}

/**
 * What a collapsed run's head says: the call still in flight, or how many there were.
 *
 * Returned as a decision rather than as a string, because the strings are catalog entries and
 * the choice between them is the part with a rule in it. `ToolCallGroup` maps this onto its two
 * keys; a test can pin the branch without a DOM or a locale.
 *
 * A name rather than a resolved label in the running case: resolving `tools.name.*` needs the
 * `te()` guard that lives beside `useI18n`, and it is the same guard the single card uses.
 */
export type ToolGroupHead =
  | { kind: "running"; name: string }
  | { kind: "count"; count: number };

export function groupHead(calls: readonly ToolCall[]): ToolGroupHead {
  const call = runningToolCall(calls);
  return call ? { kind: "running", name: call.name } : { kind: "count", count: calls.length };
}
