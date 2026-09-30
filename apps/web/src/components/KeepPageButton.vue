<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import Icon from "./Icon.vue";

/**
 * "Keep as a source" — the user's half of `ila_collect_page`, drawn on a `web_fetch` card.
 *
 * The model decides which pages are worth keeping and does not always; this puts the same
 * decision in the reader's hand for the page it read and set aside. The server re-fetches the URL
 * (the turn's page cache is gone), so the press is not instantaneous — the button holds a working
 * state rather than double-firing, and the store reports a refusal through the toast.
 *
 * **`kept` is per mount, and deliberately not persisted.** The sources panel is the record, and
 * the server's keep is idempotent, so a second press refreshes rather than duplicates. Remembering
 * "kept" across reloads would mean a second copy of the conversation's references in the store
 * just to grey out one button — a copy that could disagree with the panel.
 */

const props = defineProps<{ url: string }>();

const { t } = useI18n();
const store = useAppStore();

const keeping = ref(false);
const kept = ref(false);

/** The three states as one sentence: what the press did, or what it is doing. */
const label = computed(() =>
  kept.value
    ? t("tools.fetch.kept")
    : keeping.value
      ? t("tools.fetch.keeping")
      : t("tools.fetch.keep")
);

async function keep(): Promise<void> {
  if (keeping.value || kept.value) return;
  keeping.value = true;
  const ok = await store.keepFetchedPage(props.url);
  keeping.value = false;
  if (ok) kept.value = true;
}
</script>

<template>
  <button
    class="btn small keep-page-btn"
    type="button"
    data-testid="keep-page"
    :data-kept="kept"
    :disabled="keeping || kept"
    :title="label"
    @click="keep"
  >
    <Icon :name="kept ? 'check' : 'plus'" />
    <span>{{ label }}</span>
  </button>
</template>

<style scoped>
.keep-page-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
