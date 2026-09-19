<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { confirm } from "../composables/confirm";
import { moveIndex, parentRowIndex, type FileTreeRow } from "../utils/fileTree";
import FilePathDialog from "./dialogs/FilePathDialog.vue";
import Icon from "./Icon.vue";

/**
 * The workspace file tree, and the file manager.
 *
 * Everything with arithmetic in it lives in `utils/fileTree.ts` and in the store, because
 * components in this project are covered by Playwright and nothing else — and "which row does
 * ArrowLeft go to" is the kind of thing that is wrong in a way nobody notices.
 *
 * The rows are a **flat list** carrying their own depth, not nested `<ul>`s. That is what
 * makes indentation a multiplication, expansion a single array, and keyboard movement an
 * index — one shape serving all three, and the same shape a virtualised list would need if a
 * workspace ever grows past what is comfortable to render.
 *
 * ### Why the writes are here at all
 *
 * Until now this panel only read: the agent wrote the files and the user looked at them. It is
 * a *web* app, so there is no Finder to fall back on — a directory nobody can create a folder
 * in is a directory only the model can organise, which is the gap the four actions close. Each
 * one is a small call into the store; the two that need a name share `FilePathDialog`, and the
 * two that destroy something go through `confirm()`.
 *
 * Rows carry their own actions rather than a context menu: the sidebar is narrow and a menu
 * anchored inside it is either clipped or floating over the conversation, and the session list
 * directly above solves the same problem the same way.
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

/* ------------------------------- the file manager ------------------------------- */

/**
 * Which dialog is open, if any, and for what.
 *
 * One ref rather than two booleans: the two dialogs are the same component with different
 * words, and a file cannot be both being created and being renamed. `null` is closed.
 */
const dialog = ref<
  { kind: "folder"; dir: string } | { kind: "rename"; path: string } | null
>(null);

const uploadInput = ref<HTMLInputElement | null>(null);

/**
 * The directory an action from the toolbar applies to: the row in front of the user.
 *
 * A directory row means that directory; a file row, or nothing selected, means the directory
 * holding it. This is the reading people expect from a tree — the thing under the cursor is
 * the thing being acted on — and it is what makes "new folder" land where the eye is rather
 * than always at the root.
 */
const targetDir = computed<string>(() => {
  const row = rows.value[activeIndex.value];
  if (!row) return "";
  return row.entry.type === "dir" ? row.entry.path : parentPath(row.entry.path);
});

function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/* ------------------------------- drag to move ------------------------------- */

/**
 * Dragging a row onto a folder to move it there.
 *
 * The rename/move dialog is still the complete way to move something — it can put a file
 * anywhere by typing a path — and this is the *fast* way for a move between two rows that are
 * both on screen. Neither replaces the other: a drop target can only be a row you can see, and
 * a dialog is a poor way to put a file next to the one above it.
 *
 * `dragging` is the path being dragged, and it is what the drop target is checked against —
 * dropping a folder into its own descendant is the one move that cannot work, and the server
 * refuses it. Catching it here means the row never highlights as a valid target, rather than
 * the user dropping and reading an error.
 */
const dragging = ref<string | null>(null);
const dropTarget = ref<string | null>(null);

