<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { QuizAnswer, QuizQuestionView, QuizVerdict } from "../api/types";
import { useAppStore } from "../stores/app";
import { codeCopyClick } from "../composables/codeCopy";
import { renderMarkdown } from "../utils/markdown";
import Icon from "../components/Icon.vue";
import type { IconName } from "../utils/icons";
import QuizQuestionForm, { type QuizDraft } from "../components/QuizQuestionForm.vue";

/**
 * The quiz widget's question detail. Read-only once answered/dismissed; a SKIPPED
 * question gets the shared answer form, whose submission persists on the same row and
 * then drives an ordinary chat turn (POST then `/chat`, like the plan jump). Every
 * status gets a follow-up box: question about this question, quoted by global id.
 */
const props = defineProps<{ question: QuizQuestionView | null }>();
const emit = defineEmits<{ (e: "close"): void }>();

const { t } = useI18n();
const store = useAppStore();

const emptyDraft = (): QuizDraft => ({ selected: [], unsure: false, unsureReason: "", notes: "" });
const draft = reactive<QuizDraft>(emptyDraft());

watch(
  () => props.question?.id,
  () => {
    Object.assign(draft, emptyDraft());
    followOpen.value = false;
    followText.value = "";
  }
);

function close() {
  emit("close");
}
function onKeydown(event: Event) {
  if ((event as KeyboardEvent).key === "Escape") {
    event.preventDefault();
    close();
  }
}
watch(
  () => props.question,
  (q) => {
    if (q) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  },
  { immediate: true }
);
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

// Make-up covers both "walked away" (skipped) and an explicit card cancel (dismissed):
// both are questions the user never submitted.
const makeupEligible = computed(
  () => props.question?.status === "skipped" || props.question?.status === "dismissed"
);
const busy = computed(() => store.streaming.active);
const draftAnswered = computed(
  () => draft.selected.length > 0 || draft.unsure
);

function letter(index: number): string {
  return String.fromCharCode(65 + index);
}
function isChosen(label: string): boolean {
  return !!props.question?.answer?.selected.includes(label);
}
function chosenUnsure(): boolean {
  return !!props.question?.answer?.unsure;
}

function verdictClass(verdict: QuizVerdict | null): string {
  return verdict ?? "none";
}
function verdictLabel(verdict: QuizVerdict | null): string {
  switch (verdict) {
    case "correct":
      return t("quiz.verdictCorrect");
    case "incorrect":
      return t("quiz.verdictIncorrect");
    case "unsure":
      return t("quiz.verdictUnsure");
    default:
      return t("quiz.verdictUngraded");
  }
}
function verdictIcon(verdict: QuizVerdict | null): IconName {
  if (verdict === "correct") return "check";
  if (verdict === "incorrect") return "close";
  if (verdict === "unsure") return "help";
  return "circle";
}

function statusLabel(status: QuizQuestionView["status"]): string {
  switch (status) {
    case "pending":
      return t("quiz.pending");
    case "answered":
      return t("quiz.answered");
    case "skipped":
      return t("quiz.skipped");
    case "dismissed":
      return t("quiz.dismissed");
  }
}

/** The words `renderMarkdown` bakes into a code block's copy control. */
const markdownLabels = computed(() => ({
  copy: t("common.copy"),
  copied: t("common.copied"),
}));

const questionHtml = computed(() =>
  props.question ? renderMarkdown(props.question.question, markdownLabels.value) : ""
);
const feedbackHtml = computed(() =>
  props.question?.feedback ? renderMarkdown(props.question.feedback, markdownLabels.value) : ""
);

/** The answer/options text quoted into the model-facing make-up message. */
function optionList(): string {
  return (props.question?.options ?? [])
    .map((o, i) => `${letter(i)}. ${o.label}`)
    .join("\n");
}
function answerText(answer: QuizAnswer): string {
  const parts: string[] = [];
  if (answer.unsure) {
    parts.push(t("quiz.unsure") + (answer.unsureReason ? `：${answer.unsureReason}` : ""));
  } else if (answer.selected.length > 0) {
    parts.push(answer.selected.join(t("common.listSeparator")));
  }
  if (answer.notes) parts.push(`${t("quiz.notesLabel")}：${answer.notes}`);
  return parts.join("\n");
}

