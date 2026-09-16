import { ref } from "vue";

/**
 * Which collapsed tool-call runs the reader has opened.
 *
 * Module-scoped rather than a `ref` inside either component, and that is the whole point of
 * this file. `ChatView` renders the live turn as one `<MessageItem :streaming>` and the
 * persisted one as a `v-for` entry — two *different* component instances — and swaps them in a
 * single tick when `message_done` lands. A flag living in either instance would snap a group
 * the reader had just opened shut at the exact moment the turn ended: content shrinking under
 * their cursor while they were reading it.
 *
 * The key is the run's **first call id**. Streaming `tool_start` ids and persisted
 * `tool_call_id`s are the same strings — `chat.jump` already relies on that, addressing a card
 * "persisted or currently streaming" — and a run's first call never changes as the run grows
 * from two calls to three.
 *
 * Not `localStorage`, because this is transient view state like `ReasoningBlock`'s, which also
 * resets on reload; and not the Pinia store, which is account state reset by `forgetAccount`.
 * The map is bounded by how many groups a reader ever opens.
 */
const expanded = ref<ReadonlySet<string>>(new Set<string>());

export function isToolGroupExpanded(key: string): boolean {
  return expanded.value.has(key);
}

export function toggleToolGroup(key: string): void {
  const next = new Set(expanded.value);
  if (!next.delete(key)) next.add(key);
  expanded.value = next;
}

/**
 * Open a group without toggling it.
 *
 * What `ChatView` needs when a jump aims at a card inside a collapsed run: the intent is "show
 * me this", not "flip whatever is there" — a toggle would close the group again on a second
 * jump to the same run. Replacing the Set is what makes the change reactive; mutating the
 * existing one would not notify the card's computed.
 */
export function expandToolGroup(key: string): void {
  if (expanded.value.has(key)) return;
  expanded.value = new Set(expanded.value).add(key);
}