function onDragStart(event: DragEvent, row: FileTreeRow) {
  dragging.value = row.entry.path;
  dropTarget.value = null;
  // Some browsers cancel a drag with no data set, and the path is the payload in any case.
  event.dataTransfer?.setData("text/plain", row.entry.path);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd() {
  dragging.value = null;
  dropTarget.value = null;
}

/**
 * Whether a row can receive what is being dragged.
 *
 * Four refusals, and each is a move the server would reject or that means nothing: dropping onto
 * itself, onto the folder that already holds it, into its own subtree, and onto a *file* — a
 * file is not a place.
 */
function canDropOn(row: FileTreeRow): boolean {
  const from = dragging.value;
  if (from === null || from === row.entry.path) return false;
  if (row.entry.type !== "dir") return false;
  if (parentPath(from) === row.entry.path) return false;
  return !row.entry.path.startsWith(`${from}/`);
}

function onDragOver(event: DragEvent, row: FileTreeRow) {
  if (dragging.value === null) return;
  // `preventDefault` on dragover is what makes an element a drop target at all — without it the
  // browser refuses the drop and shows the "no entry" cursor.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = canDropOn(row) ? "move" : "none";
  dropTarget.value = canDropOn(row) ? row.entry.path : null;
}

function onDrop(event: DragEvent, row: FileTreeRow) {
  event.preventDefault();
  event.stopPropagation();
  // Read before clearing: `canDropOn` answers *about* the drag in progress, and clearing first
  // makes it answer "no" every time — which is how this was found, by a browser spec that
  // dropped a file on a folder and watched nothing happen.
  const from = dragging.value;
  const allowed = canDropOn(row);
  onDragEnd();
  if (from === null || !allowed) return;

  const name = from.slice(from.lastIndexOf("/") + 1);
  void store.moveEntry(from, row.entry.path ? `${row.entry.path}/${name}` : name);
}

/**
 * Dropping on the panel itself means the workspace root.
 *
 * The root has no row to aim at, so without this a file could be dragged *into* a folder and not
 * back *out* of one — which is half a feature.
 */
function onRootDrop(event: DragEvent) {
  event.preventDefault();
  const from = dragging.value;
  onDragEnd();
  if (from === null || parentPath(from) === "") return;

  const name = from.slice(from.lastIndexOf("/") + 1);
  void store.moveEntry(from, name);
}

function openNewFolder() {
  dialog.value = { kind: "folder", dir: targetDir.value };
}

function openRename(row: FileTreeRow) {
  dialog.value = { kind: "rename", path: row.entry.path };
}

function submitDialog(value: string) {
  const open = dialog.value;
  dialog.value = null;
  if (!open) return;
  if (open.kind === "folder") void store.createFolder(open.dir, value);
  else void store.moveEntry(open.path, value);
}

async function onDelete(row: FileTreeRow) {
  const isDir = row.entry.type === "dir";
  /*
   * A **file** is the same delete the library's rows offer, and it says the same words: the route
   * is the only thing that differs (a tree can name a path and not a reference), and both end in
   * `deleteWorkResource`. It used to have a sentence of its own — "文件会保留在回收目录中" — which
   * described the bytes accurately and left out the half a reader needs: the file's other
   * references are about to start reporting that the object is gone.
   *
   * A **directory** keeps its own pair, because the library has no equivalent: a directory is not
   * a file, nothing references it, and only an empty one may go.
   *
   * Both branches spelled out rather than an id chosen inside one `t()` call:
   * `catalog.test.ts` finds keys by scanning for `t("…")` literals, so a key reached through a
   * ternary is invisible to it and the dead-key scan reports both as unused. The narrower fix is
   * this shape; the wider one would be a `files.` entry in the dynamic-prefix allowlist, and a
   * prefix that broad is where a typo hides.
   */
  const title = isDir ? t("files.deleteDirectoryTitle") : t("sources.delete.title");
  const message = isDir
    ? t("files.deleteDirectoryMessage", { name: row.entry.name })
    : t("sources.delete.message", { name: row.entry.name });
  const detail = isDir ? undefined : t("sources.delete.detail");

  const ok = await confirm({
    title,
    message,
    detail,
    // Destructive either way, and `danger` is not a judgement about how destructive: it is the
    // colour a reader should hesitate at.
    danger: true,
  });
  if (!ok) return;

  const path = row.entry.path;
  void store.deleteEntry(path);
}

/** Upload into `targetDir`, one request per file. */
async function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Reset first: picking the same file twice in a row is otherwise a change the input does not
  // report, so the second pick would do nothing at all.
  input.value = "";
  const dir = targetDir.value;
  for (const file of files) {
    await store.uploadToFolder(dir, file);
  }
}
</script>

