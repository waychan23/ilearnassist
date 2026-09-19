<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ASK_USER_TOOL_NAME,
  type AskUserAnswer,
  type AskUserAnswers,
  type AskUserQuestion,
  type ToolCall,
} from "../api/types";
import { useAppStore } from "../stores/app";
import Icon from "./Icon.vue";

const props = defineProps<{ toolCall: ToolCall }>();
const store = useAppStore();
const { t } = useI18n();

/** One question's in-progress answer, before it is turned into an `AskUserAnswer`. */
interface Draft {
  selected: string[];
  other: string;
  /** Whether the client-added free-text choice is the one in force. */
  useOther: boolean;
}

/**
 * Questions come out of the tool call's `input`, which the model wrote and the server
 * validated against the same limits — so this parse has no failure path worth a message.
 * A row with an unparseable `input` renders as the header alone rather than throwing
 * inside a message list.
 */
const questions = computed<AskUserQuestion[]>(() => {
  try {
    const parsed = JSON.parse(props.toolCall.input) as { questions?: AskUserQuestion[] };
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch {
    return [];
  }
});

const draft = reactive<Draft[]>([]);
const current = ref(0);
const open = ref(false);

/**
 * The tab buttons, by question index. Not reactive on purpose: this exists only to move
 * focus after an auto-advance, and nothing renders differently because of it.
 */
const tabRefs: (HTMLButtonElement | undefined)[] = [];

/**
 * Keep one draft per question, without ever discarding one.
 *
 * Deliberately not a rebuild: the source is a computed, and a re-evaluation that produced
 * an equal-but-not-identical array would wipe whatever the user had already answered. The
 * watcher's whole job is to make the array the right length — answers only ever change
 * because the user changed them.
 */
watch(
  questions,
  (list) => {
    while (draft.length > list.length) draft.pop();
    while (draft.length < list.length) draft.push({ selected: [], other: "", useOther: false });
    if (current.value >= list.length) current.value = Math.max(0, list.length - 1);
  },
  { immediate: true }
);

/**
 * `preparing` is the instant between `tool_start` and `message_done`, when the questions
 * are known but the turn has not yet been persisted — answering then would race the write
 * that records the call.
 */
const status = computed(() => props.toolCall.status);
const answerable = computed(() => status.value === "awaiting");
/** Answered, skipped or dismissed — the three states that leave a record to read back. */
const settled = computed(
  () => status.value === "answered" || status.value === "skipped" || status.value === "dismissed"
);
/**
 * The instant between the call arriving and the turn recording it. Nothing to answer and
 * nothing to report — and deliberately *not* the summary, which is what it used to fall
 * through to: a card of "未回答" rows looked like a finished, unanswered record while the
 * model was still streaming the sentence that introduces it.
 */
const preparing = computed(() => !answerable.value && !settled.value);
const busy = computed(() => store.streaming.active);

/**
 * The recorded answer, once there is one. Absent while the card is still live.
 *
 * Narrowed by the tool name rather than read straight off `toolCall.answer`, which carries
 * one shape per suspending tool. The compiler will not insist: both shapes are records of
 * `{ selected, …optionals }`, so a `QuizAnswers` satisfies `AskUserAnswers` structurally
 * while being keyed by question id instead of by position — a runtime difference the types
 * cannot see. This card is the one that knows which tool it renders for.
 */
const recorded = computed<AskUserAnswers | undefined>(() =>
  props.toolCall.name === ASK_USER_TOOL_NAME ? (props.toolCall.answer as AskUserAnswers) : undefined
);

function isAnswered(index: number): boolean {
  const d = draft[index];
  if (!d) return false;
  return d.selected.length > 0 || (d.useOther && d.other.trim().length > 0);
}

const allAnswered = computed(() => questions.value.every((_, index) => isAnswered(index)));
const isLast = computed(() => current.value === questions.value.length - 1);

/**
 * Whether this card finishes itself the moment one of the model's options is picked.
 *
 * True for exactly one shape: a single question, single-select. Picking an option there
 * leaves nothing else to say — the only other input a question offers is its free-text
 * choice, and choosing one of the offered options closes that — so a Submit button would be
 * a control whose only job is to be pressed after the answer is already complete. Never true
 * for a multi-select question, where each pick is one of several and no click means "done",
 * and never true for a card holding several questions, where the set still needs sending.
 */
const autoSubmits = computed(
  () => questions.value.length === 1 && !questions.value[0]?.multiSelect
);

/**
 * Whether a Submit button has anything left to do.
 *
 * Not simply the negation of `autoSubmits`: inside an auto-submitting card, choosing the
 * free-text option opens a box the user has yet to type in and send, so Submit comes back
 * for as long as that choice is the one in force.
 */
const needsSubmit = computed(() => !autoSubmits.value || !!draft[current.value]?.useOther);

function toStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The answer to show for one question in the settled state: what the user chose, plus the
 * text they typed under "other" when they did.
 */
function recordedAnswer(index: number): AskUserAnswer | undefined {
  return recorded.value?.[String(index)];
}

function recordText(index: number): string {
  const answer = recordedAnswer(index);
  const parts = [...(answer?.selected ?? [])];
  if (answer?.other) parts.push(answer.other);
  return parts.join(t("common.listSeparator"));
}

/** Whether a label the model offered is one the user picked. */
function isChosen(index: number, label: string): boolean {
  return recordedAnswer(index)?.selected.includes(label) ?? false;
}

/** The free text the user typed under "other", when that is what they chose. */
function chosenOther(index: number): string | undefined {
  return recordedAnswer(index)?.other || undefined;
}

function toggleOption(index: number, label: string): void {
  const question = questions.value[index];
  const d = draft[index];
  if (!question || !d) return;

  if (question.multiSelect) {
    d.selected = d.selected.includes(label)
      ? d.selected.filter((l) => l !== label)
      : [...d.selected, label];
    return;
  }

  d.selected = [label];
  d.useOther = false;

  // A single choice *is* the answer to its question, so there is nothing left to do here.
  // On a one-question card that means sending it, rather than making the user press a button
  // whose only job was to be pressed after the point was already made. Neither of the other
  // two cases can: multi-select has no "I am done" the user ever gave, and the free-text
  // choice below needs typing.
  if (autoSubmits.value) {
    submit();
    return;
  }

  // On a longer card the wizard steps on by itself instead.
  if (index < questions.value.length - 1) {
    goTo(index + 1);
    // The panel is keyed by the question, so the radio just clicked has been destroyed and
    // focus has fallen to <body>. Hand it to the tab of the question that replaced it,
    // which names where the user now is and is one Tab away from its options.
    void nextTick(() => tabRefs[index + 1]?.focus());
  }
}

function toggleOther(index: number, on: boolean): void {
  const question = questions.value[index];
  const d = draft[index];
  if (!question || !d) return;
  d.useOther = on;
  // Single-select: "other" is the alternative to the offered options, not one more of them.
  if (on && !question.multiSelect) d.selected = [];
}

function goTo(index: number): void {
  if (index >= 0 && index < questions.value.length) current.value = index;
}

function submit(): void {
  if (!allAnswered.value || busy.value) return;
  const answers: AskUserAnswers = {};
  questions.value.forEach((_, index) => {
    const d = draft[index]!;
    const answer: AskUserAnswer = { selected: [...d.selected] };
    const other = d.other.trim();
    if (d.useOther && other) answer.other = other;
    answers[String(index)] = answer;
  });
  void store.answerQuestion(props.toolCall.id, { action: "submit", answers });
}

function dismiss(): void {
  if (busy.value) return;
  void store.answerQuestion(props.toolCall.id, { action: "cancel" });
}

/** Unique per call, so two pending cards never share a radio group or a panel id. */
const uid = computed(() => `ask-${props.toolCall.id.replace(/[^a-zA-Z0-9_-]/g, "")}`);
const tabId = (index: number) => `${uid.value}-tab-${index}`;
const panelId = `${uid.value}-panel`;
</script>

<template>
  <!-- The call's own id, for the reason `QuizCard` gives: a jump anchor addresses a card, and a
       card with no id on it cannot be found. -->
  <div
    class="ask-card"
    :class="{ live: answerable }"
    data-testid="ask-user-card"
    :data-tool-call-id="toolCall.id"
  >
    <div class="ask-head">
      <Icon name="help" class="mark" />
      <span class="title">{{ t("askUser.title") }}</span>
      <span class="status" :class="status ?? 'preparing'" data-testid="ask-user-status">
        {{
          status === "answered"
            ? t("askUser.answered")
            : status === "skipped"
              ? t("askUser.skipped")
              : status === "dismissed"
                ? t("askUser.dismissed")
                : answerable
                  ? t("askUser.awaiting")
                  : t("askUser.preparing")
        }}
      </span>
    </div>

    <div v-if="preparing" class="panel" data-testid="ask-user-preparing">
      <span class="hint">{{ t("askUser.preparing") }}</span>
    </div>

    <!-- Live: one question at a time, tabs across the top, a single submit at the end. -->
    <template v-else-if="answerable">
      <div class="tabs" role="tablist">
        <button
          v-for="(question, index) in questions"
          :key="index"
          :ref="(el) => (tabRefs[index] = (el as HTMLButtonElement | null) ?? undefined)"
          :id="tabId(index)"
          type="button"
          role="tab"
          class="tab"
          :class="{ active: index === current }"
          :aria-selected="index === current"
          :aria-controls="panelId"
          :data-testid="`ask-user-tab-${index}`"
          @click="goTo(index)"
        >
          <Icon v-if="isAnswered(index)" name="check" class="tab-mark" />
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
        <p class="question" data-testid="ask-user-question">{{ questions[current]?.question }}</p>
        <p v-if="questions[current]?.multiSelect" class="hint">{{ t("askUser.multiSelectHint") }}</p>
        <!--
          Shown only while it is still true: picking the free-text choice turns the card back
          into a manual one, and a hint describing the opposite of what a click does is worse
          than no hint at all.
        -->
        <p
          v-if="autoSubmits && !draft[current]?.useOther"
          class="hint"
          data-testid="ask-user-auto-hint"
        >
          {{ t("askUser.autoSubmitHint") }}
        </p>

        <!--
          Keyed by the question, so Vue rebuilds this subtree instead of reusing the
          elements across questions. Reuse is not just stale text: a checked radio whose
          `name` is mutated to the next question's group joins that group while still
          checked, and the browser then unchecks whatever was already selected there —
          silently losing the answer to the question the user navigated back to. The
          answers live in `draft`, so re-creating the inputs costs nothing.
        -->
        <div v-if="draft[current]" :key="current" class="options">
          <label
            v-for="(option, oi) in questions[current]?.options ?? []"
            :key="oi"
            class="option"
            :data-testid="`ask-user-option-${current}-${oi}`"
          >
            <input
              :type="questions[current]?.multiSelect ? 'checkbox' : 'radio'"
              :name="`${uid}-q-${current}`"
              :checked="draft[current]!.selected.includes(option.label)"
              @change="toggleOption(current, option.label)"
            />
            <span class="option-text">
              <span class="option-label">{{ option.label }}</span>
              <span v-if="option.description" class="option-desc">{{ option.description }}</span>
            </span>
          </label>

          <!--
            Appended here, never offered by the model: a free-text escape hatch is a
            property of this UI, and a model that could name it would spend one of its
            four option slots saying "Other".
          -->
          <label class="option other" :data-testid="`ask-user-other-${current}`">
            <input
              :type="questions[current]?.multiSelect ? 'checkbox' : 'radio'"
              :name="`${uid}-q-${current}`"
              :checked="draft[current]!.useOther"
              @change="toggleOther(current, !draft[current]!.useOther)"
            />
            <span class="option-text">
              <span class="option-label">{{ t("askUser.other") }}</span>
            </span>
          </label>
          <input
            v-if="draft[current]!.useOther"
            v-model="draft[current]!.other"
            class="input other-input"
            type="text"
            :placeholder="t('askUser.otherPlaceholder')"
            :aria-label="t('askUser.other')"
            :data-testid="`ask-user-other-input-${current}`"
          />
        </div>
      </div>

      <div class="ask-foot">
        <span class="step" data-testid="ask-user-step">{{
          t("askUser.step", { current: current + 1, total: questions.length })
        }}</span>
        <button
          type="button"
          class="btn ghost small"
          :disabled="current === 0"
          data-testid="ask-user-previous"
          @click="goTo(current - 1)"
        >
          <Icon name="caret-left" /> {{ t("askUser.previous") }}
        </button>
        <button
          v-if="!isLast"
          type="button"
          class="btn ghost small"
          data-testid="ask-user-next"
          @click="goTo(current + 1)"
        >
          {{ t("askUser.next") }} <Icon name="caret-right" />
        </button>
        <button
          v-if="isLast && needsSubmit"
          type="button"
          class="btn primary small"
          :disabled="!allAnswered || busy"
          data-testid="ask-user-submit"
          @click="submit"
        >
          {{ t("askUser.submit") }}
        </button>
        <button
          type="button"
          class="btn ghost small"
          :disabled="busy"
          data-testid="ask-user-dismiss"
          @click="dismiss"
        >
          {{ t("askUser.cancel") }}
        </button>
      </div>
    </template>

    <!--
      Settled: the summary is always visible, because this is what makes the choice legible
      when reading a conversation back. Only the list of options that were offered is
      behind the disclosure — the answer itself never is.
    -->
    <template v-else>
      <ul class="summary">
        <li v-for="(question, index) in questions" :key="index" class="summary-row">
          <span class="summary-question">{{ question.header }}</span>
          <span
            class="summary-answer"
            :class="{ empty: !recordedAnswer(index) }"
            :data-testid="`ask-user-answer-${index}`"
          >
            {{ recordedAnswer(index) ? recordText(index) : t("askUser.unanswered") }}
          </span>
        </li>
      </ul>
      <p v-if="status === 'skipped'" class="hint">{{ t("askUser.skippedHint") }}</p>
      <p v-else-if="status === 'dismissed'" class="hint">{{ t("askUser.dismissedHint") }}</p>

      <button
        type="button"
        class="btn ghost small disclosure"
        data-testid="ask-user-disclosure"
        @click="open = !open"
      >
        {{ t("askUser.details") }}
        <Icon :name="open ? 'caret-down' : 'caret-right'" />
      </button>
      <!--
        The options as they were offered, with the ones the user picked ticked. Reading a
        record back means seeing *what was chosen* against what was on offer — the summary
        above gives the answer, this gives the decision.
      -->
      <div v-if="open" class="details" data-testid="ask-user-details">
        <div v-for="(question, index) in questions" :key="index" class="detail">
          <div class="detail-question">{{ question.question }}</div>
          <div class="detail-label">{{ t("askUser.options") }}</div>
          <ul class="offered">
            <li
              v-for="(option, oi) in question.options"
              :key="oi"
              class="offered-option"
              :class="{ chosen: isChosen(index, option.label) }"
              :data-chosen="isChosen(index, option.label) ? 'true' : 'false'"
              :data-testid="`ask-user-detail-option-${index}-${oi}`"
            >
              <span class="mark-slot">
                <Icon v-if="isChosen(index, option.label)" name="check" class="chosen-mark" />
              </span>
              <span class="offered-text">
                {{ option.label }}
                <span v-if="option.description" class="option-desc">{{ option.description }}</span>
              </span>
            </li>
            <li
              v-if="chosenOther(index)"
              class="offered-option chosen"
              data-chosen="true"
              :data-testid="`ask-user-detail-other-${index}`"
            >
              <span class="mark-slot"><Icon name="check" class="chosen-mark" /></span>
              <span class="offered-text">
                {{ chosenOther(index) }}
                <span class="option-desc">{{ t("askUser.other") }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ask-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: var(--space-4);
  overflow: hidden;
}
/* A question waiting on the user is the one thing in the stream that wants attention. */
.ask-card.live {
  border-color: var(--accent);
}

.ask-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  font-size: var(--fs-3);
  color: var(--text-2);
}
.ask-head .mark {
  color: var(--accent);
  font-size: var(--fs-2);
}
.ask-head .title {
  color: var(--text);
  font-weight: 500;
}
.ask-head .status {
  margin-left: auto;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.ask-head .status.awaiting {
  color: var(--accent);
}

/* The strip is reused from the dialog vocabulary, at this card's own inset. */
.tabs {
  padding: 0 var(--space-5);
}
.tab-mark {
  color: var(--success);
  font-size: var(--fs-2);
  margin-right: var(--space-2);
}

.panel {
  padding: var(--space-5);
  display: grid;
  gap: var(--space-4);
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

.options {
  display: grid;
  gap: var(--space-3);
}
.option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--fs-3);
}
.option:hover {
  border-color: var(--accent);
}
.option input {
  margin: 0;
  flex: none;
  accent-color: var(--accent);
}
.option-text {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.option-label {
  color: var(--text);
}
.option-desc {
  color: var(--text-3);
  font-size: var(--fs-2);
}
.other-input {
  width: 100%;
}

.ask-foot {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.ask-foot .step {
  margin-right: auto;
  font-size: var(--fs-2);
  color: var(--text-3);
}

.summary {
  list-style: none;
  margin: 0;
  padding: var(--space-5);
  display: grid;
  gap: var(--space-3);
}
.summary-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
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