function buildAnswer(): QuizAnswer {
  const answer: QuizAnswer = { selected: [...draft.selected] };
  if (draft.unsure) {
    answer.unsure = true;
    const reason = draft.unsureReason.trim();
    if (reason) answer.unsureReason = reason;
  }
  const notes = draft.notes.trim();
  if (notes) answer.notes = notes;
  return answer;
}

async function submitMakeup(): Promise<void> {
  const question = props.question;
  if (!question || !makeupEligible.value || !draftAnswered.value || busy.value) return;
  const answer = buildAnswer();
  const message = t("quiz.makeupMessage", {
    id: question.id,
    qid: question.qid,
    question: question.question,
    options: optionList(),
    answer: answerText(answer),
  });
  // Resolves once the answer is persisted and the chat turn is DISPATCHED, not once the
  // model replies: close now so the streaming answer is visible behind the dialog.
  const ok = await store.makeupQuizAnswer(question, answer, message);
  if (ok) close();
}

/* --------------------------------- follow-up --------------------------------- */

const followOpen = ref(false);
const followText = ref("");

async function submitFollowup(): Promise<void> {
  const question = props.question;
  const text = followText.value.trim();
  if (!question || !text || busy.value) return;
  const message = t("quiz.followupMessage", {
    id: question.id,
    qid: question.qid,
    question: question.question,
    text,
  });
  followText.value = "";
  // Dispatch then close immediately: the model's reply streams into the chat behind
  // where the dialog was, instead of being covered until the turn ends.
  close();
  void store.sendPanelMessage(message);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="question" class="modal-overlay" @click.self="close" data-testid="quiz-detail-overlay">
      <div class="modal md quiz-detail" role="dialog" :aria-label="t('quiz.detail.title')">
        <div class="modal-head">
          <div class="head-id">
            <span class="qid">{{ question.qid }}</span>
            <span class="head-header">{{ question.header }}</span>
            <span class="head-status" :data-status="question.status">
              {{ statusLabel(question.status) }}
            </span>
          </div>
          <button
            class="icon-btn"
            :title="t('quiz.detail.close')"
            :aria-label="t('quiz.detail.close')"
            data-testid="quiz-detail-close"
            @click="close"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <p
            class="question-text"
            v-html="questionHtml"
            data-testid="quiz-detail-question"
            @click="codeCopyClick"
          />

          <!--
            Read-back of the given answer only. An unanswered question (pending, or
            make-up-eligible skipped/dismissed) shows nothing here: the option descriptions
            explain the choices and would hand the reasoning out before the make-up form
            below has been used — and the form lists the same choices itself.
          -->
          <template v-if="question.answer">
            <p class="section-label">{{ t("quiz.detail.yourAnswer") }}</p>
            <ul class="offered">
              <li
                v-for="(option, oi) in question.options"
                :key="oi"
                class="offered-option"
                :class="{ chosen: isChosen(option.label) }"
                :data-chosen="isChosen(option.label) ? 'true' : 'false'"
              >
                <span class="mark-slot">
                  <Icon v-if="isChosen(option.label)" name="check" class="chosen-mark" />
                </span>
                <span class="option-key">{{ letter(oi) }}</span>
                <span class="offered-text">
                  {{ option.label }}
                  <span v-if="option.description" class="option-desc">{{ option.description }}</span>
                </span>
              </li>
              <li v-if="chosenUnsure()" class="offered-option chosen" data-chosen="true">
                <span class="mark-slot"><Icon name="check" class="chosen-mark" /></span>
                <span class="offered-text">
                  {{ t("quiz.unsure") }}
                  <span v-if="question.answer?.unsureReason" class="option-desc">
                    {{ question.answer.unsureReason }}
                  </span>
                </span>
              </li>
            </ul>
          </template>

          <p v-if="question.answer?.notes" class="notes">
            <span class="field-label">{{ t("quiz.notesLabel") }}</span>
            <span>{{ question.answer.notes }}</span>
          </p>

          <!-- The model's verdict + explanation, once ila_review_quiz graded the answer. -->
          <div
            v-if="question.status === 'answered'"
            class="verdict"
            :class="verdictClass(question.verdict)"
            :data-testid="`quiz-detail-verdict-${question.id}`"
          >
            <span class="verdict-badge">
              <Icon :name="verdictIcon(question.verdict)" />
              {{ verdictLabel(question.verdict) }}
            </span>
            <template v-if="feedbackHtml">
              <span class="section-label">{{ t("quiz.detail.feedback") }}</span>
              <div class="feedback" v-html="feedbackHtml" @click="codeCopyClick" />
            </template>
            <p v-else class="feedback waiting">{{ t("quiz.detail.waitingGrade") }}</p>
          </div>

          <!-- Skipped or cancelled without answering: the make-up form. -->
          <div v-if="makeupEligible" class="makeup" data-testid="quiz-makeup">
            <p class="hint">{{ t("quiz.detail.makeupHint") }}</p>
            <QuizQuestionForm
              :question="question"
              :draft="draft"
              :index="0"
              testid-prefix="quiz-makeup"
            />
          </div>

          <!-- Follow-up, in every status. -->
          <div class="followup" data-testid="quiz-followup">
            <button
              type="button"
              class="btn ghost small"
              data-testid="quiz-followup-toggle"
              @click="followOpen = !followOpen"
            >
              <Icon name="help" /> {{ t("quiz.detail.followup") }}
            </button>
            <div v-if="followOpen" class="followup-box">
              <textarea
                v-model="followText"
                class="textarea"
                rows="2"
                :placeholder="t('quiz.detail.followupPlaceholder')"
                data-testid="quiz-followup-text"
              />
              <button
                type="button"
                class="btn primary small"
                :disabled="!followText.trim() || busy"
                data-testid="quiz-followup-send"
                @click="submitFollowup"
              >
                {{ t("quiz.detail.followupSend") }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="makeupEligible" class="modal-foot">
          <button type="button" class="btn" @click="close">{{ t("quiz.detail.close") }}</button>
          <button
            type="button"
            class="btn primary"
            :disabled="!draftAnswered || busy"
            data-testid="quiz-makeup-submit"
            @click="submitMakeup"
          >
            {{ t("quiz.detail.makeupSubmit") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.head-id {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
}
.head-header {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qid {
  flex: none;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-3);
  font-size: var(--fs-2);
}
.head-status {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.head-status.pending {
  color: var(--accent);
}

.question-text {
  margin: 0;
  font-size: var(--fs-4);
  color: var(--text);
}
.section-label {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.offered {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--space-3);
}
.offered-option {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  font-size: var(--fs-3);
}
.mark-slot {
  flex: none;
  width: 1em;
}
.chosen-mark {
  color: var(--success);
  font-size: var(--fs-2);
}
.option-key {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.offered-text {
  min-width: 0;
  color: var(--text-3);
}
.offered-option.chosen .offered-text {
  color: var(--text);
}
.option-desc {
  display: block;
  color: var(--text-3);
  font-size: var(--fs-2);
}

.notes {
  margin: 0;
  display: grid;
  gap: var(--space-1);
  font-size: var(--fs-3);
}
.field-label {
  color: var(--text-3);
  font-size: var(--fs-2);
}

.verdict {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.verdict-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-3);
  font-weight: 500;
  justify-self: start;
}
.verdict.correct {
  border-color: var(--success);
}
.verdict.correct .verdict-badge {
  color: var(--success);
}
.verdict.incorrect {
  border-color: var(--danger);
}
.verdict.incorrect .verdict-badge {
  color: var(--danger);
}
.feedback {
  margin: 0;
  font-size: var(--fs-3);
  color: var(--text-2);
}
.feedback.waiting {
  color: var(--text-3);
}

.makeup {
  display: grid;
  gap: var(--space-4);
  border-top: 1px solid var(--border);
  padding-top: var(--space-4);
}
.hint {
  margin: 0;
  font-size: var(--fs-2);
  color: var(--text-3);
}

.followup {
  border-top: 1px solid var(--border);
  padding-top: var(--space-4);
  display: grid;
  gap: var(--space-3);
}
.followup-box {
  display: grid;
  gap: var(--space-3);
  justify-items: start;
}
</style>
