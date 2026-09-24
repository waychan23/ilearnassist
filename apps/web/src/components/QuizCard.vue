<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  QUIZ_MAKEUP_TOOL_NAME,
  QUIZ_TOOL_NAME,
  type QuizAnswer,
  type QuizAnswers,
  type QuizQuestion,
  type ToolCall,
} from "../api/types";
import { useAppStore } from "../stores/app";
import Icon from "./Icon.vue";
import QuizQuestionForm, { type QuizDraft } from "./QuizQuestionForm.vue";

const props = defineProps<{ toolCall: ToolCall }>();
const store = useAppStore();
const { t } = useI18n();

/*
 * The card's root carries `data-tool-call-id` — its identity as a *call* rather than as a
 * question, and what `ChatView.revealToolCall` matches to bring it on screen. Two things send
 * that id: the quiz panel's 定位, and the reference chip in a message that asked about the
 * question. The generic card and the two file-shaped ones have always carried it; this one, the
 * plan-conflict card and the ask card were the three that did not, so a pending question's 定位
 * found no element and did nothing at all, silently.
 */

/**
 * Questions come out of the tool call's `input`, which the tool numbered and the server
 * validated against the same limits — so this parse has no failure path worth a message.
 * A row with an unparseable `input` renders as the header alone rather than throwing
 * inside a message list.
 */
