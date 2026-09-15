import { DIAGRAM_TOOL_NAME, diagramFileName, type Message } from "../api/types";

/**
 * Which of a conversation's diagram files were drawn by a call in it, and by which call.
 *
 * The diagram widget's 定位 button is built from this: `[data-tool-call-id]` is what
 * `ChatView`'s `chat.jump` handler scrolls to, so a row whose file has a call gets a button
 * and a row whose file has none — a `.mmd` somebody put in the folder by hand — simply does
 * not. That is deliberate: a button that scrolls to nothing is worse than no button.
 *
 * The join key is the *file name*, and the two sides spell it differently by construction: the
 * call records the name the model chose (`"Auth Flow"`), the directory holds what the server
 * made of it (`auth-flow.mmd`). `diagramFileName` is what closes that gap, and it is shared
 * with the server for exactly this reason — a second slug rule here would be a button on the
 * wrong row, or on none, and nothing would report it.
 *
 * A pure function of the messages rather than a getter on the store: the derivation is the
 * part worth testing, and a `.vue` component is the part this suite does not test.
 */
export function diagramAnchors(messages: readonly Message[]): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.name !== DIAGRAM_TOOL_NAME) continue;
      try {
        const name = (JSON.parse(call.input) as { name?: unknown }).name;
        // Last call wins, which is what a revision looks like: the same name called again with
        // corrected source. Scrolling to the latest one is the reply that shows what is on
        // screen now.
        if (typeof name === "string") anchors.set(diagramFileName(name), call.id);
      } catch {
        // A malformed argument record is not a row's problem — that row just has no anchor.
      }
    }
  }
  return anchors;
}
