<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
// From `shared`, not a local literal: the server filters by exactly these names, so a copy
// that drifted would offer a tool the server does not know, or hide one it does.
import { ALL_TOOL_NAMES, isBuiltinTool, isWidgetBoundTool } from "../api/types";

/**
 * The tool allow-list editor, shared by the Copilot editor and the session create/settings
 * dialogs — that is the whole reason it is a component: the master flag plus the per-tool grid
 * had one inline copy and two more call sites needed the same control.
 *
 * Bound with `v-model:all-tools` + `v-model:tools`; the pair is always written together.
 */
const props = withDefaults(
  defineProps<{
    allTools: boolean;
    tools: string[];
    /** Prefix for the master checkbox's test id (`<prefix>-all-tools`). */
    testidPrefix?: string;
  }>(),
  { testidPrefix: "tool" }
);

const emit = defineEmits<{
  "update:allTools": [value: boolean];
  "update:tools": [value: string[]];
}>();

const { t, te } = useI18n();

/** The tool list shares the tools.name.* namespace with the tool-call card. */
const toolLabel = (name: string): string => {
  const key = "tools.name." + name;
  return te(key) ? t(key) : name;
};

/**
 * Two kinds of tool are not checkable, and each predicate draws one line.
 *
 * `required`-mode tools: an allow-list can neither enable them (the widget install does) nor
 * remove them (they bypass the list in all three states), so a box here would be a control that
 * did nothing. Today that is the quiz pair and nothing else.
 *
 * **Built-in** tools (`isBuiltinTool`): the conversation's own record and transcript reads,
 * assembled in every turn whatever the allow-list says. A box that can never take effect is
 * the same lie as the one above.
 *
 * They still live in `ALL_TOOL_NAMES` so a stale allow-list naming one never errors.
 */
const pickableTools = computed(() =>
  ALL_TOOL_NAMES.filter((name) => !isWidgetBoundTool(name) && !isBuiltinTool(name))
);

/**
 * Turn the master flag on or off. Turning it off empties the list — one pair of writes — so a
 * selection can be made by hand: the saved state has to be the one on screen.
 */
function setAllTools(value: boolean) {
  emit("update:allTools", value);
  if (!value) emit("update:tools", []);
}

function isToolChecked(name: string): boolean {
  return props.allTools || props.tools.includes(name);
}

function toggleTool(name: string) {
  if (props.allTools) {
    // Unchecking one box under "all" is how "everything except this" is said, and it is the
    // only way to narrow from the flag without starting over from nothing. The list becomes
    // the rest of the names, so what is on screen is what gets saved.
    emit("update:allTools", false);
    emit("update:tools", ALL_TOOL_NAMES.filter((n) => n !== name));
    return;
  }
  const next = [...props.tools];
  const i = next.indexOf(name);
  if (i === -1) next.push(name);
  else next.splice(i, 1);
  emit("update:tools", next);
}
</script>

<template>
  <div class="field">
    <label>{{ t("toolChecklist.heading") }}</label>
    <!-- The flag writes the state the boxes show; leaving them in step by hand is what
         keeps "all tools" from meaning "the list happened to hold everything". -->
    <label class="check-row">
      <input
        type="checkbox"
        :data-testid="`${testidPrefix}-all-tools`"
        :checked="allTools"
        @change="setAllTools(($event.target as HTMLInputElement).checked)"
      />
      {{ t("toolChecklist.allTools") }}
    </label>
    <!--
      The row test id keeps the historical `tool-check-*` shape (the browser suite pinned it)
      rather than carrying the prefix; only one checklist is ever mounted per page.
    -->
    <div class="form-grid tool-checks">
      <label
        v-for="name in pickableTools"
        :key="name"
        class="check-row"
        :data-testid="`tool-check-${name}`"
      >
        <input
          type="checkbox"
          :checked="isToolChecked(name)"
          @change="toggleTool(name)"
        />
        {{ toolLabel(name) }}
      </label>
    </div>
    <div class="hint">
      {{ allTools ? t("toolChecklist.allToolsHint") : t("toolChecklist.toolsHint") }}
    </div>
    <div class="hint">{{ t("toolChecklist.boundToolsHint") }}</div>
  </div>
</template>
