<script lang="ts">
/** One question's in-progress answer, before it is turned into a `QuizAnswer`. */
export interface QuizDraft {
  selected: string[];
  /** The third state. Mutually exclusive with `selected`, which is why it is not a choice. */
  unsure: boolean;
  unsureReason: string;
  notes: string;
}
</script>

<script setup lang="ts">
import { nextTick } from "vue";
import { useI18n } from "vue-i18n";
import type { QuizQuestion } from "../api/types";
import { autosizeTextarea } from "../utils/autosize";
// `QuizDraft` is declared in the component's plain <script> block, whose scope the setup
// block shares (and which lets QuizCard import the same type).

/**
 * One question's answer form, shared by the live `QuizCard` (tab `index`, prefix
 * `quiz`) and the quiz widget's make-up dialog (single question, prefix `quiz-makeup`).
 *
 * Presentational on purpose: the parent owns the draft and the submit/cancel controls,
 * so the card's tabs and the dialog's modal framing stay separate while every option and
 * field behaves identically. The testids are parameterized by prefix+index so the
 * existing `quiz-option-q-i` selectors keep working unchanged.
 */

const props = withDefaults(
  defineProps<{
    question: QuizQuestion;
    draft: QuizDraft;
    index?: number;
    testidPrefix?: string;
  }>(),
  { index: 0, testidPrefix: "quiz" }
);

const { t } = useI18n();

/**
 * The option's letter, derived from its position in the list. Never sent by the model —
 * the tool tells it to write plain labels — and not a catalog string either: `A` is the
 * order the model listed them in, which a translated alphabet would no longer be.
 */
function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

function toggleOption(label: string): void {
  const d = props.draft;

  // Choosing is the alternative to being unsure, so it releases that state in either
  // mode. The reason text stays in the draft, in case they change their mind back.
  d.unsure = false;

  if (props.question.multiSelect) {
    d.selected = d.selected.includes(label)
      ? d.selected.filter((l) => l !== label)
      : [...d.selected, label];
    return;
  }

  d.selected = [label];
}

function toggleUnsure(on: boolean): void {
  const d = props.draft;
  d.unsure = on;
  // Mutually exclusive, in this direction too: "I don't know" and a choice are two
  // different claims, and the server refuses an answer that makes both.
  if (on) d.selected = [];
}

/**
 * Grow a box to its content as it is typed into. Driven by the event rather than a
 * watcher on the draft: the textarea's own value is already the new one by the time
 * `input` fires.
 */
function growFromEvent(event: Event): void {
  autosizeTextarea(event.target as HTMLTextAreaElement);
}

/**
 * …and size one that appears with text already in it (the panel is keyed by question,
 * and the unsure box is revealed by a checkbox). After the DOM flush rather than during
 * it, so a freshly mounted box is measured with its styles applied.
 */
function growOnMount(el: unknown): void {
  if (!(el instanceof HTMLTextAreaElement)) return;
  void nextTick(() => autosizeTextarea(el));
}
</script>

<template>
  <div class="question-body">
    <div class="options">
      <label
        v-for="(option, oi) in question.options"
        :key="oi"
        class="option"
        :data-testid="`${testidPrefix}-option-${index}-${oi}`"
      >
        <input
          :type="question.multiSelect ? 'checkbox' : 'radio'"
          :name="`${testidPrefix}-q-${index}`"
          :checked="draft.selected.includes(option.label)"
          @change="toggleOption(option.label)"
        />
        <span class="option-key">{{ letter(oi) }}</span>
        <span class="option-text">
          <span class="option-label">{{ option.label }}</span>
          <!--
            The description is shown in the settled view, never while answering: it
            explains the choice, which would hand the explanation out as a hint.
          -->
        </span>
      </label>
    </div>

    <!--
      Appended here, never offered by the model: a multiple-choice list with no escape
      hatch forces a guess and records it as knowledge. A checkbox rather than a member
      of the group, because it is a third state, and it carries no radio `name`.
    -->
    <label class="option unsure" :data-testid="`${testidPrefix}-unsure-${index}`">
      <input type="checkbox" :checked="draft.unsure" @change="toggleUnsure(!draft.unsure)" />
      <!-- Empty spacer where the options keep their letter, so the labels still line up. -->
      <span class="option-key" aria-hidden="true"></span>
      <span class="option-text">
        <span class="option-label">{{ t("quiz.unsure") }}</span>
        <span class="option-desc">{{ t("quiz.unsureHint") }}</span>
      </span>
    </label>
    <div v-if="draft.unsure" class="field">
      <label class="field-label" :for="`${testidPrefix}-unsure-reason-${index}`">
        {{ t("quiz.unsureReasonLabel") }}
      </label>
      <textarea
        :id="`${testidPrefix}-unsure-reason-${index}`"
        v-model="draft.unsureReason"
        class="textarea"
        rows="1"
        :ref="growOnMount"
        :placeholder="t('quiz.unsureReasonPlaceholder')"
        :data-testid="`${testidPrefix}-unsure-reason-${index}`"
        @input="growFromEvent"
      />
    </div>

    <div class="field">
      <label class="field-label" :for="`${testidPrefix}-notes-${index}`">
        {{ t("quiz.notesLabel") }}
      </label>
      <textarea
        :id="`${testidPrefix}-notes-${index}`"
        v-model="draft.notes"
        class="textarea"
        rows="1"
        :ref="growOnMount"
        :placeholder="t('quiz.notesPlaceholder')"
        :data-testid="`${testidPrefix}-notes-${index}`"
        @input="growFromEvent"
      />
    </div>
  </div>
</template>

<style scoped>
.question-body {
  display: grid;
  gap: var(--space-4);
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
/* Dashed, so the third state is visibly not one of the options it sits below. */
.option.unsure {
  border-style: dashed;
}
.option-key {
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-2);
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

.field {
  display: grid;
  gap: var(--space-2);
}
.field-label {
  color: var(--text-3);
  font-size: var(--fs-2);
}
/*
 * One row until the content needs more — `autosizeTextarea` grows it from there. The
 * global `.textarea` carries a 96px floor and a manual resize grip, neither belonging on
 * a box that sizes itself.
 */
.field .textarea {
  min-height: 0;
  resize: none;
}
</style>
