<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  DIAGRAM_TOOL_NAME,
  PLAN_MAKE_TOOL_NAME,
  QUIZ_TOOL_NAME,
  isInteractiveTool,
  type ToolCall,
} from "../api/types";
import AskUserCard from "./AskUserCard.vue";
import DiagramCard from "./DiagramCard.vue";
import PlanConflictCard from "./PlanConflictCard.vue";
import QuizCard from "./QuizCard.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ toolCall: ToolCall }>();

/**
 * A suspending tool's call is not a tool call to report, it is a question to answer — so it
 * renders as its own card rather than through the args/result disclosure below, which has no
 * way to offer controls and would hide the very answer the card exists to record.
 *
 * The second half of the test is not a detail. A suspending call that *failed* — a second
 * one in the same step, or a question set that failed validation — is persisted with an
 * `output` and no `status`, which is also the shape of one mid-`tool_start`. Rendering the
 * card on the name alone left it showing its "preparing" placeholder forever; falling
 * through to the ordinary card shows the `Tool error: …` the model actually got.
 */
const card = computed<"ask" | "quiz" | "plan" | null>(() => {
  if (!isInteractiveTool(props.toolCall.name)) return null;
  if (props.toolCall.status === undefined && props.toolCall.output !== undefined) return null;
  if (props.toolCall.name === QUIZ_TOOL_NAME) return "quiz";
  if (props.toolCall.name === PLAN_MAKE_TOOL_NAME) return "plan";
  return "ask";
});

/**
 * A diagram, which is the one specialized card that is *not* a question.
 *
 * Its own dispatch rather than a fourth member of `card` above, because that computed tests
 * `isInteractiveTool` — "suspends the turn" — and the diagram tool does not. Adding it to
 * `INTERACTIVE_TOOL_NAMES` to reach that switch would move diagram cards into `MessageItem`'s
 * question group (below the reply) and offer the server an answer it has no handler for.
 *
 * Gated on the name alone: a diagram call that failed has an `output` and no `status`, exactly
 * like one whose `tool_start` has not been followed by its `tool_end` yet, so the *card*
 * decides between a drawing and a failure — see `DiagramCard`, which reads the output.
 */
const isDiagram = computed(() => props.toolCall.name === DIAGRAM_TOOL_NAME);

const open = ref(false);
const { t, te } = useI18n();

/**
 * Labels come from the shared tools.name.* namespace, so this and the Copilot dialog's tool
 * list resolve the same key. Uses te() rather than a fallback operator: t() on a missing
 * key returns the key path itself, which would render as an internal identifier.
 */
const label = computed(() => {
  const key = "tools.name." + props.toolCall.name;
  return te(key) ? t(key) : props.toolCall.name;
});
const done = computed(() => props.toolCall.output !== undefined);

const arg = computed(() => {
  try {
    const obj = JSON.parse(props.toolCall.input) as Record<string, unknown>;
    for (const key of ["query", "url", "path", "content", "directory"]) {
      if (obj[key] !== undefined) {
        const s = String(obj[key]);
        return s.length > 80 ? s.slice(0, 80) + "…" : s;
      }
    }
    return "";
  } catch {
    return "";
  }
});

const prettyInput = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.toolCall.input), null, 2);
  } catch {
    return props.toolCall.input;
  }
});
</script>

<template>
  <DiagramCard v-if="isDiagram" :tool-call="toolCall" />
  <AskUserCard v-else-if="card === 'ask'" :tool-call="toolCall" />
  <QuizCard v-else-if="card === 'quiz'" :tool-call="toolCall" />
  <PlanConflictCard v-else-if="card === 'plan'" :tool-call="toolCall" />
  <div
    v-else
    class="tool-card"
    data-testid="tool-call"
    :data-tool-call-id="toolCall.id"
  >
    <div class="tool-head" @click="open = !open">
      <Icon :name="done ? 'check' : 'retry'" :class="done ? 'ok' : 'run'" />
      <span class="name">{{ label }}</span>
      <span class="arg truncate">{{ arg }}</span>
      <span class="status">{{ done ? t("tools.done") : t("tools.running") }}</span>
      <Icon class="toggle" :name="open ? 'caret-down' : 'caret-right'" />
    </div>
    <div v-if="open" class="tool-body">
      <div>
        <div class="key">{{ t("tools.args") }}</div>
        <pre>{{ prettyInput }}</pre>
      </div>
      <div v-if="done">
        <div class="key">{{ t("tools.result") }}</div>
        <pre>{{ props.toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.name {
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}
.arg {
  flex: 1;
  color: var(--text-3);
}
.status {
  font-size: var(--fs-2);
  white-space: nowrap;
}
.icon.run {
  color: var(--accent);
  animation: spin 1s linear infinite;
  display: inline-block;
}
.icon.ok {
  color: var(--success);
}
.toggle {
  color: var(--text-3);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>