const questions = computed<QuizQuestion[]>(() => {
  try {
    const parsed = JSON.parse(props.toolCall.input) as { questions?: QuizQuestion[] };
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch {
    return [];
  }
});

const draft = reactive<QuizDraft[]>([]);
const current = ref(0);
const open = ref(false);

/**
 * Keep one draft per question, without ever discarding one.
 *
 * Deliberately not a rebuild: the source is a computed, and a re-evaluation that produced
 * an equal-but-not-identical array would wipe whatever the user had already answered. The
 * watcher's whole job is to make the array the right length — answers, notes and reasons
 * only ever change because the user changed them.
 */
watch(
  questions,
  (list) => {
    while (draft.length > list.length) draft.pop();
    while (draft.length < list.length) {
      const empty: QuizDraft = { selected: [], unsure: false, unsureReason: "", notes: "" };
      draft.push(empty);
    }
    if (current.value >= list.length) current.value = Math.max(0, list.length - 1);
  },
  { immediate: true }
);

const status = computed(() => props.toolCall.status);
const answerable = computed(() => status.value === "awaiting");
/** Answered, skipped or dismissed — the three states that leave a record to read back. */
const settled = computed(
  () => status.value === "answered" || status.value === "skipped" || status.value === "dismissed"
);
/**
 * The instant between the call arriving and the turn recording it. Nothing to answer and
 * nothing to report — and deliberately *not* the summary, which would read as a finished,
 * unanswered record while the model is still streaming the sentence that introduces it.
 */
const preparing = computed(() => !answerable.value && !settled.value);
const busy = computed(() => store.streaming.active);

/**
 * The recorded answer, once there is one. Absent while the card is still live.
 *
 * The tool name is the discriminant: `answer` carries one shape per suspending tool, and
 * this card is the one that knows which of them it renders for.
 */
const recorded = computed<QuizAnswers | undefined>(() =>
  props.toolCall.name === QUIZ_TOOL_NAME
    ? (props.toolCall.answer as QuizAnswers | undefined)
    : undefined
);

function isAnswered(index: number): boolean {
  const d = draft[index];
  if (!d) return false;
  // Unsure counts: it is an answer about not knowing, which is what the quiz asked for.
  return d.selected.length > 0 || d.unsure;
}

const allAnswered = computed(() => questions.value.every((_, index) => isAnswered(index)));
const isLast = computed(() => current.value === questions.value.length - 1);

/**
 * A question's answer for the record.
 *
 * Keyed by the question's **id**, where `ask_user` keys by position — the id is what the
 * model gets back and what it will refer to the question by later, so it is what the record
 * names its question with.
 */
function recordedAnswer(index: number): QuizAnswer | undefined {
  const id = questions.value[index]?.id;
  return id ? recorded.value?.[id] : undefined;
}

function answerText(index: number): string {
  const answer = recordedAnswer(index);
  if (!answer) return t("quiz.unanswered");
  if (answer.unsure) return t("quiz.unsure");
  return answer.selected.join(t("common.listSeparator"));
}

/** Why they were unsure, when that is what they said. */
function answerReason(index: number): string | undefined {
  const answer = recordedAnswer(index);
  return answer?.unsure ? answer.unsureReason || undefined : undefined;
}

function recordNotes(index: number): string | undefined {
  return recordedAnswer(index)?.notes || undefined;
}

/** Whether a label the model offered is one the user picked. */
function isChosen(index: number, label: string): boolean {
  return recordedAnswer(index)?.selected.includes(label) ?? false;
}

function chosenUnsure(index: number): boolean {
  return recordedAnswer(index)?.unsure ?? false;
}

/**
 * The option's letter, derived from its position in the list.
 *
 * Never sent by the model — the tool tells it to write plain labels — and not a catalog
 * string either: `A` is the order the model listed them in, which a translated alphabet
 * would no longer be.
 */
function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

function goTo(index: number): void {
  if (index >= 0 && index < questions.value.length) current.value = index;
}

function submit(): void {
  if (!allAnswered.value || busy.value) return;
  const answers: QuizAnswers = {};
  questions.value.forEach((question, index) => {
    const d = draft[index];
    if (!d) return;

    const answer: QuizAnswer = { selected: [...d.selected] };
    if (d.unsure) answer.unsure = true;
    // Only ever alongside `unsure`: a reason on a question they actually answered is free
    // text with nothing to attach it to, and the server drops it.
    const reason = d.unsureReason.trim();
    if (d.unsure && reason) answer.unsureReason = reason;
    const notes = d.notes.trim();
    if (notes) answer.notes = notes;

    answers[question.id] = answer;
  });
  void store.answerQuestion(props.toolCall.id, { action: "submit", answers });
}

function dismiss(): void {
  if (busy.value) return;
  void store.answerQuestion(props.toolCall.id, { action: "cancel" });
}

/** Unique per call, so two pending cards never share a radio group or a panel id. */
const uid = computed(() => `quiz-${props.toolCall.id.replace(/[^a-zA-Z0-9_-]/g, "")}`);
const tabId = (index: number) => `${uid.value}-tab-${index}`;
const panelId = `${uid.value}-panel`;
</script>

<template>
  <!-- The call's own id, for the reason the script block gives. -->
  <div
    class="quiz-card"
    :class="{ live: answerable }"
    data-testid="quiz-card"
    :data-tool-call-id="toolCall.id"
  >
    <div class="quiz-head">
      <Icon name="bulb" class="mark" />
      <!--
        Two whole `t()` calls rather than one with the key chosen inside it, because
        `catalog.test.ts` scans the source for `t("…")` literals: a key reached through an
        expression is invisible to it, and would be reported as a dead key. The same reason
        `DiagramDialog` spells its two labels out.
      -->
      <span v-if="toolCall.name === QUIZ_MAKEUP_TOOL_NAME" class="title">{{
        t("quiz.makeupTitle")
      }}</span>
      <span v-else class="title">{{ t("quiz.title") }}</span>
      <span class="status" :class="status ?? 'preparing'" data-testid="quiz-status">
        {{
          status === "answered"
            ? t("quiz.answered")
            : status === "skipped"
              ? t("quiz.skipped")
              : status === "dismissed"
                ? t("quiz.dismissed")
                : answerable
                  ? t("quiz.awaiting")
                  : t("quiz.preparing")
        }}
      </span>
    </div>

    <div v-if="preparing" class="panel" data-testid="quiz-preparing">
      <span class="hint">{{ t("quiz.preparing") }}</span>
    </div>

    <!-- Live: one question at a time, tabs across the top, a single submit at the end. -->
    <template v-else-if="answerable">
      <!--
        The strip scrolls rather than wraps: a quiz may run to ten questions, and ten
        labelled tabs are wider than a chat column. Without it the tabs would be squeezed
        instead, which is what `flex-shrink: 0` on each one prevents.
      -->
      <div class="tabs" role="tablist">
        <button
          v-for="(question, index) in questions"
          :key="question.id || index"
          :id="tabId(index)"
          type="button"
          role="tab"
          class="tab"
          :class="{ active: index === current }"
          :aria-selected="index === current"
          :aria-controls="panelId"
          :data-testid="`quiz-tab-${index}`"
          @click="goTo(index)"
        >
          <Icon v-if="isAnswered(index)" name="check" class="tab-mark" />
          <!-- The question's own id, as issued. Data, not copy — see `letter` above. -->
          <span v-if="question.id" class="tab-id">{{ question.id }}</span>
          {{ question.header }}
        </button>
      </div>

      <div
        :id="panelId"
        class="panel"
        role="tabpanel"
        :aria-labelledby="tabId(current)"
        tabindex="0"
      >
        <div class="panel-head">
          <span v-if="questions[current]?.id" class="qid" :data-testid="`quiz-id-${current}`">
            {{ questions[current]?.id }}
          </span>
          <p class="question" data-testid="quiz-question">{{ questions[current]?.question }}</p>
        </div>
        <p v-if="questions[current]?.multiSelect" class="hint">{{ t("quiz.multiSelectHint") }}</p>

        <!--
          Keyed by the question, so Vue rebuilds this subtree instead of reusing the
          elements across questions. Reuse is not just stale text: a checked radio whose
          `name` is mutated to the next question's group joins that group while still
          checked, and the browser then unchecks whatever was already selected there —
          silently losing the answer to the question the user navigated back to. The
          answers live in `draft`, so re-creating the inputs costs nothing.
        -->
        <QuizQuestionForm
          v-if="draft[current] && questions[current]"
          :key="current"
          :question="questions[current]!"
          :draft="draft[current]!"
          :index="current"
          testid-prefix="quiz"
        />
      </div>

      <div class="quiz-foot">
        <span class="step" data-testid="quiz-step">{{
          t("quiz.step", { current: current + 1, total: questions.length })
        }}</span>
        <button
          type="button"
          class="btn ghost small"
          :disabled="current === 0"
          data-testid="quiz-previous"
          @click="goTo(current - 1)"
        >
          <Icon name="caret-left" /> {{ t("quiz.previous") }}
        </button>
        <button
          v-if="!isLast"
          type="button"
          class="btn ghost small"
          data-testid="quiz-next"
          @click="goTo(current + 1)"
        >
          {{ t("quiz.next") }} <Icon name="caret-right" />
        </button>
        <button
          v-if="isLast"
          type="button"
          class="btn primary small"
          :disabled="!allAnswered || busy"
          data-testid="quiz-submit"
          @click="submit"
        >
          {{ t("quiz.submit") }}
        </button>
        <button
          type="button"
          class="btn ghost small"
          :disabled="busy"
          data-testid="quiz-dismiss"
          @click="dismiss"
        >
          {{ t("quiz.cancel") }}
        </button>
      </div>
    </template>

    <!--
      Settled: the summary is always visible, because this is what makes the answers legible
      when a conversation is read back. Only the options that were offered are behind the
      disclosure — the answers themselves never are.
    -->
    <template v-else>
      <ul class="summary">
        <li v-for="(question, index) in questions" :key="question.id || index" class="summary-row">
          <span v-if="question.id" class="qid" :data-testid="`quiz-answer-id-${index}`">
            {{ question.id }}
          </span>
          <span class="summary-question">{{ question.header }}</span>
          <span
            class="summary-answer"
            :class="{ empty: !recordedAnswer(index) }"
            :data-testid="`quiz-answer-${index}`"
          >
            {{ answerText(index) }}
            <span v-if="answerReason(index)" class="answer-reason">{{ answerReason(index) }}</span>
          </span>
          <div
            v-if="recordNotes(index)"
            class="summary-notes"
            :data-testid="`quiz-answer-notes-${index}`"
          >
            <span class="field-label">{{ t("quiz.notesLabel") }}</span>
            <span class="notes-text">{{ recordNotes(index) }}</span>
          </div>
        </li>
      </ul>
      <p v-if="status === 'skipped'" class="hint">{{ t("quiz.skippedHint") }}</p>
      <p v-else-if="status === 'dismissed'" class="hint">{{ t("quiz.dismissedHint") }}</p>

      <button
        type="button"
        class="btn ghost small disclosure"
        data-testid="quiz-disclosure"
        @click="open = !open"
      >
        {{ t("quiz.details") }}
        <Icon :name="open ? 'caret-down' : 'caret-right'" />
      </button>
      <!--
        The options as they were offered, with the ones the user picked ticked. Reading a
        record back means seeing *what was chosen* against what was on offer — the summary
        above gives the answer, this gives the choice.
      -->
      <div v-if="open" class="details" data-testid="quiz-details">
        <div v-for="(question, index) in questions" :key="question.id || index" class="detail">
          <div class="detail-question">
            <span v-if="question.id" class="qid">{{ question.id }}</span>
            {{ question.question }}
          </div>
          <div class="detail-label">{{ t("quiz.options") }}</div>
          <ul class="offered">
            <li
              v-for="(option, oi) in question.options"
              :key="oi"
              class="offered-option"
              :class="{ chosen: isChosen(index, option.label) }"
              :data-chosen="isChosen(index, option.label) ? 'true' : 'false'"
              :data-testid="`quiz-detail-option-${index}-${oi}`"
            >
              <span class="mark-slot">
                <Icon v-if="isChosen(index, option.label)" name="check" class="chosen-mark" />
              </span>
              <span class="option-key">{{ letter(oi) }}</span>
              <span class="offered-text">
                {{ option.label }}
                <!--
                  The description explains the choice. A question in a skipped/dismissed
                  quiz was never answered and is still make-up eligible from the panel, so
                  showing it there would leak the reasoning before the make-up: only
                  settled answers get the explanation.
                -->
                <span
                  v-if="option.description && recordedAnswer(index)"
                  class="option-desc"
                  >{{ option.description }}</span
                >
              </span>
            </li>
            <!--
              The unsure answer appears with the options, not only in the summary: it *is*
              an answer, and where a reader is asking "what was on offer", its absence would
              read as a question that went unanswered.
            -->
            <li
              v-if="chosenUnsure(index)"
              class="offered-option chosen"
              data-chosen="true"
              :data-testid="`quiz-detail-unsure-${index}`"
            >
              <span class="mark-slot"><Icon name="check" class="chosen-mark" /></span>
              <span class="offered-text">
                {{ t("quiz.unsure") }}
                <span v-if="answerReason(index)" class="option-desc">{{ answerReason(index) }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.quiz-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: var(--space-4);
  overflow: hidden;
}
/* A quiz waiting on the user is the one thing in the stream that wants attention. */
.quiz-card.live {
  border-color: var(--accent);
}

.quiz-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  font-size: var(--fs-3);
  color: var(--text-2);
}
.quiz-head .mark {
  color: var(--accent);
  font-size: var(--fs-2);
}
.quiz-head .title {
  color: var(--text);
  font-weight: 500;
}
.quiz-head .status {
  margin-left: auto;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.quiz-head .status.awaiting {
  color: var(--accent);
}

/* The strip is reused from the dialog vocabulary, at this card's own inset. */
.tabs {
  padding: 0 var(--space-5);
  overflow-x: auto;
}
.tab {
  flex-shrink: 0;
}
.tab-mark {
  color: var(--success);
  font-size: var(--fs-2);
  margin-right: var(--space-2);
}
.tab-id {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin-right: var(--space-2);
}

.panel {
  padding: var(--space-5);
  display: grid;
  gap: var(--space-4);
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}
.panel-head .question {
  flex: 1;
}
.question {
  margin: 0;
  font-size: var(--fs-4);
  color: var(--text);
}
.hint {
  margin: 0;
  font-size: var(--fs-2);
  color: var(--text-3);
}

/* A question's id, as the tool issued it. A badge rather than a label, so it reads as an
   identifier beside the text rather than as part of the sentence. */
.qid {
  flex: none;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-3);
  font-size: var(--fs-2);
}


