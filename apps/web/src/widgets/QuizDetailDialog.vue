<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { QuizAnswer, QuizAnswers, QuizQuestionView, QuizVerdict } from "../api/types";
import { useAppStore } from "../stores/app";
import { quizReference } from "../utils/turnRefs";
import { codeCopyClick } from "../composables/codeCopy";
import { confirm } from "../composables/confirm";
import { useDraggableWindow } from "../composables/draggableWindow";
import { renderMarkdown } from "../utils/markdown";
import Icon from "../components/Icon.vue";
import type { IconName } from "../utils/icons";
import QuizQuestionForm, { type QuizDraft } from "../components/QuizQuestionForm.vue";

/**
 * The quiz widget's question detail. Read-only once answered/dismissed; a SKIPPED
 * question gets the shared answer form, whose submission persists on the same row and
 * then drives an ordinary chat turn (POST then `/chat`, like the plan jump). Every
 * status offers 追问: a reference to this question, staged in the composer like every other
 * object's.
 *
 * It also **pages**, which is what makes the panel a place to review a quiz rather than a list of
 * doors: `questions` is the order the panel is showing, so 上一题 / 下一题 walk the filter the
 * reader set, and 下一未答题 skips to the next one they never answered.
 */
const props = defineProps<{
  question: QuizQuestionView | null;
  /**
   * The questions to page through, in the order the panel is showing them.
   *
   * A *list* rather than the panel's own state, and deliberately not resolved here from an id:
   * the reader's filter and the tree's collapse state are the panel's business, and a dialog that
   * looked them up would be a second implementation of "which question comes next" — the one thing
   * the two sides must not disagree about.
   *
   * A question that is not in this list (the filter changed under an open dialog) has no position
   * and therefore no navigator: the strip is hidden rather than shown inert.
   */
  questions?: QuizQuestionView[];
  /**
   * Every question that can still be made up — `skipped` or `dismissed` — in the panel's own order.
   *
   * A prop rather than something derived from `questions`, because that list is the reader's
   * *filter*: a reader looking at 答对 has no unanswered question in it at all, and 补答模式 built
   * from it would be empty. The panel holds both lists and hands over the one the mode needs.
   */
  eligible?: QuizQuestionView[];
}>();
const emit = defineEmits<{ (e: "close"): void; (e: "select", question: QuizQuestionView): void }>();

const { t } = useI18n();
const store = useAppStore();

/*
 * A question window is exactly the case the drag exists for: it is opened from the panel *beside*
 * the conversation, and the passage it asks about is often under it.
 */
const panel = ref<HTMLElement | null>(null);
const { placed, dragging, movable, onDragStart, onDragKeydown, onDragReset } = useDraggableWindow({
  id: "quiz-detail",
  panel,
});

const emptyDraft = (): QuizDraft => ({ selected: [], unsure: false, unsureReason: "", notes: "" });
const draft = reactive<QuizDraft>(emptyDraft());

