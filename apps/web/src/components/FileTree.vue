<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { moveIndex, parentRowIndex, type FileTreeRow } from "../utils/fileTree";
import Icon from "./Icon.vue";

/**
 * The workspace file tree.
 *
 * Everything with arithmetic in it lives in `utils/fileTree.ts` and in the store, because
 * components in this project are covered by Playwright and nothing else — and "which row does
 * ArrowLeft go to" is the kind of thing that is wrong in a way nobody notices.
 *
 * The rows are a **flat list** carrying their own depth, not nested `<ul>`s. That is what
 * makes indentation a multiplication, expansion a single array, and keyboard movement an
 * index — one shape serving all three, and the same shape a virtualised list would need if a
 * workspace ever grows past what is comfortable to render.
 */

const { t } = useI18n();
const store = useAppStore();

/**
 * The one tabbable row.
 *
 * A roving `tabindex` rather than a tabbable row each: Tab should leave the tree for the
 * composer, not walk a hundred files first, which is the pattern `MessageMinimapRail` uses
 * for the same reason.
 */
const activeIndex = ref(0);

const rows = computed<FileTreeRow[]>(() => store.fileRows);

const treeEl = ref<HTMLElement | null>(null);

/*
 * Kept pointing at a row that exists.
 *
 * Both directions matter, and the second one is the one that is easy to miss: rows shrink
 * when a directory is collapsed or a refresh removes files, and if the index is left past the
 * end then no row has `tabindex="0"` and Tab skips the tree entirely. It grows from zero in
 * exactly the case this feature creates — an empty workspace that the agent then writes into
 * — and an index left at -1 is the same stranding from the other side.
 */
watch(
  () => rows.value.length,
  (length) => {
    if (length === 0) activeIndex.value = -1;
    else if (activeIndex.value < 0) activeIndex.value = 0;
    else if (activeIndex.value >= length) activeIndex.value = length - 1;
  }
);

/**
 * Move focus to a row, found by its path rather than by its position.
 *
 * A position-keyed lookup is the obvious way to write this and is wrong: expanding or
 * collapsing renumbers every row after it, so an index collected before the tree changed can
 * address a row that is no longer there — and `focus()` on a detached node does nothing at
 * all, which leaves focus where it was and makes the *next* key press act on the wrong row.
 * Paths are stable across every one of those changes.
 */
function focusRow(index: number) {
  const row = rows.value[index];
  if (!row) return;
  activeIndex.value = index;
  const escaped = CSS.escape(row.entry.path);
  treeEl.value?.querySelector<HTMLElement>(`[data-file-path="${escaped}"]`)?.focus();
}

function isExpanded(path: string): boolean {
  return store.fileExpanded.includes(path);
}

function activate(row: FileTreeRow) {
  if (row.entry.type === "dir") void store.toggleDirectory(row.entry.path);
  else void store.openFile(row.entry.path);
}

/**
 * The ARIA tree keyboard, following the pattern every editor implements:
 *
 * - Up/Down move between visible rows and stop at the ends
 * - Right opens a closed directory, and on an already-open one steps into it
 * - Left closes an open directory, and otherwise goes to the row that encloses this one
 * - Home/End jump, Enter/Space activates
 *
 * `Right` on a directory *that has just been opened* deliberately does not step into it: its
 * children arrive from the server, so at that moment there is nothing to step into. The next
 * press enters. The alternative — remembering an intent and acting on it when the reply
 * lands — is a state machine for a keystroke the user can simply repeat.
 */
