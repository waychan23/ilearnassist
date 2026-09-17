import { TABLE_TOOL_NAME } from "../api/types";

/**
 * The tools whose call renders **no card at all** in the conversation.
 *
 * A rule with one member, and the member is the reason the rule exists: `ila_table` renders
 * nothing because its artifact is not something a card could show. The table is written into the
 * reply as ordinary Markdown — that is the whole contract of the feature — so a card beside it
 * could only repeat the summary, and the sentence it used to carry ("the table is in the reply")
 * was there to explain a box that should not have been drawn in the first place.
 *
 * **The card was also the jump anchor**, so removing it is not only the removal of a box: the
 * 图表 panel's 定位 emits `chat.jump` with a tool-call id, and a call that renders nothing has
 * nothing to land on. `MessageItem` puts those ids on the message row instead — see
 * `data-tool-call-anchor` — which is a better target anyway, because the table really is in that
 * block.
 *
 * A `Set` rather than a name comparison, so a second cardless tool is a data edit here rather
 * than a branch somewhere else. Nothing else in the app decides what a call looks like: the
 * dispatch in `ToolCallCard` reads this, and it is the single place the question is answered.
 */
export const CARDLESS_TOOL_NAMES: ReadonlySet<string> = new Set([TABLE_TOOL_NAME]);