// A different question is a different draft. The follow-up box this used to reset is gone —
// asking about a question now stages a reference and closes, so there is nothing to carry over.
watch(
  () => props.question?.id,
  () => Object.assign(draft, emptyDraft())
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

/**
 * A question that was answered and never graded — the state a failed grading turn leaves.
 *
 * Only this state is re-openable: a graded question is settled history, and an unanswered one needs
 * no re-opening at all (it is already make-up eligible). See `reopenQuizAnswer` on the server for
 * why the answer is discarded rather than kept.
 */
const stuckUngraded = computed(
  () => props.question?.status === "answered" && props.question.verdict === null
);
// Read off whichever draft the form is showing, so the mode's own answers count too.
const draftAnswered = computed(() => {
  const source = activeDraft();
  return source.selected.length > 0 || source.unsure;
});

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

/* --------------------------------- make-up --------------------------------- */

/**
 * Whether the dialog is walking the unanswered questions instead of the panel's list.
 *
 * **补答模式**, and it is a mode rather than a filter because the two answer different questions:
 * the panel's list is what the reader is *reviewing*, and this is what they are *working through*.
 * Inside it every question is unanswered — which is what makes 上一题/下一题 mean "the previous one
 * I have not answered", and what makes a partial submit the ordinary case rather than an edge.
 */
const makeupMode = ref(false);

/** The questions the mode walks, snapshotted when it is entered, in the panel's order. */
const queue = ref<QuizQuestionView[]>([]);

/**
 * One draft per question, so paging back to a question does not lose what was typed into it.
 *
 * Keyed by the global id, not by the `Qn`: the panel reloads its rows on every finished turn, so a
 * position would move under the reader between two pages of the same form.
 */
const drafts = reactive<Record<string, QuizDraft>>({});

/** The draft the form is bound to: the queue's own in the mode, the single one otherwise. */
function activeDraft(): QuizDraft {
  const id = props.question?.id;
  const queued = makeupMode.value && id ? drafts[id] : undefined;
  return queued ?? draft;
}

function isFilled(candidate: QuizDraft | undefined): boolean {
  return !!candidate && (candidate.selected.length > 0 || candidate.unsure);
}

/** One draft as the answer the server takes. Notes travel; a reason only ever with `unsure`. */
function answerOf(source: QuizDraft): QuizAnswer {
  const answer: QuizAnswer = { selected: [...source.selected] };
  if (source.unsure) {
    answer.unsure = true;
    const reason = source.unsureReason.trim();
    if (reason) answer.unsureReason = reason;
  }
  const notes = source.notes.trim();
  if (notes) answer.notes = notes;
  return answer;
}

/** The mode's own progress: how many of the queue have been written, and where the reader is. */
const filledCount = computed(() => queue.value.filter((q) => isFilled(drafts[q.id])).length);
const queueIndex = computed(() => {
  const id = props.question?.id;
  return id ? queue.value.findIndex((q) => q.id === id) : -1;
});

/**
 * The entry point: 补答 on one question.
 *
 * If other questions are unanswered too, it asks rather than assuming — the learner came here for
 * *this* one, and a mode that silently grew to five questions would be a different request than the
 * one they made. Answering "no" submits the single question exactly as before; "yes" opens the mode
 * with the answer already typed carried into it.
 */
/**
 * Re-open the question so it can be answered again.
 *
 * The confirm is the whole of the honesty here: this **discards** the answer that is on screen —
 * the row cannot be both unanswered and carrying one — and the reader is the only one who can
 * decide that a fresh attempt is worth more than the record.
 */
async function reopen(): Promise<void> {
  const question = props.question;
  if (!question || busy.value) return;
  const yes = await confirm({
    title: t("quiz.detail.reopenTitle"),
    message: t("quiz.detail.reopenAsk"),
    detail: t("quiz.detail.reopenDetail"),
    confirmText: t("quiz.detail.reopenConfirm"),
    danger: true,
  });
  if (!yes) return;

  const updated = await store.reopenQuizQuestion(question.id);
  // The panel owns `active`; handing it the fresh row is what makes the dialog show the question as
  // unanswered — and the make-up form, which is the point of doing this.
  if (updated) emit("select", updated);
}

async function startMakeup(): Promise<void> {
  const question = props.question;
  if (!question || !makeupEligible.value || !draftAnswered.value || busy.value) return;

  const others = eligibleQuestions().filter((q) => q.id !== question.id);
  if (others.length > 0) {
    const together = await confirm({
      title: t("quiz.makeup.batchTitle"),
      message: t("quiz.makeup.batchAsk", { count: others.length }),
      detail: t("quiz.makeup.batchDetail"),
      confirmText: t("quiz.makeup.batchYes"),
      cancelText: t("quiz.makeup.batchNo"),
    });
    if (together) {
      enterMakeupMode(question);
      return;
    }
  }
  // Either there was nothing to gather or the reader said no: submit this one, which is the
  // request they made when they pressed the control.
  await submitOne(question);
}

function eligibleQuestions(): QuizQuestionView[] {
  return props.eligible ?? [];
}

function enterMakeupMode(question: QuizQuestionView): void {
  queue.value = eligibleQuestions();
  // Every entry gets its draft here rather than on first render, so a computed that reads one
  // never has to create it — a write during an evaluation is a dependency that invalidates itself.
  for (const queued of queue.value) drafts[queued.id] ??= emptyDraft();
  // The answer the reader had already typed belongs to the queue's entry for it.
  drafts[question.id] = buildAnswerFrom(draft);
  makeupMode.value = true;
}

/** The draft's own shape, copied — `buildAnswerFrom` reads it without consuming it. */
function buildAnswerFrom(source: QuizDraft): QuizDraft {
  return {
    selected: [...source.selected],
    unsure: source.unsure,
    unsureReason: source.unsureReason,
    notes: source.notes,
  };
}

/**
 * Submit one question, with no mode: the reader answered the one they were looking at.
 *
 * It goes through the same route the mode uses — one entry in the batch — so a single make-up and a
 * batch of five are the same request shape, and neither constructs a message for the model.
 */
async function submitOne(question: QuizQuestionView): Promise<void> {
  if (busy.value) return;
  // Resolves once the turn is DISPATCHED, not once the model replies: close now so the streaming
  // grading is visible behind the dialog rather than under it.
  const ok = await store.submitQuizMakeup({ [question.qid]: answerOf(activeDraft()) });
  if (ok) close();
}

/**
 * Submit the mode: everything filled in, and a confirmation when that is not everything.
 *
 * The partial submit is the requirement's, and the confirmation is what makes it honest — the
 * questions left behind keep their unanswered state, so this is "for now" rather than "that is
 * all", and the reader is told which of the two they are choosing.
 */
async function submitQueue(): Promise<void> {
  if (busy.value) return;
  const filled = queue.value.filter((q) => isFilled(drafts[q.id]));
  if (filled.length === 0) return;

  const remaining = queue.value.length - filled.length;
  if (remaining > 0) {
    const partial = await confirm({
      title: t("quiz.makeup.partialTitle"),
      message: t("quiz.makeup.partialAsk", { remaining, filled: filled.length }),
      detail: t("quiz.makeup.partialDetail"),
      confirmText: t("quiz.makeup.partialYes"),
      cancelText: t("quiz.makeup.partialNo"),
    });
    if (!partial) return;
  }

  const answers: QuizAnswers = {};
  for (const question of filled) answers[question.qid] = answerOf(drafts[question.id]!);
  const ok = await store.submitQuizMakeup(answers);
  if (ok) close();
}

function exitMakeupMode(): void {
  makeupMode.value = false;
  queue.value = [];
}

/* --------------------------------- navigation --------------------------------- */

/**
 * Where the open question sits in the list the panel is showing, or `-1`.
 *
 * By id rather than by object identity: the panel reloads its rows on `quiz.changed` and on every
 * finished turn, so the object behind the open dialog is replaced by an equal one several times a
 * conversation — and an index computed from a stale reference would be `-1` from the first reload
 * onwards, hiding the navigator exactly when it is most useful.
 */
const list = computed(() => (makeupMode.value ? queue.value : (props.questions ?? [])));
const index = computed(() => {
  const id = props.question?.id;
  return id ? list.value.findIndex((q) => q.id === id) : -1;
});
const inList = computed(() => index.value >= 0);

/**
 * The whole strip needs somewhere to go.
 *
 * A single question has no next and no previous, so a pager over it would be three controls that
 * cannot act — the "renders but does nothing" this repository keeps out of its UI.
 */
const navigable = computed(() => inList.value && list.value.length > 1);

/**
 * Where the next question with no answer is, or `-1`.
 *
 * **Strictly after the one on screen, and no wrap-around.** "下一未答题" means the next one not
 * yet answered; when there is none after this question the control is absent rather than jumping
 * back to the top, because a button that silently returns you to the beginning is a different
 * action wearing the same label than the one the reader pressed.
 *
 * "Unanswered" is `answer === null` — the same set the panel's 未回答 filter and the make-up form
 * use: `pending` (a card still on screen), `skipped` (walked away) and `dismissed` (cancelled) all
 * lack an answer, and all three are things a reader reviewing a quiz wants to find again.
 */
const nextUnanswered = computed(() =>
  list.value.findIndex((q, at) => at > index.value && !q.answer)
);

function go(to: number): void {
  const question = list.value[to];
  if (question) emit("select", question);
}

/* --------------------------------- follow-up --------------------------------- */

/**
 * Ask about this question.
 *
 * Migrated onto the 追问 mechanism every other object uses, and what changed is where the
 * *question* goes: this used to compose a sentence naming the question and send that as the
 * user's own message, so the agent read the id and the wording out of prose. Now the id is a
 * reference — a chip in the composer, and a line in the prompt that names it — which is the same
 * code path a diagram or a note takes.
 *
 * Two things fall out rather than being decided. The reader types their question in the composer,
 * where every other question is typed, instead of in a box inside this dialog; and **the dialog
 * closes**, because the composer is behind it and a chip staged under an overlay is a chip the
 * reader cannot see. Closing here is safe in a way the note window's is not: this dialog holds no
 * unsaved draft of the reader's own writing.
 */
function askFollowup(): void {
  const question = props.question;
  if (!question) return;
  // The question's own words are the label — a chip reading "Q3" would say nothing about what is
  // being asked, and the reader is looking at the question right now.
  store.stageReference(quizReference(question));
  close();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="question" class="modal-overlay" @click.self="close" data-testid="quiz-detail-overlay">
      <div
        ref="panel"
        class="modal md quiz-detail"
        :class="{ draggable: movable, 'is-moved': placed, dragging }"
        :style="placed ? { left: `${placed.left}px`, top: `${placed.top}px` } : undefined"
        role="dialog"
        :aria-label="t('quiz.detail.title')"
      >
        <div
          class="modal-head"
          :tabindex="movable ? 0 : undefined"
          :title="movable ? t('common.dragWindow') : undefined"
          :aria-label="movable ? t('common.dragWindow') : undefined"
          @pointerdown="onDragStart"
          @keydown="onDragKeydown"
          @dblclick="onDragReset"
        >
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
          <!--
            The pager, above the question rather than in the footer: the footer is the make-up
            form's, and it exists on only some statuses — a pager that came and went with it would
            move under the reader's finger as they walked the list.
          -->
          <div v-if="navigable" class="navigator" data-testid="quiz-nav">
            <!-- The same icons, labels and order as the live card's pager (`QuizCard`), because the
                 two are the same control over two different lists. -->
            <button
              type="button"
              class="btn ghost small"
              :disabled="index <= 0"
              data-testid="quiz-nav-prev"
              @click="go(index - 1)"
            >
              <Icon name="caret-left" /> {{ t("quiz.previous") }}
            </button>
            <span class="nav-count" data-testid="quiz-nav-count">
              {{ t("quiz.step", { current: index + 1, total: list.length }) }}
            </span>
            <button
              type="button"
              class="btn ghost small"
              :disabled="index >= list.length - 1"
              data-testid="quiz-nav-next"
              @click="go(index + 1)"
            >
              {{ t("quiz.next") }} <Icon name="caret-right" />
            </button>
            <!--
              Absent when there is nothing unanswered ahead of this one — see `nextUnanswered` — and
              absent in the mode, where *every* entry is unanswered and the ordinary next control
              already does exactly this.
            -->
            <button
              v-if="!makeupMode && nextUnanswered >= 0"
              type="button"
              class="btn ghost small nav-unanswered"
              data-testid="quiz-nav-unanswered"
              @click="go(nextUnanswered)"
            >
              {{ t("quiz.nextUnanswered") }} <Icon name="caret-right" />
            </button>
          </div>

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
            <!--
              The way out of that state. Without it the question is unanswerable in both
              directions: a make-up refuses an answered row, and the card that asked it is gone.
            -->
            <button
              v-if="stuckUngraded"
              type="button"
              class="btn ghost small"
              :disabled="busy"
              data-testid="quiz-reopen"
              @click="reopen"
            >
              <Icon name="retry" /> {{ t("quiz.detail.reopen") }}
            </button>
          </div>

          <!-- Skipped or cancelled without answering: the make-up form. -->
          <div v-if="makeupEligible" class="makeup" data-testid="quiz-makeup">
            <p class="hint">{{ t("quiz.detail.makeupHint") }}</p>
            <!--
              The mode's arithmetic, both halves of it: which unanswered question this is, and how
              many carry an answer already. The first is what the pager walks; the second is what a
              partial submit is about.
            -->
            <div v-if="makeupMode" class="makeup-progress">
              <span class="step" data-testid="quiz-makeup-step">{{
                t("quiz.makeup.step", { current: queueIndex + 1, total: queue.length })
              }}</span>
              <span class="filled" data-testid="quiz-makeup-filled">{{
                t("quiz.makeup.filled", { count: filledCount })
              }}</span>
            </div>
            <QuizQuestionForm
              :question="question"
              :draft="activeDraft()"
              :index="0"
              testid-prefix="quiz-makeup"
            />
          </div>

          <!--
            Ask about this question, in every status.
          -->
          <div class="followup" data-testid="quiz-followup">
            <button
              type="button"
              class="btn ghost small"
              data-testid="quiz-followup-ask"
              @click="askFollowup"
            >
              <Icon name="link" /> {{ t("turnRef.ask") }}
            </button>
          </div>
        </div>

        <div v-if="makeupEligible" class="modal-foot">
          <!--
            The mode's own way out, and it is a real control rather than the dialog's close: leaving
            the mode and leaving the dialog are different decisions, and the reader who has just
            answered three of five wants the first one.
          -->
          <button
            v-if="makeupMode"
            type="button"
            class="btn ghost"
            data-testid="quiz-makeup-exit"
            @click="exitMakeupMode"
          >
            {{ t("quiz.makeup.exit") }}
          </button>
          <button v-else type="button" class="btn" @click="close">
            {{ t("quiz.detail.close") }}
          </button>

          <button
            v-if="makeupMode"
            type="button"
            class="btn primary"
            :disabled="filledCount === 0 || busy"
            data-testid="quiz-makeup-submit-all"
            @click="submitQueue"
          >
            {{ t("quiz.makeup.submitAll") }}
          </button>
          <button
            v-else
            type="button"
            class="btn primary"
            :disabled="!draftAnswered || busy"
            data-testid="quiz-makeup-submit"
            @click="startMakeup"
          >
            {{ t("quiz.makeup.submit") }}
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

/* A pager: the two arrows hug the count they move through, and the unanswered jump sits apart from
 * them because it is a different kind of move — not one step, but the next one you skipped. */
.navigator {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.nav-count {
  font-size: var(--fs-2);
  color: var(--text-3);
  /* Fixed enough not to shuffle the arrows as the count grows from 1 to 10. */
  min-width: 7em;
  text-align: center;
}
.nav-unanswered {
  margin-left: auto;
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
</style>
