<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../api/client";
import { closeSessionFiles, uiState } from "../../composables/ui";
import { relativeTime } from "../../composables/relativeTime";
import { useAppStore } from "../../stores/app";
import { formatBytes } from "../../utils/format";
import { isDiagramFile, type FileEntry } from "../../api/types";
import Icon from "../Icon.vue";

/**
 * A conversation's own folder, as a flat list.
 *
 * Not a tree, unlike the workspace browser, and the difference is the directory rather than a
 * simplification: `sessions/<id>/` holds the files one conversation made for itself — the
 * diagrams it drew — and has no structure to navigate. `FileTree`'s expansion arithmetic would
 * be a control for something that does not exist.
 *
 * The list shows *everything* in the folder, not only the diagrams. The diagram widget is the
 * filtered view; this is the one that answers "what has this conversation written down", which
 * is a question about the folder. A row opens the ordinary file preview, which is also what a
 * workspace file does — there is one preview dialog and it reads whichever root it is handed.
 *
 * Kept off the global toast like every other list failure: the error belongs to the dialog the
 * user just opened, and it is shown with the retry that fixes it.
 */

const store = useAppStore();
const { t } = useI18n();

const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const failed = ref(false);

const closeBtn = ref<HTMLButtonElement | null>(null);

function close(): void {
  closeSessionFiles();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

/**
 * Read the folder for the conversation on screen.
 *
 * The id is captured before the await and re-checked after, the same guard `loadDirectory` and
 * `openFile` keep: a conversation switch during the round trip must not list one
 * conversation's files under another's heading.
 */
async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) return;

  loading.value = true;
  failed.value = false;
  try {
    const listing = await api.listSessionFiles(sessionId, "");
    if (sessionId !== store.activeSessionId) return;
    entries.value = listing.entries;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    failed.value = true;
  } finally {
    if (sessionId === store.activeSessionId) loading.value = false;
  }
}

/**
 * Everything that happens on *opening*, which is not the same moment as mounting.
 *
 * This component is always mounted — it renders nothing while closed, and `App.vue` has no
 * `v-if` on it — so `onMounted` fires once at app start and would leave the list as it was at
 * boot. `SourcesDialog` shipped that bug once; this is the shape that replaced it.
 *
 * `activeSessionId` is watched too, so a conversation switched while the dialog is open does
 * not leave the previous one's files on screen under the new one's name.
 */
watch(
  [() => uiState.sessionFilesOpen, () => store.activeSessionId],
  async ([open]) => {
    if (!open) {
      window.removeEventListener("keydown", onKeydown);
      return;
    }
    window.addEventListener("keydown", onKeydown);
    await load();
    // After the load, because the button does not exist until the dialog has rendered.
    await nextTick();
    closeBtn.value?.focus();
  },
  { immediate: true }
);

onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <!--
    Teleported to `body`: a fixed-position element whose ancestor is transformed is positioned
    against that ancestor, and on a compact viewport the drawer is. See `ConfirmDialog`.
  -->
  <Teleport to="body">
    <div
      v-if="uiState.sessionFilesOpen"
      class="modal-overlay"
      data-testid="session-files"
      @click.self="close"
    >
      <div class="modal">
        <div class="modal-head">
          <h3>{{ t("files.session.title") }}</h3>
          <button
            ref="closeBtn"
            class="icon-btn"
            data-testid="session-files-close"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="close"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <p class="session-lead">{{ t("files.session.lead") }}</p>

          <p v-if="failed" class="session-note error" role="alert" data-testid="session-files-error">
            <Icon name="warning" />
            <span>{{ t("files.session.failed") }}</span>
            <button class="btn small" data-testid="session-files-retry" @click="load">
              {{ t("common.retry") }}
            </button>
          </p>

          <p
            v-else-if="loading"
            class="session-note"
            data-testid="session-files-loading"
          >
            {{ t("common.loading") }}
          </p>

          <p
            v-else-if="entries.length === 0"
            class="session-note"
            data-testid="session-files-empty"
          >
            {{ t("files.session.empty") }}
          </p>

          <ul v-else class="session-list">
            <li v-for="entry in entries" :key="entry.path" class="session-row">
              <button
                class="session-open"
                data-testid="session-file-row"
                :title="t('files.session.open')"
                @click="store.openFile(entry.path, 'session')"
              >
                <span class="session-icon">
                  <Icon :name="isDiagramFile(entry.name) ? 'diagram' : 'file'" />
                </span>
                <span class="session-meta">
                  <span class="session-name truncate" :title="entry.name">{{ entry.name }}</span>
                  <!-- The same `·`-joined detail line the sources list uses. A directory has
                       no size, and this folder holds only files, but the guard costs nothing
                       and one arriving later would otherwise print "null". -->
                  <span class="session-detail" data-testid="session-file-detail">
                    {{
                      [entry.size === null ? "" : formatBytes(entry.size), entry.modifiedAt ? relativeTime(entry.modifiedAt) : ""]
                        .filter(Boolean)
                        .join(" · ")
                    }}
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div class="modal-foot">
          <button class="btn" data-testid="session-files-done" @click="close">
            {{ t("common.close") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.session-lead {
  margin: 0 0 var(--space-6);
  color: var(--text-2);
  font-size: var(--fs-2);
  line-height: 1.5;
}
.session-note {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.session-note.error {
  color: var(--danger-text);
}
.session-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.session-row {
  display: flex;
}
.session-open {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.session-open:hover {
  background: var(--panel-2);
}
.session-icon {
  display: flex;
  flex: none;
  color: var(--text-3);
}
.session-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-1);
}
.session-name {
  color: var(--text);
}
.session-detail {
  color: var(--text-3);
  font-size: var(--fs-2);
}
</style>
