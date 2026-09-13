<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PlanConflictAnswer, ToolCall } from "../api/types";
import { useAppStore } from "../stores/app";
import Icon from "./Icon.vue";

/**
 * The `ila_make_plan` fork: a conversation already has a plan and the model asked to create
 * another one, so the turn suspends until the person decides. Two fixed choices — overwrite
 * this plan as a new version, or put it in a fresh conversation — plus the usual dismiss.
 *
 * Like AskUserCard it renders the `awaiting` controls and the settled summary from one
 * stored call; unlike it there is no free text, so the answer is a single object rather
 * than a keyed record.
 */
const props = defineProps<{ toolCall: ToolCall }>();
const store = useAppStore();
const { t } = useI18n();

const status = computed(() => props.toolCall.status);
const answerable = computed(() => status.value === "awaiting");
const settled = computed(
  () => status.value === "answered" || status.value === "dismissed"
);
const preparing = computed(() => !answerable.value && !settled.value);
const busy = computed(() => store.streaming.active);

const recorded = computed<PlanConflictAnswer | undefined>(
  () => props.toolCall.answer as PlanConflictAnswer | undefined
);

function choose(choice: "edit" | "new_session"): void {
  if (busy.value) return;
  void store.answerQuestion(props.toolCall.id, {
    action: "submit",
    answers: { choice },
  });
}

function dismiss(): void {
  if (busy.value) return;
  void store.answerQuestion(props.toolCall.id, { action: "cancel" });
}
</script>

<template>
  <div class="plan-conflict-card" :class="{ live: answerable }" data-testid="plan-conflict-card">
    <div class="pc-head">
      <Icon name="help" class="mark" />
      <span class="title">{{ t("planConflict.title") }}</span>
      <span class="status" :class="status ?? 'preparing'" data-testid="plan-conflict-status">
        {{
          status === "answered"
            ? t("planConflict.answered")
            : status === "dismissed"
              ? t("planConflict.dismissed")
              : answerable
                ? t("planConflict.awaiting")
                : t("planConflict.preparing")
        }}
      </span>
    </div>

    <div v-if="preparing" class="panel" data-testid="plan-conflict-preparing">
      <span class="hint">{{ t("planConflict.preparing") }}</span>
    </div>

    <template v-else-if="answerable">
      <p class="question" data-testid="plan-conflict-question">
        {{ t("planConflict.question") }}
      </p>
      <div class="pc-actions">
        <button
          type="button"
          class="btn small"
          :disabled="busy"
          data-testid="plan-conflict-edit"
          @click="choose('edit')"
        >
          {{ t("planConflict.edit") }}
        </button>
        <button
          type="button"
          class="btn primary small"
          :disabled="busy"
          data-testid="plan-conflict-new-session"
          @click="choose('new_session')"
        >
          {{ t("planConflict.newSession") }}
        </button>
        <button
          type="button"
          class="btn ghost small"
          :disabled="busy"
          data-testid="plan-conflict-dismiss"
          @click="dismiss"
        >
          {{ t("planConflict.cancel") }}
        </button>
      </div>
    </template>

    <template v-else>
      <p class="summary" data-testid="plan-conflict-summary">
        <template v-if="status === 'dismissed'">{{ t("planConflict.dismissedHint") }}</template>
        <template v-else-if="recorded?.choice === 'new_session'">
          {{ t("planConflict.choseNewSession") }}
        </template>
        <template v-else>{{ t("planConflict.choseEdit") }}</template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.plan-conflict-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: var(--space-4);
  overflow: hidden;
}
.plan-conflict-card.live {
  border-color: var(--accent);
}
.pc-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  font-size: var(--fs-3);
  color: var(--text-2);
}
.pc-head .mark {
  color: var(--accent);
}
.pc-head .title {
  color: var(--text);
  font-weight: 500;
}
.pc-head .status {
  margin-left: auto;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.pc-head .status.awaiting {
  color: var(--accent);
}
.panel {
  padding: var(--space-5);
}
.question {
  margin: 0;
  padding: 0 var(--space-5);
  font-size: var(--fs-4);
  color: var(--text);
}
.hint {
  font-size: var(--fs-2);
  color: var(--text-3);
}
.pc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-5);
}
.summary {
  margin: 0;
  padding: var(--space-5);
  font-size: var(--fs-3);
  color: var(--text-2);
}
</style>
