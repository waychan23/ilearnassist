<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../api/types";
import { isToolGroupExpanded, toggleToolGroup } from "../composables/toolCallGroups";
import { groupHead, runningToolCall } from "../utils/toolCallGroups";
import Icon from "./Icon.vue";
import ToolCallCard from "./ToolCallCard.vue";

/**
 * A run of consecutive tool calls, drawn as one card.
 *
 * The run is decided by `groupToolCalls` in the message list — this component is handed calls
 * it already knows belong together, and a length of two or more by construction. Collapsed it
 * is a single line; open it is the cards the reader would have seen without the grouping, so
 * nothing is unreachable, it is only folded away by default.
 */
const props = defineProps<{ calls: ToolCall[] }>();

const { t, te } = useI18n();

/**
 * The run's identity in the expanded set: its first call.
 *
 * Stable across the two things that would otherwise lose the reader's place — the streaming
 * turn becoming a persisted message, and the run growing from two calls to three — because a
 * run's first call never changes and `tool_start` ids are the same strings the persisted
 * `tool_call_id`s are.
 */
const groupKey = computed(() => props.calls[0]?.id ?? "");

const running = computed(() => runningToolCall(props.calls));
const allDone = computed(() => running.value === undefined);
const expanded = computed(() => isToolGroupExpanded(groupKey.value));

/**
 * What the collapsed head says.
 *
 * While a call is in flight the head names *that call and nothing else* — a count beside a
 * live one is a number nobody is reading yet, and the reader's question is "what is it doing",
 * not "how many has it done". Once the run settles there is nothing left to name, so the head
 * becomes the count.
 *
 * The label resolves through `tools.name.*` with the same `te()` guard the card uses: `t()` on
 * a missing key returns the key path, which would render an internal identifier.
 */
const label = computed(() => {
  const head = groupHead(props.calls);
  if (head.kind === "count") return t("tools.group.count", { count: head.count }, head.count);
  const key = "tools.name." + head.name;
  return t("tools.group.running", { name: te(key) ? t(key) : head.name });
});

/**
 * The member ids, space-padded so a search can match one whole word of them.
 *
 * `ChatView` reads this to answer a jump aimed at a card this group is hiding — the plan
 * panel's "locate" points at a tool call, and while the run is collapsed that card is not in
 * the DOM at all. The attribute is what lets the lookup find the group that owns the id and
 * open it. Read out of `dataset` rather than interpolated into a selector, because an id is
 * model- and provider-authored text.
 */
const memberIds = computed(() => ` ${props.calls.map((call) => call.id).join(" ")} `);
</script>

<template>
  <div
    class="tool-card tool-group"
    data-testid="tool-call-group"
    :data-group-key="groupKey"
    :data-tool-call-ids="memberIds"
  >
    <!--
      A `<button>` rather than the clickable `<div>` the single card uses: it carries
      `aria-expanded` and a keyboard can work it, and this control exists only to reveal
      content.
    -->
    <button
      type="button"
      class="tool-head group-head"
      data-testid="tool-call-group-toggle"
      :aria-expanded="expanded"
      @click="toggleToolGroup(groupKey)"
    >
      <Icon :name="allDone ? 'check' : 'retry'" :class="allDone ? 'ok' : 'run'" />
      <span class="name">{{ label }}</span>
      <Icon class="toggle" :name="expanded ? 'caret-down' : 'caret-right'" />
    </button>

    <div v-if="expanded" class="tool-group-body" data-testid="tool-call-group-body">
      <ToolCallCard v-for="call in calls" :key="call.id" :tool-call="call" />
    </div>
  </div>
</template>
