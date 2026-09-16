<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import Icon from "./Icon.vue";

/**
 * Exporting this conversation's notes into the source library — the action, and the run's state.
 *
 * A conversation-level action rather than a widget's, because what it exports is the
 * conversation's own notes: any conversation may have them, and a button that lived in a panel
 * nobody had installed would be unreachable in exactly the case it exists for. `ChatView`'s
 * topbar draws it, beside the title it acts on.
 *
 * The run outlives the press — the server answers as soon as the job is recorded — so this is
 * mostly a *status*, and the button's wording follows it. Three of the states are the server's
 * three settled outcomes, which are kept apart deliberately: "there were no notes", "it worked"
 * and "it produced nothing usable" are three different things to tell a reader, and a single
 * failure state would report a conversation with nothing in it as a broken button.
 */
const store = useAppStore();
const { t } = useI18n();

const sync = computed(() => store.noteSync);
const running = computed(() => sync.value?.status === "running");
const stuck = computed(() => sync.value?.stuck === true);

/**
 * Whether a press should start a run or take over one.
 *
 * Forced only once the last run is past its timeout, because that is the case the force exists
 * for: a run whose process is gone is otherwise unrecoverable, while a live run is merely slow
 * and starting a second one over the same files is the thing the guard prevents.
 */
const forcing = computed(() => stuck.value);

/** The button's accessible name, which is the action it will take. */
const action = computed(() => (forcing.value ? t("noteSync.force") : t("noteSync.action")));

/**
 * What the status line says, or `null` when there is nothing to report.
 *
 * `added + updated` as one count, because the summary is regenerated on every export and every
 * file embeds it — so a run that changed one note reports the whole set as updated, and two
 * numbers that move together are one number.
 */
const status = computed(() => {
  const value = sync.value;
  if (!value) return null;
  if (value.status === "running") return stuck.value ? t("noteSync.stuck") : t("noteSync.running");
  if (value.status === "ok") {
    const count = value.added + value.updated;
    return t("noteSync.done", { count }, count);
  }
  if (value.status === "empty") return t("noteSync.empty");
  return t("noteSync.failed");
});
</script>

<template>
  <div class="topbar-sync">
    <button
      class="icon-btn sync-btn"
      data-testid="note-sync"
      :disabled="running && !forcing"
      :title="t('noteSync.hint')"
      :aria-label="action"
      @click="store.syncNotesToLibrary(forcing)"
    >
      <!--
        One icon in both states, so a press does not swap the mark out from under the pointer: it
        starts turning instead. `sync` rather than `upload` because nothing is being sent anywhere
        — the notes stay in the conversation and a copy joins the library — and `retry` would read
        as "that failed, try again", which is a different button on a different day.
      -->
      <Icon name="sync" :class="{ run: running }" />
    </button>

    <!--
      `aria-live` rather than a toast: the run ends seconds after the press, when the reader's
      attention has moved on, and their press is the thing that caused it. Announcing it here
      means the outcome arrives with the control that asked for it. The failure's own sentence is
      the provider's, which can be a paragraph — a tooltip is where that belongs, not a topbar.
    -->
    <span
      v-if="status"
      class="sync-status truncate"
      data-testid="note-sync-status"
      aria-live="polite"
      :title="sync?.error ?? undefined"
    >
      {{ status }}
    </span>
  </div>
</template>

<style scoped>
.topbar-sync {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.sync-status {
  color: var(--text-3);
  font-size: var(--fs-2);
  max-width: 22ch;
}

/*
 * Its own keyframes rather than `style.css`'s `spin`, and that is deliberate: `@keyframes` in a
 * scoped block is renamed by the compiler, so this cannot collide with the tool card's spinner —
 * which lives in `style.css` because a rule inside a `.vue` file is invisible to the
 * reduced-motion guard there. That guard is why the preference is honoured *here* instead.
 */
.icon.run {
  color: var(--accent);
  animation: sync-spin 1s linear infinite;
  display: inline-block;
}

@keyframes sync-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  /* The clock stops turning but the label still says "正在同步…", so the state survives the
     preference — the `.note-flash` reasoning in `style.css`, one layer up. */
  .icon.run {
    animation: none;
  }
}
</style>
