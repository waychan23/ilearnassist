import { SMART_CONTEXT_MESSAGES } from "@ilearnassist/shared";
import { renderPrompt } from "../prompts.js";

/**
 * The experimental smart-context window: the newest few history messages, and nothing else.
 *
 * Two consumers, one definition — `trimHistory` cuts the turn's history with this function, and
 * the route asks `smartContextGuidance()` for the prompt block that tells the model its history
 * is deliberately narrow. Both read the count from `SMART_CONTEXT_MESSAGES`, so "the latest two
 * messages" is one sentence in the codebase rather than one in the server and one in the hint.
 *
 * **The cut is over messages, and a message is a complete unit.** A message row carries its own
 * tool calls and their outputs, and `buildHistoryMessages` expands one row into an assistant
 * message plus its tool results — so slicing at a row boundary can never leave a `tool_calls`
 * block whose results are missing, which is the one pairing an OpenAI-compatible endpoint
 * refuses. That is why this deliberately does not apply `trimHistory`'s "advance to the first
 * user turn" rule: that rule exists for a window cut at an arbitrary count, and here the window
 * is the contract. A resumed turn (`/answers`) ends on the assistant row the question hangs on,
 * and a regenerate can open on an assistant row; both are valid requests, and trimming them
 * further would drop the very exchange they are continuing from.
 */
export function smartContextHistory<T>(history: readonly T[]): T[] {
  return history.slice(-SMART_CONTEXT_MESSAGES);
}

/**
 * The positive half of the mode, from the catalog (`chat.guidance.smartContext`).
 *
 * A function rather than a constant, for the reason `recallGuidance` documents: the catalog is
 * patched by the process entry point, which runs after every module has been evaluated, so a
 * module-level constant would silently ignore a tuned prompt.
 */
export function smartContextGuidance(): string {
  return renderPrompt("chat.guidance.smartContext");
}