.quiz-foot {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.quiz-foot .step {
  margin-right: auto;
  font-size: var(--fs-2);
  color: var(--text-3);
}

.summary {
  list-style: none;
  margin: 0;
  padding: var(--space-5);
  display: grid;
  gap: var(--space-4);
}
.summary-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: baseline;
  gap: var(--space-3) var(--space-4);
  font-size: var(--fs-3);
}
.summary-question {
  flex: none;
  color: var(--text-3);
}
.summary-answer {
  color: var(--text);
  min-width: 0;
}
.summary-answer.empty {
  color: var(--text-3);
}
/* Set off from the answer by a space, so "不确定" and the reason read as two things. */
.answer-reason {
  margin-left: var(--space-3);
  color: var(--text-3);
}
/* The note spans the row, because it is the user's own words about the answer above it. */
.summary-notes {
  grid-column: 2 / -1;
  display: grid;
  gap: var(--space-1);
  font-size: var(--fs-2);
}
.summary-notes .notes-text {
  color: var(--text-2);
}

.disclosure {
  margin: 0 var(--space-5) var(--space-5);
}
.details {
  border-top: 1px solid var(--border);
  padding: var(--space-5);
  display: grid;
  gap: var(--space-5);
}
.detail-question {
  color: var(--text);
  font-size: var(--fs-3);
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}
.detail-label {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin: var(--space-2) 0;
}
.offered {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--space-3);
  font-size: var(--fs-3);
}
.offered-option {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}
/* A fixed gutter so ticking one option does not shift the others sideways. */
.mark-slot {
  flex: none;
  width: 1em;
}
.chosen-mark {
  color: var(--success);
  font-size: var(--fs-2);
}
.offered-text {
  min-width: 0;
  color: var(--text-3);
}
.offered-option.chosen .offered-text {
  color: var(--text);
}
</style>
