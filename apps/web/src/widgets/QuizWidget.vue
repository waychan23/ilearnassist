<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { PlanView, QuizQuestionView } from "../api/types";
import { useAppStore } from "../stores/app";
import { emitWidgetEvent, subscribeWidgetEvents } from "../composables/widgetEvents";
import {
  buildQuizTree,
  flattenQuizTree,
  IN_PLAN_ROOT,
  OTHER_ROOT,
  type QuizFilter,
  type QuizTreeRow,
} from "../utils/quizTree";
import Icon from "../components/Icon.vue";
import type { IconName } from "../utils/icons";
import QuizDetailDialog from "./QuizDetailDialog.vue";

/**
 * The session-scoped quiz widget. Modeled on the plan widget: a read list refreshed on
 * server-side changes (grading committed mid-turn, or a turn ending), with two views
 * (flat list, chapter tree), a status filter, and per-question actions — a live pending
 * question scrolls to its chat card; everything else opens the detail dialog (read-only,
 * or a make-up form for skipped questions).
 */
const { t } = useI18n();
const store = useAppStore();

const questions = ref<QuizQuestionView[]>([]);
const plan = ref<PlanView | null>(null);
const failed = ref(false);
const view = ref<"list" | "tree">("list");
const filter = ref<QuizFilter>("all");
const collapsed = ref<Set<string>>(new Set());
const active = ref<QuizQuestionView | null>(null);

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    questions.value = [];
    plan.value = null;
    return;
  }
  try {
    const res = await api.listQuizQuestions(sessionId);
    questions.value = res.questions;
    failed.value = false;
    if (res.questions.some((q) => q.nodeId)) {
      // Best effort: without the plan the snapshot folder titles still group the rows.
      try {
        plan.value = (await api.getPlan(sessionId)).plan;
      } catch {
        plan.value = null;
      }
    } else {
      plan.value = null;
    }
  } catch {
    failed.value = true;
  }
}

function resetView(): void {
  questions.value = [];
  plan.value = null;
  failed.value = false;
  view.value = "list";
  filter.value = "all";
  collapsed.value = new Set();
  active.value = null;
}

