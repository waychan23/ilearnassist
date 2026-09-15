<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { closeSources, uiState } from "../../composables/ui";
import { confirm } from "../../composables/confirm";
import { translateParseError } from "../../utils/apiError";
import { formatBytes } from "../../utils/format";
import type { Source } from "../../api/types";
import Icon from "../Icon.vue";

/**
 * The account's uploaded files.
 *
 * Every file, not just the ones this conversation can see: a source belongs to the account, so
 * this is the only place a file that no conversation references any more is still visible —
 * which is exactly the file someone opens this to find and delete.
 *
 * Deleting is behind `confirm()` and the copy says what it costs, because it is the app's one
 * action that destroys something beyond recovery — a conversation can be recreated, a
 * workspace re-made, but bytes the user uploaded cannot.
 *
 * A row opens the file in the same preview dialog the file tree uses. That is the only place
 * an upload's *contents* can be reached: a source is not in any workspace, so the file tree
 * cannot list it, and until this existed the list offered nothing but a delete button.
 */

const store = useAppStore();
const { t } = useI18n();

const closeBtn = ref<HTMLButtonElement | null>(null);

/**
 * Escape closes this dialog — unless a preview is up over it.
 *
 * `FilePreviewDialog` listens on `window` for the same key, so without the guard one press
 * closes both: the file the reader opened vanishes and the list that opened it slides away
 * underneath. The same early return the drawer's handler makes, for the same reason.
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (store.filePreviewPath) return;
  e.preventDefault();
  close();
}

/**
 * Everything that happens on *opening*, which is not the same moment as mounting.
 *
 * This component is always mounted — it renders nothing while closed, and `App.vue` has no
 * `v-if` on it — so `onMounted` fires once at app start. Loading there left the list as it was
 * at boot and stale for every upload since, which is how the first version of this shipped: the
 * dialog opened on a correct empty list for an account that had files.
 *
 * The listener is a window one rather than `@keydown` on the overlay: the overlay is not
 * focusable, so key events never reach it.
 */
watch(
  () => uiState.sourcesOpen,
  async (open) => {
    if (!open) {
      window.removeEventListener("keydown", onKeydown);
      return;
    }
    window.addEventListener("keydown", onKeydown);
    await store.loadSources();
    // After the load, because the button does not exist until the dialog has rendered.
    await nextTick();
    closeBtn.value?.focus();
  },
  { immediate: true }
);

onUnmounted(() => window.removeEventListener("keydown", onKeydown));

function close(): void {
  closeSources();
}

/** What extraction is doing, in the same words the chip uses — one vocabulary, two places. */
function stateOf(source: Source): string {
  switch (source.parseStatus) {
    case "ready":
      return source.parsedChars
        ? t("sources.parsedChars", { count: source.parsedChars })
        : t("sources.parsed");
    case "pending":
    case "parsing":
      return t("sources.parsing");
    case "failed":
      return (
        translateParseError(source.parseErrorCode, undefined, source.parseError) ||
        t("sources.parseFailed")
      );
    default:
      // `none` — nothing to extract: a text file, an image. Not a state worth a sentence.
      return "";
  }
}

async function remove(source: Source): Promise<void> {
  const ok = await confirm({
    title: t("sources.delete.title"),
    message: t("sources.delete.message", { name: source.name }),
    detail: t("sources.delete.detail"),
    confirmText: t("sources.delete.action"),
    danger: true,
  });
  if (ok) await store.deleteSource(source.id);
}
</script>

<template>
  <!--
    Teleported to `body`: a fixed-position element whose ancestor is transformed is positioned
    against that ancestor, and on a compact viewport the drawer is. See `ConfirmDialog`.
  -->
  <Teleport to="body">
    <div v-if="uiState.sourcesOpen" class="modal-overlay" @click.self="close">
      <div class="modal" data-testid="sources-dialog">
        <div class="modal-head">
          <h3>{{ t("sources.title") }}</h3>
          <button
            ref="closeBtn"
            class="icon-btn"
            data-testid="sources-close"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="close"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <p class="sources-lead">{{ t("sources.lead") }}</p>

          <p v-if="store.sourcesError" class="sources-error" role="alert">
            <Icon name="warning" />
            <span>{{ store.sourcesError }}</span>
          </p>

          <p v-else-if="store.sourcesLoading" class="sources-empty">{{ t("sources.loading") }}</p>

          <p v-else-if="store.sources.length === 0" class="sources-empty" data-testid="sources-empty">
            {{ t("sources.empty") }}
          </p>

          <ul v-else class="sources-list">
            <li
              v-for="source in store.sources"
              :key="source.id"
              class="source"
              data-testid="source-row"
            >
              <!--
                The row's main area opens the file, and it is one button rather than a click
                handler on the `<li>` so the delete button beside it stays a sibling — a button
                inside a button is invalid, and browsers disagree about what it means. Same
                shape as the workspace card's open control, minus the stretched pseudo-element:
                this one fills the row already, so there is nothing to stretch over.
              -->
              <button
                class="source-open"
                data-testid="source-open"
                :title="t('sources.preview', { name: source.name })"
                :aria-label="t('sources.preview', { name: source.name })"
                @click="store.openSourceFile(source)"
              >
                <span class="source-icon">
                  <Icon :name="source.kind === 'image' ? 'image' : 'file'" />
                </span>
                <span class="source-meta">
                  <span class="source-name truncate">{{ source.name }}</span>
                  <span class="source-detail" data-testid="source-detail">
                    {{ [formatBytes(source.size), stateOf(source)].filter(Boolean).join(" · ") }}
                  </span>
                </span>
              </button>
              <button
                class="icon-btn danger"
                data-testid="source-delete"
                :title="t('sources.delete.action')"
                :aria-label="t('sources.delete.action')"
                @click="remove(source)"
              >
                <Icon name="trash" />
              </button>
            </li>
          </ul>
        </div>

        <div class="modal-foot">
          <button class="btn" data-testid="sources-done" @click="close">
            {{ t("common.close") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sources-lead {
  margin: 0 0 var(--space-6);
  font-size: var(--fs-3);
  color: var(--text-3);
  line-height: var(--lh-base);
}
.sources-empty {
  margin: 0;
  font-size: var(--fs-3);
  color: var(--text-3);
}
.sources-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin: 0;
  font-size: var(--fs-3);
  color: var(--danger-text);
}
.sources-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.source {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
/* The affordance, since the row is now something you can open — the workspace card's move. */
.source:hover {
  border-color: var(--accent);
}
/*
 * The open control: a real button, reset to look like the row it fills. `font: inherit` and
 * `color: inherit` are what keep it from reading as a control inside a list, and `min-width: 0`
 * is what lets a long filename shrink instead of pushing delete off the row.
 */
.source-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.source-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-2);
}
.source-meta {
  display: flex;
  flex-direction: column;
  flex: 1;
  /* Without this a long filename refuses to shrink and pushes the delete button off the row. */
  min-width: 0;
}
.source-name {
  font-size: var(--fs-3);
}
.source-detail {
  font-size: var(--fs-2);
  color: var(--text-3);
}
</style>