<template>
  <div class="file-panel">
    <!--
      The toolbar. Its two actions apply to the directory the selection is in — see `targetDir`
      — and the hint says so without a second control to explain.
    -->
    <div class="file-toolbar">
      <button
        class="icon-btn"
        :title="t('files.newFolder')"
        :aria-label="t('files.newFolder')"
        data-testid="file-new-folder"
        @click="openNewFolder"
      >
        <Icon name="folder-plus" />
      </button>
      <button
        class="icon-btn"
        :title="t('files.upload')"
        :aria-label="t('files.upload')"
        data-testid="file-upload"
        @click="uploadInput?.click()"
      >
        <Icon name="upload" />
      </button>
      <input
        ref="uploadInput"
        type="file"
        multiple
        class="hidden-input"
        data-testid="file-upload-input"
        @change="onPickFiles"
      />
    </div>

    <div
      ref="treeEl"
      class="file-tree"
      role="tree"
      :aria-label="t('files.treeLabel')"
      data-testid="file-tree"
      @dragover.prevent
      @drop="onRootDrop"
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
        :class="{ 'drop-into': dropTarget === row.entry.path }"
        draggable="true"
        @focus="activeIndex = i"
        @click="activate(row)"
        @keydown="onKeydown($event, i)"
        @dragstart="onDragStart($event, row)"
        @dragend="onDragEnd"
        @dragover="onDragOver($event, row)"
        @drop="onDrop($event, row)"
        @dragleave="dropTarget === row.entry.path && (dropTarget = null)"
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
        <span class="row-actions">
          <button
            class="icon-btn"
            :title="t('files.rename')"
            :aria-label="t('files.rename')"
            data-testid="file-rename"
            @click.stop="openRename(row)"
          >
            <Icon name="edit" />
          </button>
          <button
            class="icon-btn danger"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            data-testid="file-delete"
            @click.stop="onDelete(row)"
          >
            <Icon name="trash" />
          </button>
        </span>
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

    <!--
      The two actions that need a name. One dialog, two sets of words: a rename and a move are
      the same edit — the field holds a path relative to the workspace root — so they share a
      component rather than each growing one.
    -->
    <FilePathDialog
      v-if="dialog"
      :title="dialog.kind === 'folder' ? t('files.newFolder') : t('files.rename')"
      :label="dialog.kind === 'folder' ? t('files.newFolderHint') : t('files.renameHint')"
      :initial="dialog.kind === 'folder' ? '' : dialog.path"
      :confirm-label="dialog.kind === 'folder' ? t('common.create') : t('common.rename')"
      @close="dialog = null"
      @submit="submitDialog"
    />
  </div>
</template>

<style scoped>
/*
 * The panel: a toolbar, then the tree, then the notes.
 *
 * It fills the sidebar's scroller, so the tree is the part that grows and the toolbar stays
 * where it is — a manager whose actions scroll away is one the user has to hunt for.
 */
.file-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.file-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  /* A hairline rather than a surface: the toolbar is chrome, not a second panel. */
  border-bottom: 1px solid var(--border);
}
.file-tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

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
/*
 * The folder a drag is currently over. An outline rather than a fill: the row underneath is
 * still a row, and a filled band would hide which name is being aimed at.
 */
.file-row.drop-into {
  outline: 1.5px solid var(--accent);
  outline-offset: -1.5px;
  background: var(--panel-2);
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
  flex: 1;
}

/*
 * The row's two actions, kept out of the way until the row is pointed at.
 *
 * `focus-within` as well as `hover`, because a keyboard user reaches these buttons by tabbing
 * into them and a group revealed only on hover would be invisible until it was already used.
 * A coarse pointer gets them always: there is no hover to reveal anything with.
 */
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  opacity: 0;
}
.file-row:hover .row-actions,
.file-row:focus-within .row-actions {
  opacity: 1;
}
@media (pointer: coarse) {
  .row-actions {
    opacity: 1;
  }
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
/*
 * The file picker the upload button drives. `display: none` rather than a visually-hidden clip:
 * the button above it is the control, and an input that stayed focusable would be a second,
 * invisible tab stop on a control the user never sees.
 */
.hidden-input {
  display: none;
}
</style>
