<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../api/client";
import type { FileEntry } from "../../api/types";
import { folderCrumbs } from "../../utils/fileTree";
import Icon from "../Icon.vue";

/**
 * Choosing a destination directory inside a workspace.
 *
 * The add dialog's 目录 field used to be free text with a datalist of directories somebody had
 * happened to list already — which asked a person to *type a path* to do a thing every file
 * manager lets them point at. This is that pointer: one level at a time, the way the file tree
 * itself reads (`GET …/files?path=` answers a directory's own entries, so a folder nobody opened
 * costs nothing), plus the one write the flow needs — **creating a folder**, because "put it in
 * this month's folder" is a thought that arrives while the upload is being set up.
 *
 * ### What it collects and what it decides
 *
 * Nothing and nothing: it emits a **path** and closes. The workspace is the caller's (the add
 * dialog may still be showing a different one), the upload is the caller's, and a failure here is
 * a failure to *browse* — which is reported inside this dialog, where the reader is looking.
 *
 * ### Directories only
 *
 * A file is not a destination, so the listing is filtered to `type === "dir"` rather than drawn
 * greyed out: a row that cannot be pressed is noise in a list whose whole purpose is pressing.
 */

const props = defineProps<{
  workspaceId: string;
  /** Where to open, which is wherever the caller has already chosen. */
  initial: string;
}>();

const emit = defineEmits<{ close: []; pick: [path: string] }>();

const { t } = useI18n();

/** The directory being shown. `""` is the workspace root, the same convention `?path=` uses. */
const current = ref(props.initial);
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

/** The new-folder row: open, and what has been typed into it. */
const creating = ref(false);
const newName = ref("");
const createError = ref<string | null>(null);
const createBusy = ref(false);

const folders = computed(() => entries.value.filter((entry) => entry.type === "dir"));
const crumbs = computed(() => folderCrumbs(current.value, t("sources.dirRoot")));

/**
 * Read one level.
 *
 * Re-read on every navigation rather than cached, deliberately: a picker is open for seconds, and
 * a stale level is a folder the reader cannot see after making it. The sequence guard is the same
 * one the file tree keeps (`loadDirectory`'s) — two clicks in quick succession race, and the loser
 * must not paint.
 */