function onKeydown(event: KeyboardEvent, index: number) {
  const row = rows.value[index];
  if (!row) return;
  const isDir = row.entry.type === "dir";
  const expanded = isDir && isExpanded(row.entry.path);

  switch (event.key) {
    case "ArrowDown":
      focusRow(moveIndex(rows.value, index, 1));
      break;
    case "ArrowUp":
      focusRow(moveIndex(rows.value, index, -1));
      break;
    case "ArrowRight":
      if (isDir && !expanded) activate(row);
      else if (isDir) focusRow(moveIndex(rows.value, index, 1));
      else return;
      break;
    case "ArrowLeft":
      if (expanded) activate(row);
      else if (row.depth > 0) focusRow(parentRowIndex(rows.value, index));
      else return;
      break;
    case "Home":
      focusRow(0);
      break;
    case "End":
      focusRow(rows.value.length - 1);
      break;
    case "Enter":
    case " ":
      activate(row);
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onRefresh() {
  void store.refreshFileTree();
}
</script>

<template>
  <div
    ref="treeEl"
    class="file-tree"
    role="tree"
    :aria-label="t('files.treeLabel')"
    data-testid="file-tree"
  >
    <div
      v-for="(row, i) in rows"
      :key="row.entry.path"
      class="file-row"
      role="treeitem"
      data-testid="file-row"
      :data-file-path="row.entry.path"
      :aria-level="row.depth + 1"
      :aria-expanded="row.entry.type === 'dir' ? isExpanded(row.entry.path) : undefined"
      :aria-selected="i === activeIndex"
      :aria-busy="store.fileLoadingPath === row.entry.path ? true : undefined"
      :tabindex="i === activeIndex ? 0 : -1"
      :style="{ '--depth': row.depth }"
      :title="row.entry.name"
      @focus="activeIndex = i"
      @click="activate(row)"
      @keydown="onKeydown($event, i)"
    >
      <span class="twist">
        <Icon v-if="row.entry.type === 'dir'" :name="isExpanded(row.entry.path) ? 'caret-down' : 'caret-right'" />
      </span>
      <span class="kind">
        <Icon
          :name="row.entry.type === 'dir' ? (isExpanded(row.entry.path) ? 'folder-open' : 'folder') : 'file'"
        />
      </span>
      <span class="label truncate">{{ row.entry.name }}</span>
    </div>

    <!--
      The three things a tree of rows cannot say by itself. Each is a line under the list
      rather than a row, because none of them is a file.
    -->
    <p v-if="store.fileTreeError" class="file-note error" data-testid="file-tree-error">
      <span>{{ store.fileTreeError }}</span>
      <button class="btn small" data-testid="file-tree-retry" @click="onRefresh">
        {{ t("files.retry") }}
      </button>
    </p>
    <p
      v-else-if="rows.length === 0 && store.fileListings[''] && !store.fileLoadingPath"
      class="file-note"
      data-testid="file-tree-empty"
    >
      {{ t("files.empty") }}
    </p>
    <p v-if="store.fileTruncatedAt !== null" class="file-note" data-testid="file-tree-truncated">
      {{ t("files.truncated", { count: store.fileTruncatedAt }) }}
    </p>
  </div>
</template>

<style scoped>
/*
 * The row. Indentation is `--depth` set inline times a spacing token — the depth is genuinely
 * not a scale value, so it is a computed multiple rather than a literal per level.
 */
.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6) var(--space-3)
    calc(var(--space-4) + var(--depth, 0) * var(--space-6));
  margin: 1px var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-3);
  min-height: 26px;
  cursor: pointer;
  user-select: none;
}
.file-row:hover {
  background: var(--panel-2);
}
.file-row[aria-selected="true"] {
  color: var(--text);
}
.file-row:focus-visible {
  outline-offset: -2px;
}
.twist,
.kind {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  font-size: var(--fs-2);
}
.twist {
  width: 12px;
}
.kind {
  color: var(--text-3);
}
.file-row[aria-expanded="true"] .kind {
  color: var(--accent);
}
.file-row .label {
  min-width: 0;
}

.file-note {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin: 0;
  padding: var(--space-4) var(--space-6);
  color: var(--text-3);
  font-size: var(--fs-2);
}
.file-note.error {
  color: var(--danger-text);
}

/* A finger gets the drawer's 44px row; a mouse keeps the tree dense enough to scan. */
@media (pointer: coarse) {
  .file-row {
    min-height: 44px;
  }
}
</style>