watch(
  () => store.activeSessionId,
  () => {
    resetView();
    void load();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    switch (event.type) {
      // A grading call committed mid-turn; the turn ending adds/answers questions.
      case "quiz.changed":
      case "turn.finished":
        if (event.sessionId === store.activeSessionId) void load();
        break;
      // The chapter tree moves when the plan does.
      case "plan.changed":
        if (event.sessionId === store.activeSessionId) void load();
        break;
      default:
        break;
    }
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/* --------------------------------- filtering --------------------------------- */

function matches(q: QuizQuestionView): boolean {
  switch (filter.value) {
    case "all":
      return true;
    case "answered":
      return q.status === "answered";
    case "skipped":
      // "Skipped" in the panel covers both walking away and an explicit card cancel:
      // either way the question was never submitted and is make-up eligible.
      return q.status === "skipped" || q.status === "dismissed";
    case "wrong":
      return q.verdict === "incorrect";
  }
}

const filteredQuestions = computed(() =>
  questions.value.filter(matches).sort((a, b) => a.position - b.position)
);

const treeRows = computed<QuizTreeRow[]>(() =>
  flattenQuizTree(buildQuizTree(questions.value, plan.value?.tree ?? null, filter.value), collapsed.value)
);

const visibleQuestionCount = computed(() =>
  view.value === "list" ? filteredQuestions.value.length : treeRows.value.filter((r) => r.kind === "question").length
);

/* ----------------------------------- rows ----------------------------------- */

function toggleFolder(id: string): void {
  if (id === IN_PLAN_ROOT || id === OTHER_ROOT) return;
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function openQuestion(question: QuizQuestionView): void {
  if (question.status === "pending") {
    // The live card in the chat is the answer surface; scroll there instead of opening
    // a read-only dialog.
    emitWidgetEvent({ type: "chat.jump", toolCallId: question.toolCallId });
    return;
  }
  active.value = question;
}

function groupTitle(row: QuizTreeRow & { kind: "group" }): string {
  if (row.id === IN_PLAN_ROOT) return t("quiz.groupInPlan");
  if (row.id === OTHER_ROOT) return t("quiz.groupOther");
  return row.title;
}

function statusIcon(q: QuizQuestionView): IconName {
  switch (q.status) {
    case "pending":
      return "circle";
    case "skipped":
    case "dismissed":
      return "skip";
    case "answered":
      if (q.verdict === "correct") return "check";
      if (q.verdict === "incorrect") return "close";
      if (q.verdict === "unsure") return "help";
      return "progress";
  }
}

function statusTitle(q: QuizQuestionView): string {
  if (q.status === "answered" && q.verdict) {
    if (q.verdict === "correct") return t("quiz.verdictCorrect");
    if (q.verdict === "incorrect") return t("quiz.verdictIncorrect");
    return t("quiz.verdictUnsure");
  }
  switch (q.status) {
    case "pending":
      return t("quiz.pending");
    case "answered":
      return t("quiz.verdictUngraded");
    case "skipped":
      return t("quiz.skipped");
    // A cancelled quiz is a skipped question as far as the panel is concerned.
    case "dismissed":
      return t("quiz.skipped");
  }
}

</script>

<template>
  <div class="quiz-widget" data-testid="widget-quiz">
    <div v-if="!store.activeSession" class="widget-empty">
      {{ t("widgets.quiz.noSession") }}
    </div>

    <div v-else-if="failed" class="widget-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div class="quiz-toolbar" data-testid="quiz-toolbar">
        <div class="segmented" role="group" :aria-label="t('widgets.quiz.name')">
          <button
            type="button"
            class="segment"
            :class="{ active: view === 'list' }"
            :aria-pressed="view === 'list'"
            data-testid="quiz-view-list"
            @click="view = 'list'"
          >
            {{ t("quiz.viewList") }}
          </button>
          <button
            type="button"
            class="segment"
            :class="{ active: view === 'tree' }"
            :aria-pressed="view === 'tree'"
            data-testid="quiz-view-tree"
            @click="view = 'tree'"
          >
            {{ t("quiz.viewTree") }}
          </button>
        </div>
        <select
          v-model="filter"
          class="select quiz-filter"
          :aria-label="t('quiz.title')"
          data-testid="quiz-filter"
        >
          <option value="all">{{ t("quiz.filterAll") }}</option>
          <option value="answered">{{ t("quiz.filterAnswered") }}</option>
          <option value="skipped">{{ t("quiz.filterSkipped") }}</option>
          <option value="wrong">{{ t("quiz.filterWrong") }}</option>
        </select>
      </div>

      <div v-if="visibleQuestionCount === 0" class="widget-empty" data-testid="quiz-empty">
        {{ t("quiz.empty") }}
      </div>

      <!-- Flat list -->
      <ul v-else-if="view === 'list'" class="quiz-list" data-testid="quiz-list">
        <li v-for="q in filteredQuestions" :key="q.id">
          <button
            type="button"
            class="quiz-row"
            :class="['s-' + q.status, 'v-' + (q.verdict ?? 'none')]"
            :title="statusTitle(q)"
            :data-testid="`quiz-row-${q.id}`"
            @click="openQuestion(q)"
          >
            <span class="row-icon" :data-status="q.status" :data-verdict="q.verdict ?? ''">
              <Icon :name="statusIcon(q)" />
            </span>
            <span class="qid">{{ q.qid }}</span>
            <span class="row-text">
              <span class="row-header">{{ q.header }}</span>
              <span class="row-question">{{ q.question }}</span>
            </span>
          </button>
        </li>
      </ul>

      <!-- Chapter tree -->
      <ul v-else class="quiz-tree" data-testid="quiz-tree">
        <template v-for="row in treeRows" :key="row.kind === 'group' ? row.id : row.question.id">
          <li v-if="row.kind === 'group'" :style="{ '--quiz-depth': row.depth }">
            <button
              type="button"
              class="quiz-group"
              :class="{ root: row.depth === 0, missing: row.missing }"
              :data-testid="`quiz-node-${row.id}`"
              @click="toggleFolder(row.id)"
            >
              <Icon
                v-if="row.depth > 0"
                class="caret"
                :name="collapsed.has(row.id) ? 'caret-right' : 'caret-down'"
              />
              <span v-else class="caret-spacer" aria-hidden="true" />
              <span v-if="row.number" class="node-number">{{ row.number }}</span>
              <span class="node-title">{{ groupTitle(row) }}</span>
              <span v-if="row.missing" class="node-missing">（{{ t("quiz.nodeMissing") }}）</span>
              <span class="node-count">{{ row.questionCount }}</span>
            </button>
          </li>
          <li v-else :style="{ '--quiz-depth': row.depth }">
            <button
              type="button"
              class="quiz-row quiz-leaf"
              :class="['s-' + row.question.status, 'v-' + (row.question.verdict ?? 'none')]"
              :title="statusTitle(row.question)"
              :data-testid="`quiz-row-${row.question.id}`"
              @click="openQuestion(row.question)"
            >
              <span
                class="row-icon"
                :data-status="row.question.status"
                :data-verdict="row.question.verdict ?? ''"
              >
                <Icon :name="statusIcon(row.question)" />
              </span>
              <span class="qid">{{ row.question.qid }}</span>
              <span class="row-text">
                <span class="row-header">{{ row.question.header }}</span>
                <span class="row-question">{{ row.question.question }}</span>
              </span>
            </button>
          </li>
        </template>
      </ul>

      <QuizDetailDialog :question="active" @close="active = null" />
    </template>
  </div>
</template>

<style scoped>
.quiz-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex: none;
}
.segment {
  appearance: none;
  border: 0;
  background: transparent;
  padding: var(--space-1) var(--space-3);
  font-size: var(--fs-2);
  color: var(--text-3);
  cursor: pointer;
}
.segment.active {
  background: var(--panel-2);
  color: var(--text);
}
.quiz-filter {
  margin-left: auto;
  width: auto;
  font-size: var(--fs-2);
  padding: var(--space-1) var(--space-2);
}

.quiz-list,
.quiz-tree {
  list-style: none;
  margin: 0;
  padding: 0 var(--space-3) var(--space-4);
  display: grid;
  gap: var(--space-1);
}

.quiz-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.quiz-row:hover {
  background: var(--panel-2);
}
.quiz-leaf {
  padding-left: calc(var(--space-3) + var(--quiz-depth, 1) * var(--space-4));
}
.row-icon {
  flex: none;
  display: inline-flex;
  font-size: var(--fs-3);
  color: var(--text-3);
}
.row-icon[data-status="pending"] {
  color: var(--accent);
}
.row-icon[data-verdict="correct"] {
  color: var(--success);
}
.row-icon[data-verdict="incorrect"] {
  color: var(--danger);
}
.qid {
  flex: none;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-3);
  font-size: var(--fs-2);
}
.row-text {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.row-header {
  font-size: var(--fs-2);
  color: var(--text-3);
}
.row-question {
  font-size: var(--fs-3);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quiz-group {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  padding-left: calc(var(--space-3) + (var(--quiz-depth, 0)) * var(--space-4));
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: var(--fs-3);
  color: var(--text);
}
.quiz-group.root {
  font-weight: 500;
  cursor: default;
}
.quiz-group.missing .node-title {
  color: var(--text-3);
}
.caret {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.caret-spacer {
  width: var(--fs-2);
  flex: none;
}
.node-number {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
  min-width: 2.5em;
}
.node-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-missing {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.node-count {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-2);
  color: var(--text-3);
}
</style>