let seq = 0;
async function load(): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  try {
    const listing = await api.listFiles(props.workspaceId, current.value);
    if (mine !== seq) return;
    entries.value = listing.entries;
    error.value = null;
  } catch (e) {
    if (mine !== seq) return;
    entries.value = [];
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

/**
 * Go into a directory — a crumb or a row, one function because it is one act.
 *
 * It **reads the new level itself**, and that is not a detail: `current` is what the listing is
 * *of*, and a version of this that only moved the pointer left the previous level's rows on
 * screen under a breadcrumb saying otherwise. (Found by the browser suite, which is the only
 * place the two can be seen disagreeing.)
 *
 * Opening anywhere also cancels a half-typed folder name: it was a name for the level being left.
 */
function open(path: string): void {
  current.value = path;
  creating.value = false;
  newName.value = "";
  createError.value = null;
  void load();
}

async function create(): Promise<void> {
  const name = newName.value.trim();
  if (!name || createBusy.value) return;
  // The same rule the server enforces (`NAME_REQUIRED`), checked here so a typo is answered
  // without a round trip: a separator would put the folder somewhere nobody pointed at.
  if (name.includes("/") || name.includes("\\")) {
    createError.value = t("sources.dirNameInvalid");
    return;
  }

  createBusy.value = true;
  const path = current.value ? `${current.value}/${name}` : name;
  try {
    await api.createWorkspaceDirectory(props.workspaceId, path);
    createBusy.value = false;
    creating.value = false;
    newName.value = "";
    createError.value = null;
    // **Into the folder that was just made**: creating one here is almost always the first half
    // of "put the file in it", and landing in it makes the second half one press.
    open(path);
  } catch (e) {
    createBusy.value = false;
    createError.value = e instanceof Error ? e.message : String(e);
  }
}

watch(
  () => [props.workspaceId, props.initial],
  () => {
    current.value = props.initial;
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal dir-picker" role="dialog" aria-modal="true" data-testid="dir-picker">
        <div class="modal-head">
          <h3>{{ t("sources.dirPick") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="dir-picker-cancel"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>

        <div class="modal-body">
          <!-- Every stop on the way down, root first — the root included, so "put it at the top"
               is one press rather than a control of its own. -->
          <nav class="crumbs" :aria-label="t('sources.dirPick')" data-testid="dir-crumbs">
            <template v-for="(crumb, index) in crumbs" :key="crumb.path">
              <span v-if="index > 0" class="crumb-sep">/</span>
              <button
                class="crumb"
                type="button"
                :class="{ current: crumb.path === current }"
                :disabled="crumb.path === current"
                data-testid="dir-crumb"
                @click="open(crumb.path)"
              >
                {{ crumb.name }}
              </button>
            </template>
          </nav>

          <p v-if="loading" class="dir-note">{{ t("common.loading") }}</p>
          <p v-else-if="error" class="dir-note error" role="alert" data-testid="dir-picker-error">
            {{ error }}
          </p>
          <div v-else-if="folders.length === 0" class="dir-note" data-testid="dir-picker-empty">
            {{ t("sources.dirEmpty") }}
          </div>
          <ul v-else class="dir-list" data-testid="dir-list">
            <li v-for="folder in folders" :key="folder.path">
              <button
                class="dir-row"
                type="button"
                data-testid="dir-row"
                :title="folder.name"
                @click="open(folder.path)"
              >
                <Icon name="folder" />
                <span class="truncate">{{ folder.name }}</span>
                <Icon name="caret-right" class="dir-go" />
              </button>
            </li>
          </ul>

          <!-- The one write. Inline rather than a second dialog on top of this one: the name is a
               word, and a third overlay for a word is a stack nobody can see the bottom of. -->
          <div v-if="creating" class="dir-create">
            <input
              v-model="newName"
              class="input"
              :placeholder="t('sources.dirNameHint')"
              data-testid="dir-new-name"
              @keydown.enter.prevent="create"
              @keydown.escape.prevent="creating = false"
            />
            <button
              class="btn primary"
              :disabled="!newName.trim() || createBusy"
              data-testid="dir-new-submit"
              @click="create"
            >
              {{ t("common.create") }}
            </button>
          </div>
          <p v-if="createError" class="dir-note error" role="alert" data-testid="dir-new-error">
            {{ createError }}
          </p>
        </div>

        <div class="modal-foot">
          <button
            v-if="!creating"
            class="btn"
            data-testid="dir-new"
            @click="
              creating = true;
              createError = null;
            "
          >
            <Icon name="folder-plus" />
            {{ t("sources.dirNew") }}
          </button>
          <button class="btn" data-testid="dir-picker-close" @click="emit('close')">
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn primary"
            data-testid="dir-pick-confirm"
            @click="emit('pick', current)"
          >
            {{ t("sources.dirChoose") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dir-picker {
  width: var(--modal-md);
}
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  font-size: var(--fs-3);
}
.crumb {
  border: none;
  background: none;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.crumb:hover:not(:disabled) {
  background: var(--panel-2);
}
/* The stop you are standing on: a label rather than a control, because pressing it would do
   nothing — and a control that provably cannot change anything is a lie. */
.crumb.current {
  color: var(--text-2);
  cursor: default;
}
.crumb-sep {
  color: var(--text-3);
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  /* Bounded so a workspace with a hundred folders does not push the footer off the screen. */
  max-height: 320px;
  overflow-y: auto;
}
.dir-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-3);
  text-align: left;
  cursor: pointer;
}
.dir-row:hover {
  background: var(--panel-2);
}
.dir-row .icon {
  flex: none;
  color: var(--text-3);
}
/* The "go into it" mark, quiet: it points at what a press does, it is not a second control. */
.dir-go {
  margin-left: auto;
  color: var(--text-3);
}
.dir-note {
  margin: 0;
  font-size: var(--fs-3);
  color: var(--text-3);
}
.dir-note.error {
  color: var(--danger-text);
}
.dir-create {
  display: flex;
  gap: var(--space-3);
}
.dir-create .input {
  flex: 1;
  min-width: 0;
}
</style>
